/**
 * Shared storage, employee directory, roster calculation and audit helpers.
 */
var SHIFT_TABLE_HEADERS = {};
SHIFT_TABLE_HEADERS["Shift_Assignments"] = [
  "Assignment ID", "Group ID", "Emp ID", "Pattern Name", "Effective Start Date",
  "Effective End Date", "Status", "Created By", "Created At", "Notes"
];
SHIFT_TABLE_HEADERS["Shift_Overrides"] = [
  "Override ID", "Emp ID", "Shift Date", "Shift Code", "Source", "Reason",
  "Related Request ID", "Created By", "Created At", "Previous Shift", "Status"
];
SHIFT_TABLE_HEADERS["Shift_Swap_Requests"] = [
  "Request ID", "Requester ID", "Partner ID", "Shift Date", "Requester Original Shift",
  "Partner Original Shift", "Status", "Partner Decision", "SIC Approver IDs",
  "Manager Approver IDs", "SIC Decisions JSON", "Manager Decisions JSON",
  "Created By", "Created At", "Partner Responded At", "Completed At", "Comments"
];
SHIFT_TABLE_HEADERS["Shift_Audit"] = [
  "Audit ID", "Actor ID", "Action", "Employee IDs", "Effective Dates",
  "Old Values", "New Values", "Details", "Timestamp", "Outcome"
];
SHIFT_TABLE_HEADERS["Shift_Downliner_Requests"] = [
  "Request ID", "Requester ID", "Requester Role", "Employee ID", "Class",
  "Action", "Status", "Created At", "Decided By", "Decided At", "Comments"
];
SHIFT_TABLE_HEADERS["Shift_Swap_Approval_Links"] = [
  "Link ID", "Token Hash", "Request ID", "Approver ID", "Approver Type", "Decision",
  "Expires At", "Status", "Created At", "Used At"
];

function ensureAllTables_() {
  var ss = SpreadsheetApp.openById(SHIFT_APP_CONFIG.SPREADSHEET_ID);
  var employeeSheet = ss.getSheetByName(SHIFT_APP_CONFIG.EMPLOYEE_SHEET);
  if (!employeeSheet) throw new Error("Employee sheet '" + SHIFT_APP_CONFIG.EMPLOYEE_SHEET + "' was not found.");
  ensureEmployeeColumns_(employeeSheet);
  Object.keys(SHIFT_TABLE_HEADERS).forEach(function(name) {
    ensureTableSheet_(getSpreadsheetForTable_(name), name, SHIFT_TABLE_HEADERS[name]);
  });
}

function ensureEmployeeColumns_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) throw new Error("Emp_List must contain its employee headers in row 1.");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var additions = [];
  var required = [
    { name: "Role", aliases: ["Role", "Roles", "Access Role"] },
    { name: "SIC", aliases: ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"] },
    { name: "L1 Manager", aliases: ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"] },
    { name: "Password", aliases: ["Password", "Password Hash", "Login Password"] },
    { name: "Secret Question", aliases: ["Secret Question", "Security Question", "Recovery Question"] },
    { name: "Secret Answer Hash", aliases: ["Secret Answer Hash"] }
  ];
  required.forEach(function(item) {
    if (!findHeaderName_(headers, item.aliases)) additions.push(item.name);
  });
  if (additions.length) {
    sheet.getRange(1, headers.length + 1, 1, additions.length).setValues([additions]);
    sheet.setFrozenRows(1);
  }
}

function ensureTableSheet_(ss, name, requiredHeaders) {
  var sheet = name === SHIFT_APP_CONFIG.TABLES.AUDIT && SHIFT_APP_CONFIG.AUDIT_SHEET_ID
    ? ss.getSheetById(Number(SHIFT_APP_CONFIG.AUDIT_SHEET_ID))
    : null;
  if (!sheet) sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    sheet.setFrozenRows(1);
    return;
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var add = requiredHeaders.filter(function(h) {
    return !headers.some(function(existing) { return norm_(existing) === norm_(h); });
  });
  if (add.length) sheet.getRange(1, headers.length + 1, 1, add.length).setValues([add]);
  sheet.setFrozenRows(1);
}

function openEmployeeSheet_() {
  var sheet = SpreadsheetApp.openById(SHIFT_APP_CONFIG.SPREADSHEET_ID).getSheetByName(SHIFT_APP_CONFIG.EMPLOYEE_SHEET);
  if (!sheet) throw new Error("Employee sheet was not found.");
  return sheet;
}

function getSpreadsheetForTable_(name) {
  var spreadsheetId = name === SHIFT_APP_CONFIG.TABLES.AUDIT
    ? SHIFT_APP_CONFIG.AUDIT_SPREADSHEET_ID
    : SHIFT_APP_CONFIG.SPREADSHEET_ID;
  return SpreadsheetApp.openById(spreadsheetId || SHIFT_APP_CONFIG.SPREADSHEET_ID);
}

function tableSheet_(name) {
  var ss = getSpreadsheetForTable_(name);
  var sheet = name === SHIFT_APP_CONFIG.TABLES.AUDIT && SHIFT_APP_CONFIG.AUDIT_SHEET_ID
    ? ss.getSheetById(Number(SHIFT_APP_CONFIG.AUDIT_SHEET_ID))
    : null;
  if (!sheet) sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("Missing data sheet '" + name + "'. Run setupShiftManagement() first.");
  return sheet;
}

function getEmployees_() {
  var sheet = openEmployeeSheet_();
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getDisplayValues();
  var headers = values[0].map(function(h) { return String(h).trim(); });
  var result = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var obj = { __rowNum: i + 1 };
    headers.forEach(function(h, idx) { obj[h] = row[idx]; });
    var id = getEmpValue_(obj, ["Emp ID", "Employee ID", "Employee No", "Staff ID", "Employee Number"]);
    if (String(id || "").trim()) result.push(obj);
  }
  return result;
}

function findEmployeeById_(empId) {
  var needle = norm_(empId);
  if (!needle) return null;
  var employees = getEmployees_();
  for (var i = 0; i < employees.length; i++) {
    var id = getEmpValue_(employees[i], ["Emp ID", "Employee ID", "Employee No", "Staff ID", "Employee Number"]);
    if (norm_(id) === needle) return employees[i];
  }
  return null;
}

function findEmployeeByIdentity_(identity) {
  var needle = norm_(identity);
  if (!needle) return null;
  var employees = getEmployees_();
  for (var i = 0; i < employees.length; i++) {
    var emp = employees[i];
    var vals = [
      getEmpValue_(emp, ["Emp ID", "Employee ID", "Employee No", "Staff ID", "Employee Number"]),
      getEmpValue_(emp, ["Emp Name", "Employee Name", "Full Name", "Name"]),
      getEmpValue_(emp, ["Official Email", "Official Email Id", "Work Email"]),
      getEmpValue_(emp, ["Personal Email", "Personal Email Id", "Email"])
    ];
    for (var j = 0; j < vals.length; j++) if (norm_(vals[j]) === needle) return emp;
  }
  return null;
}

function getEmpValue_(emp, aliases) {
  if (!emp) return "";
  var actual = findHeaderName_(Object.keys(emp).filter(function(k) { return k !== "__rowNum"; }), aliases);
  return actual ? emp[actual] : "";
}

function findHeaderName_(headers, aliases) {
  var normalized = headers.map(function(h) { return { raw: h, norm: norm_(h) }; });
  for (var i = 0; i < aliases.length; i++) {
    var target = norm_(aliases[i]);
    for (var j = 0; j < normalized.length; j++) {
      if (normalized[j].norm === target) return normalized[j].raw;
    }
  }
  return "";
}

function norm_(value) {
  return String(value === null || value === undefined ? "" : value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function employeeId_(emp) {
  return String(getEmpValue_(emp, ["Emp ID", "Employee ID", "Emp No", "Staff ID", "Employee Number"]) || "").trim();
}

function employeeName_(emp) {
  return String(getEmpValue_(emp, ["Emp Name", "Employee Name", "Full Name", "Name"]) || "").trim();
}

function employeeClass_(emp) {
  var raw = String(getEmpValue_(emp, ["Class"]) || "").trim().toLowerCase();
  var classes = SHIFT_APP_CONFIG.CLASSES || ["National", "Expat", "Contract"];
  for (var i = 0; i < classes.length; i++) {
    if (raw === String(classes[i]).toLowerCase()) return classes[i];
  }
  return "";
}

function getEmployeesByClass_(className) {
  var selected = String(className || "").trim();
  if ((SHIFT_APP_CONFIG.CLASSES || []).indexOf(selected) < 0) {
    throw new Error("Select a valid employee class: " + (SHIFT_APP_CONFIG.CLASSES || []).join(", ") + ".");
  }
  return getEmployees_().filter(function(emp) { return employeeClass_(emp) === selected; });
}

function sameEmployeeClass_(a, b) {
  return !!a && !!b && !!employeeClass_(a) && employeeClass_(a) === employeeClass_(b);
}

function displayDate_(dateValue) {
  var iso = normalizeSheetDate_(dateValue);
  if (!iso) return "";
  try {
    return Utilities.formatDate(parseIsoDate_(iso), SHIFT_APP_CONFIG.TIME_ZONE, "dd/MMM/yyyy");
  } catch (err) {
    return String(dateValue || "");
  }
}

function employeeEmail_(emp) {
  return String(getEmpValue_(emp, ["Official Email", "Official Email Id", "Work Email", "Personal Email", "Personal Email Id", "Email"]) || "").trim();
}

function employeeEmails_(emp) {
  var work = String(getEmpValue_(emp, ["Official Email", "Official Email Id", "Work Email"]) || "").trim();
  var personal = String(getEmpValue_(emp, ["Personal Email", "Personal Email Id", "Email"]) || "").trim();
  return Array.from(new Set([work, personal].filter(function(x) { return x && x.indexOf("@") > 0; })));
}

function publicEmployee_(emp) {
  return {
    empId: employeeId_(emp), name: employeeName_(emp),
    department: String(getEmpValue_(emp, ["Department", "Departments Hierarchy 2 Name"]) || ""),
    businessUnit: String(getEmpValue_(emp, ["Business Unit", "Group Company Code"]) || ""),
    employeeClass: employeeClass_(emp),
    officialEmail: String(getEmpValue_(emp, ["Official Email", "Official Email Id", "Work Email"]) || ""),
    role: getRoles_(emp).join(", "), roles: getRoles_(emp),
    sic: String(getEmpValue_(emp, ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"]) || ""),
    manager: String(getEmpValue_(emp, ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"]) || "")
  };
}

function getRoles_(emp) {
  var raw = String(getEmpValue_(emp, ["Role", "Roles", "Access Role"]) || "").trim();
  if (!raw) return ["Employee"];
  var parts = raw.split(/[,;|]/).map(function(s) { return s.trim(); }).filter(Boolean);
  var result = [];
  parts.forEach(function(part) {
    var key = norm_(part);
    var role = "";
    if (key === "hr" || key === "superadmin" || key === "superadministrator") role = "HR";
    else if (key === "sic" || key === "shiftincharge") role = "SIC";
    else if (key === "l1manager" || key === "manager" || key === "linemanager") role = "L1 Manager";
    else if (key === "employee" || key === "staff" || key === "user") role = "Employee";
    if (role && result.indexOf(role) === -1) result.push(role);
  });
  return result.length ? result : ["Employee"];
}

function hasRole_(emp, role) {
  return getRoles_(emp).indexOf(role) !== -1;
}

function fieldReferencesEmployee_(fieldValue, emp) {
  if (!fieldValue || !emp) return false;
  var identities = [
    employeeId_(emp), employeeName_(emp),
    getEmpValue_(emp, ["Official Email", "Official Email Id", "Work Email"]),
    getEmpValue_(emp, ["Personal Email", "Personal Email Id", "Email"])
  ].map(norm_).filter(Boolean);
  var tokens = String(fieldValue).split(/[,;|]/).map(function(s) { return norm_(s); }).filter(Boolean);
  return tokens.some(function(token) { return identities.indexOf(token) !== -1; });
}

function getDownliners_(actor, employees) {
  var actorId = employeeId_(actor);
  return employees.filter(function(candidate) {
    if (employeeId_(candidate) === actorId) return false;
    var sic = getEmpValue_(candidate, ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"]);
    var manager = getEmpValue_(candidate, ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"]);
    return fieldReferencesEmployee_(sic, actor) || fieldReferencesEmployee_(manager, actor);
  });
}

function isAssignedSicTo_(target, actor) {
  return fieldReferencesEmployee_(
    getEmpValue_(target, ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"]), actor
  );
}

function canManageEmployee_(actor, target) {
  if (!actor || !target) return false;
  if (hasRole_(actor, "HR")) return true;
  return hasRole_(actor, "SIC") && isAssignedSicTo_(target, actor);
}

function sameImmediateUplineGroup_(a, b) {
  var aSic = splitIds_(getEmpValue_(a, ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"])).map(norm_);
  var bSic = splitIds_(getEmpValue_(b, ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"])).map(norm_);
  var aMgr = splitIds_(getEmpValue_(a, ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"])).map(norm_);
  var bMgr = splitIds_(getEmpValue_(b, ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"])).map(norm_);
  var sameSic = aSic.some(function(id) { return id && bSic.indexOf(id) !== -1; });
  var sameManager = aMgr.some(function(id) { return id && bMgr.indexOf(id) !== -1; });
  return sameSic || sameManager;
}

function getAllowedSwapPartners_(actor, employees) {
  var actorId = employeeId_(actor);
  var actorClass = employeeClass_(actor);
  if (!actorClass) return [];
  var direct = getDownliners_(actor, employees).filter(function(candidate) {
    return employeeClass_(candidate) === actorClass;
  });
  if (direct.length) return direct;
  return employees.filter(function(candidate) {
    return employeeId_(candidate) !== actorId &&
      employeeClass_(candidate) === actorClass &&
      sameImmediateUplineGroup_(actor, candidate);
  });
}

function datesForRange_(fromDate, toDate) {
  var from = parseIsoDate_(fromDate);
  var to = parseIsoDate_(toDate);
  if (to < from) throw new Error("End date must be on or after start date.");
  var days = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
  if (days > 366) throw new Error("Please request a maximum range of 366 calendar days at a time.");
  var list = [];
  for (var i = 0; i < days; i++) list.push(isoDate_(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, 12, 0, 0)));
  return list;
}

function todayISO_() {
  return Utilities.formatDate(new Date(), SHIFT_APP_CONFIG.TIME_ZONE, "yyyy-MM-dd");
}

function parseIsoDate_(str) {
  if (str instanceof Date) return new Date(str.getFullYear(), str.getMonth(), str.getDate(), 12, 0, 0);
  var text = String(str || "").trim();
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error("Date must use YYYY-MM-DD format.");
  var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new Error("Invalid calendar date: " + text);
  }
  return date;
}

function isoDate_(date) {
  return Utilities.formatDate(date, SHIFT_APP_CONFIG.TIME_ZONE, "yyyy-MM-dd");
}

function datePlusDays_(iso, number) {
  var date = parseIsoDate_(iso);
  date.setDate(date.getDate() + number);
  return isoDate_(date);
}

function getTableRows_(sheetName) {
  var sheet = tableSheet_(sheetName);
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  var data = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var records = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i].every(function(v) { return v === "" || v === null; })) continue;
    var row = { __rowNum: i + 1 };
    headers.forEach(function(h, idx) { row[h] = data[i][idx]; });
    records.push(row);
  }
  return records;
}

function appendObjects_(sheetName, objects) {
  if (!objects || !objects.length) return;
  var sheet = tableSheet_(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function(h) { return String(h).trim(); });
  var rows = objects.map(function(obj) {
    return headers.map(function(h) { return obj[h] === undefined || obj[h] === null ? "" : obj[h]; });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  if (sheetName === SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS || sheetName === SHIFT_APP_CONFIG.TABLES.OVERRIDES) invalidateShiftDataCache_();
}

function updateTableRecord_(sheetName, idHeader, idValue, updates) {
  var sheet = tableSheet_(sheetName);
  var records = getTableRows_(sheetName);
  var target = records.find(function(rec) { return String(rec[idHeader]) === String(idValue); });
  if (!target) throw new Error("Record not found: " + idValue);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function(h) { return String(h).trim(); });
  var row = sheet.getRange(target.__rowNum, 1, 1, headers.length).getValues()[0];
  Object.keys(updates).forEach(function(k) {
    var idx = headers.indexOf(k);
    if (idx >= 0) row[idx] = updates[k];
  });
  sheet.getRange(target.__rowNum, 1, 1, headers.length).setValues([row]);
  if (sheetName === SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS || sheetName === SHIFT_APP_CONFIG.TABLES.OVERRIDES) invalidateShiftDataCache_();
  return target;
}

function updateEmployeeFields_(emp, updates) {
  var sheet = openEmployeeSheet_();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function(h) { return String(h).trim(); });
  var rowValues = sheet.getRange(emp.__rowNum, 1, 1, headers.length).getValues()[0];
  Object.keys(updates).forEach(function(aliasListText) {
    var aliases = aliasListText.split("|");
    var found = findHeaderName_(headers, aliases);
    if (!found) throw new Error("Employee column missing: " + aliases[0]);
    rowValues[headers.indexOf(found)] = updates[aliasListText];
  });
  sheet.getRange(emp.__rowNum, 1, 1, headers.length).setValues([rowValues]);
}

function addAudit_(actorId, action, employeeIds, dates, oldValues, newValues, details, outcome) {
  appendObjects_(SHIFT_APP_CONFIG.TABLES.AUDIT, [{
    "Audit ID": Utilities.getUuid(), "Actor ID": String(actorId || ""), "Action": String(action || ""),
    "Employee IDs": Array.isArray(employeeIds) ? employeeIds.join(", ") : String(employeeIds || ""),
    "Effective Dates": Array.isArray(dates) ? dates.join(", ") : String(dates || ""),
    "Old Values": typeof oldValues === "string" ? oldValues : JSON.stringify(oldValues || ""),
    "New Values": typeof newValues === "string" ? newValues : JSON.stringify(newValues || ""),
    "Details": String(details || ""), "Timestamp": new Date(), "Outcome": String(outcome || "Success")
  }]);
}

function sendEmployeeNotice_(emp, subject, body, actionLinks) {
  var emails = employeeEmails_(emp);
  if (!emails.length) return;
  var plainBody = String(body || "") + "\n\nThis is an automated notification from Shift Management.";
  var options = {
    to: emails[0],
    subject: "[Shift Management] " + subject,
    body: plainBody,
    name: "Shift Management"
  };
  if (Array.isArray(actionLinks) && actionLinks.length) {
    var html = '<div style="font-family:Arial,sans-serif;color:#243b53;line-height:1.6;max-width:640px">' +
      '<p>' + escapeHtmlForEmail_(body).replace(/\r?\n/g, "<br>") + '</p>' +
      '<p style="margin:24px 0 10px"><strong>Choose an action:</strong></p><div>';
    actionLinks.forEach(function(link) {
      var color = link.decision === "reject" || link.decision === "decline" ? "#a12626" : "#176b87";
      html += '<a href="' + escapeHtmlForEmail_(link.url) + '" style="display:inline-block;margin:0 10px 10px 0;padding:11px 18px;background:' +
        color + ';color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">' +
        escapeHtmlForEmail_(link.label) + '</a>';
      plainBody += "\n\n" + link.label + ": " + link.url;
    });
    html += '</div><p style="font-size:12px;color:#627d98">For security, opening a link displays a confirmation page. The decision is recorded only when you confirm it there. The links expire after 72 hours and can be used once.</p>' +
      '<p style="font-size:12px;color:#627d98">Shift Management</p></div>';
    options.body = plainBody;
    options.htmlBody = html;
  }
  try {
    MailApp.sendEmail(options);
  } catch (err) {
    console.error("Unable to send notification to " + employeeId_(emp) + ": " + err.message);
  }
}

function escapeHtmlForEmail_(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function createRosterGrid_(employees, fromDate, toDate) {
  var dates = datesForRange_(fromDate, toDate);
  var rows = employees.slice().sort(function(a, b) {
    return employeeId_(a).localeCompare(employeeId_(b), undefined, { numeric: true, sensitivity: "base" });
  }).map(function(emp) {
    var shifts = {};
    dates.forEach(function(date) { shifts[date] = getShiftForDate_(employeeId_(emp), date); });
    return { employee: publicEmployee_(emp), shifts: shifts };
  });
  return { dates: dates, rows: rows };
}

var SHIFT_ROSTER_DATA_CACHE_ = null;

function invalidateShiftDataCache_() {
  SHIFT_ROSTER_DATA_CACHE_ = null;
}

function getShiftDataSnapshot_() {
  if (!SHIFT_ROSTER_DATA_CACHE_) {
    SHIFT_ROSTER_DATA_CACHE_ = {
      overrides: getTableRows_(SHIFT_APP_CONFIG.TABLES.OVERRIDES),
      assignments: getTableRows_(SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS)
    };
  }
  return SHIFT_ROSTER_DATA_CACHE_;
}

function getShiftForDate_(empId, dateIso) {
  var snapshot = getShiftDataSnapshot_();
  for (var i = snapshot.overrides.length - 1; i >= 0; i--) {
    var ov = snapshot.overrides[i];
    var ovDate = normalizeSheetDate_(ov["Shift Date"]);
    if (String(ov["Emp ID"]) === String(empId) && ovDate === dateIso && String(ov.Status || "Active") === "Active") {
      return String(ov["Shift Code"] || "");
    }
  }
  var applicable = snapshot.assignments.filter(function(a) {
    if (String(a["Emp ID"]) !== String(empId) || String(a.Status || "Active") !== "Active") return false;
    var start = normalizeSheetDate_(a["Effective Start Date"]);
    var end = normalizeSheetDate_(a["Effective End Date"]);
    return start && start <= dateIso && (!end || end >= dateIso);
  });
  if (!applicable.length) return "";
  applicable.sort(function(a, b) {
    var sa = normalizeSheetDate_(a["Effective Start Date"]);
    var sb = normalizeSheetDate_(b["Effective Start Date"]);
    if (sa !== sb) return sa < sb ? -1 : 1;
    return Number(a.__rowNum) - Number(b.__rowNum);
  });
  var assignment = applicable[applicable.length - 1];
  var pattern = SHIFT_APP_CONFIG.PATTERNS[String(assignment["Pattern Name"] || "")];
  if (!pattern) return "";
  var startDate = normalizeSheetDate_(assignment["Effective Start Date"]);
  var difference = Math.floor((parseIsoDate_(dateIso).getTime() - parseIsoDate_(startDate).getTime()) / 86400000);
  return pattern.charAt(difference % pattern.length);
}

function normalizeSheetDate_(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (value instanceof Date) return isoDate_(value);
  var text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m) return isoDate_(new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 12, 0, 0));
  return text;
}

function requireRole_(emp, roles) {
  var allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.some(function(role) { return hasRole_(emp, role); })) throw new Error("You do not have permission to perform this action.");
}

function getReferencedEmployees_(fieldValue) {
  if (!fieldValue) return [];
  var tokens = String(fieldValue).split(/[,;|]/).map(function(s) { return s.trim(); }).filter(Boolean);
  var result = [];
  tokens.forEach(function(token) {
    var emp = findEmployeeByIdentity_(token);
    if (emp && result.every(function(existing) { return employeeId_(existing) !== employeeId_(emp); })) result.push(emp);
  });
  return result;
}

function getSwapApprovers_(employeeA, employeeB, kind) {
  var aliases = kind === "SIC"
    ? ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"]
    : ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"];
  var refs = [];
  [employeeA, employeeB].forEach(function(emp) {
    getReferencedEmployees_(getEmpValue_(emp, aliases)).forEach(function(ref) {
      if (employeeId_(ref) !== employeeId_(employeeA) &&
          employeeId_(ref) !== employeeId_(employeeB) &&
          refs.every(function(existing) { return employeeId_(existing) !== employeeId_(ref); })) refs.push(ref);
    });
  });
  return refs;
}

/** One-time, non-destructive migration of existing audit rows to the dedicated workbook. */
function migrateLegacyAuditRows_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("SHIFT_AUDIT_MIGRATION_DONE") === "true") return 0;
  var sourceSpreadsheet = SpreadsheetApp.openById(SHIFT_APP_CONFIG.SPREADSHEET_ID);
  var sourceSheet = sourceSpreadsheet.getSheetByName(SHIFT_APP_CONFIG.TABLES.AUDIT);
  if (!sourceSheet || sourceSheet.getLastRow() < 2) {
    props.setProperty("SHIFT_AUDIT_MIGRATION_DONE", "true");
    return 0;
  }
  var existingIds = {};
  getTableRows_(SHIFT_APP_CONFIG.TABLES.AUDIT).forEach(function(row) {
    existingIds[String(row["Audit ID"] || "")] = true;
  });
  var values = sourceSheet.getRange(1, 1, sourceSheet.getLastRow(), sourceSheet.getLastColumn()).getValues();
  var headers = values[0].map(function(header) { return String(header || "").trim(); });
  var migrated = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].every(function(value) { return value === "" || value === null; })) continue;
    var obj = {};
    headers.forEach(function(header, idx) { obj[header] = values[i][idx]; });
    var id = String(obj["Audit ID"] || "");
    if (id && existingIds[id]) continue;
    if (id) existingIds[id] = true;
    migrated.push(obj);
  }
  appendObjects_(SHIFT_APP_CONFIG.TABLES.AUDIT, migrated);
  props.setProperty("SHIFT_AUDIT_MIGRATION_DONE", "true");
  return migrated.length;
}
