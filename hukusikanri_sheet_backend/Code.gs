const SPREADSHEET_ID = '1DNvKBKSmnKg7eU0T7T_46Qz5ib1phGFzG8yxdPQCUyw';
const ACCESS_HASH_PROPERTY = 'WELFARE_ACCESS_PASSWORD_SHA256';
const DEFAULT_ACCESS_HASH = '9af712cb3d7e9703631b41c37afc000805966fa4aca533ec3b231ccbf625a2bc';

const SHEETS = {
  users: {
    name: 'Users',
    headers: ['id', 'name', 'kana', 'status', 'recipientNo', 'wardName', 'municipalCode', 'planStart', 'planEnd', 'monitoringCycle', 'updatedAt', 'json']
  },
  deadlines: {
    name: 'Deadlines',
    headers: ['userId', 'name', 'group', 'type', 'start', 'end', 'office', 'level']
  },
  monitoring: {
    name: 'MonitoringRecords',
    headers: ['userId', 'name', 'month', 'recordDone', 'meetingDone', 'reportDone', 'mailed', 'returned', 'officeSent', 'billingDone', 'billingSent', 'noticeSent', 'json']
  },
  renewalTasks: {
    name: 'RenewalTasks',
    headers: ['userId', 'name', 'task', 'done', 'completed', 'completedForDate', 'due', 'updatedAt']
  },
  history: {
    name: 'History',
    headers: ['userId', 'name', 'at', 'action', 'detail']
  },
  conflicts: {
    name: 'SyncConflicts',
    headers: ['at', 'userId', 'name', 'area', 'serverUpdatedAt', 'incomingUpdatedAt', 'resolution']
  },
  state: {
    name: 'State',
    headers: ['key', 'value', 'updatedAt']
  },
  syncAudit: {
    name: 'SyncAudit',
    headers: ['at', 'action', 'clientId', 'expectedRevision', 'previousRevision', 'newRevision', 'incomingUsers', 'storedUsers', 'conflicts', 'staleClient']
  }
};

function doGet() {
  return json_({ ok: true, status: 'ready', requiresAuth: true });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const request = JSON.parse((e.postData && e.postData.contents) || '{}');
    assertAuthenticated_(request.accessPassword || '');
    if (request.action === 'authenticate') {
      return json_({ ok: true, authenticated: true });
    }

    lock.waitLock(30000);
    locked = true;
    ensureAllSheets_();

    if (request.action === 'getUsers') {
      const state = readState_();
      return json_({
        ok: true,
        users: readStoredUsers_(),
        revision: state.revision || '',
        saveStatus: state.status || 'ready',
        spreadsheetId: SPREADSHEET_ID
      });
    }

    if (request.action !== 'saveUsers') throw new Error('Unsupported action: ' + request.action);
    const users = Array.isArray(request.users) ? request.users : [];
    const state = readState_();
    const previousRevision = state.revision || '';
    const expectedRevision = String(request.expectedRevision || '');
    const staleClient = Boolean(expectedRevision && previousRevision && expectedRevision !== previousRevision);
    const merged = mergeUserSets_(readStoredUsers_(), users);
    const newRevision = newRevision_();
    saveUsers_(merged.users, request.savedAt || new Date().toISOString(), newRevision);
    if (merged.conflicts.length) appendRows_(SHEETS.conflicts, merged.conflicts);
    appendRows_(SHEETS.syncAudit, [[
      new Date().toISOString(),
      'saveUsers',
      String(request.clientId || ''),
      expectedRevision,
      previousRevision,
      newRevision,
      users.length,
      merged.users.length,
      merged.conflicts.length,
      staleClient
    ]]);
    return json_({
      ok: true,
      saved: merged.users.length,
      conflicts: merged.conflicts.length,
      staleClient: staleClient,
      revision: newRevision,
      users: merged.users,
      savedAt: new Date().toISOString()
    });
  } catch (error) {
    return json_({ ok: false, error: error.message || String(error) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function saveUsers_(users, sourceSavedAt, revision) {
  const now = new Date().toISOString();
  writeRows_(SHEETS.state, [['status', 'saving', now], ['revision', readState_().revision || '', now]]);
  writeRows_(SHEETS.users, users.map(userRow_));
  writeRows_(SHEETS.deadlines, users.flatMap(deadlineRows_));
  writeRows_(SHEETS.monitoring, users.flatMap(monitoringRows_));
  writeRows_(SHEETS.renewalTasks, users.flatMap(renewalTaskRows_));
  writeRows_(SHEETS.history, users.flatMap(historyRows_).slice(-5000));
  writeRows_(SHEETS.state, [
    ['status', 'ready', now],
    ['revision', revision || newRevision_(), now],
    ['lastSave', sourceSavedAt || '', now],
    ['lastServerSave', now, now]
  ]);
}

function readState_() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.state.name);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  return values.reduce(function(state, row) {
    if (row[0]) state[String(row[0])] = String(row[1] || '');
    return state;
  }, {});
}

function newRevision_() {
  return new Date().toISOString() + '-' + Utilities.getUuid().slice(0, 8);
}

function assertAuthenticated_(password) {
  const expected = PropertiesService.getScriptProperties().getProperty(ACCESS_HASH_PROPERTY) || DEFAULT_ACCESS_HASH;
  if (!password || sha256_(password) !== expected) throw new Error('認証に失敗しました。');
}

function sha256_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ''),
    Utilities.Charset.UTF_8
  ).map(function(byte) {
    const normalized = byte < 0 ? byte + 256 : byte;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('');
}

function readStoredUsers_() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.users.name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEETS.users.headers.length).getValues()
    .map(function(row) {
      try { return JSON.parse(row[11] || '{}'); } catch (error) { return {}; }
    })
    .filter(function(user) { return user && user.id; });
}

function mergeUserSets_(storedUsers, incomingUsers) {
  const stored = {};
  const incoming = {};
  const conflicts = [];
  storedUsers.forEach(function(user) { if (user && user.id) stored[user.id] = user; });
  incomingUsers.forEach(function(user) { if (user && user.id) incoming[user.id] = user; });
  const ids = {};
  Object.keys(stored).forEach(function(id) { ids[id] = true; });
  Object.keys(incoming).forEach(function(id) { ids[id] = true; });
  const users = Object.keys(ids).map(function(id) {
    if (!stored[id]) return incoming[id];
    if (!incoming[id]) return stored[id];
    return mergeUser_(stored[id], incoming[id], conflicts);
  });
  return { users: users, conflicts: conflicts };
}

function mergeUser_(serverUser, incomingUser, conflicts) {
  const serverTime = timestamp_(serverUser.updatedAt);
  const incomingTime = timestamp_(incomingUser.updatedAt);
  const incomingIsNewer = incomingTime >= serverTime;
  const winner = clone_(incomingIsNewer ? incomingUser : serverUser);
  const older = incomingIsNewer ? serverUser : incomingUser;

  winner.checks = mergeNamedRecords_(serverUser.checks, incomingUser.checks);
  winner.monitoringRecords = mergeNamedRecords_(serverUser.monitoringRecords, incomingUser.monitoringRecords);
  winner.agencyNotices = mergeNamedRecords_(serverUser.agencyNotices, incomingUser.agencyNotices);
  winner.deadlineCompletions = mergeNamedRecords_(serverUser.deadlineCompletions, incomingUser.deadlineCompletions);
  winner.history = mergeHistory_(serverUser.history, incomingUser.history);
  winner.updatedAt = incomingIsNewer ? (incomingUser.updatedAt || serverUser.updatedAt || '') : (serverUser.updatedAt || incomingUser.updatedAt || '');

  if (serverTime && incomingTime && serverTime !== incomingTime) {
    conflicts.push([
      new Date().toISOString(),
      winner.id || '',
      winner.name || '',
      'basic-user-fields',
      serverUser.updatedAt || '',
      incomingUser.updatedAt || '',
      incomingIsNewer ? 'incoming-newer-won; task and monitoring records merged' : 'server-newer-kept; task and monitoring records merged'
    ]);
  }
  return winner;
}

function mergeNamedRecords_(serverRecords, incomingRecords) {
  const server = serverRecords || {};
  const incoming = incomingRecords || {};
  const keys = {};
  Object.keys(server).forEach(function(key) { keys[key] = true; });
  Object.keys(incoming).forEach(function(key) { keys[key] = true; });
  const result = {};
  Object.keys(keys).forEach(function(key) {
    const a = server[key];
    const b = incoming[key];
    if (!a) { result[key] = b; return; }
    if (!b) { result[key] = a; return; }
    result[key] = timestamp_(b.changedAt || b.completed) >= timestamp_(a.changedAt || a.completed) ? b : a;
  });
  return result;
}

function mergeHistory_(serverHistory, incomingHistory) {
  const seen = {};
  return (serverHistory || []).concat(incomingHistory || []).filter(function(item) {
    const key = [item.at || '', item.action || '', item.detail || ''].join('|');
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).sort(function(a, b) { return timestamp_(a.at) - timestamp_(b.at); }).slice(-10000);
}

function timestamp_(value) {
  const time = new Date(value || 0).getTime();
  return isNaN(time) ? 0 : time;
}

function clone_(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function userRow_(user) {
  return [
    user.id || '',
    user.name || '',
    user.kana || '',
    user.status || 'active',
    user.recipientNo || '',
    user.wardName || '',
    user.municipalCode || '',
    user.planStart || '',
    user.planEnd || '',
    user.monitoringCycle || '',
    user.updatedAt || '',
    JSON.stringify(user || {})
  ];
}

function deadlineRows_(user) {
  const rows = [];
  rows.push([user.id || '', user.name || '', 'plan', 'plan-support', user.planStart || '', user.planEnd || '', '', '']);
  ['training1', 'training2', 'care1', 'care2'].forEach(function(group) {
    (user[group] || []).forEach(function(item) {
      rows.push([
        user.id || '',
        user.name || '',
        group,
        item.type || '',
        item.start || '',
        item.end || '',
        item.office || '',
        item.level || ''
      ]);
    });
  });
  return rows.filter(function(row) { return row[4] || row[5] || row[3]; });
}

function renewalTaskRows_(user) {
  const checks = user.checks || {};
  const labels = {
    document: '書類作成',
    send: '役所送付',
    confirm: '本人受給者交付確認',
    pdf: '受給者証の写し保存',
    updateInfo: '個人シートの更新'
  };
  return Object.keys(labels).map(function(key) {
    const task = checks[key] || {};
    return [
      user.id || '',
      user.name || '',
      labels[key],
      bool_(task.done),
      task.completed || '',
      task.completedForDate || '',
      task.due || user.planEnd || '',
      user.updatedAt || ''
    ];
  });
}

function monitoringRows_(user) {
  const records = user.monitoringRecords || {};
  const notices = user.agencyNotices || {};
  return Object.keys(records).map(function(month) {
    const record = records[month] || {};
    const notice = notices[month] || {};
    return [
      user.id || '',
      user.name || '',
      month,
      bool_(record.recordDone),
      bool_(record.meetingDone),
      bool_(record.reportDone),
      bool_(record.mailed),
      bool_(record.returned),
      bool_(record.officeSent),
      bool_(record.billingDone),
      bool_(record.billingSent),
      bool_(notice.noticeSent),
      JSON.stringify({ record: record, notice: notice })
    ];
  });
}

function historyRows_(user) {
  return (user.history || []).map(function(item) {
    return [
      user.id || '',
      user.name || '',
      item.at || '',
      item.action || '',
      item.detail || ''
    ];
  });
}

function ensureAllSheets_() {
  Object.keys(SHEETS).forEach(function(key) {
    ensureSheet_(SHEETS[key]);
  });
}

function ensureSheet_(def) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(def.name);
  if (!sheet) sheet = ss.insertSheet(def.name);
  if (sheet.getLastRow() === 0) sheet.appendRow(def.headers);
}

function writeRows_(def, rows) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(def.name);
  sheet.clearContents();
  sheet.appendRow(def.headers);
  if (rows.length) sheet.getRange(2, 1, rows.length, def.headers.length).setValues(rows);
}

function appendRows_(def, rows) {
  if (!rows.length) return;
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(def.name);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, def.headers.length).setValues(rows);
}

function bool_(value) {
  return value === true;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function jsonp_(callback, payload) {
  if (!/^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(callback)) return json_({ ok: false, error: 'Invalid callback' });
  return ContentService.createTextOutput(callback + '(' + JSON.stringify(payload) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
