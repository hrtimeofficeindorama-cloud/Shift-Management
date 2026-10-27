/**
 * Roster scheduling, change, employee/manager views and HR bulk import.
 */
function getInitialData(token) {
  var ctx = requireFullSession_(token);
  var actor = ctx.employee;
  var employees = getEmployees_();
  var roles = getRoles_(actor);
  var team = getTeamForActiveRole_(actor, employees, ctx.activeRole);
  var canSchedule = ctx.activeRole === "HR" || ctx.activeRole === "SIC";
  return {
    employee: publicEmployee_(actor), roles: roles, activeRole: ctx.activeRole,
    isHr: ctx.activeRole === "HR", canSchedule: canSchedule,
    canViewTeam: team.length > 0 || hasRole_(actor, "HR"),
    canBulkImport: ctx.activeRole === "HR",
    patterns: Object.keys(SHIFT_APP_CONFIG.PATTERNS).map(function(name) {
      return { name: name, sequence: SHIFT_APP_CONFIG.PATTERNS[name] };
    }),
    monthStart: currentMonthRange_().start,
    monthEnd: currentMonthRange_().end,
    shifts: Object.keys(SHIFT_APP_CONFIG.SHIFT_CODES).map(function(code) {
      return { code: code, label: SHIFT_APP_CONFIG.SHIFT_CODES[code].label, in: SHIFT_APP_CONFIG.SHIFT_CODES[code].in, out: SHIFT_APP_CONFIG.SHIFT_CODES[code].out };
    }),
    team: team.map(publicEmployee_),
    swapPartners: getAllowedSwapPartners_(actor, employees).map(publicEmployee_),
    today: todayISO_()
  };
}

function getRosterData(token, fromDate, toDate) {
  var ctx = requireFullSession_(token);
  var dates = datesForRange_(fromDate, toDate);
  var employees = getEmployees_();
  var actor = ctx.employee;
  var allowed = ctx.activeRole === "HR" ? employees : getTeamForActiveRole_(actor, employees, ctx.activeRole);
  if (!allowed.length) allowed = [actor];
  return createRosterGrid_(allowed, dates[0], dates[dates.length - 1]);
}

function getEmployeeRoster(token, empId, fromDate, toDate) {
  var ctx = requireFullSession_(token);
  var target = findEmployeeByIdentity_(empId);
  if (!target) throw new Error("Employee not found.");
  var teamIds = getDownliners_(ctx.employee, getEmployees_()).map(employeeId_);
  if (!canManageEmployee_(ctx.employee, target) &&
      !(hasRole_(ctx.employee, "L1 Manager") && teamIds.indexOf(employeeId_(target)) >= 0) &&
      employeeId_(ctx.employee) !== employeeId_(target) && !hasRole_(ctx.employee, "HR")) {
    throw new Error("You do not have permission to view this roster.");
  }
  var dates = datesForRange_(fromDate, toDate);
  return createRosterGrid_([target], dates[0], dates[dates.length - 1]);
}

function createShiftSchedule(token, request) {
  var ctx = requireFullSession_(token);
  request = request || {};
  requireActiveRoleOneOf_(ctx, ["HR", "SIC"]);
  var startISO = isoDate_(parseIsoDate_(request.startDate));
  if (startISO <= todayISO_()) throw new Error("A new shift schedule must start after today.");
  var patternName = String(request.patternName || "");
  if (!SHIFT_APP_CONFIG.PATTERNS[patternName]) throw new Error("Select a valid shift pattern.");
  var ids = normalizeEmployeeIds_(request.employeeIds);
  if (!ids.length) throw new Error("Select at least one employee.");
  var employees = ids.map(function(id) {
    var emp = findEmployeeById_(id);
    if (!emp) throw new Error("Employee not found: " + id);
    if (!canManageEmployeeForActiveRole_(ctx, emp)) throw new Error("You cannot schedule shifts for " + id + " under your active role.");
    return emp;
  });
  var groupId = Utilities.getUuid();
  var now = new Date();
  employees.forEach(function(emp) { closeAssignmentsAt_(employeeId_(emp), startISO); });
  appendObjects_(SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS, employees.map(function(emp) {
    return {
      "Assignment ID": Utilities.getUuid(), "Group ID": groupId, "Emp ID": employeeId_(emp),
      "Pattern Name": patternName, "Effective Start Date": startISO, "Effective End Date": "",
      "Status": "Active", "Created By": ctx.empId, "Created At": now, "Notes": String(request.notes || "")
    };
  }));
  employees.forEach(function(emp) {
    sendEmployeeNotice_(emp, "New shift schedule", "A new shift pattern has been assigned.\nPattern: " + patternName +
      "\nPattern sequence: " + SHIFT_APP_CONFIG.PATTERNS[patternName] + "\nEffective from: " + startISO +
      "\nPlease sign in to Shift Management to view your roster.");
  });
  addAudit_(ctx.empId, "SHIFT_SCHEDULE_CREATED", ids, [startISO], "", {
    patternName: patternName, sequence: SHIFT_APP_CONFIG.PATTERNS[patternName], groupId: groupId
  }, "Scheduled " + employees.length + " employee(s)", "Success");
  return { success: true, message: "Shift schedule created for " + employees.length + " employee(s).", groupId: groupId };
}

function createShiftChange(token, request) {
  var ctx = requireFullSession_(token);
  request = request || {};
  requireActiveRoleOneOf_(ctx, ["HR", "SIC"]);
  var mode = String(request.mode || "");
  var ids = normalizeEmployeeIds_(request.employeeIds);
  if (!ids.length) throw new Error("Select at least one employee.");
  var employees = ids.map(function(id) {
    var emp = findEmployeeById_(id);
    if (!emp) throw new Error("Employee not found: " + id);
    if (!canManageEmployeeForActiveRole_(ctx, emp)) throw new Error("You cannot change shifts for " + id + " under your active role.");
    return emp;
  });
  if (mode === "pattern") {
    var effective = isoDate_(parseIsoDate_(request.effectiveDate));
    if (ctx.activeRole !== "HR" && effective < todayISO_()) throw new Error("Shift changes cannot be effective in the past. Switch to HR to make a historical correction.");
    var patternName = String(request.patternName || "");
    if (!SHIFT_APP_CONFIG.PATTERNS[patternName]) throw new Error("Select a valid shift pattern.");
    var groupId = Utilities.getUuid();
    employees.forEach(function(emp) { closeAssignmentsAt_(employeeId_(emp), effective); });
    var now = new Date();
    appendObjects_(SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS, employees.map(function(emp) {
      return {
        "Assignment ID": Utilities.getUuid(), "Group ID": groupId, "Emp ID": employeeId_(emp),
        "Pattern Name": patternName, "Effective Start Date": effective, "Effective End Date": "",
        "Status": "Active", "Created By": ctx.empId, "Created At": now, "Notes": String(request.reason || "")
      };
    }));
    employees.forEach(function(emp) {
      sendEmployeeNotice_(emp, "Shift pattern changed", "Your recurring shift pattern has changed to " + patternName +
        " (" + SHIFT_APP_CONFIG.PATTERNS[patternName] + ") effective " + effective + ".\nReason: " + (request.reason || "Not specified"));
    });
    addAudit_(ctx.empId, "SHIFT_PATTERN_CHANGED", ids, [effective], "", {
      patternName: patternName, sequence: SHIFT_APP_CONFIG.PATTERNS[patternName]
    }, String(request.reason || ""), "Success");
    return { success: true, message: "Pattern changed for " + employees.length + " employee(s), effective " + effective + "." };
  }
  if (mode !== "dates") throw new Error("Select a valid shift-change mode.");
  var entries = Array.isArray(request.entries) ? request.entries : [];
  if (!entries.length) throw new Error("Add at least one shift date and replacement code.");
  var validCodes = Object.keys(SHIFT_APP_CONFIG.SHIFT_CODES);
  var seenDates = {};
  var overrides = [];
  var oldValues = [];
  entries.forEach(function(entry) {
    var date = isoDate_(parseIsoDate_(entry.date));
    if (ctx.activeRole !== "HR" && date < todayISO_()) throw new Error("Shift changes cannot affect past dates: " + date + ". Switch to HR to make a historical correction.");
    if (seenDates[date]) throw new Error("The date " + date + " appears more than once. Keep one replacement shift per date.");
    seenDates[date] = true;
    var code = String(entry.shiftCode || "").trim().toUpperCase();
    if (validCodes.indexOf(code) === -1) throw new Error("Invalid shift code: " + code);
    employees.forEach(function(emp) {
      var previous = getShiftForDate_(employeeId_(emp), date);
      oldValues.push({ empId: employeeId_(emp), date: date, shift: previous });
      overrides.push({
        "Override ID": Utilities.getUuid(), "Emp ID": employeeId_(emp), "Shift Date": date,
        "Shift Code": code, "Source": "SIC Change", "Reason": String(request.reason || ""),
        "Related Request ID": "", "Created By": ctx.empId, "Created At": new Date(),
        "Previous Shift": previous, "Status": "Active"
      });
    });
  });
  appendObjects_(SHIFT_APP_CONFIG.TABLES.OVERRIDES, overrides);
  employees.forEach(function(emp) {
    var selected = entries.map(function(e) {
      return isoDate_(parseIsoDate_(e.date)) + " = " + String(e.shiftCode || "").toUpperCase();
    }).join("\n");
    sendEmployeeNotice_(emp, "Shift date(s) changed", "Your roster has been updated for the following date(s):\n" +
      selected + "\nReason: " + (request.reason || "Not specified"));
  });
  addAudit_(ctx.empId, "SHIFT_DATES_CHANGED", ids, entries.map(function(e) { return e.date; }), oldValues,
    overrides.map(function(o) { return { empId: o["Emp ID"], date: o["Shift Date"], shift: o["Shift Code"] }; }),
    String(request.reason || ""), "Success");
  return { success: true, message: "Shift date override(s) saved." };
}

function closeAssignmentsAt_(empId, startDate) {
  var assignments = getTableRows_(SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS).filter(function(a) {
    return String(a["Emp ID"]) === String(empId) && String(a.Status || "Active") === "Active";
  });
  assignments.forEach(function(a) {
    var oldStart = normalizeSheetDate_(a["Effective Start Date"]);
    var oldEnd = normalizeSheetDate_(a["Effective End Date"]);
    if (oldStart && oldStart >= startDate) {
      updateTableRecord_(SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS, "Assignment ID", a["Assignment ID"], { "Status": "Superseded" });
    } else if (oldStart && oldStart < startDate && (!oldEnd || oldEnd >= startDate)) {
      updateTableRecord_(SHIFT_APP_CONFIG.TABLES.ASSIGNMENTS, "Assignment ID", a["Assignment ID"], {
        "Effective End Date": datePlusDays_(startDate, -1)
      });
    }
  });
}

function normalizeEmployeeIds_(ids) {
  if (typeof ids === "string") ids = ids.split(/[,;\n]/);
  if (!Array.isArray(ids)) return [];
  return ids.map(function(id) { return String(id || "").trim(); }).filter(function(id, index, arr) {
    return id && arr.indexOf(id) === index;
  });
}

function bulkImportShifts(token, csvText) {
  var ctx = requireFullSession_(token);
  requireActiveRole_(ctx, "HR");
  var text = String(csvText || "").trim();
  if (!text) throw new Error("Choose a CSV file or paste its contents.");
  var rows = Utilities.parseCsv(text);
  if (rows.length < 2) throw new Error("CSV must include a header row and at least one data row.");
  var headers = rows[0].map(function(h) { return String(h || "").trim(); });
  var idxEmp = findHeaderIndex_(headers, ["Emp ID", "Employee ID", "Employee No", "Staff ID"]);
  var idxDate = findHeaderIndex_(headers, ["Shift Date", "Date", "Roster Date"]);
  var idxShift = findHeaderIndex_(headers, ["Shift Code", "Shift", "Code"]);
  if (idxEmp < 0 || idxDate < 0 || idxShift < 0) throw new Error("Required CSV columns: Emp ID, Shift Date, Shift Code.");
  var validCodes = Object.keys(SHIFT_APP_CONFIG.SHIFT_CODES);
  var directoryMap = {};
  getEmployees_().forEach(function(employee) { directoryMap[norm_(employeeId_(employee))] = employee; });
  var seen = {};
  var good = [];
  var rejected = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (row.every(function(v) { return !String(v || "").trim(); })) continue;
    var empId = String(row[idxEmp] || "").trim();
    var rawDate = String(row[idxDate] || "").trim();
    var shift = String(row[idxShift] || "").trim().toUpperCase();
    var rowNum = i + 1;
    var issues = [];
    var emp = empId ? (directoryMap[norm_(empId)] || null) : null;
    var date = "";
    if (!empId || !emp) issues.push("Unknown or missing employee ID");
    try { date = parseImportDate_(rawDate); } catch (err) { issues.push(err.message); }
    if (validCodes.indexOf(shift) < 0) issues.push("Invalid shift code");
    var key = empId + "|" + date;
    if (date && seen[key]) issues.push("Duplicate employee/date in file (row " + seen[key] + ")");
    if (date) seen[key] = rowNum;
    if (issues.length) rejected.push({ row: rowNum, employeeId: empId, date: rawDate, errors: issues.join("; ") });
    else good.push({ emp: emp, empId: empId, date: date, shift: shift });
  }
  var oldValues = [];
  var newValues = [];
  var overrideRows = [];
  var auditRows = [];
  good.forEach(function(item) {
    var oldShift = getShiftForDate_(item.empId, item.date);
    oldValues.push({ empId: item.empId, date: item.date, shift: oldShift });
    newValues.push({ empId: item.empId, date: item.date, shift: item.shift });
    overrideRows.push({
      "Override ID": Utilities.getUuid(), "Emp ID": item.empId, "Shift Date": item.date,
      "Shift Code": item.shift, "Source": "HR Bulk Import", "Reason": "HR bulk import",
      "Related Request ID": "", "Created By": ctx.empId, "Created At": new Date(),
      "Previous Shift": oldShift, "Status": "Active"
    });
    auditRows.push({
      "Audit ID": Utilities.getUuid(), "Actor ID": ctx.empId, "Action": "HR_BULK_IMPORT_ROW",
      "Employee IDs": item.empId, "Effective Dates": item.date,
      "Old Values": JSON.stringify({ shift: oldShift }), "New Values": JSON.stringify({ shift: item.shift }),
      "Details": "HR bulk shift import", "Timestamp": new Date(), "Outcome": "Success"
    });
  });
  appendObjects_(SHIFT_APP_CONFIG.TABLES.OVERRIDES, overrideRows);
  appendObjects_(SHIFT_APP_CONFIG.TABLES.AUDIT, auditRows);
  addAudit_(ctx.empId, "HR_BULK_IMPORT", good.map(function(r) { return r.empId; }),
    good.map(function(r) { return r.date; }), oldValues, newValues,
    "Processed " + good.length + " valid rows; rejected " + rejected.length, "Completed with validation");
  var rejectionCsv = "Row,Emp ID,Shift Date,Errors\n" + rejected.map(function(r) {
    return [r.row, r.employeeId, r.date, r.errors].map(csvEscape_).join(",");
  }).join("\n");
  return {
    success: true, processed: good.length, rejected: rejected.length, rejectedRows: rejected,
    rejectionCsv: rejectionCsv,
    message: "Processed " + good.length + " valid row(s); rejected " + rejected.length + " row(s). Past, present and future dates are permitted for HR imports."
  };
}

function findHeaderIndex_(headers, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    var idx = headers.findIndex(function(h) { return norm_(h) === norm_(aliases[i]); });
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseImportDate_(value) {
  var text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isoDate_(parseIsoDate_(text));
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m) return isoDate_(parseIsoDate_(m[3] + "-" + ("0" + m[1]).slice(-2) + "-" + ("0" + m[2]).slice(-2)));
  throw new Error("Invalid date; use YYYY-MM-DD or M/D/YYYY");
}

function csvEscape_(value) {
  var text = String(value === null || value === undefined ? "" : value);
  return '"' + text.replace(/"/g, '""') + '"';
}

/** Role-aware employee visibility: SIC and L1 Manager use their respective hierarchy columns. */
function getTeamForActiveRole_(actor, employees, activeRole) {
  if (activeRole === "HR") return employees;
  if (activeRole === "SIC") return [actor].concat(employees.filter(function(candidate) {
    return employeeId_(candidate) !== employeeId_(actor) && isAssignedSicTo_(candidate, actor);
  }));
  if (activeRole === "L1 Manager") return [actor].concat(employees.filter(function(candidate) {
    return employeeId_(candidate) !== employeeId_(actor) && fieldReferencesEmployee_(
      getEmpValue_(candidate, ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"]), actor);
  }));
  var reports = getDownliners_(actor, employees);
  return reports.length ? [actor].concat(reports) : [actor];
}

function requireActiveRoleOneOf_(ctx, roles) {
  if (!ctx || roles.indexOf(ctx.activeRole) < 0) {
    throw new Error("Switch to one of these roles to perform this action: " + roles.join(", ") + ".");
  }
  if (getRoles_(ctx.employee).indexOf(ctx.activeRole) < 0) throw new Error("The active role is not assigned to your account.");
}

/** Returns a flat export matrix for HR to download as CSV. */
function exportShiftRoster(token, fromDate, toDate) {
  var ctx = requireFullSession_(token);
  requireActiveRole_(ctx, "HR");
  var defaults = currentMonthRange_();
  var start = isoDate_(parseIsoDate_(fromDate || defaults.start));
  var end = isoDate_(parseIsoDate_(toDate || defaults.end));
  var dates = datesForRange_(start, end);
  var employees = getEmployees_().slice().sort(function(a, b) {
    return employeeId_(a).localeCompare(employeeId_(b), undefined, {numeric:true});
  });
  var headers = ["Emp ID", "Shift Type"].concat(dates);
  var rows = employees.map(function(emp) {
    var codes = dates.map(function(date) {
      var code = getShiftForDate_(employeeId_(emp), date);
      if (code) return code;
      var day = parseIsoDate_(date).getDay();
      return day === 0 || day === 6 ? "O" : "G";
    });
    var shiftType = codes.some(function(code) { return ["D", "N", "A", "B"].indexOf(code) >= 0; }) ? "S" : "G";
    return [employeeId_(emp), shiftType].concat(codes);
  });
  addAudit_(ctx.empId, "SHIFT_ROSTER_EXPORTED", employees.map(employeeId_), [start, end], "", "",
    "Exported " + employees.length + " employees across " + dates.length + " day(s)", "Success");
  return { headers: headers, rows: rows, fromDate: start, toDate: end, count: rows.length };
}

function currentMonthRange_() {
  var today = parseIsoDate_(todayISO_());
  var start = isoDate_(new Date(today.getFullYear(), today.getMonth(), 1, 12, 0, 0));
  var end = isoDate_(new Date(today.getFullYear(), today.getMonth() + 1, 0, 12, 0, 0));
  return { start: start, end: end };
}


function canManageEmployeeForActiveRole_(ctx, target) {
  if (!ctx || !target) return false;
  if (ctx.activeRole === "HR") return hasRole_(ctx.employee, "HR");
  if (ctx.activeRole === "SIC") return hasRole_(ctx.employee, "SIC") && (employeeId_(target) === ctx.empId || isAssignedSicTo_(target, ctx.employee));
  return false;
}
