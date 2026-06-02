import { createServer } from "node:http";
import { randomInt, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const config = {
  port: readIntEnv("PORT", 8787),
  publicBasePath: normalizeBasePath(process.env.PUBLIC_BASE_PATH || "/"),
  sub2apiBaseUrl: trimTrailingSlash(process.env.SUB2API_BASE_URL || "http://127.0.0.1:3000"),
  authMePath: ensureLeadingSlash(process.env.SUB2API_AUTH_ME_PATH || "/api/v1/auth/me"),
  adminApiKey: process.env.SUB2API_ADMIN_API_KEY || "",
  adminAuthHeader: process.env.SUB2API_ADMIN_AUTH_HEADER || "x-api-key",
  adminAuthValue: process.env.SUB2API_ADMIN_AUTH_VALUE || process.env.SUB2API_ADMIN_API_KEY || "",
  balancePathTemplate:
    process.env.SUB2API_BALANCE_PATH_TEMPLATE || "/api/v1/admin/users/{id}/balance",
  balanceOperation: process.env.SUB2API_BALANCE_OPERATION || "add",
  balanceAmountField: process.env.SUB2API_BALANCE_AMOUNT_FIELD || "balance",
  checkinAmount: readFloatEnv("CHECKIN_AMOUNT", 0.1),
  checkinMinAmount: readFloatEnv("CHECKIN_MIN_AMOUNT", readFloatEnv("CHECKIN_AMOUNT", 0.1)),
  checkinMaxAmount: readFloatEnv("CHECKIN_MAX_AMOUNT", readFloatEnv("CHECKIN_AMOUNT", 0.1)),
  checkinAmountStep: readFloatEnv("CHECKIN_AMOUNT_STEP", 0.01),
  checkinRewardMode: normalizeRewardMode(process.env.CHECKIN_REWARD_MODE || ""),
  defaultRewardRules: parseRewardRulesEnv(process.env.CHECKIN_REWARD_RULES || ""),
  checkinUnit: process.env.CHECKIN_UNIT || "USD",
  checkinTimezone: process.env.CHECKIN_TIMEZONE || "Asia/Shanghai",
  checkinNotePrefix: process.env.CHECKIN_NOTE_PREFIX || "Daily check-in",
  checkinAdminPassword: process.env.CHECKIN_ADMIN_PASSWORD || "",
  dbFile: path.resolve(rootDir, process.env.CHECKIN_DB_FILE || process.env.SQLITE_FILE || "./data/checkins.db"),
  legacyDataFile: path.resolve(rootDir, process.env.DATA_FILE || "./data/checkins.json"),
  publicTokenStorageKeys: splitCsv(
    process.env.PUBLIC_TOKEN_STORAGE_KEYS ||
      "token,access_token,auth_token,sub2api_token,auth-storage,user,sub2api-auth"
  ),
  userTokenCookieNames: splitCsv(
    process.env.USER_TOKEN_COOKIE_NAMES || "token,access_token,auth_token,sub2api_token"
  )
};

const staticFiles = new Map([
  ["/app.js", { file: path.join(rootDir, "public", "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/admin.js", { file: path.join(rootDir, "public", "admin.js"), type: "text/javascript; charset=utf-8" }],
  ["/admin.css", { file: path.join(rootDir, "public", "admin.css"), type: "text/css; charset=utf-8" }],
  ["/styles.css", { file: path.join(rootDir, "public", "styles.css"), type: "text/css; charset=utf-8" }]
]);

let storeLock = Promise.resolve();
let db;

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error.status && error.code) {
      sendJson(res, error.status, {
        ok: false,
        error: error.code,
        message: error.message
      });
      return;
    }

    console.error("[request:error]", error);
    sendJson(res, 500, { ok: false, error: "internal_error", message: "服务内部错误" });
  }
});

await initStorage();

server.listen(config.port, () => {
  logInfo("service.started", {
    port: config.port,
    publicBasePath: config.publicBasePath,
    sub2apiBaseUrl: config.sub2apiBaseUrl,
    dbFile: config.dbFile,
    checkinAmount: config.checkinAmount,
    checkinUnit: config.checkinUnit,
    timezone: config.checkinTimezone
  });

  if (!config.checkinAdminPassword) {
    logWarn("config.missing_checkin_admin_password", {
      message: "CHECKIN_ADMIN_PASSWORD is empty; admin APIs are disabled."
    });
  }

  if (!config.adminApiKey && !config.adminAuthValue) {
    logWarn("config.missing_admin_api_key", {
      message: "SUB2API_ADMIN_API_KEY is empty; check-in will fail."
    });
  }

  void probeSub2api();
});

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const routePath = stripPublicBasePath(pathname);
  const method = req.method === "HEAD" ? "GET" : req.method;

  if (routePath === null) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }

  if (method === "GET" && routePath === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "sub2api-qiandao",
      time: new Date().toISOString()
    });
    return;
  }

  if (method === "GET" && routePath === "/api/config") {
    const rewardConfig = getRewardConfig();
    const rewardSummary = publicRewardSummary(rewardConfig.summary);

    sendJson(res, 200, {
      ok: true,
      basePath: config.publicBasePath,
      amount: rewardSummary.hidden ? null : rewardSummary.min,
      unit: config.checkinUnit,
      timezone: config.checkinTimezone,
      rewardSummary,
      tokenStorageKeys: config.publicTokenStorageKeys
    });
    return;
  }

  if (method === "GET" && routePath === "/api/admin/config") {
    requireAdmin(req);
    const rewardConfig = getRewardConfig();
    const adminStats = getAdminStats();

    sendJson(res, 200, {
      ok: true,
      unit: config.checkinUnit,
      timezone: config.checkinTimezone,
      notePrefix: getNotePrefix(),
      rewardMode: rewardConfig.mode,
      rewardRange: rewardConfig.range,
      rewardRules: rewardConfig.rewardRules,
      rewardSummary: rewardConfig.summary,
      stats: adminStats,
      system: getAdminSystemInfo(),
      recentEntries: getRecentEntries(30).map(publicAdminEntry)
    });
    return;
  }

  if (method === "PUT" && routePath === "/api/admin/config") {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const rewardMode = validateRewardMode(body?.rewardMode ?? getRewardMode());
    const rewardRange = validateRewardRange(body?.rewardRange ?? getRewardRange());
    const rewardRules = validateRewardRules(body?.rewardRules ?? getRewardRules());
    const notePrefix = validateNotePrefix(body?.notePrefix ?? getNotePrefix());

    saveAdminConfig({ rewardMode, rewardRange, rewardRules, notePrefix });
    const rewardSummary = summarizeRewardConfig({ mode: rewardMode, range: rewardRange, rewardRules });

    logInfo("admin.config.updated", {
      rewardMode,
      rewardRange,
      count: rewardRules.length,
      enabledCount: rewardRules.filter((rule) => rule.enabled).length,
      notePrefix
    });

    sendJson(res, 200, {
      ok: true,
      notePrefix,
      rewardMode,
      rewardRange,
      rewardRules,
      rewardSummary
    });
    return;
  }

  if (method === "GET" && routePath === "/api/me") {
    const user = await resolveCurrentUser(req);
    const date = dateKey(new Date(), config.checkinTimezone);
    const entry = findEntry(user.id, date);

    if (entry) {
      refreshEntryIdentity(entry, user);
    }

    sendJson(res, 200, {
      ok: true,
      user: publicUser(user),
      date,
      checkedIn: Boolean(entry),
      entry: entry ? publicEntry(entry) : null
    });
    return;
  }

  if (method === "GET" && routePath === "/api/calendar") {
    const user = await resolveCurrentUser(req);
    const month = validateMonth(url.searchParams.get("month") || monthKey(new Date(), config.checkinTimezone));
    const entries = getUserEntriesForMonth(user.id, month);

    sendJson(res, 200, {
      ok: true,
      user: publicUser(user),
      month,
      entries: entries.map(publicEntry),
      totalAmount: entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
      unit: config.checkinUnit
    });
    return;
  }

  if (method === "POST" && routePath === "/api/checkin") {
    const user = await resolveCurrentUser(req);
    const result = await checkIn(user);
    sendJson(res, 200, result);
    return;
  }

  if (method === "GET" && staticFiles.has(routePath)) {
    serveStatic(res, staticFiles.get(routePath));
    return;
  }

  if (method === "GET" && (routePath === "/" || routePath === "/index.html")) {
    sendHtml(res, renderIndex());
    return;
  }

  if (method === "GET" && (routePath === "/admin" || routePath === "/admin/")) {
    sendHtml(res, renderAdmin());
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

async function checkIn(user) {
  return withStoreLock(async () => {
    const date = dateKey(new Date(), config.checkinTimezone);
    const existing = findEntry(user.id, date);

    if (existing) {
      refreshEntryIdentity(existing, user);

      logInfo("checkin.duplicate", {
        user: logUser(user),
        date,
        amount: existing.amount,
        unit: existing.unit,
        originalCreatedAt: existing.createdAt
      });

      return {
        ok: true,
        alreadyCheckedIn: true,
        date,
        user: publicUser(user),
        entry: publicEntry(existing)
      };
    }

    const rewardConfig = getRewardConfig();
    const reward = pickReward(rewardConfig);
    const notePrefix = getNotePrefix();
    const note = `${notePrefix} ${date} ${reward.amount} ${config.checkinUnit}`;
    const upstream = await addUserBalance(user.id, reward.amount, note);
    const identity = userIdentityForStorage(user);
    const entry = {
      id: `${date}:${user.id}`,
      userId: String(user.id),
      userName: identity.userName,
      userEmail: identity.userEmail,
      date,
      amount: reward.amount,
      unit: config.checkinUnit,
      rewardRuleId: reward.id,
      rewardLabel: reward.label,
      rewardWeight: reward.weight,
      note,
      createdAt: new Date().toISOString(),
      upstreamStatus: upstream.status
    };

    insertCheckin(entry);

    logInfo("checkin.success", {
      user: logUser(user),
      date,
      amount: entry.amount,
      unit: entry.unit,
      rewardRuleId: entry.rewardRuleId,
      rewardLabel: entry.rewardLabel,
      rewardWeight: entry.rewardWeight,
      rewardMode: rewardConfig.mode,
      upstreamStatus: upstream.status,
      createdAt: entry.createdAt
    });

    return {
      ok: true,
      alreadyCheckedIn: false,
      date,
      user: publicUser(user),
      entry: publicEntry(entry)
    };
  });
}

async function resolveCurrentUser(req) {
  const headers = buildUserAuthHeaders(req);
  const tokenUser = extractUserFromJwt(req);

  if (!headers.Authorization && !headers.Cookie) {
    throw httpError(401, "missing_user_token", "无法读取当前登录用户，请确认签到页与 Sub2API 同源部署。");
  }

  const upstream = await fetchJson(`${config.sub2apiBaseUrl}${config.authMePath}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...headers
    }
  });

  if (!upstream.ok) {
    throw httpError(401, "invalid_user_token", "当前登录态验证失败，请重新登录 Sub2API 后再试。");
  }

  const user = mergeUserIdentity(extractUser(upstream.body), tokenUser);

  if (!user?.id) {
    logError("sub2api.user.unrecognized", {
      body: upstream.body
    });
    throw httpError(502, "unrecognized_user_response", "无法从 Sub2API 用户接口解析用户 ID。");
  }

  logInfo("sub2api.user.verified", {
    user: logUser(user),
    upstreamStatus: upstream.status
  });

  return user;
}

function buildUserAuthHeaders(req) {
  const headers = {};
  const authorization = req.headers.authorization;
  const explicitToken = req.headers["x-sub2api-token"] || req.headers["x-user-token"];

  if (authorization) {
    headers.Authorization = authorization;
  } else if (explicitToken) {
    headers.Authorization = asBearerToken(String(explicitToken));
  }

  const cookies = parseCookieHeader(req.headers.cookie || "");
  const tokenCookieName = config.userTokenCookieNames.find((name) => cookies[name]);

  if (!headers.Authorization && tokenCookieName) {
    headers.Authorization = asBearerToken(cookies[tokenCookieName]);
  }

  if (req.headers.cookie) {
    headers.Cookie = req.headers.cookie;
  }

  return headers;
}

async function addUserBalance(userId, amount, note) {
  if (!config.adminAuthValue) {
    throw httpError(500, "missing_admin_api_key", "服务端未配置 SUB2API_ADMIN_API_KEY。");
  }

  const url = `${config.sub2apiBaseUrl}${config.balancePathTemplate.replace(
    "{id}",
    encodeURIComponent(String(userId))
  )}`;
  const body = {
    [config.balanceAmountField]: amount,
    operation: config.balanceOperation,
    notes: note
  };

  const upstream = await fetchJson(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [config.adminAuthHeader]: config.adminAuthValue
    },
    body: JSON.stringify(body)
  });

  if (!upstream.ok) {
    logError("sub2api.balance.failed", {
      userId: String(userId),
      amount,
      operation: config.balanceOperation,
      status: upstream.status,
      body: upstream.body
    });
    throw httpError(502, "balance_update_failed", "Sub2API 余额增加失败。");
  }

  return upstream;
}

async function probeSub2api() {
  const url = `${config.sub2apiBaseUrl}${config.authMePath}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    logInfo("sub2api.connection.ok", {
      baseUrl: config.sub2apiBaseUrl,
      authMePath: config.authMePath,
      status: response.status
    });
  } catch (error) {
    logError("sub2api.connection.failed", {
      baseUrl: config.sub2apiBaseUrl,
      authMePath: config.authMePath,
      message: error.message
    });
  }
}

async function fetchJson(url, options) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (error) {
    logError("sub2api.fetch.failed", {
      url,
      method: options?.method || "GET",
      message: error.message
    });
    throw httpError(502, "sub2api_unreachable", "无法连接 Sub2API。");
  }

  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 1000) };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body
  };
}

function withStoreLock(task) {
  const next = storeLock.then(task, task);
  storeLock = next.catch(() => {});
  return next;
}

async function initStorage() {
  await mkdir(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reward_rules (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      weight REAL NOT NULL CHECK (weight >= 0),
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      user_email TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      unit TEXT NOT NULL,
      reward_rule_id TEXT NOT NULL DEFAULT '',
      reward_label TEXT NOT NULL DEFAULT '',
      reward_weight REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      upstream_status INTEGER,
      UNIQUE (user_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_checkins_created_at ON checkins (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins (user_id, date);
  `);
  ensureColumn("checkins", "user_email", "TEXT NOT NULL DEFAULT ''");

  await migrateLegacyJsonIfNeeded();
  seedRewardRulesIfNeeded();
  seedSettingsIfNeeded();

  logInfo("storage.sqlite.ready", {
    dbFile: config.dbFile
  });
}

async function migrateLegacyJsonIfNeeded() {
  if (countRows("checkins") > 0 || countRows("reward_rules") > 0) {
    return;
  }

  let legacy;

  try {
    legacy = JSON.parse(await readFile(config.legacyDataFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const store = normalizeStore(legacy);

  db.exec("BEGIN");

  try {
    replaceRewardRules(store.rewardRules);

    for (const entry of store.entries) {
      insertCheckin({
        id: entry.id || `${entry.date}:${entry.userId}`,
        userId: entry.userId,
        userName: entry.userName || "",
        userEmail: entry.userEmail || "",
        date: entry.date,
        amount: Number(entry.amount),
        unit: entry.unit || config.checkinUnit,
        rewardRuleId: entry.rewardRuleId || "",
        rewardLabel: entry.rewardLabel || "",
        rewardWeight: Number(entry.rewardWeight || 0),
        note: entry.note || "",
        createdAt: entry.createdAt || new Date().toISOString(),
        upstreamStatus: entry.upstreamStatus || null
      });
    }

    setSetting("legacy_json_migrated_from", config.legacyDataFile);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  logInfo("storage.legacy_json.migrated", {
    legacyDataFile: config.legacyDataFile,
    entries: store.entries.length,
    rewardRules: store.rewardRules.length
  });
}

function seedRewardRulesIfNeeded() {
  if (countRows("reward_rules") > 0) {
    return;
  }

  replaceRewardRules(normalizeRewardRules([]));
}

function seedSettingsIfNeeded() {
  if (!getSetting("checkin_note_prefix")) {
    setSetting("checkin_note_prefix", config.checkinNotePrefix);
  }

  if (!getSetting("reward_mode")) {
    setSetting("reward_mode", defaultRewardMode());
  }

  const range = defaultRewardRange();

  if (!getSetting("range_min_amount")) {
    setSetting("range_min_amount", range.min);
  }

  if (!getSetting("range_max_amount")) {
    setSetting("range_max_amount", range.max);
  }

  if (!getSetting("range_step")) {
    setSetting("range_step", range.step);
  }
}

function countRows(tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
}

function getRewardRules() {
  const rows = db
    .prepare(
      `SELECT id, label, amount, weight, enabled
       FROM reward_rules
       ORDER BY sort_order ASC, rowid ASC`
    )
    .all();

  return normalizeRewardRules(
    rows.map((row) => ({
      id: row.id,
      label: row.label,
      amount: row.amount,
      weight: row.weight,
      enabled: Boolean(row.enabled)
    }))
  );
}

function getRewardConfig() {
  const mode = getRewardMode();
  const range = getRewardRange();
  const rewardRules = getRewardRules();

  return {
    mode,
    range,
    rewardRules,
    summary: summarizeRewardConfig({ mode, range, rewardRules })
  };
}

function getRewardMode() {
  const mode = normalizeRewardMode(getSetting("reward_mode"));
  return mode || defaultRewardMode();
}

function defaultRewardMode() {
  if (config.checkinRewardMode) {
    return config.checkinRewardMode;
  }

  const enabledRules = getRewardRules().filter((rule) => rule.enabled && rule.weight > 0);
  return enabledRules.length > 1 ? "weighted_random" : "range_random";
}

function getRewardRange() {
  const fallback = defaultRewardRange();

  return validateRewardRange({
    min: readNumberSetting("range_min_amount", fallback.min),
    max: readNumberSetting("range_max_amount", fallback.max),
    step: readNumberSetting("range_step", fallback.step)
  });
}

function defaultRewardRange() {
  return validateRewardRange({
    min: config.checkinMinAmount,
    max: config.checkinMaxAmount,
    step: config.checkinAmountStep
  });
}

function readNumberSetting(key, fallback) {
  const value = getSetting(key);

  if (!value) {
    return fallback;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function saveAdminConfig({ rewardMode, rewardRange, rewardRules, notePrefix }) {
  db.exec("BEGIN");

  try {
    setSetting("reward_mode", rewardMode);
    setSetting("range_min_amount", rewardRange.min);
    setSetting("range_max_amount", rewardRange.max);
    setSetting("range_step", rewardRange.step);
    replaceRewardRules(rewardRules);
    setSetting("checkin_note_prefix", notePrefix);
    setSetting("reward_rules_updated_at", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replaceRewardRules(rewardRules) {
  db.prepare("DELETE FROM reward_rules").run();

  const statement = db.prepare(`
    INSERT INTO reward_rules (id, label, amount, weight, enabled, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  rewardRules.forEach((rule, index) => {
    statement.run(rule.id, rule.label, rule.amount, rule.weight, rule.enabled ? 1 : 0, index, now);
  });
}

function findEntry(userId, date) {
  const row = db
    .prepare(
      `SELECT
        id,
        user_id AS userId,
        user_name AS userName,
        user_email AS userEmail,
        date,
        amount,
        unit,
        reward_rule_id AS rewardRuleId,
        reward_label AS rewardLabel,
        reward_weight AS rewardWeight,
        note,
        created_at AS createdAt,
        upstream_status AS upstreamStatus
       FROM checkins
       WHERE user_id = ? AND date = ?
       LIMIT 1`
    )
    .get(String(userId), date);

  return row || null;
}

function getUserEntriesForMonth(userId, month) {
  return db
    .prepare(
      `SELECT
        id,
        user_id AS userId,
        user_name AS userName,
        user_email AS userEmail,
        date,
        amount,
        unit,
        reward_rule_id AS rewardRuleId,
        reward_label AS rewardLabel,
        reward_weight AS rewardWeight,
        note,
        created_at AS createdAt,
        upstream_status AS upstreamStatus
       FROM checkins
       WHERE user_id = ? AND date >= ? AND date < ?
       ORDER BY date ASC`
    )
    .all(String(userId), `${month}-01`, nextMonthKey(month));
}

function insertCheckin(entry) {
  db.prepare(
    `INSERT INTO checkins (
      id,
      user_id,
      user_name,
      user_email,
      date,
      amount,
      unit,
      reward_rule_id,
      reward_label,
      reward_weight,
      note,
      created_at,
      upstream_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.id,
    String(entry.userId),
    entry.userName || "",
    entry.userEmail || "",
    entry.date,
    entry.amount,
    entry.unit,
    entry.rewardRuleId || "",
    entry.rewardLabel || "",
    entry.rewardWeight || 0,
    entry.note || "",
    entry.createdAt,
    entry.upstreamStatus || null
  );
}

function refreshEntryIdentity(entry, user) {
  const identity = userIdentityForStorage(user);

  if (!identity.userName && !identity.userEmail) {
    return;
  }

  updateCheckinIdentity(entry.id, identity);
  entry.userName = entry.userName || identity.userName;
  entry.userEmail = entry.userEmail || identity.userEmail;
}

function updateCheckinIdentity(id, identity) {
  db.prepare(
    `UPDATE checkins
     SET
       user_name = CASE WHEN user_name = '' THEN ? ELSE user_name END,
       user_email = CASE WHEN user_email = '' THEN ? ELSE user_email END
     WHERE id = ?`
  ).run(identity.userName || "", identity.userEmail || "", id);
}

function getRecentEntries(limit) {
  return db
    .prepare(
      `SELECT
        id,
        user_id AS userId,
        user_name AS userName,
        user_email AS userEmail,
        date,
        amount,
        unit,
        reward_rule_id AS rewardRuleId,
        reward_label AS rewardLabel,
        reward_weight AS rewardWeight,
        note,
        created_at AS createdAt,
        upstream_status AS upstreamStatus
       FROM checkins
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

function getAdminStats() {
  const today = dateKey(new Date(), config.checkinTimezone);
  const currentMonth = today.slice(0, 7);
  const todayStats = getAggregateStats(today, nextDateKey(today));
  const monthStats = getAggregateStats(`${currentMonth}-01`, nextMonthKey(currentMonth));
  const allTimeStats = getAggregateStats("0000-00-00", "9999-99-99");
  const longestStreaks = getLongestStreaks(10, today);

  return {
    today,
    month: currentMonth,
    unit: config.checkinUnit,
    todayCount: todayStats.count,
    todayAmount: todayStats.amount,
    monthUsers: monthStats.users,
    monthCount: monthStats.count,
    monthAmount: monthStats.amount,
    allTimeUsers: allTimeStats.users,
    allTimeCount: allTimeStats.count,
    allTimeAmount: allTimeStats.amount,
    averageReward: allTimeStats.count > 0 ? allTimeStats.amount / allTimeStats.count : 0,
    dailyTrend: getDailyTrend(14, today),
    rewardBreakdown: getRewardBreakdown(currentMonth),
    longestStreaks
  };
}

function getAggregateStats(startDate, endDate) {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS count,
        COUNT(DISTINCT user_id) AS users,
        COALESCE(SUM(amount), 0) AS amount
       FROM checkins
       WHERE date >= ? AND date < ?`
    )
    .get(startDate, endDate);

  return {
    count: Number(row?.count || 0),
    users: Number(row?.users || 0),
    amount: Number(row?.amount || 0)
  };
}

function getLongestStreaks(limit, today = dateKey(new Date(), config.checkinTimezone)) {
  const activeSince = previousDateKey(today);
  const rows = db
    .prepare(
      `SELECT
        user_id AS userId,
        MAX(user_name) AS userName,
        MAX(user_email) AS userEmail,
        MAX(date) AS lastDate
       FROM checkins
       GROUP BY user_id
       HAVING lastDate >= ?
       ORDER BY lastDate DESC
       `
    )
    .all(activeSince);

  return rows
    .map((row) => {
      const streak = getUserCurrentStreak(row.userId, today);

      return {
        userId: row.userId,
        userName: row.userName || "",
        userEmail: row.userEmail || "",
        userDisplayName: displayUserName(row) || `用户 ${row.userId}`,
        streak,
        lastDate: row.lastDate || ""
      };
    })
    .filter((row) => row.streak > 0)
    .sort((left, right) => right.streak - left.streak || String(right.lastDate).localeCompare(String(left.lastDate)))
    .slice(0, limit);
}

function getDailyTrend(days, today = dateKey(new Date(), config.checkinTimezone)) {
  const startDate = shiftDateKey(today, -(days - 1));
  const rows = db
    .prepare(
      `SELECT
        date,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS amount
       FROM checkins
       WHERE date >= ? AND date <= ?
       GROUP BY date`
    )
    .all(startDate, today);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const trend = [];

  for (let index = 0; index < days; index += 1) {
    const date = shiftDateKey(startDate, index);
    const row = byDate.get(date);

    trend.push({
      date,
      count: Number(row?.count || 0),
      amount: Number(row?.amount || 0)
    });
  }

  return trend;
}

function getRewardBreakdown(month) {
  return db
    .prepare(
      `SELECT
        COALESCE(NULLIF(reward_label, ''), amount || ' ' || unit) AS label,
        amount,
        unit,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS totalAmount
       FROM checkins
       WHERE date >= ? AND date < ?
       GROUP BY label, amount, unit
       ORDER BY count DESC, totalAmount DESC
       LIMIT 12`
    )
    .all(`${month}-01`, nextMonthKey(month))
    .map((row) => ({
      label: row.label || "奖励",
      amount: Number(row.amount || 0),
      unit: row.unit || config.checkinUnit,
      count: Number(row.count || 0),
      totalAmount: Number(row.totalAmount || 0)
    }));
}

function getUserCurrentStreak(userId, today = dateKey(new Date(), config.checkinTimezone)) {
  const rows = db
    .prepare(
      `SELECT date
       FROM checkins
       WHERE user_id = ?
       ORDER BY date DESC
       LIMIT 370`
    )
    .all(String(userId));
  const latestDate = rows[0]?.date || "";
  const yesterday = previousDateKey(today);

  if (latestDate !== today && latestDate !== yesterday) {
    return 0;
  }

  let expectedDate = latestDate;
  let streak = 0;

  for (const row of rows) {
    if (row.date !== expectedDate) {
      break;
    }

    streak += 1;
    expectedDate = previousDateKey(expectedDate);
  }

  return streak;
}

function getAdminSystemInfo() {
  return {
    storage: "SQLite",
    publicBasePath: config.publicBasePath,
    sub2apiBaseUrl: config.sub2apiBaseUrl,
    authMePath: config.authMePath,
    adminAuthHeader: config.adminAuthHeader,
    adminAuthConfigured: Boolean(config.adminApiKey || config.adminAuthValue),
    balanceOperation: config.balanceOperation,
    balancePathTemplate: config.balancePathTemplate,
    balanceAmountField: config.balanceAmountField,
    dbFile: config.dbFile,
    timezone: config.checkinTimezone,
    unit: config.checkinUnit
  };
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, String(value), new Date().toISOString());
}

function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key)?.value || "";
}

function getNotePrefix() {
  return getSetting("checkin_note_prefix") || config.checkinNotePrefix;
}

function validateNotePrefix(value) {
  const notePrefix = String(value ?? "").trim();

  if (!notePrefix) {
    throw httpError(400, "invalid_note_prefix", "备注前缀不能为空。");
  }

  if (notePrefix.length > 120) {
    throw httpError(400, "invalid_note_prefix", "备注前缀最多 120 个字符。");
  }

  return notePrefix;
}

function validateMonth(value) {
  const month = String(value || "").trim();

  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw httpError(400, "invalid_month", "月份格式必须是 YYYY-MM。");
  }

  const monthNumber = Number(month.slice(5, 7));

  if (monthNumber < 1 || monthNumber > 12) {
    throw httpError(400, "invalid_month", "月份必须在 01 到 12 之间。");
  }

  return month;
}

function nextMonthKey(month) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const next = monthNumber === 12 ? { year: year + 1, month: 1 } : { year, month: monthNumber + 1 };

  return `${next.year}-${String(next.month).padStart(2, "0")}`;
}

function nextDateKey(date) {
  return shiftDateKey(date, 1);
}

function previousDateKey(date) {
  return shiftDateKey(date, -1);
}

function shiftDateKey(date, delta) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));

  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function publicEntry(entry) {
  return {
    date: entry.date,
    amount: entry.amount,
    unit: entry.unit,
    rewardLabel: entry.rewardLabel || "",
    note: entry.note,
    createdAt: entry.createdAt
  };
}

function publicAdminEntry(entry) {
  return {
    userId: entry.userId,
    userName: entry.userName || "",
    userEmail: entry.userEmail || "",
    userDisplayName: displayUserName(entry) || `用户 ${entry.userId}`,
    streak: getUserCurrentStreak(entry.userId),
    date: entry.date,
    amount: entry.amount,
    unit: entry.unit,
    rewardLabel: entry.rewardLabel || "",
    createdAt: entry.createdAt,
    upstreamStatus: entry.upstreamStatus || null
  };
}

function userIdentityForStorage(user) {
  return {
    userName: displayUserName(user),
    userEmail: firstNonEmpty(user.email, user.userEmail)
  };
}

function displayUserName(value) {
  return firstNonEmpty(
    value?.userName,
    value?.name,
    value?.username,
    value?.displayName,
    value?.email,
    value?.userEmail
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function publicUser(user) {
  return {
    id: String(user.id),
    name: displayUserName(user),
    email: user.email || "",
    balance: user.balance ?? null
  };
}

function publicRewardSummary(summary) {
  if (!summary || summary.mode !== "fixed") {
    return {
      mode: summary?.mode || "random",
      sourceMode: summary?.sourceMode || "",
      hidden: true
    };
  }

  return {
    mode: "fixed",
    sourceMode: summary.sourceMode || "fixed",
    hidden: false,
    min: summary.min,
    max: summary.max,
    display: `${summary.min}`
  };
}

function normalizeStore(store) {
  return {
    version: 2,
    entries: Array.isArray(store.entries) ? store.entries : [],
    rewardRules: normalizeRewardRules(store.rewardRules),
    updatedAt: store.updatedAt || null
  };
}

function normalizeRewardRules(rules) {
  const validated = validateRewardRules(rules, { allowEmpty: true });

  if (validated.length > 0 && totalEnabledWeight(validated) > 0) {
    return validated;
  }

  if (config.defaultRewardRules.length > 0) {
    return config.defaultRewardRules.map((rule) => ({ ...rule }));
  }

  return [
    {
      id: "default",
      label: `${config.checkinAmount} ${config.checkinUnit}`,
      amount: config.checkinAmount,
      weight: 100,
      enabled: true
    }
  ];
}

function validateRewardMode(value) {
  const mode = normalizeRewardMode(value);

  if (!mode) {
    throw httpError(400, "invalid_reward_mode", "奖励模式必须是 range_random 或 weighted_random。");
  }

  return mode;
}

function normalizeRewardMode(value) {
  const mode = String(value || "").trim().toLowerCase();

  if (["range", "range_random", "newapi"].includes(mode)) {
    return "range_random";
  }

  if (["weighted", "weighted_random", "rules"].includes(mode)) {
    return "weighted_random";
  }

  return "";
}

function validateRewardRange(value) {
  const min = roundAmount(Number(value?.min ?? value?.minAmount));
  const max = roundAmount(Number(value?.max ?? value?.maxAmount));
  const step = roundAmount(Number(value?.step));

  if (!Number.isFinite(min) || min <= 0) {
    throw httpError(400, "invalid_reward_range", "最小奖励金额必须大于 0。");
  }

  if (!Number.isFinite(max) || max <= 0) {
    throw httpError(400, "invalid_reward_range", "最大奖励金额必须大于 0。");
  }

  if (max < min) {
    throw httpError(400, "invalid_reward_range", "最大奖励金额不能小于最小奖励金额。");
  }

  if (!Number.isFinite(step) || step <= 0) {
    throw httpError(400, "invalid_reward_range", "随机步长必须大于 0。");
  }

  const stepsFloat = (max - min) / step;
  const steps = Math.round(stepsFloat);

  if (Math.abs(stepsFloat - steps) > 1e-8) {
    throw httpError(400, "invalid_reward_range", "最大金额减最小金额必须能被步长整除。");
  }

  if (steps > 10000) {
    throw httpError(400, "invalid_reward_range", "随机区间过大，请调大步长或缩小金额范围。");
  }

  return { min, max, step };
}

function validateRewardRules(rules, options = {}) {
  if (!Array.isArray(rules)) {
    if (options.allowEmpty) {
      return [];
    }

    throw httpError(400, "invalid_reward_rules", "奖励档位必须是数组。");
  }

  const normalized = rules
    .map((rule, index) => ({
      id: sanitizeRuleId(rule?.id, index),
      label: sanitizeRuleLabel(rule?.label, rule?.amount),
      amount: Number(rule?.amount),
      weight: Number(rule?.weight),
      enabled: rule?.enabled !== false
    }))
    .filter((rule) => rule.enabled || rule.amount || rule.weight || rule.label);

  if (!options.allowEmpty && normalized.length === 0) {
    throw httpError(400, "empty_reward_rules", "至少需要配置一个奖励档位。");
  }

  if (normalized.length > 50) {
    throw httpError(400, "too_many_reward_rules", "奖励档位最多 50 个。");
  }

  for (const rule of normalized) {
    if (!Number.isFinite(rule.amount) || rule.amount <= 0) {
      throw httpError(400, "invalid_reward_amount", "奖励金额必须大于 0。");
    }

    if (!Number.isFinite(rule.weight) || rule.weight < 0) {
      throw httpError(400, "invalid_reward_weight", "奖励权重不能小于 0。");
    }
  }

  if (!options.allowEmpty && totalEnabledWeight(normalized) <= 0) {
    throw httpError(400, "invalid_reward_weight", "至少需要一个启用档位的权重大于 0。");
  }

  return normalized;
}

function sanitizeRuleId(value, index) {
  const raw = String(value || `rule-${index + 1}`).trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || `rule-${index + 1}`;
}

function sanitizeRuleLabel(label, amount) {
  const value = String(label || `${amount || ""}`).trim();
  return value.slice(0, 80) || "随机奖励";
}

function totalEnabledWeight(rules) {
  return rules
    .filter((rule) => rule.enabled)
    .reduce((sum, rule) => sum + rule.weight, 0);
}

function pickReward(rewardConfig) {
  if (rewardConfig.mode === "range_random") {
    return pickRangeReward(rewardConfig.range);
  }

  return pickWeightedReward(rewardConfig.rewardRules);
}

function pickRangeReward(range) {
  const steps = Math.round((range.max - range.min) / range.step);
  const amount = roundAmount(range.min + randomInt(steps + 1) * range.step);

  return {
    id: "range-random",
    label: range.min === range.max ? "固定奖励" : "区间随机",
    amount,
    weight: 0,
    enabled: true
  };
}

function pickWeightedReward(rules) {
  const enabledRules = rules.filter((rule) => rule.enabled && rule.weight > 0);
  const totalWeight = totalEnabledWeight(enabledRules);
  let cursor = Math.random() * totalWeight;

  for (const rule of enabledRules) {
    cursor -= rule.weight;

    if (cursor <= 0) {
      return { ...rule };
    }
  }

  return { ...enabledRules[enabledRules.length - 1] };
}

function summarizeRewardConfig(rewardConfig) {
  if (rewardConfig.mode === "range_random") {
    return summarizeRewardRange(rewardConfig.range);
  }

  return summarizeRewardRules(rewardConfig.rewardRules);
}

function summarizeRewardRange(range) {
  return {
    mode: range.min === range.max ? "fixed" : "range_random",
    sourceMode: "range_random",
    min: range.min,
    max: range.max,
    step: range.step,
    totalWeight: 0,
    rules: []
  };
}

function summarizeRewardRules(rules) {
  const enabledRules = rules.filter((rule) => rule.enabled && rule.weight > 0);
  const amounts = enabledRules.map((rule) => rule.amount);
  const totalWeight = totalEnabledWeight(enabledRules);

  return {
    mode: enabledRules.length > 1 ? "weighted_random" : "fixed",
    sourceMode: "weighted_random",
    min: Math.min(...amounts),
    max: Math.max(...amounts),
    totalWeight,
    rules: enabledRules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      amount: rule.amount,
      weight: rule.weight,
      probability: totalWeight > 0 ? rule.weight / totalWeight : 0
    }))
  };
}

function roundAmount(value) {
  return Number(Number(value).toFixed(6));
}

function parseRewardRulesEnv(value) {
  if (!value.trim()) {
    return [];
  }

  try {
    return validateRewardRules(JSON.parse(value), { allowEmpty: true });
  } catch {
    const rules = value
      .split(",")
      .map((item, index) => {
        const [amount, weight = "1", label = ""] = item.split(":").map((part) => part.trim());

        return {
          id: `env-${index + 1}`,
          label: label || amount,
          amount: Number(amount),
          weight: Number(weight),
          enabled: true
        };
      })
      .filter((rule) => Number.isFinite(rule.amount));

    return validateRewardRules(rules, { allowEmpty: true });
  }
}

function requireAdmin(req) {
  if (!config.checkinAdminPassword) {
    throw httpError(403, "admin_disabled", "管理端未启用，请先配置 CHECKIN_ADMIN_PASSWORD。");
  }

  const provided = getAdminPassword(req);

  if (!safeEqual(provided, config.checkinAdminPassword)) {
    throw httpError(401, "invalid_admin_password", "管理密码错误。");
  }
}

function getAdminPassword(req) {
  const direct = req.headers["x-checkin-admin-password"];

  if (direct) {
    return String(direct);
  }

  const authorization = String(req.headers.authorization || "");

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7);
  }

  if (authorization.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const index = decoded.indexOf(":");
      return index === -1 ? decoded : decoded.slice(index + 1);
    } catch {
      return "";
    }
  }

  return "";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 1024 * 1024) {
      throw httpError(413, "payload_too_large", "请求体过大。");
    }
  }

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "invalid_json", "请求体不是合法 JSON。");
  }
}

function logUser(user) {
  return {
    id: String(user.id),
    name: user.name || "",
    email: user.email || ""
  };
}

function logInfo(event, data = {}) {
  writeLog("info", event, data);
}

function logWarn(event, data = {}) {
  writeLog("warn", event, data);
}

function logError(event, data = {}) {
  writeLog("error", event, data);
}

function writeLog(level, event, data) {
  const payload = {
    time: new Date().toISOString(),
    level,
    event,
    ...data
  };
  const line = `[sub2api-qiandao] ${JSON.stringify(payload)}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function extractUser(payload) {
  const candidates = [
    payload?.data?.user,
    payload?.data?.currentUser,
    payload?.data,
    payload?.user,
    payload?.result?.user,
    payload?.result,
    payload
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const id = candidate.id ?? candidate.user_id ?? candidate.userId ?? candidate.uuid ?? candidate.sub;

    if (id === undefined || id === null || id === "") {
      continue;
    }

    return {
      id,
      name:
        candidate.username ??
        candidate.name ??
        candidate.displayName ??
        candidate.display_name ??
        candidate.nickname ??
        candidate.email ??
        "",
      email: candidate.email ?? "",
      balance: candidate.balance ?? candidate.quota ?? candidate.credit ?? null
    };
  }

  return null;
}

function extractUserFromJwt(req) {
  const token = getUserTokenFromRequest(req);

  if (!token) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8"));
    return extractUser(payload);
  } catch {
    return null;
  }
}

function getUserTokenFromRequest(req) {
  const authorization = String(req.headers.authorization || "");
  const explicitToken = req.headers["x-sub2api-token"] || req.headers["x-user-token"];

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  if (authorization) {
    return authorization.trim();
  }

  if (explicitToken) {
    return String(explicitToken).replace(/^bearer\s+/i, "").trim();
  }

  const cookies = parseCookieHeader(req.headers.cookie || "");
  const tokenCookieName = config.userTokenCookieNames.find((name) => cookies[name]);

  return tokenCookieName ? String(cookies[tokenCookieName]).replace(/^bearer\s+/i, "").trim() : "";
}

function base64UrlToBase64(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

function mergeUserIdentity(user, tokenUser) {
  if (!user) {
    return tokenUser;
  }

  if (!tokenUser) {
    return user;
  }

  return {
    ...user,
    id: user.id ?? tokenUser.id,
    name: firstNonEmpty(user.name, tokenUser.name),
    email: firstNonEmpty(user.email, tokenUser.email),
    balance: user.balance ?? tokenUser.balance ?? null
  };
}

function stripPublicBasePath(pathname) {
  const base = config.publicBasePath;

  if (base === "/") {
    return pathname;
  }

  if (pathname === base) {
    return "/";
  }

  if (pathname.startsWith(`${base}/`)) {
    return pathname.slice(base.length) || "/";
  }

  return null;
}

function serveStatic(res, asset) {
  res.writeHead(200, {
    "Content-Type": asset.type,
    "Cache-Control": "no-store"
  });
  createReadStream(asset.file).pipe(res);
}

function renderIndex() {
  const base = config.publicBasePath === "/" ? "" : config.publicBasePath;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sub2API 每日签到</title>
    <link rel="stylesheet" href="${base}/styles.css" />
    <script>window.__CHECKIN_BASE_PATH__ = ${JSON.stringify(config.publicBasePath)};</script>
    <script type="module" src="${base}/app.js"></script>
  </head>
  <body>
    <main class="shell">
      <section class="page-head">
        <div>
          <p class="eyebrow">Daily Check-in</p>
          <h1>每日签到</h1>
          <p class="summary" id="summary">正在读取当前登录用户...</p>
        </div>
        <button class="checkin-button" id="checkinButton" type="button" disabled>立即签到</button>
      </section>

      <section class="stats-grid" aria-live="polite">
        <article class="stat-card" id="identity" hidden>
          <span>当前账号</span>
          <strong id="userName">-</strong>
        </article>
        <article class="stat-card" id="rewardCard">
          <span>今日奖励</span>
          <strong id="rewardAmount">-</strong>
        </article>
        <article class="stat-card">
          <span>本月累计</span>
          <strong id="monthTotal">-</strong>
        </article>
      </section>

      <section class="content-grid">
        <article class="panel calendar-panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Calendar</p>
              <h2 id="calendarTitle">签到日历</h2>
            </div>
            <div class="month-actions">
              <button class="ghost-button" id="prevMonthButton" type="button">上月</button>
              <button class="ghost-button" id="currentMonthButton" type="button">本月</button>
              <button class="ghost-button" id="nextMonthButton" type="button">下月</button>
            </div>
          </div>
          <div class="week-row" aria-hidden="true">
            <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
          </div>
          <div class="calendar-grid" id="calendarGrid"></div>
        </article>

        <aside class="panel side-panel">
          <div>
            <p class="eyebrow">Status</p>
            <h2>签到状态</h2>
          </div>
          <p class="message" id="message"></p>
          <p class="hint" id="hint"></p>
          <div class="history-list" id="historyList"></div>
        </aside>
      </section>
    </main>
  </body>
</html>`;
}

function renderAdmin() {
  const base = config.publicBasePath === "/" ? "" : config.publicBasePath;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sub2API 签到管理</title>
    <link rel="stylesheet" href="${base}/admin.css" />
    <script>window.__CHECKIN_BASE_PATH__ = ${JSON.stringify(config.publicBasePath)};</script>
    <script type="module" src="${base}/admin.js"></script>
  </head>
  <body>
    <main class="admin-shell">
      <section class="page-head hero">
        <div>
          <p class="eyebrow">Check-in Admin</p>
          <h1>签到奖励配置</h1>
          <p class="summary">支持 New API 风格的区间随机，也可以继续使用多档位权重抽奖。</p>
        </div>
      </section>

      <section class="panel login-panel" id="loginPanel">
        <label for="passwordInput">管理密码</label>
        <div class="login-row">
          <input id="passwordInput" type="password" autocomplete="current-password" placeholder="CHECKIN_ADMIN_PASSWORD" />
          <button id="loginButton" type="button">进入</button>
        </div>
        <p class="hint">管理端只使用独立密码，不会暴露 Sub2API Admin API Key。</p>
      </section>
      <p class="message global-message" id="message"></p>

      <nav class="admin-tabs" id="adminTabs" aria-label="管理端导航" hidden>
        <button class="tab-button" type="button" data-tab="overview">总览</button>
        <button class="tab-button" type="button" data-tab="leaderboard">排行榜</button>
        <button class="tab-button" type="button" data-tab="rewards">奖励规则</button>
        <button class="tab-button" type="button" data-tab="records">签到记录</button>
        <button class="tab-button" type="button" data-tab="system">系统信息</button>
      </nav>

      <section class="tab-page" id="overviewPanel" data-panel="overview" hidden>
        <section class="panel stats-panel" id="statsPanel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Analytics</p>
              <h2>签到总览</h2>
            </div>
            <span class="panel-note" id="statsDateText">-</span>
          </div>
          <div class="stats-grid">
            <article>
              <span>今日签到人数</span>
              <strong id="todayCountText">-</strong>
            </article>
            <article>
              <span>今日发放总额</span>
              <strong id="todayAmountText">-</strong>
            </article>
            <article>
              <span>本月签到人数</span>
              <strong id="monthUsersText">-</strong>
            </article>
            <article>
              <span>本月发放总额</span>
              <strong id="monthAmountText">-</strong>
            </article>
            <article>
              <span>累计签到次数</span>
              <strong id="allTimeCountText">-</strong>
            </article>
            <article>
              <span>累计发放总额</span>
              <strong id="allTimeAmountText">-</strong>
            </article>
            <article>
              <span>累计签到用户</span>
              <strong id="allTimeUsersText">-</strong>
            </article>
            <article>
              <span>平均单次奖励</span>
              <strong id="averageRewardText">-</strong>
            </article>
          </div>
        </section>

        <section class="dashboard-grid">
          <article class="panel">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Trend</p>
                <h2>近 14 天趋势</h2>
              </div>
            </div>
            <div class="trend-list" id="trendList"></div>
          </article>

          <article class="panel">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Rewards</p>
                <h2>本月奖励分布</h2>
              </div>
            </div>
            <div class="breakdown-list" id="rewardBreakdownList"></div>
          </article>
        </section>
      </section>

      <section class="tab-page" id="leaderboardPanel" data-panel="leaderboard" hidden>
        <section class="panel streak-panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Leaderboard</p>
              <h2>连续签到榜</h2>
            </div>
            <span class="panel-note">最后签到在今天或昨天的用户</span>
          </div>
          <p class="hint leaderboard-hint">按当前连续签到天数排序，用于观察高活跃用户。断签用户不会进入这个榜单。</p>
          <div class="streak-list" id="streakList"></div>
        </section>
      </section>

      <section class="panel config-panel tab-page" id="configPanel" data-panel="rewards" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Reward Mode</p>
            <h2>奖励模式</h2>
          </div>
        </div>

        <div class="meta-grid">
          <div>
            <span>单位</span>
            <strong id="unitText">-</strong>
          </div>
          <div>
            <span>时区</span>
            <strong id="timezoneText">-</strong>
          </div>
          <div>
            <span>当前模式</span>
            <strong id="modeText">-</strong>
          </div>
        </div>

        <form id="rulesForm">
          <div class="mode-switch" role="radiogroup" aria-label="奖励模式">
            <label class="mode-card">
              <input class="mode-input" name="rewardMode" type="radio" value="range_random" />
              <span>New API 区间随机</span>
              <small>设置最小/最大金额，按步长等概率抽取一个金额。</small>
            </label>
            <label class="mode-card">
              <input class="mode-input" name="rewardMode" type="radio" value="weighted_random" />
              <span>权重档位随机</span>
              <small>每个金额档位有独立权重，适合做大额低概率奖励。</small>
            </label>
          </div>

          <section class="reward-section" id="rangeSection">
            <div class="section-head">
              <div>
                <p class="eyebrow">Range</p>
                <h2>区间随机</h2>
              </div>
              <p class="hint">仿 New API：在最小金额和最大金额之间抽取。因为这里是 USD 小数，增加了步长来避免浮点随机误差。</p>
            </div>
            <div class="range-grid">
              <label>
                <span>最小金额</span>
                <input id="rangeMinInput" type="number" min="0" step="0.000001" placeholder="0.1" />
              </label>
              <label>
                <span>最大金额</span>
                <input id="rangeMaxInput" type="number" min="0" step="0.000001" placeholder="2" />
              </label>
              <label>
                <span>随机步长</span>
                <input id="rangeStepInput" type="number" min="0" step="0.000001" placeholder="0.1" />
              </label>
            </div>
            <p class="hint range-preview" id="rangePreview"></p>
          </section>

          <section class="reward-section" id="weightedSection">
            <div class="section-head with-action">
              <div>
                <p class="eyebrow">Weighted Rules</p>
                <h2>权重档位</h2>
              </div>
              <button id="addRuleButton" type="button">新增档位</button>
            </div>
            <p class="hint">概率 = 当前档位权重 / 所有启用档位权重总和。</p>
            <div class="rules" id="rules"></div>
          </section>

          <label class="note-prefix-field" for="notePrefixInput">
            <span>余额备注前缀</span>
            <input id="notePrefixInput" type="text" maxlength="120" placeholder="Daily check-in" />
            <small>签到成功后写入 Sub2API 余额调整备注，例如：Daily check-in 2026-05-31 0.1 USD。</small>
          </label>

          <div class="actions">
            <button class="secondary" id="reloadButton" type="button">重新加载</button>
            <button class="primary" type="submit">保存配置</button>
          </div>
        </form>
      </section>

      <section class="panel history-panel tab-page" id="historyPanel" data-panel="records" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Recent</p>
            <h2>最近签到</h2>
          </div>
          <span class="panel-note" id="historyMetaText">-</span>
        </div>
        <div class="toolbar">
          <input id="recordSearchInput" type="search" placeholder="搜索用户、日期、奖励名称" />
          <button class="secondary" id="clearSearchButton" type="button">清空</button>
          <button class="secondary" id="exportCsvButton" type="button">导出 CSV</button>
        </div>
        <div class="history" id="history"></div>
      </section>

      <section class="tab-page" id="systemPanel" data-panel="system" hidden>
        <section class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Runtime</p>
              <h2>系统信息</h2>
            </div>
          </div>
          <div class="system-grid" id="systemGrid"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Checklist</p>
              <h2>部署检查</h2>
            </div>
          </div>
          <div class="checklist" id="checklist"></div>
        </section>
      </section>
    </main>
  </body>
</html>`;
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function readIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function readFloatEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) ? value : fallback;
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function ensureLeadingSlash(value) {
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeBasePath(value) {
  const pathValue = ensureLeadingSlash(value || "/").replace(/\/+$/, "");
  return pathValue || "/";
}

function asBearerToken(value) {
  return value.toLowerCase().startsWith("bearer ") ? value : `Bearer ${value}`;
}

function parseCookieHeader(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) {
          return [part, ""];
        }

        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function dateKey(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function monthKey(date, timezone) {
  return dateKey(date, timezone).slice(0, 7);
}
