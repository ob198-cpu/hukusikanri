(() => {
  "use strict";

  const CURRENT_KEY = "welfare_users_static_v2";
  const LEGACY_KEYS = new Set(["welfare_users_v1", "welfare_users_static_v1"]);
  const BACKUP_PREFIX = "welfare_users_backup_";
  const PENDING_KEY = "welfare_google_sheet_pending_v1";
  const EXPECTED_HOST = "ob198-cpu.github.io";
  const MAX_PREVIEW_NAMES = 6;
  let candidates = [];

  const $ = selector => document.querySelector(selector);

  function parseJson(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function isKnownKey(key) {
    return key === CURRENT_KEY || key === PENDING_KEY || LEGACY_KEYS.has(key) || key.startsWith(BACKUP_PREFIX);
  }

  function hasWelfareShape(value, allowNameOnly = false) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const strongFields = [
      "recipientNo",
      "recipientStart",
      "recipientEnd",
      "planStart",
      "planEnd",
      "monitoringMonth",
      "services",
      "checks",
      "monitoringRecords",
      "agencyNotices",
      "deadlineCompletions"
    ];
    const strongMatches = strongFields.filter(field => field in value).length;
    return strongMatches > 0 || (allowNameOnly && ("name" in value || "recipientNo" in value));
  }

  function extractUsers(parsed, key) {
    const allowNameOnly = isKnownKey(key);
    const sources = [
      { type: "array", value: Array.isArray(parsed) ? parsed : null },
      { type: "users", value: Array.isArray(parsed?.users) ? parsed.users : null },
      { type: "data", value: Array.isArray(parsed?.data) ? parsed.data : null },
      { type: "records", value: Array.isArray(parsed?.records) ? parsed.records : null }
    ];
    for (const source of sources) {
      if (!source.value) continue;
      const users = source.value.filter(item => hasWelfareShape(item, allowNameOnly));
      if (users.length) return { users, sourceType: source.type };
    }
    return { users: [], sourceType: "" };
  }

  function candidateLabel(key) {
    if (key === CURRENT_KEY) return "現在表示中の保存データ";
    if (key === PENDING_KEY) return "未送信のシート同期データ";
    if (LEGACY_KEYS.has(key)) return "旧版の保存データ";
    if (key.startsWith(BACKUP_PREFIX)) return "日付付きバックアップ";
    return "互換データ候補";
  }

  function timestampFromBackupKey(key) {
    if (!key.startsWith(BACKUP_PREFIX)) return 0;
    const value = key.slice(BACKUP_PREFIX.length);
    const normalized = value
      .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4")
      .replace(/-(\d{3})Z$/, ".$1Z");
    const timestamp = Date.parse(normalized);
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  function latestTimestamp(users, key, parsed) {
    const values = [timestampFromBackupKey(key), Date.parse(parsed?.savedAt || "") || 0];
    users.forEach(user => {
      values.push(Date.parse(user?.updatedAt || "") || 0);
      (Array.isArray(user?.history) ? user.history : []).forEach(item => {
        values.push(Date.parse(item?.at || "") || 0);
      });
    });
    return Math.max(...values, 0);
  }

  function scanCandidates() {
    const found = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = parseJson(raw);
      if (parsed === null) continue;
      const extracted = extractUsers(parsed, key);
      if (!extracted.users.length) continue;
      found.push({
        key,
        raw,
        users: extracted.users,
        sourceType: extracted.sourceType,
        label: candidateLabel(key),
        bytes: new Blob([raw]).size,
        latestTimestamp: latestTimestamp(extracted.users, key, parsed)
      });
    }
    return found.sort((a, b) => {
      const preferred = key => key === CURRENT_KEY ? 0 : key === PENDING_KEY ? 1 : LEGACY_KEYS.has(key) ? 2 : key.startsWith(BACKUP_PREFIX) ? 3 : 4;
      return preferred(a.key) - preferred(b.key) || b.latestTimestamp - a.latestTimestamp || b.users.length - a.users.length;
    });
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return "日時情報なし";
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(timestamp));
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function previewNames(users) {
    const names = users.map(user => String(user?.name || "").trim()).filter(Boolean);
    const unique = [...new Set(names)];
    if (!unique.length) return "氏名情報なし";
    const preview = unique.slice(0, MAX_PREVIEW_NAMES).join("、");
    return unique.length > MAX_PREVIEW_NAMES ? `${preview} ほか${unique.length - MAX_PREVIEW_NAMES}名` : preview;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderEnvironment() {
    $("[data-origin]").textContent = window.location.origin;
    const warning = $("#origin-warning");
    if (window.location.hostname === EXPECTED_HOST && window.location.protocol === "https:") {
      warning.hidden = true;
      return;
    }
    warning.textContent = `このページは ${window.location.origin} の保存領域を確認しています。実データの救出には https://${EXPECTED_HOST}/hukusikanri/recovery.html を使ってください。`;
    warning.hidden = false;
  }

  function renderCandidates() {
    const list = $("#candidate-list");
    const table = $("#candidate-table-wrap");
    const empty = $("#empty-state");
    const exportAll = $("#btn-export-all");
    $("#candidate-count").textContent = String(candidates.length);
    exportAll.disabled = candidates.length === 0;
    list.innerHTML = "";

    if (!candidates.length) {
      table.hidden = true;
      empty.hidden = false;
      $("#result-summary").textContent = "本システム形式のデータ配列は見つかりませんでした。";
      return;
    }

    table.hidden = false;
    empty.hidden = true;
    const totalRecords = candidates.reduce((sum, item) => sum + item.users.length, 0);
    $("#result-summary").textContent = `候補内に延べ${totalRecords}件あります。件数と氏名を確認し、先に一括保存してください。`;
    list.innerHTML = candidates.map((candidate, index) => `
      <tr>
        <td>
          <span class="candidate-title">${escapeHtml(candidate.label)}</span>
          <span class="candidate-key">${escapeHtml(candidate.key)}</span>
          <span class="candidate-key">${escapeHtml(formatBytes(candidate.bytes))}</span>
        </td>
        <td><span class="count-badge">${candidate.users.length}件</span></td>
        <td>${escapeHtml(formatDateTime(candidate.latestTimestamp))}</td>
        <td class="names-preview">${escapeHtml(previewNames(candidate.users))}</td>
        <td><button type="button" class="btn secondary" data-export-index="${index}">この候補を保存</button></td>
      </tr>
    `).join("");
  }

  function fileStamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  function safeFilePart(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
  }

  function downloadJson(fileName, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function candidatePayload(candidate) {
    return {
      format: "hukusikanri-browser-recovery-v1",
      capturedAt: new Date().toISOString(),
      origin: window.location.origin,
      key: candidate.key,
      label: candidate.label,
      sourceType: candidate.sourceType,
      recordCount: candidate.users.length,
      users: candidate.users,
      raw: candidate.raw
    };
  }

  function exportCandidate(index) {
    const candidate = candidates[index];
    if (!candidate) return;
    downloadJson(
      `hukusikanri_recovery_${safeFilePart(candidate.key)}_${fileStamp()}.json`,
      candidatePayload(candidate)
    );
  }

  function exportAllCandidates() {
    if (!candidates.length) return;
    downloadJson(`hukusikanri_recovery_all_${fileStamp()}.json`, {
      format: "hukusikanri-browser-recovery-package-v1",
      capturedAt: new Date().toISOString(),
      origin: window.location.origin,
      candidateCount: candidates.length,
      candidates: candidates.map(candidatePayload)
    });
  }

  function rescan() {
    candidates = scanCandidates();
    renderCandidates();
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-export-index]");
    if (!button) return;
    exportCandidate(Number(button.dataset.exportIndex));
  });

  $("#btn-rescan").addEventListener("click", rescan);
  $("#btn-export-all").addEventListener("click", exportAllCandidates);
  renderEnvironment();
  rescan();
})();
