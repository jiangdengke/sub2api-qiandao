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
  rewardModeInputs: [...document.querySelectorAll("input[name='rewardMode']")],
  rangeSection: document.querySelector("#rangeSection"),
  weightedSection: document.querySelector("#weightedSection"),
  rangeMinInput: document.querySelector("#rangeMinInput"),
  rangeMaxInput: document.querySelector("#rangeMaxInput"),
  rangeStepInput: document.querySelector("#rangeStepInput"),
  rangePreview: document.querySelector("#rangePreview"),
  notePrefixInput: document.querySelector("#notePrefixInput"),
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
  for (const input of elements.rewardModeInputs) {
    input.addEventListener("change", updateRewardModeUi);
  }
  for (const input of [elements.rangeMinInput, elements.rangeMaxInput, elements.rangeStepInput]) {
    input.addEventListener("input", renderRangePreview);
  }
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
    const rewardMode = readRewardMode();
    const rewardRange = readRewardRange();
    const rewardRules = readRules();
    const data = await adminFetch("/api/admin/config", {
      method: "PUT",
      body: {
        notePrefix: elements.notePrefixInput.value.trim(),
        rewardMode,
        rewardRange,
        rewardRules
      }
    });
    state.config = {
      ...state.config,
      notePrefix: data.notePrefix,
      rewardMode: data.rewardMode,
      rewardRange: data.rewardRange,
      rewardRules: data.rewardRules,
      rewardSummary: data.rewardSummary
    };
    renderRules(data.rewardRules);
    renderSummary(state.config);
    showMessage("签到规则已保存，新签到会立即使用。", "success");
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
  elements.modeText.textContent = modeLabel(data.rewardMode, data.rewardSummary);
  elements.notePrefixInput.value = data.notePrefix || "";
  setRewardMode(data.rewardMode || data.rewardSummary?.sourceMode || "range_random");
  const range = data.rewardRange || {
    min: data.rewardSummary?.min || 0.1,
    max: data.rewardSummary?.max || data.rewardSummary?.min || 0.1,
    step: data.rewardSummary?.step || 0.01
  };
  elements.rangeMinInput.value = range.min;
  elements.rangeMaxInput.value = range.max;
  elements.rangeStepInput.value = range.step;
  updateRewardModeUi();
  renderRangePreview();
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

function readRewardMode() {
  return elements.rewardModeInputs.find((input) => input.checked)?.value || "range_random";
}

function setRewardMode(mode) {
  const normalized = mode === "weighted_random" ? "weighted_random" : "range_random";

  for (const input of elements.rewardModeInputs) {
    input.checked = input.value === normalized;
  }
}

function readRewardRange() {
  return {
    min: Number(elements.rangeMinInput.value),
    max: Number(elements.rangeMaxInput.value),
    step: Number(elements.rangeStepInput.value)
  };
}

function updateRewardModeUi() {
  const mode = readRewardMode();
  elements.rangeSection.hidden = mode !== "range_random";
  elements.weightedSection.hidden = mode !== "weighted_random";
  document.body.dataset.rewardMode = mode;
}

function renderRangePreview() {
  const range = readRewardRange();
  const unit = state.config?.unit || "";

  if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || !Number.isFinite(range.step)) {
    elements.rangePreview.textContent = "请输入完整的最小金额、最大金额和步长。";
    return;
  }

  if (range.min <= 0 || range.max <= 0 || range.step <= 0 || range.max < range.min) {
    elements.rangePreview.textContent = "金额和步长必须大于 0，且最大金额不能小于最小金额。";
    return;
  }

  const stepsFloat = (range.max - range.min) / range.step;
  const steps = Math.round(stepsFloat);

  if (Math.abs(stepsFloat - steps) > 1e-8) {
    elements.rangePreview.textContent = "最大金额减最小金额需要能被步长整除。";
    return;
  }

  const count = steps + 1;

  elements.rangePreview.textContent = `会从 ${formatAmount(range.min)} 到 ${formatAmount(range.max)} ${unit} 中等概率抽取，步长 ${formatAmount(range.step)}，共 ${count} 个可能值。`;
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

function modeLabel(mode, summary) {
  if (mode === "weighted_random") {
    return summary?.mode === "fixed" ? "固定档位" : "权重随机";
  }

  return summary?.mode === "fixed" ? "固定金额" : "区间随机";
}

function formatAmount(value) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 6
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
    const userName = entry.userDisplayName || entry.userName || entry.userEmail || `用户 ${entry.userId}`;
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(userName)}</strong>
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
