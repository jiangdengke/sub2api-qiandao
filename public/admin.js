const state = {
  password: sessionStorage.getItem("checkinAdminPassword") || "",
  config: null
};

const elements = {
  loginPanel: document.querySelector("#loginPanel"),
  configPanel: document.querySelector("#configPanel"),
  historyPanel: document.querySelector("#historyPanel"),
  passwordInput: document.querySelector("#passwordInput"),
  loginButton: document.querySelector("#loginButton"),
  unitText: document.querySelector("#unitText"),
  timezoneText: document.querySelector("#timezoneText"),
  modeText: document.querySelector("#modeText"),
  rules: document.querySelector("#rules"),
  rulesForm: document.querySelector("#rulesForm"),
  addRuleButton: document.querySelector("#addRuleButton"),
  reloadButton: document.querySelector("#reloadButton"),
  message: document.querySelector("#message"),
  history: document.querySelector("#history")
};

boot();

function boot() {
  elements.passwordInput.value = state.password;
  elements.loginButton.addEventListener("click", () => void login());
  elements.passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void login();
    }
  });
  elements.addRuleButton.addEventListener("click", () => {
    addRuleRow({
      id: `rule-${Date.now()}`,
      label: "随机奖励",
      amount: 0.1,
      weight: 10,
      enabled: true
    });
    updateProbabilities();
  });
  elements.reloadButton.addEventListener("click", () => void loadConfig());
  elements.rulesForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveConfig();
  });

  if (state.password) {
    void loadConfig();
  }
}

async function login() {
  state.password = elements.passwordInput.value.trim();
  sessionStorage.setItem("checkinAdminPassword", state.password);
  await loadConfig();
}

async function loadConfig() {
  try {
    const data = await adminFetch("/api/admin/config");
    state.config = data;
    renderConfig(data);
    showMessage("配置已加载。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function saveConfig() {
  try {
    const rewardRules = readRules();
    const data = await adminFetch("/api/admin/config", {
      method: "PUT",
      body: {
        rewardRules
      }
    });
    state.config = {
      ...state.config,
      rewardRules: data.rewardRules,
      rewardSummary: data.rewardSummary
    };
    renderRules(data.rewardRules);
    renderSummary(state.config);
    showMessage("奖励配置已保存，新签到会立即使用。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function adminFetch(path, options = {}) {
  const basePath = window.__CHECKIN_BASE_PATH__ === "/" ? "" : window.__CHECKIN_BASE_PATH__;
  const response = await fetch(`${basePath}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Checkin-Admin-Password": state.password
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || "请求失败");
  }

  return payload;
}

function renderConfig(data) {
  elements.loginPanel.hidden = true;
  elements.configPanel.hidden = false;
  elements.historyPanel.hidden = false;
  renderSummary(data);
  renderRules(data.rewardRules);
  renderHistory(data.recentEntries || []);
}

function renderSummary(data) {
  elements.unitText.textContent = data.unit;
  elements.timezoneText.textContent = data.timezone;
  elements.modeText.textContent = data.rewardSummary?.mode === "weighted_random" ? "随机权重" : "固定奖励";
}

function renderRules(rules) {
  elements.rules.textContent = "";

  for (const rule of rules) {
    addRuleRow(rule);
  }

  updateProbabilities();
}

function addRuleRow(rule) {
  const row = document.createElement("article");
  row.className = "rule-row";
  row.innerHTML = `
    <label>
      <span>启用</span>
      <input class="rule-enabled" type="checkbox" ${rule.enabled ? "checked" : ""} />
    </label>
    <label>
      <span>名称</span>
      <input class="rule-label" type="text" value="${escapeAttr(rule.label)}" placeholder="小奖" />
    </label>
    <label>
      <span>金额</span>
      <input class="rule-amount" type="number" min="0" step="0.000001" value="${rule.amount}" />
    </label>
    <label>
      <span>权重</span>
      <input class="rule-weight" type="number" min="0" step="0.000001" value="${rule.weight}" />
    </label>
    <div class="probability">
      <span>概率</span>
      <strong class="rule-probability">-</strong>
    </div>
    <button class="remove-rule" type="button">删除</button>
  `;
  row.dataset.ruleId = rule.id;
  row.querySelector(".remove-rule").addEventListener("click", () => {
    row.remove();
    updateProbabilities();
  });

  for (const input of row.querySelectorAll("input")) {
    input.addEventListener("input", updateProbabilities);
    input.addEventListener("change", updateProbabilities);
  }

  elements.rules.append(row);
}

function readRules() {
  return [...elements.rules.querySelectorAll(".rule-row")].map((row, index) => ({
    id: row.dataset.ruleId || `rule-${index + 1}`,
    label: row.querySelector(".rule-label").value.trim() || `档位 ${index + 1}`,
    amount: Number(row.querySelector(".rule-amount").value),
    weight: Number(row.querySelector(".rule-weight").value),
    enabled: row.querySelector(".rule-enabled").checked
  }));
}

function updateProbabilities() {
  const rows = [...elements.rules.querySelectorAll(".rule-row")];
  const weights = rows.map((row) => {
    if (!row.querySelector(".rule-enabled").checked) {
      return 0;
    }

    return Number(row.querySelector(".rule-weight").value) || 0;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  rows.forEach((row, index) => {
    const probability = total > 0 ? weights[index] / total : 0;
    row.querySelector(".rule-probability").textContent = `${Math.round(probability * 1000) / 10}%`;
  });
}

function renderHistory(entries) {
  elements.history.textContent = "";

  if (entries.length === 0) {
    elements.history.innerHTML = `<p class="empty">还没有签到记录。</p>`;
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("article");
    item.className = "history-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(entry.userName || `用户 ${entry.userId}`)}</strong>
        <span>${escapeHtml(entry.date)} · ${escapeHtml(entry.rewardLabel || "奖励")}</span>
      </div>
      <b>${entry.amount} ${escapeHtml(entry.unit)}</b>
    `;
    elements.history.append(item);
  }
}

function showMessage(text, tone) {
  elements.message.textContent = text;
  elements.message.dataset.tone = tone;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
