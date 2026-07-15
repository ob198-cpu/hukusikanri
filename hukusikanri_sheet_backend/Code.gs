const SPREADSHEET_ID = '1DNvKBKSmnKg7eU0T7T_46Qz5ib1phGFzG8yxdPQCUyw';

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
  }
};

function doGet(e) {
  ensureAllSheets_();
  const action = (e && e.parameter && e.parameter.action) || '';
  const payload = action === 'getUsers'
    ? { ok: true, users: readStoredUsers_(), spreadsheetId: SPREADSHEET_ID }
    : { ok: true, status: 'ready', spreadsheetId: SPREADSHEET_ID };
  const callback = e && e.parameter && e.parameter.callback;
  return callback ? jsonp_(callback, payload) : json_(payload);
}

function doPost(e) {
  try {
    ensureAllSheets_();
    const request = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (request.action !== 'saveUsers') throw new Error('Unsupported action: ' + request.action);
    const users = Array.isArray(request.users) ? request.users : [];
    const merged = mergeUserSets_(readStoredUsers_(), users);
    saveUsers_(merged.users, request.savedAt || new Date().toISOString());
    if (merged.conflicts.length) appendRows_(SHEETS.conflicts, merged.conflicts);
    return json_({ ok: true, saved: merged.users.length, conflicts: merged.conflicts.length, savedAt: new Date().toISOString() });
  } catch (error) {
    return json_({ ok: false, error: error.message || String(error) });
  }
}

function saveUsers_(users, sourceSavedAt) {
  writeRows_(SHEETS.users, users.map(userRow_));
  writeRows_(SHEETS.deadlines, users.flatMap(deadlineRows_));
  writeRows_(SHEETS.monitoring, users.flatMap(monitoringRows_));
  writeRows_(SHEETS.renewalTasks, users.flatMap(renewalTaskRows_));
  writeRows_(SHEETS.history, users.flatMap(historyRows_).slice(-5000));
  writeRows_(SHEETS.state, [['lastSave', sourceSavedAt || '', new Date().toISOString()]]);
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
