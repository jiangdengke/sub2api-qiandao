const state = {
  config: null,
  token: null,
  checkedIn: false
};

const elements = {
  summary: document.querySelector("#summary"),
  identity: document.querySelector("#identity"),
  userName: document.querySelector("#userName"),
  rewardAmount: document.querySelector("#rewardAmount"),
  checkinButton: document.querySelector("#checkinButton"),
  message: document.querySelector("#message"),
  hint: document.querySelector("#hint")
};

boot();

async function boot() {
  elements.checkinButton.addEventListener("click", () => {
    void submitCheckin();
  });

  try {
    state.config = await apiFetch("/api/config", { skipAuth: true });
    state.token = findUserToken(state.config.tokenStorageKeys || []);
    elements.rewardAmount.textContent = `${state.config.amount} ${state.config.unit}`;
    await refreshMe();
  } catch (error) {
    showError(error);
  }
}

async function refreshMe() {
  const data = await apiFetch("/api/me");
  state.checkedIn = data.checkedIn;

  const userName = data.user.name || data.user.email || `用户 ${data.user.id}`;
  elements.userName.textContent = userName;
  elements.identity.hidden = false;

  if (data.checkedIn) {
    elements.summary.textContent = "今天已经签到，奖励已发放。";
    elements.checkinButton.textContent = "今日已签到";
    elements.checkinButton.disabled = true;
    setMessage(formatEntry(data.entry), "success");
  } else {
    elements.summary.textContent = `今天签到可获得 ${state.config.amount} ${state.config.unit}`;
    elements.checkinButton.textContent = "立即签到";
    elements.checkinButton.disabled = false;
    setMessage("每天只能领取一次，按服务端时区计算。", "neutral");
  }

  elements.hint.textContent = `结算日期：${data.date}，时区：${state.config.timezone}`;
}

async function submitCheckin() {
  elements.checkinButton.disabled = true;
  elements.checkinButton.textContent = "签到中...";
  setMessage("正在向 Sub2API 发放余额。", "neutral");

  try {
    const data = await apiFetch("/api/checkin", { method: "POST" });
    state.checkedIn = true;
    elements.summary.textContent = data.alreadyCheckedIn ? "今天已经签到，不能重复领取。" : "签到成功，奖励已发放。";
    elements.checkinButton.textContent = "今日已签到";
    elements.checkinButton.disabled = true;
    setMessage(formatEntry(data.entry), "success");
  } catch (error) {
    elements.checkinButton.disabled = false;
    elements.checkinButton.textContent = "重新签到";
    showError(error);
  }
}

async function apiFetch(path, options = {}) {
  const basePath = window.__CHECKIN_BASE_PATH__ === "/" ? "" : window.__CHECKIN_BASE_PATH__;
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };

  if (options.method && options.method !== "GET") {
    headers["Content-Type"] = "application/json";
  }

  if (!options.skipAuth && state.token) {
    headers.Authorization = asBearerToken(state.token);
  }

  const response = await fetch(`${basePath}${path}`, {
    method: options.method || "GET",
    credentials: "include",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || "请求失败");
    error.code = payload.error || "request_failed";
    error.status = response.status;
    throw error;
  }

  return payload;
}

function findUserToken(extraKeys) {
  const keys = [
    ...extraKeys,
    "token",
    "access_token",
    "auth_token",
    "sub2api_token",
    "jwt",
    "auth",
    "user"
  ];

  for (const key of new Set(keys)) {
    const raw = safeLocalStorageGet(key);
    const token = extractToken(raw);

    if (token) {
      return token;
    }
  }

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const token = extractToken(safeLocalStorageGet(key));

    if (token) {
      return token;
    }
  }

  return null;
}

function extractToken(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const direct = value.trim();
  const directJwt = direct.match(/(?:Bearer\s+)?(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/);

  if (directJwt) {
    return directJwt[1];
  }

  try {
    return extractTokenFromObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function extractTokenFromObject(value, depth = 0) {
  if (!value || depth > 5) {
    return null;
  }

  if (typeof value === "string") {
    return extractToken(value);
  }

  if (typeof value !== "object") {
    return null;
  }

  const preferredKeys = [
    "token",
    "accessToken",
    "access_token",
    "authToken",
    "jwt",
    "idToken",
    "value"
  ];

  for (const key of preferredKeys) {
    const token = extractTokenFromObject(value[key], depth + 1);

    if (token) {
      return token;
    }
  }

  for (const item of Object.values(value)) {
    const token = extractTokenFromObject(item, depth + 1);

    if (token) {
      return token;
    }
  }

  return null;
}

function safeLocalStorageGet(key) {
  try {
    return key ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function asBearerToken(value) {
  return value.toLowerCase().startsWith("bearer ") ? value : `Bearer ${value}`;
}

function formatEntry(entry) {
  if (!entry) {
    return "";
  }

  return `已领取 ${entry.amount} ${entry.unit}，发放时间 ${formatTime(entry.createdAt)}。`;
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function setMessage(text, tone) {
  elements.message.textContent = text;
  elements.message.dataset.tone = tone;
}

function showError(error) {
  elements.summary.textContent = "签到服务暂时不可用。";
  setMessage(error.message || "请求失败", "error");

  if (error.status === 401 || error.code === "missing_user_token") {
    elements.hint.textContent = "建议把签到服务反代到 Sub2API 同源路径，例如 /checkin/，这样 iframe 可以读取当前登录态。";
  } else {
    elements.hint.textContent = "请检查服务端环境变量、Sub2API 地址和管理员 API Key。";
  }
}
