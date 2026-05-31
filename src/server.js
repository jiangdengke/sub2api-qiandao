import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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
    const rewardRules = getRewardRules();
    const rewardSummary = summarizeRewardRules(rewardRules);

    sendJson(res, 200, {
      ok: true,
      basePath: config.publicBasePath,
      amount: rewardSummary.min,
      unit: config.checkinUnit,
      timezone: config.checkinTimezone,
      rewardSummary,
      tokenStorageKeys: config.publicTokenStorageKeys
    });
    return;
  }

  if (method === "GET" && routePath === "/api/admin/config") {
    requireAdmin(req);
    const rewardRules = getRewardRules();

    sendJson(res, 200, {
      ok: true,
      unit: config.checkinUnit,
      timezone: config.checkinTimezone,
      rewardRules,
      rewardSummary: summarizeRewardRules(rewardRules),
      recentEntries: getRecentEntries(30).map(publicAdminEntry)
    });
    return;
  }

  if (method === "PUT" && routePath === "/api/admin/config") {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const rewardRules = validateRewardRules(body?.rewardRules);

    saveRewardRules(rewardRules);

    logInfo("admin.reward_rules.updated", {
      count: rewardRules.length,
      enabledCount: rewardRules.filter((rule) => rule.enabled).length
    });

    sendJson(res, 200, {
      ok: true,
      rewardRules,
      rewardSummary: summarizeRewardRules(rewardRules)
    });
    return;
  }

  if (method === "GET" && routePath === "/api/me") {
    const user = await resolveCurrentUser(req);
    const date = dateKey(new Date(), config.checkinTimezone);
    const entry = findEntry(user.id, date);

    sendJson(res, 200, {
      ok: true,
      user: publicUser(user),
      date,
      checkedIn: Boolean(entry),
      entry: entry ? publicEntry(entry) : null
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

    const reward = pickReward(getRewardRules());
    const note = `${config.checkinNotePrefix} ${date} ${reward.amount} ${config.checkinUnit}`;
    const upstream = await addUserBalance(user.id, reward.amount, note);
    const entry = {
      id: `${date}:${user.id}`,
      userId: String(user.id),
      userName: user.name || "",
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

  const user = extractUser(upstream.body);

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

  await migrateLegacyJsonIfNeeded();
  seedRewardRulesIfNeeded();

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

function countRows(tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
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

function saveRewardRules(rewardRules) {
  db.exec("BEGIN");

  try {
    replaceRewardRules(rewardRules);
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

function insertCheckin(entry) {
  db.prepare(
    `INSERT INTO checkins (
      id,
      user_id,
      user_name,
      date,
      amount,
      unit,
      reward_rule_id,
      reward_label,
      reward_weight,
      note,
      created_at,
      upstream_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.id,
    String(entry.userId),
    entry.userName || "",
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

function getRecentEntries(limit) {
  return db
    .prepare(
      `SELECT
        id,
        user_id AS userId,
        user_name AS userName,
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

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, String(value), new Date().toISOString());
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
    date: entry.date,
    amount: entry.amount,
    unit: entry.unit,
    rewardLabel: entry.rewardLabel || "",
    createdAt: entry.createdAt,
    upstreamStatus: entry.upstreamStatus || null
  };
}

function publicUser(user) {
  return {
    id: String(user.id),
    name: user.name || "",
    email: user.email || "",
    balance: user.balance ?? null
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

function pickReward(rules) {
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

function summarizeRewardRules(rules) {
  const enabledRules = rules.filter((rule) => rule.enabled && rule.weight > 0);
  const amounts = enabledRules.map((rule) => rule.amount);
  const totalWeight = totalEnabledWeight(enabledRules);

  return {
    mode: enabledRules.length > 1 ? "weighted_random" : "fixed",
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

    const id = candidate.id ?? candidate.user_id ?? candidate.userId ?? candidate.uuid;

    if (id === undefined || id === null || id === "") {
      continue;
    }

    return {
      id,
      name: candidate.username ?? candidate.name ?? candidate.displayName ?? candidate.email ?? "",
      email: candidate.email ?? "",
      balance: candidate.balance ?? candidate.quota ?? candidate.credit ?? null
    };
  }

  return null;
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
      <section class="hero-card" aria-live="polite">
        <div class="orb orb-a"></div>
        <div class="orb orb-b"></div>
        <p class="eyebrow">Sub2API Check-in</p>
        <h1>每日签到</h1>
        <p class="summary" id="summary">正在读取当前登录用户...</p>

        <div class="identity" id="identity" hidden>
          <span class="identity-label">当前账号</span>
          <strong id="userName">-</strong>
        </div>

        <div class="reward">
          <span class="reward-label">今日奖励</span>
          <strong id="rewardAmount">-</strong>
        </div>

        <button class="checkin-button" id="checkinButton" type="button" disabled>
          立即签到
        </button>

        <p class="message" id="message"></p>
        <p class="hint" id="hint"></p>
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
      <section class="panel hero">
        <p class="eyebrow">Check-in Admin</p>
        <h1>签到奖励配置</h1>
        <p class="summary">配置多个金额档位和权重。用户每日签到时按权重随机获得其中一个档位。</p>
      </section>

      <section class="panel login-panel" id="loginPanel">
        <label for="passwordInput">管理密码</label>
        <div class="login-row">
          <input id="passwordInput" type="password" autocomplete="current-password" placeholder="CHECKIN_ADMIN_PASSWORD" />
          <button id="loginButton" type="button">进入</button>
        </div>
        <p class="hint">管理端只使用独立密码，不会暴露 Sub2API Admin API Key。</p>
      </section>

      <section class="panel config-panel" id="configPanel" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Reward Rules</p>
            <h2>奖励档位</h2>
          </div>
          <button id="addRuleButton" type="button">新增档位</button>
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
          <div class="rules" id="rules"></div>
          <div class="actions">
            <button class="secondary" id="reloadButton" type="button">重新加载</button>
            <button class="primary" type="submit">保存配置</button>
          </div>
        </form>
        <p class="message" id="message"></p>
      </section>

      <section class="panel history-panel" id="historyPanel" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Recent</p>
            <h2>最近签到</h2>
          </div>
        </div>
        <div class="history" id="history"></div>
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
