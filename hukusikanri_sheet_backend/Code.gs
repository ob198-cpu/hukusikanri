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
  history: {
    name: 'History',
    headers: ['userId', 'name', 'at', 'action', 'detail']
  },
  state: {
    name: 'State',
    headers: ['key', 'value', 'updatedAt']
  }
};

function doGet() {
  ensureAllSheets_();
  return json_({ ok: true, status: 'ready', spreadsheetId: SPREADSHEET_ID });
}

function doPost(e) {
  try {
    ensureAllSheets_();
    const request = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (request.action !== 'saveUsers') throw new Error('Unsupported action: ' + request.action);
    const users = Array.isArray(request.users) ? request.users : [];
    saveUsers_(users, request.savedAt || new Date().toISOString());
    return json_({ ok: true, saved: users.length, savedAt: new Date().toISOString() });
  } catch (error) {
    return json_({ ok: false, error: error.message || String(error) });
  }
}

function saveUsers_(users, sourceSavedAt) {
  writeRows_(SHEETS.users, users.map(userRow_));
  writeRows_(SHEETS.deadlines, users.flatMap(deadlineRows_));
  writeRows_(SHEETS.monitoring, users.flatMap(monitoringRows_));
  writeRows_(SHEETS.history, users.flatMap(historyRows_).slice(-5000));
  writeRows_(SHEETS.state, [['lastSave', sourceSavedAt || '', new Date().toISOString()]]);
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
  rows.push([user.id || '', user.name || '', '計画相談', '計画相談', user.planStart || '', user.planEnd || '', '', '']);
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

function bool_(value) {
  return value === true;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
