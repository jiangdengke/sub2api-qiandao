import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  checkinUnit: process.env.CHECKIN_UNIT || "USD",
  checkinTimezone: process.env.CHECKIN_TIMEZONE || "Asia/Shanghai",
  checkinNotePrefix: process.env.CHECKIN_NOTE_PREFIX || "Daily check-in",
  dataFile: path.resolve(rootDir, process.env.DATA_FILE || "./data/checkins.json"),
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
  ["/styles.css", { file: path.join(rootDir, "public", "styles.css"), type: "text/css; charset=utf-8" }]
]);

let storeLock = Promise.resolve();

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

server.listen(config.port, () => {
  logInfo("service.started", {
    port: config.port,
    publicBasePath: config.publicBasePath,
    sub2apiBaseUrl: config.sub2apiBaseUrl,
    checkinAmount: config.checkinAmount,
    checkinUnit: config.checkinUnit,
    timezone: config.checkinTimezone
  });

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
    sendJson(res, 200, {
      ok: true,
      basePath: config.publicBasePath,
      amount: config.checkinAmount,
      unit: config.checkinUnit,
      timezone: config.checkinTimezone,
      tokenStorageKeys: config.publicTokenStorageKeys
    });
    return;
  }

  if (method === "GET" && routePath === "/api/me") {
    const user = await resolveCurrentUser(req);
    const date = dateKey(new Date(), config.checkinTimezone);
    const store = await loadStore();
    const entry = findEntry(store, user.id, date);

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

  sendJson(res, 404, { ok: false, error: "not_found" });
}

async function checkIn(user) {
  return withStoreLock(async () => {
    const date = dateKey(new Date(), config.checkinTimezone);
    const store = await loadStore();
    const existing = findEntry(store, user.id, date);

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

    const note = `${config.checkinNotePrefix} ${date}`;
    const upstream = await addUserBalance(user.id, config.checkinAmount, note);
    const entry = {
      id: `${date}:${user.id}`,
      userId: String(user.id),
      userName: user.name || "",
      date,
      amount: config.checkinAmount,
      unit: config.checkinUnit,
      note,
      createdAt: new Date().toISOString(),
      upstreamStatus: upstream.status
    };

    store.entries.push(entry);
    await saveStore(store);

    logInfo("checkin.success", {
      user: logUser(user),
      date,
      amount: entry.amount,
      unit: entry.unit,
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

async function loadStore() {
  try {
    const raw = await readFile(config.dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, entries: [] };
    }

    throw error;
  }
}

async function saveStore(store) {
  await mkdir(path.dirname(config.dataFile), { recursive: true });
  const tmpFile = `${config.dataFile}.${process.pid}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmpFile, config.dataFile);
}

function withStoreLock(task) {
  const next = storeLock.then(task, task);
  storeLock = next.catch(() => {});
  return next;
}

function findEntry(store, userId, date) {
  return store.entries.find((entry) => entry.userId === String(userId) && entry.date === date);
}

function publicEntry(entry) {
  return {
    date: entry.date,
    amount: entry.amount,
    unit: entry.unit,
    note: entry.note,
    createdAt: entry.createdAt
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
