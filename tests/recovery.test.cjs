const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const recoverySource = fs.readFileSync(path.join(__dirname, "..", "recovery.js"), "utf8");

class MemoryStorage {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  get length() {
    return this.entries.size;
  }

  key(index) {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key) {
    return this.entries.has(key) ? this.entries.get(key) : null;
  }
}

function element() {
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    listeners: {},
    addEventListener(type, callback) {
      this.listeners[type] = callback;
    }
  };
}

function runRecovery(entries, location = {
  origin: "https://ob198-cpu.github.io",
  hostname: "ob198-cpu.github.io",
  protocol: "https:"
}) {
  const elements = Object.fromEntries([
    "[data-origin]",
    "#origin-warning",
    "#candidate-list",
    "#candidate-table-wrap",
    "#empty-state",
    "#btn-export-all",
    "#candidate-count",
    "#result-summary",
    "#btn-rescan"
  ].map(selector => [selector, element()]));
  let downloadedBlob = null;
  let downloadedName = "";
  const fakeUrl = {
    createObjectURL(blob) {
      downloadedBlob = blob;
      return "blob:test";
    },
    revokeObjectURL() {}
  };
  const documentListeners = {};
  const document = {
    body: {
      appendChild() {}
    },
    querySelector(selector) {
      return elements[selector] || null;
    },
    addEventListener(type, callback) {
      documentListeners[type] = callback;
    },
    createElement(tagName) {
      assert.equal(tagName, "a");
      return {
        href: "",
        download: "",
        click() {
          downloadedName = this.download;
        },
        remove() {}
      };
    }
  };
  const context = {
    console,
    document,
    localStorage: new MemoryStorage(entries),
    window: {
      location,
      setTimeout(callback) {
        callback();
      }
    },
    URL: fakeUrl,
    Blob,
    Intl,
    Date,
    JSON,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number
  };
  vm.runInNewContext(recoverySource, context, { filename: "recovery.js" });
  return {
    elements,
    documentListeners,
    getDownloadedBlob: () => downloadedBlob,
    getDownloadedName: () => downloadedName
  };
}

async function main() {
  const fixture = {
    welfare_users_static_v2: JSON.stringify([
      { id: "current-1", name: "現行一郎", recipientNo: "100001", updatedAt: "2026-07-15T01:00:00Z" }
    ]),
    welfare_users_v1: JSON.stringify([
      { id: "legacy-1", name: "旧版一郎", planEnd: "2026-08-01" },
      { id: "legacy-2", name: "旧版二郎", planEnd: "2026-09-01" },
      { id: "legacy-3", name: "旧版三郎", planEnd: "2026-10-01" }
    ]),
    "welfare_users_backup_2026-06-01T09-00-00": JSON.stringify([
      { id: "backup-1", name: "控え一郎", checks: {} },
      { id: "backup-2", name: "控え二郎", checks: {} }
    ]),
    welfare_google_sheet_pending_v1: JSON.stringify({
      savedAt: "2026-07-14T11:30:00Z",
      users: [
        { id: "pending-1", name: "同期一郎", monitoringRecords: {} },
        { id: "pending-2", name: "同期二郎", monitoringRecords: {} },
        { id: "pending-3", name: "同期三郎", monitoringRecords: {} },
        { id: "pending-4", name: "同期四郎", monitoringRecords: {} }
      ]
    }),
    compatible_unknown_key: JSON.stringify([{ name: "互換一郎", recipientEnd: "2026-12-31" }]),
    unrelated_app_data: JSON.stringify([{ name: "対象外" }])
  };

  const populated = runRecovery(fixture);
  assert.equal(populated.elements["#candidate-count"].textContent, "5");
  assert.equal(populated.elements["#candidate-table-wrap"].hidden, false);
  assert.equal(populated.elements["#empty-state"].hidden, true);
  assert.equal(populated.elements["#btn-export-all"].disabled, false);
  assert.match(populated.elements["#candidate-list"].innerHTML, /現在表示中の保存データ/);
  assert.match(populated.elements["#candidate-list"].innerHTML, /未送信のシート同期データ/);
  assert.match(populated.elements["#candidate-list"].innerHTML, /旧版三郎/);
  assert.match(populated.elements["#candidate-list"].innerHTML, /4件/);
  const backupRow = populated.elements["#candidate-list"].innerHTML.match(/<tr>[\s\S]*?日付付きバックアップ[\s\S]*?<\/tr>/)?.[0] || "";
  assert.match(backupRow, /2026\/06\/01 09:00/);
  assert.doesNotMatch(populated.elements["#candidate-list"].innerHTML, /対象外/);

  populated.elements["#btn-export-all"].listeners.click();
  assert.match(populated.getDownloadedName(), /^hukusikanri_recovery_all_/);
  const exported = JSON.parse(await populated.getDownloadedBlob().text());
  assert.equal(exported.format, "hukusikanri-browser-recovery-package-v1");
  assert.equal(exported.candidateCount, 5);
  assert.equal(exported.candidates.find(item => item.key === "welfare_users_v1").recordCount, 3);

  const empty = runRecovery({ unrelated: JSON.stringify([{ name: "対象外" }]) });
  assert.equal(empty.elements["#candidate-count"].textContent, "0");
  assert.equal(empty.elements["#candidate-table-wrap"].hidden, true);
  assert.equal(empty.elements["#empty-state"].hidden, false);
  assert.equal(empty.elements["#btn-export-all"].disabled, true);

  const wrongOrigin = runRecovery({}, {
    origin: "file://",
    hostname: "",
    protocol: "file:"
  });
  assert.equal(wrongOrigin.elements["#origin-warning"].hidden, false);
  assert.match(wrongOrigin.elements["#origin-warning"].textContent, /ob198-cpu\.github\.io/);

  console.log("recovery.test.cjs: all assertions passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
