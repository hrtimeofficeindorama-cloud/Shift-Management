/**
 * DailyImportBridge.gs — load after DailyLeaveModel.gs
 * Converts range leave objects into daily rows.
 * Leave Type always normalized via normalizeLeaveTypeToPolicy_().
 */

function normalizeLeaveTypeToPolicy_(raw) {
  var s = String(raw || '').trim();
  if (!s) return 'Annual Leave';
  var low = s.toLowerCase().replace(/[_\/]+/g, ' ').replace(/\s+/g, ' ').trim();

  var canonical = [
    'Annual Leave', 'Casual Leave', 'Medical Leave', 'Leave of Absence',
    'Sick Leave', 'Probation Leave', 'Compassionate Leave', 'Examination Leave',
    'Maternity Leave', 'Official Leave', 'Study Leave'
  ];
  for (var i = 0; i < canonical.length; i++) {
    if (low === canonical[i].toLowerCase()) return canonical[i];
  }

  var rules = [
    [/leave\s*of\s*absence|\babsence\b/, 'Leave of Absence'],
    [/\bcompassionate\b|\bcompass\b/, 'Compassionate Leave'],
    [/\bexamination\b|\bexam\b/, 'Examination Leave'],
    [/\bmaternity\b/, 'Maternity Leave'],
    [/\bprobation\b/, 'Probation Leave'],
    [/\bofficial\b/, 'Official Leave'],
    [/\bmedical\b/, 'Medical Leave'],
    [/\bsick\b/, 'Sick Leave'],
    [/\bcasual\b/, 'Casual Leave'],
    [/\bstudy\b/, 'Study Leave'],
    [/\bannual\b|\bal\b/, 'Annual Leave']
  ];
  for (var r = 0; r < rules.length; r++) {
    if (rules[r][0].test(low)) return rules[r][1];
  }

  if (!/\bleave\b/i.test(s)) s = s + ' Leave';
  return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function importRangeLeavesAsDaily_(rangeLeaves, sourceLabel) {
  Logger.log('importRangeLeavesAsDaily_ from ' + (sourceLabel || 'source') +
    ': ' + (rangeLeaves ? rangeLeaves.length : 0) + ' range apps');
  ensureDailyTblLeaveSchema_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('tblLeave');
  var allDaily = [];
  for (var i = 0; i < (rangeLeaves || []).length; i++) {
    var L = rangeLeaves[i];
    var rawType = L.leaveType || L.type || '';
    var normType = normalizeLeaveTypeToPolicy_(rawType);
    if (String(rawType).trim() && String(rawType).trim() !== normType) {
      Logger.log('Leave type map: "' + rawType + '" → "' + normType + '"');
    }
    var rows = expandLeaveApplicationToDailyRows_(
      L.entryCode || L.entry || '',
      L.empId || L.emp || '',
      normType,
      L.startDate || L.start,
      L.endDate || L.end || L.startDate || L.start,
      L.leaveReason || L.reason || ''
    );
    for (var j = 0; j < rows.length; j++) allDaily.push(rows[j]);
  }
  var result = appendDailyLeaveRows_(sheet, allDaily, null);
  Logger.log('importRangeLeavesAsDaily_ appended=' + result.appended +
    ' skippedDup=' + result.skipped);
  return {
    success: true,
    message: (sourceLabel || 'Import') + ': +' + result.appended +
      ' daily rows (skipped dup ' + result.skipped + ')',
    appended: result.appended,
    skipped: result.skipped
  };
}

function submitLeaveApplicationDaily(payload) {
  if (!payload || !payload.empId || !payload.startDate) {
    return { success: false, message: 'empId and startDate required' };
  }
  var entry = payload.entryCode || (
    'UI-' + String(payload.empId).toUpperCase() + '-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss')
  );
  var rows = expandLeaveApplicationToDailyRows_(
    entry,
    payload.empId,
    normalizeLeaveTypeToPolicy_(payload.leaveType || 'Annual Leave'),
    payload.startDate,
    payload.endDate || payload.startDate,
    payload.leaveReason || ''
  );
  ensureDailyTblLeaveSchema_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('tblLeave');
  var result = appendDailyLeaveRows_(sheet, rows, null);
  if (result.appended && typeof calculateLeaveUtilized === 'function') {
    try { calculateLeaveUtilized(); } catch (e) {
      Logger.log('post-submit recalc: ' + e.message);
    }
  }
  return {
    success: result.appended > 0,
    message: result.appended
      ? ('Leave saved: ' + result.appended + ' day(s)' +
          (result.skipped ? ', ' + result.skipped + ' day(s) already existed' : ''))
      : ('No new days saved (all ' + result.skipped + ' already on file)'),
    entryCode: entry,
    appended: result.appended,
    skipped: result.skipped
  };
}

/** One-time: rewrite existing tblLeave Leave Type values to policy names. */
function normalizeAllTblLeaveTypes() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('tblLeave');
  if (!sheet || sheet.getLastRow() < 2) {
    return { success: false, message: 'tblLeave empty or missing' };
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h || '').trim(); });
  var iType = headers.indexOf('Leave Type');
  if (iType < 0) return { success: false, message: 'Leave Type column missing' };

  var n = sheet.getLastRow() - 1;
  var col = sheet.getRange(2, iType + 1, n, 1).getValues();
  var fixed = 0;
  for (var i = 0; i < col.length; i++) {
    var raw = col[i][0];
    var norm = normalizeLeaveTypeToPolicy_(raw);
    if (String(raw || '').trim() !== norm) {
      col[i][0] = norm;
      fixed++;
    }
  }
  if (fixed) {
    sheet.getRange(2, iType + 1, n, 1).setValues(col);
    SpreadsheetApp.flush();
  }
  var msg = 'normalizeAllTblLeaveTypes: fixed ' + fixed + ' of ' + n + ' row(s)';
  Logger.log(msg);
  return { success: true, message: msg, fixed: fixed, total: n };
}
