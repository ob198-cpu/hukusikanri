const STORAGE_KEY = "welfare_users_static_v2";
const LEGACY_STORAGE_KEYS = ["welfare_users_v1", "welfare_users_static_v1"];
const DATED_BACKUP_PREFIX = "welfare_users_backup_";
const GOOGLE_SHEET_ENDPOINT_KEY = "welfare_google_sheet_endpoint_v1";
const GOOGLE_SHEET_PENDING_KEY = "welfare_google_sheet_pending_v1";
const GOOGLE_SHEET_LAST_SYNC_KEY = "welfare_google_sheet_last_sync_v1";
const GOOGLE_SHEET_REVISION_KEY = "welfare_google_sheet_revision_v1";
const GOOGLE_SHEET_CLIENT_ID_KEY = "welfare_google_sheet_client_id_v1";
const ACCESS_PASSWORD_SESSION_KEY = "welfare_access_password_session_v1";
const DEFAULT_GOOGLE_SHEET_ENDPOINT = "https://script.google.com/macros/s/AKfycbw4F3TJMF481WLZTN6RMgeRSSap0n-qT_2Pcn5TGoXmL46MtE4Suh_0Onz1LPgfSMjxTw/exec";
const TARGET_SPREADSHEET_ID = "1DNvKBKSmnKg7eU0T7T_46Qz5ib1phGFzG8yxdPQCUyw";
const WARN_DAYS = 60;
const URGENT_DAYS = 30;
const HISTORY_LIMIT = 10000;
const STORAGE_WARNING_BYTES = 4 * 1024 * 1024;
const BACKUP_REMINDER_DAYS = 7;
const SINGLE_SERVICE_TARGETS = ["training1", "training2"];
let pendingImport = null;
let cloudRefreshTimer = null;
let cloudSaveChain = Promise.resolve();
let applicationStarted = false;
const RENEWAL_STEPS = [
  { key: "document", formKey: "document", label: "書類作成", short: "書類作成" },
  { key: "send", formKey: "send", label: "役所送付", short: "役所送付", legacyKey: "apply" },
  { key: "confirm", formKey: "confirm", label: "本人受給者交付確認", short: "本人確認" },
  { key: "pdf", formKey: "pdf", label: "受給者証の写し保存", short: "写し保存" },
  { key: "updateInfo", formKey: "update", label: "個人シートの更新", short: "シート更新" }
];

const MONITORING_FIELD_LABELS = {
  visited: "モニタリング実施",
  recordDone: "モニタリング記録",
  meetingDone: "担当者会議録",
  reportDone: "モニタリング報告書",
  mailed: "利用者へ郵送",
  returned: "署名返送",
  officeSent: "役所へ写し送付",
  addOn: "加算対象",
  billingDone: "給付費請求",
  billingSent: "請求情報送信",
  noticeCreated: "代理受領通知書作成",
  noticeSent: "代理受領通知送付"
};

const ERA_OPTIONS = [
  { label: "令和", value: "reiwa", start: 2019, end: 9999 },
  { label: "平成", value: "heisei", start: 1989, end: 2019 },
  { label: "昭和", value: "showa", start: 1926, end: 1989 },
  { label: "大正", value: "taisho", start: 1912, end: 1926 }
];

const MUNICIPALITY_OPTIONS = [
  { label: "札幌市（児）", ward: "児", code: "011008" },
  { label: "札幌市中央区", ward: "中央区", code: "011015" },
  { label: "札幌市北区", ward: "北区", code: "011023" },
  { label: "札幌市東区", ward: "東区", code: "011031" },
  { label: "札幌市白石区", ward: "白石区", code: "011049" },
  { label: "札幌市豊平区", ward: "豊平区", code: "011056" },
  { label: "札幌市南区", ward: "南区", code: "011064" },
  { label: "札幌市西区", ward: "西区", code: "011072" },
  { label: "札幌市厚別区", ward: "厚別区", code: "011080" },
  { label: "札幌市手稲区", ward: "手稲区", code: "011098" },
  { label: "札幌市清田区", ward: "清田区", code: "011106" }
];

const SERVICE_OPTIONS = {
  training1: ["就労移行支援", "就労継続支援B型", "就労継続支援A型", "自立訓練（生活訓練）"],
  training2: ["共同生活援助"],
  care1: ["居宅介護", "重度訪問介護", "同行援護", "行動援護", "療養介護", "生活介護", "短期入所・ショートステイ", "重度障害者等包括支援", "施設入所支援"],
  care2: ["居宅介護", "重度訪問介護", "同行援護", "行動援護", "療養介護", "生活介護", "短期入所・ショートステイ", "重度障害者等包括支援", "施設入所支援"]
};

const SERVICE_LABELS = {
  training1: "訓練等給付費情報1",
  training2: "訓練等給付費情報2（共同生活援助）",
  care1: "介護給付費情報1",
  care2: "介護給付費情報2"
};

const TASK_LABELS = Object.fromEntries(RENEWAL_STEPS.map(step => [step.key, step.label]));
const USER_STATUS_LABELS = {
  active: "利用中",
  paused: "停止",
  ended: "終了",
  hidden: "非表示",
  deleted: "削除済み"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function isDashboardVisible(user) {
  if (!user || typeof user !== "object") return false;
  return (user.status || "active") === "active";
}

function isAlertEligible(user) {
  if (!user || typeof user !== "object") return false;
  return (user.status || "active") === "active";
}

function isDeletedUser(user) {
  return (user?.status || "active") === "deleted";
}

function canShowInManagement(user, includeInactive = false) {
  const status = user?.status || "active";
  if (status === "deleted" || status === "hidden") return false;
  if (status === "active") return true;
  return includeInactive && (status === "paused" || status === "ended");
}

function loadAll() {
  const current = parseUserList(localStorage.getItem(STORAGE_KEY));
  if (current.length) {
    return normalizeAndPersist(current);
  }

  const recovered = recoverStoredUsers();
  if (recovered.length) {
    alert(`保存済みデータを${recovered.length}件復元しました。`);
    return normalizeAndPersist(recovered);
  }

  return [];
}

function saveAll(users) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
  markSheetSyncPending(users);
  scheduleSheetSync();
  warnIfStorageLarge();
}

function sheetEndpoint() {
  return DEFAULT_GOOGLE_SHEET_ENDPOINT;
}

function setSheetEndpoint(url) {
  if (url.trim() !== DEFAULT_GOOGLE_SHEET_ENDPOINT) {
    throw new Error("保存先は管理者設定で固定されています。");
  }
  localStorage.setItem(GOOGLE_SHEET_ENDPOINT_KEY, DEFAULT_GOOGLE_SHEET_ENDPOINT);
}

function markSheetSyncPending(users) {
  const payload = {
    spreadsheetId: TARGET_SPREADSHEET_ID,
    users: users.map(user => normalizeUser({ ...user })),
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(GOOGLE_SHEET_PENDING_KEY, JSON.stringify(payload));
}

function pendingSheetSync() {
  try {
    return JSON.parse(localStorage.getItem(GOOGLE_SHEET_PENDING_KEY) || "null");
  } catch {
    return null;
  }
}

function scheduleSheetSync() {
  if (!sheetEndpoint()) return;
  window.clearTimeout(scheduleSheetSync.timer);
  scheduleSheetSync.timer = window.setTimeout(() => syncSheetNow(false), 600);
}

function cloudClientId() {
  let clientId = localStorage.getItem(GOOGLE_SHEET_CLIENT_ID_KEY);
  if (!clientId) {
    clientId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(GOOGLE_SHEET_CLIENT_ID_KEY, clientId);
  }
  return clientId;
}

function cloudRevision() {
  return localStorage.getItem(GOOGLE_SHEET_REVISION_KEY) || "";
}

function setCloudRevision(revision) {
  if (revision) localStorage.setItem(GOOGLE_SHEET_REVISION_KEY, String(revision));
}

async function cloudRequest(action, payload = {}, password = sessionStorage.getItem(ACCESS_PASSWORD_SESSION_KEY) || "") {
  const endpoint = sheetEndpoint();
  if (!endpoint) throw new Error("Apps Script WebアプリURLが未設定です。");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action,
      accessPassword: password,
      clientId: cloudClientId(),
      ...payload
    })
  });
  if (!response.ok) throw new Error(`サーバー応答エラー (${response.status})`);
  const result = await response.json();
  if (!result?.ok) throw new Error(result?.error || "サーバー処理に失敗しました。");
  return result;
}

function syncSheetNow(showAlert = true) {
  const run = () => performSheetSync(showAlert);
  cloudSaveChain = cloudSaveChain.then(run, run);
  return cloudSaveChain;
}

async function performSheetSync(showAlert = true) {
  const endpoint = sheetEndpoint();
  if (!endpoint) {
    if (showAlert) alert("Apps Script WebアプリURLを設定してください。");
    renderSheetSyncStatus();
    return false;
  }
  const payload = pendingSheetSync() || {
    spreadsheetId: TARGET_SPREADSHEET_ID,
    users: loadAll(),
    savedAt: new Date().toISOString()
  };
  try {
    const result = await cloudRequest("saveUsers", {
      ...payload,
      expectedRevision: cloudRevision()
    });
    setCloudRevision(result.revision);
    if (Array.isArray(result.users)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result.users.map(user => normalizeUser({ ...user }))));
      renderDashboard();
      renderPersonalSheets();
      renderMonitoringManagement();
    }
    const currentPending = pendingSheetSync();
    if (!currentPending || currentPending.savedAt === payload.savedAt) {
      localStorage.removeItem(GOOGLE_SHEET_PENDING_KEY);
    }
    const confirmedAt = result.savedAt || new Date().toISOString();
    localStorage.setItem(GOOGLE_SHEET_LAST_SYNC_KEY, confirmedAt);
    const message = result.staleClient
      ? `サーバー保存済み: ${formatDateTime(confirmedAt)} / 他PCの更新と統合しました`
      : `サーバー保存済み: ${formatDateTime(confirmedAt)}`;
    renderSheetSyncStatus(message, true);
    if (showAlert) alert(result.staleClient ? "他のPCの更新と統合し、サーバー保存を確認しました。" : "サーバーへの保存完了を確認しました。");
    if (pendingSheetSync()) scheduleSheetSync();
    return true;
  } catch (error) {
    renderSheetSyncStatus(`送信失敗: ${error.message || error}`);
    if (showAlert) alert(`Googleスプレッドシートへの送信に失敗しました: ${error.message || error}`);
    return false;
  }
}

async function requestCloudUsers() {
  try {
    const result = await cloudRequest("getUsers");
    setCloudRevision(result.revision);
    return result;
  } catch (error) {
    renderSheetSyncStatus(`読込失敗: ${error.message || error}`);
    return null;
  }
}

function changedAt(record) {
  const value = record?.changedAt || record?.completed || "";
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function mergeNamedCloudRecords(localRecords = {}, cloudRecords = {}) {
  const keys = new Set([...Object.keys(localRecords || {}), ...Object.keys(cloudRecords || {})]);
  return Object.fromEntries([...keys].map(key => {
    const local = localRecords?.[key];
    const cloud = cloudRecords?.[key];
    if (!local) return [key, cloud];
    if (!cloud) return [key, local];
    return [key, changedAt(local) >= changedAt(cloud) ? local : cloud];
  }));
}

function mergeCloudUser(localUser, cloudUser) {
  if (!localUser) return { ...cloudUser, _cloudUpdatedAt: cloudUser.updatedAt || "" };
  if (!cloudUser) return localUser;
  const localTime = Date.parse(localUser.updatedAt || 0) || 0;
  const cloudTime = Date.parse(cloudUser.updatedAt || 0) || 0;
  const newer = localTime > cloudTime ? localUser : cloudUser;
  return normalizeUser({
    ...newer,
    checks: mergeNamedCloudRecords(localUser.checks, cloudUser.checks),
    monitoringRecords: mergeNamedCloudRecords(localUser.monitoringRecords, cloudUser.monitoringRecords),
    agencyNotices: mergeNamedCloudRecords(localUser.agencyNotices, cloudUser.agencyNotices),
    deadlineCompletions: mergeNamedCloudRecords(localUser.deadlineCompletions, cloudUser.deadlineCompletions),
    history: [...(localUser.history || []), ...(cloudUser.history || [])]
      .filter((item, index, rows) => rows.findIndex(candidate => `${candidate.at}|${candidate.action}|${candidate.detail}` === `${item.at}|${item.action}|${item.detail}`) === index)
      .slice(-HISTORY_LIMIT),
    _cloudUpdatedAt: cloudUser.updatedAt || ""
  });
}

async function refreshFromCloud() {
  const payload = await requestCloudUsers();
  if (!payload || !Array.isArray(payload.users)) return false;
  const local = loadAll();
  const cloudById = new Map(payload.users.filter(user => user?.id).map(user => [user.id, user]));
  const localById = new Map(local.filter(user => user?.id).map(user => [user.id, user]));
  const ids = new Set([...cloudById.keys(), ...localById.keys()]);
  const merged = [...ids].map(id => mergeCloudUser(localById.get(id), cloudById.get(id)));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  const cloudSnapshot = JSON.stringify(payload.users.map(user => normalizeUser({ ...user })));
  if (JSON.stringify(merged) !== cloudSnapshot) {
    markSheetSyncPending(merged);
    scheduleSheetSync();
  }
  renderDashboard();
  renderPersonalSheets();
  renderMonitoringManagement();
  renderSheetSyncStatus();
  return true;
}

function renderSheetSyncStatus(message = "", isSuccess = false) {
  const endpointInput = $("#sheet-endpoint");
  if (endpointInput) endpointInput.value = sheetEndpoint();
  const status = $("#sheet-sync-status");
  if (!status) return;
  const pending = pendingSheetSync();
  const last = localStorage.getItem(GOOGLE_SHEET_LAST_SYNC_KEY);
  if (message) {
    status.textContent = message;
    status.className = `sheet-sync-status ${isSuccess ? "ok" : "warn"}`;
  } else if (!sheetEndpoint()) {
    status.textContent = "未設定: Apps Script WebアプリURLを設定すると、保存時にシートへ送信します。";
    status.className = "sheet-sync-status warn";
  } else if (pending) {
    status.textContent = `未送信データあり: ${formatDateTime(pending.savedAt)} 保存分`;
    status.className = "sheet-sync-status warn";
  } else if (last) {
    status.textContent = `サーバー保存済み: ${formatDateTime(last)}`;
    status.className = "sheet-sync-status ok";
  } else {
    status.textContent = "設定済み: 次回保存時にシートへ送信します。";
    status.className = "sheet-sync-status ok";
  }
}

function parseUserList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isUserLikeData) : [];
  } catch {
    return [];
  }
}

function recoverStoredUsers() {
  const candidates = [...LEGACY_STORAGE_KEYS, ...Object.keys(localStorage)]
    .filter((key, index, all) => key !== STORAGE_KEY && all.indexOf(key) === index);

  let best = [];
  candidates.forEach(key => {
    const users = parseUserList(localStorage.getItem(key));
    if (users.length > best.length) best = users;
  });
  return best;
}

function normalizeAndPersist(users) {
  const normalized = users.map(user => normalizeUser(user));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function isUserLikeData(value) {
  return !!value && typeof value === "object" && (
    "name" in value ||
    "recipientNo" in value ||
    "recipientEnd" in value ||
    "planEnd" in value ||
    "checks" in value
  );
}

function decodeImportPayload(payload) {
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function importUserFromUrlHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#importUser=")) return "";
  try {
    const imported = JSON.parse(decodeImportPayload(hash.slice("#importUser=".length)));
    if (!isUserLikeData(imported)) throw new Error("利用者データとして読み取れません。");
    const existing = loadAll().find(user =>
      imported.recipientNo && user.recipientNo === imported.recipientNo
    );
    const user = normalizeUser({
      ...existing,
      ...imported,
      id: existing?.id || imported.id || uid(),
      checks: existing?.checks || imported.checks || {},
      deadlineCompletions: existing?.deadlineCompletions || imported.deadlineCompletions || {},
      history: existing?.history || imported.history || []
    });
    addHistory(user, existing ? "URL取込で更新" : "URL取込で新規作成", `計画相談期限: ${formatDate(user.planEnd)}`);
    upsertUser(user);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return user.id;
  } catch (error) {
    alert(`URLからの取り込みに失敗しました: ${error.message}`);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return "";
  }
}

function uid() {
  return `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getUser(id) {
  return loadAll().find(user => user.id === id);
}

function upsertUser(user) {
  user.updatedAt = new Date().toISOString();
  const users = loadAll();
  const index = users.findIndex(item => item.id === user.id);
  if (index >= 0) users[index] = user;
  else users.push(user);
  saveAll(users);
}

function deleteUser(id) {
  updateUserStatus(id, "deleted", "削除済みに変更");
}

function updateUserStatus(id, status, action = "利用状態変更") {
  const users = loadAll();
  const index = users.findIndex(user => user.id === id);
  if (index < 0) return;
  const user = users[index];
  const previous = user.status || "active";
  user.status = status;
  if (status === "deleted") user.deletedAt = new Date().toISOString();
  if (previous === "deleted" && status !== "deleted") user.restoredAt = new Date().toISOString();
  addHistory(user, action, `${USER_STATUS_LABELS[previous] || previous} → ${USER_STATUS_LABELS[status] || status}`);
  users[index] = normalizeUser(user);
  saveAll(users);
}

function restoreUser(id) {
  updateUserStatus(id, "active", "削除済みから復元");
}

function normalizeUser(user) {
  user.checks = user.checks || {};
  user.history = Array.isArray(user.history) ? user.history.slice(-HISTORY_LIMIT) : [];
  user.status = user.status || "active";
  user.monitoringCycle = normalizeMonitoringCycle(user.monitoringCycle);
  SINGLE_SERVICE_TARGETS.forEach(key => {
    user[key] = (user[key] || []).slice(0, 1);
  });
  const legacyApply = user.checks.apply;
  if (legacyApply && !user.checks.send) {
    user.checks.send = { ...legacyApply };
  }
  RENEWAL_STEPS.forEach(step => {
    user.checks[step.key] = user.checks[step.key] || {};
  });
  RENEWAL_STEPS.forEach(({ key }) => {
    const task = user.checks[key];
    if (task?.done && !task.completedForDate) {
      task.completedForDate = taskDueDate(user, key) || "";
    }
    if (!task?.done && task?.completedForDate) {
      task.completedForDate = "";
    }
  });
  user.deadlineCompletions = user.deadlineCompletions || {};
  user.monitoringRecords = user.monitoringRecords && typeof user.monitoringRecords === "object" ? user.monitoringRecords : {};
  user.agencyNotices = user.agencyNotices && typeof user.agencyNotices === "object" ? user.agencyNotices : {};
  return user;
}

function addHistory(user, action, detail = "") {
  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    at: new Date().toISOString(),
    action,
    detail
  });
  user.history = user.history.slice(-HISTORY_LIMIT);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${formatDate(date.toISOString().slice(0, 10))} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  if (!value) return "-";
  return toJapaneseEraDate(value) || value.replaceAll("-", "/");
}

function daysUntil(value) {
  const date = parseDate(value);
  if (!date) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function renewalTargetDate(user) {
  const candidates = deadlineCandidates(user)
    .map(item => item.date)
    .filter(Boolean)
    .sort();
  return candidates[0] || "";
}

function renewalMonthLabel(user) {
  const target = parseDate(renewalTargetDate(user));
  if (!target) return "受給者証更新";
  return `${target.getMonth() + 1}月受給者証更新`;
}

function renewalAlertLabel(user) {
  const targetDate = renewalTargetDate(user);
  const days = daysUntil(targetDate);
  if (!targetDate || days === null) return "期限未設定";
  if ((user.status || "active") !== "active") return USER_STATUS_LABELS[user.status] || "対象外";
  if (isRenewalComplete(user)) return "更新完了";
  if (days < 0) return `期限超過 ${Math.abs(days)}日`;
  if (days === 0) return "本日期限";
  if (days <= URGENT_DAYS) return `期限まであと${days}日`;
  return `期限 ${formatDate(targetDate)}`;
}

function deadlineStatusText(value) {
  const days = daysUntil(value);
  if (days === null) return "期限未設定";
  if (days < 0) return `期限超過 ${Math.abs(days)}日`;
  if (days === 0) return "本日期限";
  return `期限まであと${days}日`;
}

function deadlineOverviewStatus(value, completed) {
  if (!value) return { className: "muted", badge: "未入力", text: "期限判定なし" };
  if (completed) return { className: "done", badge: "確認済", text: "確認済" };
  const days = daysUntil(value);
  if (days === null) return { className: "muted", badge: "未入力", text: "期限判定なし" };
  if (days <= URGENT_DAYS) return { className: "urgent", badge: "30日以内", text: deadlineStatusText(value) };
  if (days <= WARN_DAYS) return { className: "warn", badge: "60日以内", text: deadlineStatusText(value) };
  return { className: "ok", badge: "60日超", text: deadlineStatusText(value) };
}

function deadlineOverviewItems(user) {
  const items = [
    {
      key: "recipient",
      label: "受給者証",
      detail: "有効期間終了",
      start: user.recipientStart,
      end: user.recipientEnd || "",
      completed: false,
      note: user.recipientEnd ? "" : "終了日未入力"
    },
    {
      key: "plan",
      label: "計画相談",
      detail: "有効期間終了",
      start: user.planStart,
      end: user.planEnd,
      completed: isDeadlineCompleted(user, { key: "plan", date: user.planEnd })
    }
  ];

  ["training1", "training2", "care1", "care2"].forEach(key => {
    (user[key] || []).forEach((row, index) => {
      const completeKey = `service:${key}:${index}:${row.type || ""}:${row.start || ""}:${row.end || ""}`;
      items.push({
        key: completeKey,
        label: row.type || SERVICE_LABELS[key],
        detail: SERVICE_LABELS[key],
        start: row.start,
        end: row.end,
        completed: isDeadlineCompleted(user, { key: completeKey, date: row.end }),
        note: row.office || ""
      });
    });
  });

  return items.sort((a, b) => {
    if (!a.end && !b.end) return 0;
    if (!a.end) return 1;
    if (!b.end) return -1;
    return a.end.localeCompare(b.end);
  });
}

function isRenewalMonthActive(user) {
  if (!isAlertEligible(user)) return false;
  const target = parseDate(renewalTargetDate(user));
  if (!target) return false;
  const days = daysUntil(renewalTargetDate(user));
  return days !== null && days <= URGENT_DAYS && !isRenewalComplete(user);
}

function isRenewalStepDone(user, key) {
  const task = user.checks?.[key] || {};
  if (!task.done) return false;
  const dueDate = taskDueDate(user, key);
  return !dueDate || task.completedForDate === dueDate;
}

function isRenewalComplete(user) {
  return RENEWAL_STEPS.every(step => isRenewalStepDone(user, step.key));
}

function normalizeMonitoringCycle(value) {
  if (value === "毎月") return "1か月";
  return value || "";
}

function monitoringCycleMonths(value) {
  const normalized = normalizeMonitoringCycle(value);
  if (normalized === "半年") return 6;
  const match = normalized.match(/^([1-5])か月$/);
  return match ? Number(match[1]) : 0;
}

function toJapaneseEraParts(value) {
  const date = parseDate(value);
  if (!date) return null;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const era = ERA_OPTIONS.find(item => year >= item.start && year <= item.end);
  if (!era) return null;
  return {
    era: era.value,
    eraLabel: era.label,
    year: year - era.start + 1,
    month,
    day
  };
}

function toJapaneseEraDate(value) {
  const parts = toJapaneseEraParts(value);
  if (!parts) return "";
  const eraYear = parts.year === 1 ? "元" : `${parts.year}`;
  return `${parts.eraLabel}${eraYear}年${parts.month}月${parts.day}日`;
}

function toIsoDateFromEra(eraValue, eraYear, month, day) {
  const era = ERA_OPTIONS.find(item => item.value === eraValue);
  const yearNumber = Number(eraYear);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (!era || !yearNumber || !monthNumber || !dayNumber) return "";
  const fullYear = era.start + yearNumber - 1;
  const date = new Date(fullYear, monthNumber - 1, dayNumber);
  if (
    date.getFullYear() !== fullYear ||
    date.getMonth() + 1 !== monthNumber ||
    date.getDate() !== dayNumber
  ) {
    return "";
  }
  return `${fullYear}-${String(monthNumber).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
}

function setupJapaneseDateInputs(root = document) {
  root.querySelectorAll('input[type="date"]:not([data-era-ready])').forEach(input => {
    input.dataset.eraReady = "true";
    input.classList.add("native-date");

    const wrapper = document.createElement("div");
    wrapper.className = "wareki-date";
    wrapper.dataset.dateFor = input.id || "";
    if (input.dataset.dateLabel || input.title) {
      wrapper.classList.add("wareki-has-caption");
      wrapper.dataset.label = input.dataset.dateLabel || input.title;
    }
    wrapper.innerHTML = `
      <select class="era-select" aria-label="元号">
        ${ERA_OPTIONS.map(era => `<option value="${era.value}">${era.label}</option>`).join("")}
      </select>
      <input type="number" class="era-year" min="1" max="99" inputmode="numeric" aria-label="年">
      <span>年</span>
      <select class="era-month" aria-label="月">
        <option value=""></option>
        ${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join("")}
      </select>
      <span>月</span>
      <select class="era-day" aria-label="日">
        <option value=""></option>
        ${Array.from({ length: 31 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join("")}
      </select>
      <span>日</span>
      <button type="button" class="btn-date-clear" aria-label="日付をクリア">クリア</button>
    `;

    input.insertAdjacentElement("afterend", wrapper);
    const eraSelect = wrapper.querySelector(".era-select");
    const eraYear = wrapper.querySelector(".era-year");
    const eraMonth = wrapper.querySelector(".era-month");
    const eraDay = wrapper.querySelector(".era-day");
    const clear = wrapper.querySelector(".btn-date-clear");

    const syncFromInput = () => {
      const parts = toJapaneseEraParts(input.value);
      if (!parts) {
        eraSelect.value = "reiwa";
        eraYear.value = "";
        eraMonth.value = "";
        eraDay.value = "";
        return;
      }
      eraSelect.value = parts.era;
      eraYear.value = parts.year;
      eraMonth.value = String(parts.month);
      eraDay.value = String(parts.day);
    };

    const syncToInput = () => {
      input.value = toIsoDateFromEra(eraSelect.value, eraYear.value, eraMonth.value, eraDay.value);
    };

    [eraSelect, eraYear, eraMonth, eraDay].forEach(control => {
      control.addEventListener("input", syncToInput);
      control.addEventListener("change", syncToInput);
    });
    clear.addEventListener("click", () => {
      input.value = "";
      syncFromInput();
    });
    input.addEventListener("change", syncFromInput);
    input._syncEraFromInput = syncFromInput;
    input._syncEraToInput = syncToInput;
    syncFromInput();
  });
}

function syncJapaneseDateInputs(root = document) {
  root.querySelectorAll('input[type="date"][data-era-ready]').forEach(input => {
    if (input._syncEraFromInput) input._syncEraFromInput();
  });
}

function syncEraInputsToNative(root = document) {
  root.querySelectorAll('input[type="date"][data-era-ready]').forEach(input => {
    if (input._syncEraToInput) input._syncEraToInput();
  });
}

function readDateInput(selector, root = document) {
  const input = root.querySelector(selector);
  if (!input) return "";
  if (input._syncEraToInput) input._syncEraToInput();
  return input.value || "";
}

function showView(name) {
  $$(".view").forEach(view => view.classList.remove("active"));
  $$(".tab-btn").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  $(`#view-${name}`).classList.add("active");
  if (name === "dashboard") renderDashboard();
  if (name === "personal") renderPersonalSheets();
  if (name === "monitoring") renderMonitoringManagement();
  if (name === "backup") renderBackup();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setupWardSelect() {
  const ward = $("#ward");
  ward.innerHTML = '<option value="">選択してください</option>' +
    MUNICIPALITY_OPTIONS.map(item => `<option value="${item.code}">${item.label}（${item.code}）</option>`).join("") +
    '<option value="__custom__">その他（手入力）</option>';

  ward.addEventListener("change", () => {
    const selected = MUNICIPALITY_OPTIONS.find(item => item.code === ward.value);
    const isCustom = ward.value === "__custom__";
    $("#custom-ward-wrap").classList.toggle("hidden", !isCustom);
    if (selected) {
      $("#custom-ward").value = "";
      $("#municipal-code").value = selected.code;
    }
    if (!ward.value) {
      $("#custom-ward").value = "";
      $("#municipal-code").value = "";
    }
  });
}

function addServiceRow(target, data = {}) {
  if (SINGLE_SERVICE_TARGETS.includes(target) && $(`#${target}-rows .service-row`)) return;
  const node = $("#tpl-service-row").content.firstElementChild.cloneNode(true);
  const select = node.querySelector(".svc-type");
  select.innerHTML = '<option value="">サービス種別</option>' +
    SERVICE_OPTIONS[target].map(option => `<option>${escapeHtml(option)}</option>`).join("");
  select.value = data.type || "";
  node.querySelector(".svc-start").value = data.start || "";
  node.querySelector(".svc-end").value = data.end || "";
  node.querySelector(".svc-office").value = data.office || "";
  const level = node.querySelector(".svc-level");
  if (target === "training2") {
    level.classList.remove("hidden");
    level.value = data.level || "";
  }
  const removeButton = node.querySelector(".btn-remove");
  if (SINGLE_SERVICE_TARGETS.includes(target)) {
    removeButton.classList.add("hidden");
  } else {
    removeButton.addEventListener("click", () => node.remove());
  }
  $(`#${target}-rows`).appendChild(node);
  setupJapaneseDateInputs(node);
}

function collectServiceRows(target) {
  const rows = $$(`#${target}-rows .service-row`).map(row => ({
    type: row.querySelector(".svc-type").value,
    start: readDateInput(".svc-start", row),
    end: readDateInput(".svc-end", row),
    office: row.querySelector(".svc-office").value.trim(),
    level: target === "training2" ? row.querySelector(".svc-level").value : ""
  })).filter(row => row.type || row.start || row.end || row.office || row.level);
  return SINGLE_SERVICE_TARGETS.includes(target) ? rows.slice(0, 1) : rows;
}

function clearForm() {
  $("#user-form").reset();
  syncJapaneseDateInputs($("#user-form"));
  $("#user-id").value = "";
  $("#input-title").textContent = "入力シート";
  $("#btn-delete").style.display = "none";
  $("#custom-ward-wrap").classList.add("hidden");
  ["training1", "training2", "care1", "care2"].forEach(key => {
    $(`#${key}-rows`).innerHTML = "";
  });
  SINGLE_SERVICE_TARGETS.forEach(key => addServiceRow(key));
}

function fillForm(user) {
  clearForm();
  $("#user-id").value = user.id;
  $("#input-title").textContent = `入力シート編集: ${user.name || "(無名)"}`;
  $("#btn-delete").style.display = "";
  setValue("name", user.name);
  setValue("kana", user.kana);
  setValue("birthday", user.birthday);
  setValue("phone", user.phone);
  setValue("address", user.address);
  setValue("recipient-no", user.recipientNo);
  setValue("user-status", user.status || "active");
  setValue("municipal-code", user.municipalCode);
  setValue("disability-type", user.disabilityType);
  setValue("recipient-start", user.recipientStart);
  setValue("plan-start", user.planStart);
  setValue("plan-end", user.planEnd);
  setValue("monitoring-cycle", normalizeMonitoringCycle(user.monitoringCycle));
  setValue("payment-cap", user.paymentCap);
  setValue("note", user.note);

  const matched = MUNICIPALITY_OPTIONS.find(item => item.label === user.wardName || item.code === user.municipalCode);
  if (matched) {
    $("#ward").value = matched.code;
    $("#custom-ward-wrap").classList.add("hidden");
  } else if (user.wardName) {
    $("#ward").value = "__custom__";
    $("#custom-ward-wrap").classList.remove("hidden");
    $("#custom-ward").value = user.wardName;
  }

  SINGLE_SERVICE_TARGETS.forEach(key => {
    $(`#${key}-rows`).innerHTML = "";
    addServiceRow(key, (user[key] || [])[0] || {});
  });
  ["care1", "care2"].forEach(key => {
    (user[key] || []).forEach(row => addServiceRow(key, row));
  });

  const checks = user.checks || {};
  RENEWAL_STEPS.forEach(step => fillRenewalTaskField(user, checks, step));
}

function setValue(id, value) {
  const element = $(`#${id}`);
  if (!element) return;
  element.value = value || "";
  if (element._syncEraFromInput) element._syncEraFromInput();
}

function fillRenewalTaskField(user, checks, step) {
  const task = checks[step.key] || {};
  const checkbox = $(`#chk-${step.formKey}`);
  if (checkbox) checkbox.checked = isRenewalStepDone(user, step.key);
  setValue(`${step.formKey}-completed`, task.completed);
  setValue(`${step.formKey}-note`, task.note);
}

function collectRenewalTaskField(existing, step) {
  const existingTask = existing.checks?.[step.key] || {};
  const completed = readDateInput(`#${step.formKey}-completed`);
  const done = !!$(`#chk-${step.formKey}`)?.checked;
  return {
    done,
    due: existingTask.due || "",
    completed,
    note: $(`#${step.formKey}-note`)?.value.trim() || "",
    completedForDate: existingTask.completedForDate || ""
  };
}

function collectForm() {
  const selectedWard = MUNICIPALITY_OPTIONS.find(item => item.code === $("#ward").value);
  const customWard = $("#ward").value === "__custom__" ? $("#custom-ward").value.trim() : "";
  const id = $("#user-id").value || uid();
  const existing = getUser(id) || {};
  const user = {
    id,
    name: $("#name").value.trim(),
    kana: $("#kana").value.trim(),
    birthday: readDateInput("#birthday"),
    phone: $("#phone").value.trim(),
    address: $("#address").value.trim(),
    recipientNo: $("#recipient-no").value.trim(),
    status: $("#user-status").value || "active",
    wardName: selectedWard ? selectedWard.label : customWard,
    municipalCode: $("#municipal-code").value.trim(),
    disabilityType: $("#disability-type").value,
    recipientStart: readDateInput("#recipient-start"),
    recipientEnd: existing.recipientEnd || "",
    applicationDeadline: existing.applicationDeadline || "",
    planStart: readDateInput("#plan-start"),
    planEnd: readDateInput("#plan-end"),
    monitoringCycle: normalizeMonitoringCycle($("#monitoring-cycle").value),
    paymentCap: $("#payment-cap").value.trim(),
    training1: collectServiceRows("training1"),
    training2: collectServiceRows("training2"),
    care1: collectServiceRows("care1"),
    care2: collectServiceRows("care2"),
    checks: Object.fromEntries(RENEWAL_STEPS.map(step => [step.key, collectRenewalTaskField(existing, step)])),
    deadlineCompletions: existing.deadlineCompletions || {},
    history: existing.history || [],
    note: $("#note").value.trim(),
    updatedAt: new Date().toISOString()
  };
  return normalizeUser(user);
}

function validateCollectedUser(user) {
  const errors = [];
  const warnings = [];
  if (!user.name) errors.push("氏名は必須です。");
  validateDateRange("計画相談支援情報", user.planStart, user.planEnd, errors);
  ["training1", "training2", "care1", "care2"].forEach(key => {
    (user[key] || []).forEach((row, index) => {
      validateDateRange(`${SERVICE_LABELS[key]} ${index + 1}`, row.start, row.end, errors);
    });
  });

  if ((user.status || "active") === "active") {
    if (!user.planEnd) warnings.push("計画相談支援情報の有効期間終了が未入力です。");
    const hasServiceEnd = ["training1", "training2", "care1", "care2"].some(key =>
      (user[key] || []).some(row => row.end)
    );
    if (!hasServiceEnd) warnings.push("各サービスの終了日が1件も入力されていません。期限アラートに出ません。");
    if (!user.monitoringCycle) warnings.push("モニタリング月が未設定です。モニタリング対象月に表示されません。");
  }

  return { errors, warnings };
}

function validateDateRange(label, start, end, errors) {
  if (!start || !end) return;
  if (new Date(start).getTime() > new Date(end).getTime()) {
    errors.push(`${label}の開始日が終了日より後になっています。`);
  }
}

function confirmUserWarnings(warnings) {
  if (!warnings.length) return true;
  return confirm(`保存できますが、運用上の警告があります。\n\n- ${warnings.join("\n- ")}\n\nこのまま保存しますか？`);
}

function buildAlerts(users) {
  const recipient = [];
  const monitoring = [];
  const tasks = [];

  users.forEach(user => {
    deadlineCandidates(user).forEach(item => {
      if (isDeadlineCompleted(user, item)) return;
      const alert = deadlineAlert(user, item);
      if (alert) {
        recipient.push(alert);
        tasks.push(deadlineTaskAlert(alert));
      }
    });

    RENEWAL_STEPS.forEach(step => {
      if (shouldShowRenewalTask(user, step.key)) {
        tasks.push(taskAlert(user, step.key, taskDueDate(user, step.key)));
      }
    });

    if (isMonitoringMonth(user)) {
      monitoring.push({
        user,
        level: "warn",
        title: "当月モニタリング",
        message: `${user.monitoringCycle}の対象月です。`,
        nextAction: "モニタリング確認"
      });
    }
  });

  return {
    recipient: recipient.sort((a, b) => a.days - b.days),
    monitoring: monitoring.sort((a, b) => (a.user.name || "").localeCompare(b.user.name || "", "ja")),
    tasks: tasks.sort((a, b) => (a.days ?? 99999) - (b.days ?? 99999))
  };
}

function deadlineCandidates(user) {
  return [
    { key: "plan", title: "計画相談", date: user.planEnd, start: user.planStart },
    ...["training1", "training2", "care1", "care2"].flatMap(key =>
      (user[key] || []).map((row, index) => ({
        key: `service:${key}:${index}:${row.type || ""}:${row.start || ""}:${row.end || ""}`,
        title: `サービス期限: ${row.type || SERVICE_LABELS[key]}`,
        date: row.end,
        start: row.start,
        office: row.office
      }))
    )
  ].filter(item => item.date);
}

function isDeadlineCompleted(user, item) {
  const done = user.deadlineCompletions?.[item.key];
  return !!done && done.date === item.date;
}

function deadlineAlert(user, item) {
  const days = daysUntil(item.date);
  if (days === null || days > WARN_DAYS) return null;
  const period = `${formatDate(item.start)}から${formatDate(item.date)}まで`;
  return {
    user,
    level: days <= URGENT_DAYS ? "urgent" : "warn",
    title: item.title,
    days,
    message: days < 0
      ? `${period}。期限を${Math.abs(days)}日超過しています。`
      : `${period}。期限まで残り${days}日です。`,
    nextAction: "期限更新確認"
  };
}

function deadlineTaskAlert(alert) {
  return {
    ...alert,
    title: `期限対応: ${alert.title}`,
    message: `${alert.message} 対応が完了するまで処理タスクに残します。`,
    nextAction: alert.nextAction
  };
}

function taskAlert(user, key, date) {
  const task = user.checks?.[key] || {};
  const days = daysUntil(date);
  const isRevived = !!task.done;
  return {
    user,
    level: days !== null && days <= URGENT_DAYS ? "urgent" : "info",
    title: TASK_LABELS[key],
    days,
    message: taskMessage(date, days, task, isRevived),
    nextAction: isRevived ? "再確認" : key === "pdf" ? "写しの受領確認" : "完了処理"
  };
}

function shouldShowRenewalTask(user, key) {
  if (!isRenewalMonthActive(user)) return false;
  return !isRenewalStepDone(user, key);
}

function taskDueDate(user, key) {
  const task = user.checks?.[key] || {};
  return task.due || renewalTargetDate(user) || user.planEnd;
}

function taskMessage(date, days, task, isRevived) {
  if (!date) return "完了するまで残ります。完了後も期限30日前になったら再表示します。";
  if (isRevived) {
    return `前回対応日: ${formatDate(task.completed)}。${formatDate(date)} が近いため再表示しています。`;
  }
  const remain = days === null ? "" : days < 0 ? `期限を${Math.abs(days)}日超過しています。` : `期限まで残り${days}日です。`;
  return `${formatDate(date)} に確認。${remain} 完了後も期限30日前になったら再表示します。`;
}

function pendingTaskLabels(user) {
  return RENEWAL_STEPS
    .filter(step => !isRenewalStepDone(user, step.key))
    .map(step => step.label)
    .join("、");
}

function isMonitoringMonth(user) {
  if (!isAlertEligible(user)) return false;
  const cycleMonths = monitoringCycleMonths(user.monitoringCycle);
  if (!cycleMonths) return false;
  if (cycleMonths === 1) return true;
  const start = parseDate(user.planStart);
  if (!start) return false;
  const now = new Date();
  const diff = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth();
  if (diff < 0) return false;
  return diff % cycleMonths === 0;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function addMonthsToKey(monthKey, offset) {
  const [year, month] = (monthKey || currentMonthKey()).split("-").map(Number);
  const date = new Date(year, (month || 1) - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthKeyLabel(monthKey) {
  if (!monthKey) return "-";
  const [year, month] = monthKey.split("-");
  return `${year}年${Number(month)}月`;
}

function monthKeyShortLabel(monthKey) {
  if (!monthKey) return "-";
  return `${Number(monthKey.split("-")[1])}月`;
}

function noticeMonthKeys(startMonthKey, count = 6) {
  return Array.from({ length: count }, (_, index) => addMonthsToKey(startMonthKey, index));
}

function noticeYearFromControl() {
  const yearInput = $("#notice-start-year");
  const year = Number(yearInput?.value);
  if (year && year >= 1900 && year <= 9999) return year;
  return Number(currentMonthKey().split("-")[0]);
}

function setNoticeYear(year) {
  const safeYear = Number(year) || Number(currentMonthKey().split("-")[0]);
  const yearInput = $("#notice-start-year");
  const hidden = $("#notice-start-month");
  if (yearInput) yearInput.value = safeYear;
  if (hidden) hidden.value = `${safeYear}-01`;
  return safeYear;
}

function populateMonthSelect(select) {
  if (!select || select.options.length) return;
  select.innerHTML = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    return `<option value="${month}">${month}月</option>`;
  }).join("");
}

function setMonthControl(prefix, monthKey) {
  const key = monthKey || currentMonthKey();
  const [year, month] = key.split("-");
  const hidden = $(`#${prefix}-month`);
  const yearInput = $(`#${prefix}-year`);
  const monthSelect = $(`#${prefix}-month-number`);
  populateMonthSelect(monthSelect);
  if (hidden) hidden.value = key;
  if (yearInput) yearInput.value = year;
  if (monthSelect) monthSelect.value = String(Number(month));
}

function syncMonthControl(prefix) {
  const hidden = $(`#${prefix}-month`);
  const yearInput = $(`#${prefix}-year`);
  const monthSelect = $(`#${prefix}-month-number`);
  populateMonthSelect(monthSelect);
  const year = Number(yearInput?.value);
  const month = Number(monthSelect?.value);
  if (!year || year < 1900 || year > 9999 || !month) return hidden?.value || "";
  const key = `${year}-${String(month).padStart(2, "0")}`;
  if (hidden) hidden.value = key;
  return key;
}

function isMonitoringDueInMonth(user, monthKey) {
  if (!isAlertEligible(user)) return false;
  const cycleMonths = monitoringCycleMonths(user.monitoringCycle);
  if (!cycleMonths) return false;
  if (cycleMonths === 1) return true;
  const start = parseDate(user.planStart);
  if (!start) return false;
  const [year, month] = monthKey.split("-").map(Number);
  const target = new Date(year, month - 1, 1);
  const diff = (target.getFullYear() - start.getFullYear()) * 12 + target.getMonth() - start.getMonth();
  if (diff < 0) return false;
  return diff % cycleMonths === 0;
}

function defaultMonitoringRecord(monthKey) {
  return {
    month: monthKey,
    visited: false,
    recordDone: false,
    meetingDone: false,
    reportDone: false,
    mailed: false,
    returned: false,
    officeSent: false,
    addOn: false,
    billingDone: false,
    billingSent: false
  };
}

function monitoringRecord(user, monthKey) {
  return {
    ...defaultMonitoringRecord(monthKey),
    ...(user.monitoringRecords?.[monthKey] || {})
  };
}

function defaultAgencyNotice(monthKey) {
  return {
    month: monthKey,
    noticeCreated: false,
    noticeSent: false
  };
}

function agencyNoticeRecord(user, monthKey) {
  return {
    ...defaultAgencyNotice(monthKey),
    ...(user.agencyNotices?.[monthKey] || {})
  };
}

function monitoringRecordHasActivity(record) {
  return Object.entries(record).some(([key, value]) => key !== "month" && value === true);
}

function monitoringWorkComplete(record) {
  return record.recordDone && record.reportDone && record.mailed && record.returned && record.officeSent;
}

function monitoringWorkStatus(record, isTarget = true) {
  if (!isTarget && !monitoringRecordHasActivity(record)) return { text: "対象外", type: "inactive" };
  if (monitoringWorkComplete(record)) return { text: "完了", type: "done" };
  if (record.mailed && !record.returned) return { text: "署名返送待ち", type: "wait" };
  if (record.returned && !record.officeSent) return { text: "役所送付待ち", type: "danger" };
  return { text: "未完了", type: "danger" };
}

function monitoringBillingReady(record) {
  return record.recordDone && record.reportDone;
}

function monitoringBillingStatus(record) {
  if (record.billingDone && record.billingSent) return { text: "完了", type: "done" };
  if (!monitoringBillingReady(record)) return { text: "資料不足", type: "danger" };
  if (record.billingDone && !record.billingSent) return { text: "送信待ち", type: "wait" };
  return { text: "請求待ち", type: "danger" };
}

function monitoringAddOnTarget(user, record, billingMonthKey, workMonthKey) {
  if (record.meetingDone || record.addOn) return true;
  if (workMonthKey && workMonthKey !== billingMonthKey) {
    const workRecord = monitoringRecord(user, workMonthKey);
    if (workRecord.meetingDone || workRecord.addOn) return true;
  }
  return false;
}

function agencyNoticeStatus(record) {
  if (record.noticeCreated && record.noticeSent) return { text: "完了", type: "done" };
  if (record.noticeCreated && !record.noticeSent) return { text: "送付待ち", type: "wait" };
  return { text: "未作成", type: "danger" };
}

function monitoringTargetUsers(monthKey) {
  const filter = $("#monitoring-work-filter")?.value || "target";
  const includeInactive = !!$("#monitoring-include-inactive")?.checked;
  return loadAll()
    .filter(user => canShowInManagement(user, includeInactive))
    .filter(user => {
      const record = monitoringRecord(user, monthKey);
      const isTarget = isMonitoringDueInMonth(user, monthKey) || monitoringRecordHasActivity(record);
      if (filter === "all") return true;
      if (filter === "incomplete") return isTarget && !monitoringWorkComplete(record);
      return isTarget;
    });
}

function monitoringCheckboxHtml(user, monthKey, kind, field, checked, invert = false) {
  const isChecked = invert ? !checked : checked;
  return `
    <td class="monitoring-check-cell">
      <input type="checkbox"
        data-monitoring-kind="${escapeHtml(kind)}"
        data-monitoring-user="${escapeHtml(user.id)}"
        data-monitoring-month="${escapeHtml(monthKey)}"
        data-monitoring-field="${escapeHtml(field)}"
        ${invert ? 'data-monitoring-invert="true"' : ""}
        ${isChecked ? "checked" : ""}>
    </td>
  `;
}

function renderMonitoringManagement() {
  const input = $("#monitoring-month");
  if (!input) return;
  if (!input.value) setMonthControl("monitoring", currentMonthKey());

  const monthKey = syncMonthControl("monitoring") || currentMonthKey();
  const billingInput = $("#billing-source-month");
  if (billingInput && !billingInput.value) setMonthControl("billing-source", addMonthsToKey(monthKey, -1));
  const billingSourceMonth = syncMonthControl("billing-source") || addMonthsToKey(monthKey, -1);
  const noticeYear = setNoticeYear(noticeYearFromControl());
  const noticeStartMonth = `${noticeYear}-01`;
  const workUsers = monitoringTargetUsers(monthKey);
  const billingUsers = loadAll()
    .filter(user => isDashboardVisible(user) && (
      isMonitoringDueInMonth(user, billingSourceMonth) ||
      !!user.monitoringRecords?.[billingSourceMonth] ||
      monitoringRecordHasActivity(monitoringRecord(user, billingSourceMonth))
    ));
  const noticeUsers = loadAll()
    .filter(user => isAlertEligible(user));
  const noticeMonths = noticeMonthKeys(noticeStartMonth, 12);

  $("#monitoring-work-title").textContent = `${monthKeyLabel(monthKey)} モニタリング実施管理`;
  $("#monitoring-billing-title").textContent = `${monthKeyLabel(billingSourceMonth)}実施分 給付費請求管理`;
  $("#monitoring-notice-title").textContent = `${noticeYear}年 1月〜12月 給付費の受領通知`;

  const workRecords = workUsers.map(user => ({ user, record: monitoringRecord(user, monthKey) }));
  const billingRecords = billingUsers.map(user => ({ user, record: monitoringRecord(user, billingSourceMonth) }));
  const noticeRecords = noticeUsers.flatMap(user => noticeMonths.map(month => ({ user, month, record: agencyNoticeRecord(user, month) })));

  $("#monitoring-work-count").textContent = `${workRecords.filter(item => (
    isMonitoringDueInMonth(item.user, monthKey) ||
    monitoringRecordHasActivity(item.record)
  ) && !monitoringWorkComplete(item.record)).length}件`;
  $("#monitoring-return-count").textContent = `${workRecords.filter(item => item.record.mailed && !item.record.returned).length}件`;
  $("#monitoring-billing-count").textContent = `${billingRecords.filter(item => !(item.record.billingDone && item.record.billingSent)).length}件`;
  $("#monitoring-notice-count").textContent = `${noticeRecords.filter(item => !item.record.noticeSent).length}件`;

  $("#monitoring-work-body").innerHTML = workRecords.length ? workRecords.map(({ user, record }) => {
    const isTarget = isMonitoringDueInMonth(user, monthKey) || monitoringRecordHasActivity(record);
    const status = monitoringWorkStatus(record, isTarget);
    return `
      <tr class="monitoring-${status.type}">
        <td><strong>${escapeHtml(user.name || "(無名)")}</strong></td>
        <td><span class="monitoring-status-pill ${status.type}">${escapeHtml(status.text)}</span></td>
        ${monitoringCheckboxHtml(user, monthKey, "work", "recordDone", record.recordDone)}
        ${monitoringCheckboxHtml(user, monthKey, "work", "meetingDone", record.meetingDone)}
        ${monitoringCheckboxHtml(user, monthKey, "work", "reportDone", record.reportDone)}
        ${monitoringCheckboxHtml(user, monthKey, "work", "mailed", record.mailed)}
        ${monitoringCheckboxHtml(user, monthKey, "work", "returned", record.returned)}
        ${monitoringCheckboxHtml(user, monthKey, "work", "officeSent", record.officeSent)}
      </tr>
    `;
  }).join("") : '<tr><td colspan="8">この月のモニタリング対象者はいません。</td></tr>';

  $("#monitoring-billing-body").innerHTML = billingRecords.length ? billingRecords.map(({ user, record }) => {
    const status = monitoringBillingStatus(record);
    const addOnTarget = monitoringAddOnTarget(user, record, billingSourceMonth, monthKey);
    return `
      <tr class="monitoring-${status.type}">
        <td><strong>${escapeHtml(user.name || "(無名)")}</strong></td>
        <td>${escapeHtml(monthKeyLabel(billingSourceMonth))}</td>
        <td class="monitoring-check-cell"><span class="monitoring-auto-label ${addOnTarget ? "target" : ""}">${addOnTarget ? "対象" : "-"}</span></td>
        ${monitoringCheckboxHtml(user, billingSourceMonth, "billing", "billingDone", record.billingDone)}
        ${monitoringCheckboxHtml(user, billingSourceMonth, "billing", "billingSent", record.billingSent)}
        <td><span class="monitoring-status-pill ${status.type}">${escapeHtml(status.text)}</span></td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="6">${escapeHtml(monthKeyLabel(billingSourceMonth))}のモニタリング対象者はいません。</td></tr>`;

  $("#monitoring-notice-table").innerHTML = noticeUsers.length ? `
    <table class="monitoring-table monitoring-notice-month-table">
      <thead>
        <tr>
          <th>氏名</th>
          ${noticeMonths.map(month => `<th>${escapeHtml(monthKeyShortLabel(month))}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${noticeUsers.map(user => `
          <tr>
            <td><strong>${escapeHtml(user.name || "(無名)")}</strong></td>
            ${noticeMonths.map(month => {
              const record = agencyNoticeRecord(user, month);
              return monitoringCheckboxHtml(user, month, "notice", "noticeSent", record.noticeSent);
            }).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : '<div class="empty-state">利用中の利用者はいません。</div>';
}

function updateMonitoringField(userId, monthKey, kind, field, checked) {
  const user = getUser(userId);
  if (!user) return;
  if (kind === "notice") {
    user.agencyNotices = user.agencyNotices || {};
    user.agencyNotices[monthKey] = {
      ...defaultAgencyNotice(monthKey),
      ...(user.agencyNotices[monthKey] || {}),
      [field]: checked,
      changedAt: new Date().toISOString()
    };
  } else {
    user.monitoringRecords = user.monitoringRecords || {};
    const nextRecord = {
      ...defaultMonitoringRecord(monthKey),
      ...(user.monitoringRecords[monthKey] || {}),
      [field]: checked,
      changedAt: new Date().toISOString()
    };
    if (field === "meetingDone") nextRecord.addOn = checked;
    user.monitoringRecords[monthKey] = {
      ...nextRecord
    };
  }
  addHistory(user, "モニタリング管理更新", `${monthKeyLabel(monthKey)} / ${MONITORING_FIELD_LABELS[field] || field}: ${checked ? "済" : "未"}`);
  upsertUser(user);
  renderMonitoringManagement();
  renderDashboard();
}

function handleMonitoringCheckboxChange(event) {
  const target = event.target;
  if (!target.matches("[data-monitoring-kind]")) return;
  updateMonitoringField(
    target.dataset.monitoringUser,
    target.dataset.monitoringMonth,
    target.dataset.monitoringKind,
    target.dataset.monitoringField,
    target.dataset.monitoringInvert === "true" ? !target.checked : target.checked
  );
}

function renderDashboard() {
  const users = loadAll().filter(user => isDashboardVisible(user));
  const monitoringUsers = users.filter(user => isMonitoringDueInMonth(user, currentMonthKey()) || monitoringRecordHasActivity(monitoringRecord(user, currentMonthKey())));
  renderMonitoringCards(monitoringUsers);
  renderRenewalCards(users);
  $("#count-monitoring").textContent = monitoringUsers.length;
  $("#count-renewal").textContent = users.length;
}

function renderMonitoringCards(users) {
  const container = $("#monitoring-card-list");
  container.innerHTML = "";

  if (!users.length) {
    container.innerHTML = '<div class="empty-state">登録済みの利用者はいません。個人シートから新規作成してください。</div>';
    return;
  }

  const monthKey = currentMonthKey();
  const targetUsers = [...users];

  if (!targetUsers.length) {
    container.innerHTML = '<div class="empty-state">当月のモニタリング対象者はいません。</div>';
    return;
  }

  container.innerHTML = `
    <div class="monitoring-table-wrap dashboard-monitoring-table">
      <table class="monitoring-table">
        <thead>
          <tr>
            <th>氏名</th>
            <th>状態</th>
            <th>記録作成</th>
            <th>会議録作成</th>
            <th>報告書作成</th>
            <th>報告書郵送</th>
            <th>報告書返送</th>
            <th>写しを郵送</th>
          </tr>
        </thead>
        <tbody>
          ${targetUsers.map(user => {
            const record = monitoringRecord(user, monthKey);
            const isTarget = isMonitoringDueInMonth(user, monthKey) || monitoringRecordHasActivity(record);
            const status = monitoringWorkStatus(record, isTarget);
            return `
              <tr class="monitoring-${status.type}">
                <td><button type="button" class="monitoring-person-name inline-name" data-monitoring-open="${escapeHtml(user.id)}">${escapeHtml(user.name || "(無名)")}</button></td>
                <td><span class="monitoring-status-pill ${status.type}">${escapeHtml(status.text)}</span></td>
                ${monitoringCheckboxHtml(user, monthKey, "work", "recordDone", record.recordDone)}
                ${monitoringCheckboxHtml(user, monthKey, "work", "meetingDone", record.meetingDone)}
                ${monitoringCheckboxHtml(user, monthKey, "work", "reportDone", record.reportDone)}
                ${monitoringCheckboxHtml(user, monthKey, "work", "mailed", record.mailed)}
                ${monitoringCheckboxHtml(user, monthKey, "work", "returned", record.returned)}
                ${monitoringCheckboxHtml(user, monthKey, "work", "officeSent", record.officeSent)}
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;

  container.querySelectorAll("[data-monitoring-open]").forEach(button => {
    button.addEventListener("click", () => showDetail(button.dataset.monitoringOpen));
  });
}

function groupTaskAlerts(alerts) {
  const groups = new Map();
  alerts.forEach(alert => {
    const id = alert.user.id;
    if (!groups.has(id)) {
      groups.set(id, {
        user: alert.user,
        level: alert.level,
        days: alert.days,
        tags: []
      });
    }
    const group = groups.get(id);
    if (alert.level === "urgent") group.level = "urgent";
    if ((alert.days ?? 99999) < (group.days ?? 99999)) group.days = alert.days;
    group.tags.push(alert);
  });
  return Array.from(groups.values()).sort((a, b) => (a.days ?? 99999) - (b.days ?? 99999));
}

function renderRenewalCards(users) {
  const container = $("#renewal-card-list");
  container.innerHTML = "";

  if (!users.length) {
    container.innerHTML = '<div class="empty-state">登録済みの利用者はいません。個人シートから新規作成してください。</div>';
    return;
  }

  users.forEach(user => {
    const active = isRenewalMonthActive(user);
    const complete = isRenewalComplete(user);
    const status = user.status || "active";
    const card = document.createElement("article");
    card.className = `renewal-person-card ${active ? "active" : ""} ${complete ? "complete" : ""} ${status !== "active" ? "inactive" : ""}`;
    card.innerHTML = `
      <button type="button" class="renewal-person-name" data-renewal-open="${escapeHtml(user.id)}">${escapeHtml(user.name || "(無名)")}</button>
      <span class="renewal-month-badge ${active ? "alert" : ""}">${escapeHtml(renewalAlertLabel(user))}</span>
      <div class="renewal-step-tags">
        ${RENEWAL_STEPS.map((step, index) => renewalStepTagHtml(user, step, index)).join("")}
      </div>
    `;
    card.querySelector("[data-renewal-open]").addEventListener("click", () => showDetail(user.id));
    card.querySelectorAll("[data-renewal-step]").forEach(button => {
      button.addEventListener("click", () => toggleRenewalStep(user.id, button.dataset.renewalStep));
    });
    container.appendChild(card);
  });
}

function renewalStepTagHtml(user, step, index) {
  const done = isRenewalStepDone(user, step.key);
  const active = isRenewalMonthActive(user);
  return `
    <button type="button" class="renewal-step-tag ${done ? "done" : ""} ${active && !done ? "pending-alert" : ""}" data-renewal-step="${escapeHtml(step.key)}">
      <span>${index + 1}</span>${escapeHtml(step.short)}<b>${done ? "済" : "未"}</b>
    </button>
  `;
}

function renderTaskTagList(containerId, groups) {
  const container = $(`#${containerId}`);
  container.innerHTML = "";
  if (!groups.length) {
    container.innerHTML = '<div class="empty-state">現在表示する対象はありません。</div>';
    return;
  }

  groups.forEach(group => {
    const item = document.createElement("div");
    item.className = `task-tag-row ${group.level}`;
    item.innerHTML = `
      <button type="button" class="task-tag-name" data-id="${escapeHtml(group.user.id)}">${escapeHtml(group.user.name || "(無名)")}</button>
      <div class="task-tag-list">
        ${group.tags.map(alert => `<span class="task-mini-tag ${alert.level}">${escapeHtml(alert.title)}</span>`).join("")}
      </div>
      <button class="btn-primary btn-confirm" data-id="${escapeHtml(group.user.id)}">確認</button>
    `;
    item.querySelectorAll("[data-id]").forEach(button => {
      button.addEventListener("click", () => showDetail(button.dataset.id));
    });
    container.appendChild(item);
  });
}

function renderSummaryCard(prefix, alerts) {
  $(`#${prefix}-count`).textContent = alerts.length;
  const container = $(`#${prefix}-list`);
  container.innerHTML = "";

  if (!alerts.length) {
    container.innerHTML = '<span class="summary-empty">対象者なし</span>';
    return;
  }

  alerts.forEach(alert => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "summary-link";
    button.textContent = `${alert.user.name || "(無名)"}（${alert.title}）`;
    button.addEventListener("click", () => showDetail(alert.user.id));
    container.appendChild(button);
  });
}

function renderAlertList(containerId, alerts) {
  const container = $(`#${containerId}`);
  container.innerHTML = "";
  if (!alerts.length) {
    container.innerHTML = '<div class="empty-state">現在表示する対象はありません。</div>';
    return;
  }
  alerts.forEach(alert => {
    const item = document.createElement("div");
    item.className = `alert-item ${alert.level}`;
    item.innerHTML = `
      <div class="alert-name">${escapeHtml(alert.user.name || "(無名)")}</div>
      <div class="alert-body">
        <div class="alert-headline">
          <strong>${escapeHtml(alert.title)}</strong>
          <small>次に行うこと: ${escapeHtml(alert.nextAction)}</small>
        </div>
        <p>${escapeHtml(alert.message)}</p>
      </div>
      <button class="btn-primary btn-confirm" data-id="${alert.user.id}">確認</button>
    `;
    item.querySelector(".btn-confirm").addEventListener("click", () => showDetail(alert.user.id));
    container.appendChild(item);
  });
}

function renderPersonalSheets() {
  const query = ($("#personal-search")?.value || "").trim().toLowerCase();
  const statusFilter = $("#personal-status-filter")?.value || "normal";
  const users = loadAll()
    .filter(user => personalUserMatches(user, query, statusFilter))
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
  const container = $("#personal-sheet-list");
  container.innerHTML = "";

  if (!users.length) {
    container.innerHTML = `
      <div class="empty-state">
        条件に合う利用者はいません。検索条件や表示状態を確認してください。
      </div>
    `;
    return;
  }

  users.forEach(user => {
    const card = document.createElement("article");
    const status = user.status || "active";
    card.className = `personal-sheet-card ${status !== "active" ? "inactive" : ""}`;
    card.innerHTML = `
      <div>
        <h3>${escapeHtml(user.name || "(無名)")}</h3>
        <p>${escapeHtml(user.kana || "")}</p>
      </div>
      <div class="personal-sheet-meta">
        <span>受給者証番号: ${escapeHtml(user.recipientNo || "-")}</span>
        <span>状態: ${escapeHtml(USER_STATUS_LABELS[status] || "利用中")}</span>
        <span>区: ${escapeHtml(user.wardName || "-")}</span>
        <span>計画相談期限: ${formatDate(user.planEnd)}</span>
        <span>モニタリング: ${escapeHtml(user.monitoringCycle || "-")}</span>
      </div>
      <div class="actions">
        <button class="btn-primary" data-confirm="${user.id}">個人シートを見る</button>
        <button class="btn-secondary" data-edit="${user.id}">編集</button>
        ${userManagementButtons(user)}
      </div>
    `;
    card.querySelector("[data-confirm]").addEventListener("click", () => showDetail(user.id));
    card.querySelector("[data-edit]").addEventListener("click", () => {
      fillForm(user);
      showView("input");
    });
    bindUserManagementButtons(card);
    container.appendChild(card);
  });
}

function personalUserMatches(user, query, statusFilter) {
  const status = user.status || "active";
  if (statusFilter === "normal" && (status === "hidden" || status === "deleted")) return false;
  if (statusFilter !== "normal" && statusFilter !== "all" && status !== statusFilter) return false;
  if (!query) return true;
  const haystack = [
    user.name,
    user.kana,
    user.recipientNo,
    user.wardName,
    user.municipalCode,
    USER_STATUS_LABELS[status]
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function userManagementButtons(user) {
  const id = escapeHtml(user.id);
  const status = user.status || "active";
  if (status === "deleted") {
    return `<button class="btn-secondary" data-user-action="restore" data-user-id="${id}">復元</button>`;
  }
  const hideButton = status === "hidden"
    ? `<button class="btn-secondary" data-user-action="restore" data-user-id="${id}">再表示</button>`
    : `<button class="btn-secondary" data-user-action="hide" data-user-id="${id}">非表示</button>`;
  return `${hideButton}<button class="btn-danger" data-user-action="delete" data-user-id="${id}">削除</button>`;
}

function bindUserManagementButtons(root = document) {
  root.querySelectorAll("[data-user-action]").forEach(button => {
    button.addEventListener("click", () => handleUserManagementAction(button.dataset.userId, button.dataset.userAction));
  });
}

function handleUserManagementAction(id, action) {
  const user = getUser(id);
  if (!user) return;
  if (action === "delete") {
    if (!confirm(`${user.name || "この利用者"}を削除済みにします。後から復元できます。`)) return;
    deleteUser(id);
  } else if (action === "hide") {
    updateUserStatus(id, "hidden", "非表示に変更");
  } else if (action === "restore") {
    restoreUser(id);
  }
  renderDashboard();
  renderPersonalSheets();
  renderMonitoringManagement();
}

function showDetail(id) {
  const user = getUser(id);
  if (!user) return;
  $("#detail-title").textContent = `確認画面: ${user.name || "(無名)"}`;
  $("#btn-edit-from-detail").dataset.id = id;
  $("#detail-content").innerHTML = detailHtml(user);
  $$("#detail-content [data-task-checkbox]").forEach(checkbox => {
    checkbox.addEventListener("change", () => updateTaskFromCheckbox(id, checkbox.dataset.taskCheckbox, checkbox.checked));
  });
  $$("#detail-content [data-deadline-complete]").forEach(button => {
    button.addEventListener("click", () => toggleDeadline(id, button.dataset.deadlineComplete, button.dataset.deadlineDate));
  });
  bindUserManagementButtons($("#detail-content"));
  showView("detail");
}

function detailHtml(user) {
  const renewalComplete = isRenewalComplete(user);
  const services = ["training1", "training2", "care1", "care2"].flatMap(key =>
    (user[key] || []).map((row, index) => ({
      ...row,
      completeKey: `service:${key}:${index}:${row.type || ""}:${row.start || ""}:${row.end || ""}`,
      deadlineCompletions: user.deadlineCompletions || {},
      group: SERVICE_LABELS[key],
      alertEligible: isAlertEligible(user),
      renewalComplete
    }))
  );
  const renewalActive = isRenewalMonthActive(user);
  const alertLabel = renewalAlertLabel(user);
  return `
    <article class="detail-card wide-detail user-management-card">
      <div>
        <h3>利用者管理</h3>
        <p>非表示・削除済み・復元をここから行えます。削除済みにしてもデータは残ります。</p>
      </div>
      <div class="actions">${userManagementButtons(user)}</div>
    </article>
    <div class="detail-top-grid wide-detail">
      <article class="detail-card task-priority-card ${renewalActive ? "renewal-urgent" : ""}">
        <div class="priority-heading">
          <div>
            <h3>更新時タスク</h3>
            <p>チェックを押すとすぐ保存され、ダッシュボードにも反映されます。</p>
          </div>
          <span>${taskDoneCount(user)} / ${RENEWAL_STEPS.length} 完了</span>
        </div>
        ${renewalActive ? `
          <div class="renewal-alert-note">
            <strong>${escapeHtml(alertLabel)}</strong>
            <span>更新手続きが未完了です。下の未完了項目を処理してください。</span>
          </div>
        ` : ""}
        ${RENEWAL_STEPS.map(step => taskHtml(user, step)).join("")}
      </article>
      <article class="detail-card deadline-summary-card ${renewalActive ? "renewal-urgent" : ""}">
        <h3>期限情報・サービス期限まとめ</h3>
        ${renewalActive ? `<p class="deadline-alert-text">${escapeHtml(alertLabel)}です。期限の確認と更新手続きを進めてください。</p>` : ""}
        ${deadlineOverviewHtml(user)}
        <div class="deadline-main-grid">
          ${periodInfo(user, "plan", "計画相談", user.planStart, user.planEnd)}
          ${info("モニタリング", user.monitoringCycle)}
        </div>
        <div class="deadline-service-list">
          ${services.length ? services.map(serviceHtml).join("") : '<div class="empty-state">サービス登録はありません。</div>'}
        </div>
      </article>
    </div>
    <article class="detail-card basic-info-card wide-detail">
      <h3>基本情報</h3>
      <div class="info-grid basic-info-grid">
        ${info("氏名", user.name)}
        ${info("フリガナ", user.kana)}
        ${info("生年月日", formatDate(user.birthday))}
        ${info("電話番号", user.phone)}
        ${info("住所", user.address)}
        ${info("受給者証番号", user.recipientNo)}
        ${info("利用状態", USER_STATUS_LABELS[user.status || "active"] || "利用中")}
        ${info("管轄する区", user.wardName)}
        ${info("自治体コード", user.municipalCode)}
        ${info("障害者種別", user.disabilityType)}
        ${info("利用者負担上限額", user.paymentCap)}
      </div>
    </article>
    <article class="detail-card wide-detail">
      <h3>備考</h3>
      <p>${escapeHtml(user.note || "備考はありません。")}</p>
    </article>
    <article class="detail-card wide-detail history-card">
      <h3>履歴確認</h3>
      ${historyHtml(user)}
    </article>
  `;
}

function deadlineOverviewHtml(user) {
  const items = deadlineOverviewItems(user);
  return `
    <div class="deadline-overview" aria-label="期限一覧">
      <div class="deadline-overview-head">
        <strong>期限一覧</strong>
        <span>赤は30日以内・期限超過です。</span>
      </div>
      ${items.map(item => {
        const status = deadlineOverviewStatus(item.end, item.completed);
        return `
          <div class="deadline-overview-row ${status.className}">
            <div>
              <strong>${escapeHtml(item.label)}</strong>
              <span>${escapeHtml(item.detail || "")}</span>
            </div>
            <div>
              <span>期間</span>
              <strong>${formatDate(item.start)} から ${formatDate(item.end)} まで</strong>
              ${item.note ? `<small>${escapeHtml(item.note)}</small>` : ""}
            </div>
            <em>${escapeHtml(status.text)}</em>
            <b>${escapeHtml(status.badge)}</b>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function info(label, value) {
  return `<div class="info-box"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "-")}</strong></div>`;
}

function periodInfo(user, key, label, start, end) {
  const done = user.deadlineCompletions?.[key];
  const isDone = !!done && done.date === end;
  const days = daysUntil(end);
  const urgent = isAlertEligible(user) && !isRenewalComplete(user) && !isDone && days !== null && days <= URGENT_DAYS;
  return `
    <div class="info-box period-info ${isDone ? "deadline-done" : ""} ${urgent ? "urgent" : ""}">
      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${formatDate(start)}から <em>${formatDate(end)}</em> まで</strong>
        ${urgent ? `<small class="urgent-text">${escapeHtml(renewalAlertLabel(user))}</small>` : ""}
        ${isDone ? `<small>完了日: ${formatDate(done.completed)}</small>` : ""}
      </div>
      <button type="button" class="btn-secondary deadline-complete-btn ${isDone ? "undo" : ""}" data-deadline-complete="${escapeHtml(key)}" data-deadline-date="${escapeHtml(end || "")}">
        ${isDone ? "確認を戻す" : "期限確認済"}
      </button>
    </div>
  `;
}

function taskHtml(user, step) {
  const key = step.key;
  const task = user.checks?.[key] || {};
  const done = isRenewalStepDone(user, key);
  const date = task.nextCheck || task.due || task.completed || task.requested;
  const urgent = !done && isRenewalMonthActive(user);
  return `
    <div class="task-line ${done ? "done" : "pending"} ${urgent ? "urgent" : ""}">
      <label class="task-check-label">
        <input type="checkbox" data-task-checkbox="${key}" ${done ? "checked" : ""}>
        <span>${done ? "完了" : "未完了"}</span>
      </label>
      <div class="task-line-body">
        <strong>${escapeHtml(step.label)}</strong>
        <p>状態: ${done ? "完了" : "未完了"} / 確認日: ${formatDate(date)} ${task.note ? ` / ${escapeHtml(task.note)}` : ""}</p>
        <small>${urgent ? `${escapeHtml(renewalAlertLabel(user))}。この手続きが未完了です。` : "完了後も、期限まであと30日になったら処理タスクに再表示します。"}</small>
      </div>
    </div>
  `;
}

function taskDoneCount(user) {
  return RENEWAL_STEPS.filter(step => isRenewalStepDone(user, step.key)).length;
}

function serviceHtml(service) {
  const done = service.deadlineCompletions?.[service.completeKey];
  const isDone = !!done && done.date === service.end;
  const days = daysUntil(service.end);
  const urgent = service.alertEligible !== false && !service.renewalComplete && !isDone && days !== null && days <= URGENT_DAYS;
  return `
    <div class="service-line ${isDone ? "deadline-done" : ""} ${urgent ? "urgent" : ""}">
      <div class="service-line-main">
        <strong>${escapeHtml(service.type || "-")}</strong>
        <p>${escapeHtml(service.group)} / ${formatDate(service.start)}から <em>${formatDate(service.end)}</em> まで</p>
        <p>使用事業所: ${escapeHtml(service.office || "-")}${service.level ? ` / 区分種別: ${escapeHtml(service.level)}` : ""}</p>
        ${urgent ? `<small class="urgent-text">${escapeHtml(deadlineStatusText(service.end))}</small>` : ""}
        ${isDone ? `<small>完了日: ${formatDate(done.completed)}</small>` : ""}
      </div>
      <button type="button" class="btn-secondary deadline-complete-btn ${isDone ? "undo" : ""}" data-deadline-complete="${escapeHtml(service.completeKey)}" data-deadline-date="${escapeHtml(service.end || "")}">
        ${isDone ? "確認を戻す" : "期限確認済"}
      </button>
    </div>
  `;
}

function historyHtml(user) {
  const history = Array.isArray(user.history) ? [...user.history].reverse() : [];
  if (!history.length) {
    return '<div class="empty-state">履歴はまだありません。</div>';
  }
  return `
    <div class="history-list">
      ${history.map(item => `
        <div class="history-line">
          <time>${escapeHtml(formatDateTime(item.at))}</time>
          <strong>${escapeHtml(item.action || "-")}</strong>
          <span>${escapeHtml(item.detail || "")}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function toggleDeadline(userId, key, date) {
  const user = getUser(userId);
  if (!user) return;
  user.deadlineCompletions = user.deadlineCompletions || {};
  if (user.deadlineCompletions[key]?.date === date) {
    delete user.deadlineCompletions[key];
    addHistory(user, "期限完了を取消", `${key} / ${formatDate(date)}`);
  } else {
    user.deadlineCompletions[key] = {
      date,
      completed: new Date().toISOString().slice(0, 10)
    };
    addHistory(user, "期限完了", `${key} / ${formatDate(date)}`);
  }
  upsertUser(user);
  renderDashboard();
  showDetail(userId);
}

function updateTaskFromCheckbox(userId, key, done) {
  const user = getUser(userId);
  if (!user) return;
  user.checks = user.checks || {};
  user.checks[key] = user.checks[key] || {};
  const dueDate = taskDueDate(user, key);
  user.checks[key].done = done;
  user.checks[key].completed = done ? new Date().toISOString().slice(0, 10) : "";
  user.checks[key].completedForDate = done ? dueDate : "";
  user.checks[key].changedAt = new Date().toISOString();
  addHistory(user, done ? "更新手続き完了" : "更新手続き取消", `${TASK_LABELS[key] || key} / ${formatDate(dueDate)}`);
  upsertUser(user);
  renderDashboard();
  showDetail(userId);
}

function toggleRenewalStep(userId, key) {
  const user = getUser(userId);
  if (!user) return;
  user.checks = user.checks || {};
  user.checks[key] = user.checks[key] || {};
  const done = !isRenewalStepDone(user, key);
  const dueDate = taskDueDate(user, key);
  user.checks[key].done = done;
  user.checks[key].completed = done ? new Date().toISOString().slice(0, 10) : "";
  user.checks[key].completedForDate = done ? dueDate : "";
  user.checks[key].changedAt = new Date().toISOString();
  addHistory(user, done ? "更新手続き完了" : "更新手続き取消", `${TASK_LABELS[key] || key} / ${formatDate(dueDate)}`);
  upsertUser(user);
  renderDashboard();
}

function renderBackup() {
  const users = loadAll();
  const usage = storageUsageBytes();
  $("#record-count").textContent = users.length;
  $("#storage-usage").textContent = formatBytes(usage);
  const warning = $("#storage-warning");
  if (usage >= STORAGE_WARNING_BYTES) {
    warning.hidden = false;
    warning.textContent = "保存容量が大きくなっています。CSVエクスポートと日付付きバックアップを必ず残してください。";
  } else {
    warning.hidden = true;
    warning.textContent = "";
  }
  renderBackupReminder();
  renderSheetSyncStatus();
  renderDatedBackups();
}

function renderBackupReminder() {
  const box = $("#backup-reminder");
  if (!box) return;
  const backups = listDatedBackups();
  if (!backups.length) {
    box.hidden = false;
    box.textContent = "日付付きバックアップがまだありません。運用開始前に必ず保存してください。";
    return;
  }
  const latestDate = backupKeyToDate(backups[0].key);
  const days = latestDate ? Math.floor((Date.now() - latestDate.getTime()) / 86400000) : 999;
  if (days >= BACKUP_REMINDER_DAYS) {
    box.hidden = false;
    box.textContent = `最後の日付付きバックアップから${days}日経過しています。CSV出力と日付付きバックアップを残してください。`;
  } else {
    box.hidden = true;
    box.textContent = "";
  }
}

function backupKeyToDate(key) {
  const value = key.replace(DATED_BACKUP_PREFIX, "");
  const normalized = value.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4").replace(/-(\d{3})Z$/, ".$1Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function storageUsageBytes() {
  try {
    return Object.keys(localStorage).reduce((total, key) => {
      const value = localStorage.getItem(key) || "";
      return total + new Blob([key, value]).size;
    }, 0);
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  return `${Math.ceil(bytes / 1024)}KB`;
}

function warnIfStorageLarge() {
  if (typeof sessionStorage === "undefined") return;
  if (sessionStorage.getItem("storage-size-warning-shown")) return;
  if (storageUsageBytes() < STORAGE_WARNING_BYTES) return;
  sessionStorage.setItem("storage-size-warning-shown", "1");
  alert("保存容量が大きくなっています。バックアップ画面からCSVエクスポートと日付付きバックアップを残してください。");
}

function datedBackupKey() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${DATED_BACKUP_PREFIX}${stamp}`;
}

function listDatedBackups() {
  return Object.keys(localStorage)
    .filter(key => key.startsWith(DATED_BACKUP_PREFIX))
    .sort()
    .reverse()
    .map(key => {
      const raw = localStorage.getItem(key) || "[]";
      const users = parseUserList(raw);
      return { key, raw, count: users.length, createdAt: key.replace(DATED_BACKUP_PREFIX, "").replace("T", " ").replace("Z", "") };
    });
}

function saveDatedBackup() {
  localStorage.setItem(datedBackupKey(), JSON.stringify(loadAll()));
  renderBackup();
  alert("日付付きバックアップを保存しました。");
}

function restoreDatedBackup(key) {
  const users = parseUserList(localStorage.getItem(key));
  if (!users.length) {
    alert("このバックアップから利用者データを読み取れませんでした。");
    return;
  }
  if (!confirm(`${users.length}件のバックアップで現在のデータを置き換えます。よろしいですか？`)) return;
  saveAll(users);
  renderDashboard();
  renderMonitoringManagement();
  renderBackup();
  alert("バックアップから復元しました。");
}

function deleteDatedBackup(key) {
  if (!confirm("この日付付きバックアップを削除します。現在の利用者データは削除されません。")) return;
  localStorage.removeItem(key);
  renderBackup();
}

function renderDatedBackups() {
  const container = $("#dated-backup-list");
  if (!container) return;
  const backups = listDatedBackups();
  if (!backups.length) {
    container.innerHTML = '<div class="empty-state">日付付きバックアップはまだありません。</div>';
    return;
  }
  container.innerHTML = backups.map(item => `
    <div class="dated-backup-item">
      <div>
        <strong>${escapeHtml(item.createdAt)}</strong>
        <span>${item.count}件 / ${formatBytes(new Blob([item.raw]).size)}</span>
      </div>
      <div class="actions">
        <button class="btn-secondary" data-backup-restore="${escapeHtml(item.key)}">復元</button>
        <button class="btn-danger" data-backup-delete="${escapeHtml(item.key)}">削除</button>
      </div>
    </div>
  `).join("");
  container.querySelectorAll("[data-backup-restore]").forEach(button => {
    button.addEventListener("click", () => restoreDatedBackup(button.dataset.backupRestore));
  });
  container.querySelectorAll("[data-backup-delete]").forEach(button => {
    button.addEventListener("click", () => deleteDatedBackup(button.dataset.backupDelete));
  });
}

function exportCsv() {
  const headers = [
    "氏名",
    "フリガナ",
    "生年月日",
    "電話番号",
    "住所",
    "受給者証番号",
    "管轄区",
    "自治体コード",
    "障害者種別",
    "受給者証開始",
    "計画相談開始",
    "計画相談終了",
    "モニタリング",
    "利用者負担上限額",
    "バックアップデータ"
  ];
  const rows = loadAll().map(user => [
    user.name,
    user.kana,
    user.birthday,
    user.phone,
    user.address,
    user.recipientNo,
    user.wardName,
    user.municipalCode,
    user.disabilityType,
    user.recipientStart,
    user.planStart,
    user.planEnd,
    user.monitoringCycle,
    user.paymentCap,
    JSON.stringify(user)
  ]);
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `welfare_users_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function exportHistoryCsv() {
  const headers = ["氏名", "状態", "日時", "操作", "内容"];
  const rows = loadAll().flatMap(user => {
    const history = Array.isArray(user.history) ? user.history : [];
    return history.map(item => [
      user.name || "",
      USER_STATUS_LABELS[user.status || "active"] || "",
      item.at || "",
      item.action || "",
      item.detail || ""
    ]);
  });
  if (!rows.length) {
    alert("出力できる履歴がありません。");
    return;
  }
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `welfare_history_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = event => {
    try {
      const rows = parseCsv(event.target.result);
      if (rows.length < 2) throw new Error("CSVに利用者データがありません。");
      const headers = rows[0];
      const backupIndex = headers.indexOf("バックアップデータ");
      if (backupIndex < 0) throw new Error("バックアップデータ列がありません。");
      const data = rows.slice(1).filter(row => row.some(cell => cell.trim())).map(row => normalizeUser(JSON.parse(row[backupIndex])));
      const mode = $("#import-mode")?.value || "merge";
      pendingImport = buildImportPreview(data, mode);
      renderImportPreview(pendingImport);
    } catch (error) {
      alert(`取り込みに失敗しました: ${error.message}`);
    }
  };
  reader.readAsText(file);
}

function buildImportPreview(data, mode) {
  const current = loadAll();
  const merged = mode === "replace" ? null : mergeImportedUsers(current, data);
  const duplicateNames = duplicateValues(data.map(user => user.name).filter(Boolean));
  const missingRecipientNo = data.filter(user => !user.recipientNo).length;
  return { mode, data, merged, currentCount: current.length, duplicateNames, missingRecipientNo };
}

function duplicateValues(values) {
  const counts = new Map();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

function renderImportPreview(preview) {
  const container = $("#import-preview");
  if (!container) return;
  const warnings = [];
  if (preview.mode === "replace") warnings.push("全置換です。現在のデータは取り込むCSVの内容に置き換わります。");
  if (preview.duplicateNames.length) warnings.push(`同姓同名・同名候補: ${preview.duplicateNames.join("、")}`);
  if (preview.missingRecipientNo) warnings.push(`受給者証番号なし: ${preview.missingRecipientNo}件。氏名一致で更新される可能性があります。`);
  container.hidden = false;
  container.innerHTML = `
    <h3>CSV取込確認</h3>
    <div class="import-preview-grid">
      <span>方式</span><strong>${preview.mode === "replace" ? "全置換" : "追加・差分更新"}</strong>
      <span>取込件数</span><strong>${preview.data.length}件</strong>
      <span>現在件数</span><strong>${preview.currentCount}件</strong>
      <span>予定</span><strong>${preview.mode === "replace" ? `${preview.data.length}件で置換` : `${preview.merged.updated}件更新 / ${preview.merged.added}件追加`}</strong>
    </div>
    ${warnings.length ? `<div class="backup-warning import-warning">${warnings.map(escapeHtml).join("<br>")}</div>` : ""}
    <div class="import-preview-table-wrap">
      <table class="mini-table">
        <thead><tr><th>氏名</th><th>受給者証番号</th><th>状態</th><th>計画相談期限</th></tr></thead>
        <tbody>
          ${preview.data.slice(0, 20).map(user => `
            <tr>
              <td>${escapeHtml(user.name || "-")}</td>
              <td>${escapeHtml(user.recipientNo || "-")}</td>
              <td>${escapeHtml(USER_STATUS_LABELS[user.status || "active"] || "-")}</td>
              <td>${formatDate(user.planEnd)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${preview.data.length > 20 ? `<p class="muted">先頭20件のみ表示しています。</p>` : ""}
    </div>
    <div class="actions">
      <button type="button" class="btn-primary" id="btn-apply-import">この内容で取り込む</button>
      <button type="button" class="btn-secondary" id="btn-cancel-import">取り消す</button>
    </div>
  `;
  $("#btn-apply-import").addEventListener("click", applyPendingImport);
  $("#btn-cancel-import").addEventListener("click", clearImportPreview);
}

function applyPendingImport() {
  if (!pendingImport) return;
  if (pendingImport.mode === "replace") {
    if (!confirm(`${pendingImport.data.length}件で現在のデータを全て置き換えます。よろしいですか？`)) return;
    saveAll(pendingImport.data);
  } else {
    saveAll(pendingImport.merged.users);
  }
  clearImportPreview();
  renderDashboard();
  renderBackup();
  renderPersonalSheets();
  renderMonitoringManagement();
  alert("取り込みました。");
}

function clearImportPreview() {
  pendingImport = null;
  const container = $("#import-preview");
  if (!container) return;
  container.hidden = true;
  container.innerHTML = "";
}

function userMergeKey(user) {
  if (user.id) return `id:${user.id}`;
  if (user.recipientNo) return `recipient:${user.recipientNo}`;
  if (user.name) return `name:${user.name}`;
  return "";
}

function mergeImportedUsers(currentUsers, importedUsers) {
  const users = currentUsers.map(user => normalizeUser({ ...user }));
  let added = 0;
  let updated = 0;
  importedUsers.forEach(imported => {
    const key = userMergeKey(imported);
    const index = users.findIndex(user => userMergeKey(user) === key || (
      imported.recipientNo && user.recipientNo === imported.recipientNo
    ) || (
      imported.name && user.name === imported.name
    ));
    if (index >= 0) {
      users[index] = normalizeUser({
        ...users[index],
        ...imported,
        id: users[index].id || imported.id || uid(),
        history: [...(users[index].history || []), ...(imported.history || [])].slice(-HISTORY_LIMIT)
      });
      updated++;
    } else {
      users.push(normalizeUser({ ...imported, id: imported.id || uid() }));
      added++;
    }
  });
  return { users, added, updated };
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function startApplication() {
  if (applicationStarted) return;
  applicationStarted = true;
  setupJapaneseDateInputs();
  setupWardSelect();
  $$(".tab-btn").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.view === "input") clearForm();
    showView(button.dataset.view);
  }));
  $$("[data-view-link]").forEach(button => button.addEventListener("click", () => showView(button.dataset.viewLink)));
  $("#btn-new-from-personal").addEventListener("click", () => {
    clearForm();
    showView("input");
  });
  ["personal-search", "personal-status-filter"].forEach(id => {
    const control = $(`#${id}`);
    if (control) control.addEventListener("input", renderPersonalSheets);
    if (control) control.addEventListener("change", renderPersonalSheets);
  });
  $("#btn-save-top").addEventListener("click", () => $("#user-form").requestSubmit());
  $("#btn-cancel").addEventListener("click", () => showView("dashboard"));
  $("#btn-cancel-bottom").addEventListener("click", () => showView("dashboard"));
  $("#btn-edit-from-detail").addEventListener("click", event => {
    const user = getUser(event.currentTarget.dataset.id);
    if (!user) return;
    fillForm(user);
    showView("input");
  });
  $$(".btn-add").forEach(button => {
    button.addEventListener("click", () => addServiceRow(button.dataset.target));
  });
  setMonthControl("monitoring", currentMonthKey());
  setMonthControl("billing-source", addMonthsToKey(currentMonthKey(), -1));
  setNoticeYear(Number(currentMonthKey().split("-")[0]));
  $("#monitoring-prev-month").addEventListener("click", () => {
    const next = addMonthsToKey(syncMonthControl("monitoring"), -1);
    setMonthControl("monitoring", next);
    setMonthControl("billing-source", addMonthsToKey(next, -1));
    renderMonitoringManagement();
  });
  $("#monitoring-next-month").addEventListener("click", () => {
    const next = addMonthsToKey(syncMonthControl("monitoring"), 1);
    setMonthControl("monitoring", next);
    setMonthControl("billing-source", addMonthsToKey(next, -1));
    renderMonitoringManagement();
  });
  ["monitoring-year", "monitoring-month-number"].forEach(id => $(`#${id}`).addEventListener("change", () => {
    const current = syncMonthControl("monitoring");
    setMonthControl("billing-source", addMonthsToKey(current, -1));
    renderMonitoringManagement();
  }));
  ["monitoring-work-filter", "monitoring-include-inactive"].forEach(id => {
    const control = $(`#${id}`);
    if (control) control.addEventListener("change", renderMonitoringManagement);
  });
  $("#billing-prev-target-month").addEventListener("click", () => {
    setMonthControl("billing-source", addMonthsToKey(syncMonthControl("billing-source"), -1));
    renderMonitoringManagement();
  });
  $("#billing-next-target-month").addEventListener("click", () => {
    setMonthControl("billing-source", addMonthsToKey(syncMonthControl("billing-source"), 1));
    renderMonitoringManagement();
  });
  ["billing-source-year", "billing-source-month-number"].forEach(id => $(`#${id}`).addEventListener("change", () => {
    syncMonthControl("billing-source");
    renderMonitoringManagement();
  }));
  $("#notice-prev-period").addEventListener("click", () => {
    setNoticeYear(noticeYearFromControl() - 1);
    renderMonitoringManagement();
  });
  $("#notice-next-period").addEventListener("click", () => {
    setNoticeYear(noticeYearFromControl() + 1);
    renderMonitoringManagement();
  });
  $("#notice-start-year").addEventListener("change", () => {
    setNoticeYear(noticeYearFromControl());
    renderMonitoringManagement();
  });
  $$("[data-monitoring-tab]").forEach(button => {
    button.addEventListener("click", () => {
      $$("[data-monitoring-tab]").forEach(tab => tab.classList.remove("active"));
      $$("[data-monitoring-panel]").forEach(panel => panel.classList.remove("active"));
      button.classList.add("active");
      $(`[data-monitoring-panel="${button.dataset.monitoringTab}"]`).classList.add("active");
      renderMonitoringManagement();
    });
  });
  $("#view-monitoring").addEventListener("change", handleMonitoringCheckboxChange);
  $("#view-dashboard").addEventListener("change", handleMonitoringCheckboxChange);
  $("#user-form").addEventListener("submit", event => {
    event.preventDefault();
    syncEraInputsToNative($("#user-form"));
    const user = collectForm();
    const validation = validateCollectedUser(user);
    if (validation.errors.length) {
      alert(validation.errors.join("\n"));
      return;
    }
    if (!confirmUserWarnings(validation.warnings)) {
      return;
    }
    const wasNew = !getUser(user.id);
    const previous = getUser(user.id);
    const previousStatus = previous?.status || "active";
    addHistory(user, wasNew ? "個人シート新規作成" : "個人シート更新", `計画相談期限: ${formatDate(user.planEnd)}`);
    if (!wasNew && previousStatus !== user.status) {
      addHistory(user, "利用状態変更", `${USER_STATUS_LABELS[previousStatus] || previousStatus} → ${USER_STATUS_LABELS[user.status] || user.status}`);
    }
    upsertUser(user);
    showDetail(user.id);
  });
  $("#btn-delete").addEventListener("click", () => {
    const id = $("#user-id").value;
    if (!id) return;
    if (confirm("この利用者を削除済みにします。後から復元できます。よろしいですか？")) {
      deleteUser(id);
      showView("dashboard");
    }
  });
  $("#btn-save-dated-backup").addEventListener("click", saveDatedBackup);
  $("#btn-export").addEventListener("click", exportCsv);
  $("#btn-export-history").addEventListener("click", exportHistoryCsv);
  $("#btn-save-sheet-endpoint").addEventListener("click", () => {
    try {
      setSheetEndpoint($("#sheet-endpoint").value);
      renderSheetSyncStatus();
      alert("保存先は管理者設定で固定されています。");
    } catch (error) {
      alert(error.message || error);
    }
  });
  $("#btn-sync-sheet-now").addEventListener("click", () => {
    markSheetSyncPending(loadAll());
    syncSheetNow(true);
  });
  $("#btn-logout").addEventListener("click", () => {
    sessionStorage.removeItem(ACCESS_PASSWORD_SESSION_KEY);
    location.reload();
  });
  $("#import-mode").addEventListener("change", clearImportPreview);
  $("#import-file").addEventListener("change", event => {
    const file = event.target.files && event.target.files[0];
    if (file) importCsv(file);
    event.target.value = "";
  });
  const importedId = importUserFromUrlHash();
  renderDashboard();
  renderMonitoringManagement();
  window.setTimeout(() => refreshFromCloud(), 700);
  if (importedId) showDetail(importedId);
}

async function attemptLogin(password) {
  const status = $("#auth-status");
  const button = $("#auth-submit");
  button.disabled = true;
  status.textContent = "認証中です...";
  status.className = "auth-status";
  try {
    await cloudRequest("authenticate", {}, password);
    sessionStorage.setItem(ACCESS_PASSWORD_SESSION_KEY, password);
    status.textContent = "";
    document.body.classList.remove("auth-locked");
    $("#auth-gate").hidden = true;
    startApplication();
    return true;
  } catch (error) {
    sessionStorage.removeItem(ACCESS_PASSWORD_SESSION_KEY);
    status.textContent = error.message || "認証に失敗しました。";
    status.className = "auth-status error";
    $("#auth-password").focus();
    return false;
  } finally {
    button.disabled = false;
  }
}

function init() {
  $("#auth-form").addEventListener("submit", event => {
    event.preventDefault();
    attemptLogin($("#auth-password").value);
  });
  const savedPassword = sessionStorage.getItem(ACCESS_PASSWORD_SESSION_KEY);
  if (savedPassword) {
    $("#auth-password").value = savedPassword;
    attemptLogin(savedPassword);
  } else {
    $("#auth-password").focus();
  }
}

document.addEventListener("DOMContentLoaded", init);
