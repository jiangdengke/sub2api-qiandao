const state = {
  config: null,
  token: null,
  checkedIn: false,
  currentDate: new Date(),
  currentMonth: toMonthKey(new Date()),
  today: ""
};

const elements = {
  summary: document.querySelector("#summary"),
  identity: document.querySelector("#identity"),
  userName: document.querySelector("#userName"),
  rewardAmount: document.querySelector("#rewardAmount"),
  monthTotal: document.querySelector("#monthTotal"),
  checkinButton: document.querySelector("#checkinButton"),
  message: document.querySelector("#message"),
  hint: document.querySelector("#hint"),
  calendarTitle: document.querySelector("#calendarTitle"),
  calendarGrid: document.querySelector("#calendarGrid"),
  historyList: document.querySelector("#historyList"),
  prevMonthButton: document.querySelector("#prevMonthButton"),
  currentMonthButton: document.querySelector("#currentMonthButton"),
  nextMonthButton: document.querySelector("#nextMonthButton")
};

boot();

async function boot() {
  elements.checkinButton.addEventListener("click", () => {
    void submitCheckin();
  });
  elements.prevMonthButton.addEventListener("click", () => {
    state.currentMonth = shiftMonth(state.currentMonth, -1);
    void refreshCalendar();
  });
  elements.currentMonthButton.addEventListener("click", () => {
    state.currentMonth = toMonthKey(new Date());
    void refreshCalendar();
  });
  elements.nextMonthButton.addEventListener("click", () => {
    state.currentMonth = shiftMonth(state.currentMonth, 1);
    void refreshCalendar();
  });

  try {
    state.config = await apiFetch("/api/config", { skipAuth: true });
    state.token = findUserToken(state.config.tokenStorageKeys || []);
    elements.rewardAmount.textContent = formatRewardSummary(state.config.rewardSummary, state.config.unit);
    await refreshMe();
    await refreshCalendar();
  } catch (error) {
    showError(error);
  }
}

async function refreshMe() {
  const data = await apiFetch("/api/me");
  state.checkedIn = data.checkedIn;
  state.today = data.date;
  state.currentMonth = data.date.slice(0, 7);

  const userName = data.user.name || data.user.email || `用户 ${data.user.id}`;
  elements.userName.textContent = userName;
  elements.identity.hidden = false;

  if (data.checkedIn) {
    elements.summary.textContent = "今日已签到，奖励已发放。";
    elements.checkinButton.textContent = "今日已签到";
    elements.checkinButton.disabled = true;
    setMessage(formatEntry(data.entry), "success");
  } else {
    elements.summary.textContent = rewardSummaryText(state.config.rewardSummary, state.config.unit);
    elements.checkinButton.textContent = "立即签到";
    elements.checkinButton.disabled = false;
    setMessage("每天只能领取一次，按服务端时区计算。", "neutral");
  }

  elements.hint.textContent = `结算日期：${data.date}，时区：${state.config.timezone}`;
}

async function refreshCalendar() {
  const data = await apiFetch(`/api/calendar?month=${encodeURIComponent(state.currentMonth)}`);
  renderCalendar(data.month, data.entries);
  renderHistory(data.entries, data.unit);
  elements.monthTotal.textContent = `${formatAmount(data.totalAmount)} ${data.unit}`;
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
    await refreshCalendar();
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

function renderCalendar(month, entries) {
  const entryMap = new Map(entries.map((entry) => [entry.date, entry]));
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(year, monthNumber - 1, 1);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const leadingBlanks = (firstDay.getDay() + 6) % 7;
  const cells = [];

  for (let index = 0; index < leadingBlanks; index += 1) {
    cells.push({ blank: true });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    cells.push({
      day,
      date,
      entry: entryMap.get(date)
    });
  }

  elements.calendarTitle.textContent = `${year} 年 ${String(monthNumber).padStart(2, "0")} 月签到`;
  elements.calendarGrid.textContent = "";

  for (const cell of cells) {
    const item = document.createElement("div");

    if (cell.blank) {
      item.className = "calendar-day is-blank";
      elements.calendarGrid.append(item);
      continue;
    }

    item.className = "calendar-day";

    if (cell.date === state.today) {
      item.classList.add("is-today");
    }

    if (cell.entry) {
      item.classList.add("is-checked");
    }

    item.innerHTML = `
      <span class="day-number">${cell.day}</span>
      ${cell.entry ? `<strong>${formatAmount(cell.entry.amount)} ${escapeHtml(cell.entry.unit)}</strong>` : ""}
    `;
    elements.calendarGrid.append(item);
  }
}

function renderHistory(entries, unit) {
  elements.historyList.textContent = "";

  if (entries.length === 0) {
    elements.historyList.innerHTML = `<p class="empty">本月还没有签到记录。</p>`;
    return;
  }

  for (const entry of [...entries].reverse()) {
    const item = document.createElement("article");
    item.className = "history-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(entry.date)}</strong>
        <span>${escapeHtml(entry.rewardLabel || "签到奖励")}</span>
      </div>
      <b>${formatAmount(entry.amount)} ${escapeHtml(entry.unit || unit)}</b>
    `;
    elements.historyList.append(item);
  }
}

function findUserToken(extraKeys) {
  const urlToken = new URLSearchParams(window.location.search).get("token");

  if (urlToken) {
    return urlToken;
  }

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

  const label = entry.rewardLabel ? `（${entry.rewardLabel}）` : "";
  return `已领取 ${formatAmount(entry.amount)} ${entry.unit}${label}，发放时间 ${formatTime(entry.createdAt)}。`;
}

function formatRewardSummary(summary, unit) {
  if (!summary) {
    return `- ${unit}`;
  }

  if (summary.min !== summary.max) {
    return `${formatAmount(summary.min)} - ${formatAmount(summary.max)} ${unit}`;
  }

  return `${formatAmount(summary.min)} ${unit}`;
}

function rewardSummaryText(summary, unit) {
  if (!summary || summary.mode === "fixed") {
    return `今天签到可获得 ${formatRewardSummary(summary, unit)}`;
  }

  if (summary.mode === "range_random") {
    return `今天签到随机获得 ${formatRewardSummary(summary, unit)}，按 ${formatAmount(summary.step)} ${unit} 为步长等概率抽取。`;
  }

  const odds = summary.rules
    .map((rule) => `${formatAmount(rule.amount)}${unit} ${Math.round(rule.probability * 1000) / 10}%`)
    .join(" / ");

  return `今天签到随机获得 ${formatRewardSummary(summary, unit)}，概率：${odds}`;
}

function formatAmount(value) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 6
  });
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

function toMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 1 + delta, 1);
  return toMonthKey(date);
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
