/**
 * Roster scheduling, change, employee/manager views and HR bulk import.
 */
function getInitialData(token) {
  var ctx = requireFullSession_(token);
  var actor = ctx.employee;
  var employees = getEmployees_();
  var roles = getRoles_(actor);
  var classEmployees = getEmployeesByClass_(ctx.activeClass);
  var team = getTeamForActiveRole_(actor, employees, ctx.activeRole).filter(function(emp) {
    return employeeClass_(emp) === ctx.activeClass;
  });
  var canSchedule = ["HR", "SIC", "L1 Manager"].indexOf(ctx.activeRole) >= 0;
  var swapPartners = [];
  if (employeeClass_(actor) === ctx.activeClass) {
    swapPartners = getAllowedSwapPartners_(actor, employees).filter(function(emp) {
      return employeeClass_(emp) === employeeClass_(actor);
    });
  }
  return {
    employee: publicEmployee_(actor), roles: roles, activeRole: ctx.activeRole,
    activeClass: ctx.activeClass, classes: SHIFT_APP_CONFIG.CLASSES,
    isHr: ctx.activeRole === "HR", canSchedule: canSchedule,
    canEditRoster: canSchedule || ctx.activeRole === "Employee",
    canRequestDownliners: ["SIC", "L1 Manager"].indexOf(ctx.activeRole) >= 0,
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
    classEmployees: (["HR", "SIC", "L1 Manager"].indexOf(ctx.activeRole) >= 0) ? classEmployees.map(publicEmployee_) : [],
    swapPartners: swapPartners.map(publicEmployee_),
    today: todayISO_()
  };
}

function getRosterData(token, fromDate, toDate) {
  var ctx = requireFullSession_(token);
  return getRosterDataForContext_(ctx, getEmployees_(), fromDate, toDate);
}

function getRosterDataForContext_(ctx, employees, fromDate, toDate) {
  var dates = datesForRange_(fromDate, toDate);
  var actor = ctx.employee;
  var allowed = (ctx.activeRole === "HR" ? employees : getTeamForActiveRole_(actor, employees, ctx.activeRole))
    .filter(function(emp) { return employeeClass_(emp) === ctx.activeClass; });
  if (!allowed.length && employeeClass_(actor) === ctx.activeClass) allowed = [actor];
  return createRosterGrid_(allowed, dates[0], dates[dates.length - 1]);
}

function getEmployeeRoster(token, empId, fromDate, toDate) {
  var ctx = requireFullSession_(token);
  var target = findEmployeeByIdentity_(empId);
  if (!target) throw new Error("Employee not found.");
  if (employeeClass_(target) !== ctx.activeClass) throw new Error("Switch to the employee's class before viewing this roster.");
  if (!canEditRosterCell_(ctx, target)) {
    throw new Error("You do not have permission to view this employee's roster under the selected role.");
  }
  var dates = datesForRange_(fromDate, toDate);
  return createRosterGrid_([target], dates[0], dates[dates.length - 1]);
}

function createShiftSchedule(token, request) {
  var ctx = requireFullSession_(token);
  request = request || {};
  requireActiveRoleOneOf_(ctx, ["HR", "SIC", "L1 Manager"]);
  var startISO = isoDate_(parseIsoDate_(request.startDate));
  if (startISO <= todayISO_()) throw new Error("A new shift schedule must start after today.");
  var patternName = String(request.patternName || "");
  if (!SHIFT_APP_CONFIG.PATTERNS[patternName]) throw new Error("Select a valid shift pattern.");
  var ids = normalizeEmployeeIds_(request.employeeIds);
  if (!ids.length) throw new Error("Select at least one employee.");
  var employees = ids.map(function(id) {
    var emp = findEmployeeById_(id);
    if (!emp) throw new Error("Employee not found: " + id);
    if (!canManageEmployeeForActiveRole_(ctx, emp)) throw new Error("You cannot schedule shifts for " + id + " under your active role or selected class.");
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
      "\nPattern sequence: " + SHIFT_APP_CONFIG.PATTERNS[patternName] + "\nEffective from: " + displayDate_(startISO) +
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
  requireActiveRoleOneOf_(ctx, ["HR", "SIC", "L1 Manager"]);
  var mode = String(request.mode || "");
  var ids = normalizeEmployeeIds_(request.employeeIds);
  if (!ids.length) throw new Error("Select at least one employee.");
  var employees = ids.map(function(id) {
    var emp = findEmployeeById_(id);
    if (!emp) throw new Error("Employee not found: " + id);
    if (!canManageEmployeeForActiveRole_(ctx, emp)) throw new Error("You cannot change shifts for " + id + " under your active role or selected class.");
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
        " (" + SHIFT_APP_CONFIG.PATTERNS[patternName] + ") effective " + displayDate_(effective) + ".\nReason: " + (request.reason || "Not specified"));
    });
    addAudit_(ctx.empId, "SHIFT_PATTERN_CHANGED", ids, [effective], "", {
      patternName: patternName, sequence: SHIFT_APP_CONFIG.PATTERNS[patternName]
    }, String(request.reason || ""), "Success");
    return { success: true, message: "Pattern changed for " + employees.length + " employee(s), effective " + displayDate_(effective) + "." };
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
    if (ctx.activeRole !== "HR" && date < todayISO_()) throw new Error("Shift changes cannot affect past dates: " + displayDate_(date) + ". Switch to HR to make a historical correction.");
    if (seenDates[date]) throw new Error("The date " + displayDate_(date) + " appears more than once. Keep one replacement shift per date.");
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
      return displayDate_(isoDate_(parseIsoDate_(e.date))) + " = " + String(e.shiftCode || "").toUpperCase();
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
  getEmployeesByClass_(ctx.activeClass).forEach(function(employee) { directoryMap[norm_(employeeId_(employee))] = employee; });
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
  if (activeRole === "Employee") return [actor];
  return [actor];
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
  var employees = getEmployeesByClass_(ctx.activeClass).slice().sort(function(a, b) {
    return employeeId_(a).localeCompare(employeeId_(b), undefined, {numeric:true,sensitivity:"base"});
  });
  var headers = ["Emp ID", "Shift Type"].concat(dates.map(displayDate_));
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
  if (!ctx || !target || employeeClass_(target) !== ctx.activeClass) return false;
  if (ctx.activeRole === "HR") return hasRole_(ctx.employee, "HR");
  if (ctx.activeRole === "SIC") {
    return hasRole_(ctx.employee, "SIC") &&
      (employeeId_(target) === ctx.empId || isAssignedSicTo_(target, ctx.employee));
  }
  if (ctx.activeRole === "L1 Manager") {
    return hasRole_(ctx.employee, "L1 Manager") &&
      (employeeId_(target) === ctx.empId || fieldReferencesEmployee_(
        getEmpValue_(target, ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"]), ctx.employee));
  }
  return false;
}


/** Apply one or more grid-cell changes after validating the entire batch. */
function updateRosterCells(token, entries) {
  var ctx = requireFullSession_(token);
  var items = Array.isArray(entries) ? entries : [];
  if (!items.length) throw new Error("Select at least one shift cell to update.");
  if (items.length > 1000) throw new Error("Update no more than 1,000 shift cells at a time.");
  var permittedRoles = ["HR", "SIC", "L1 Manager", "Employee"];
  if (permittedRoles.indexOf(ctx.activeRole) < 0 || getRoles_(ctx.employee).indexOf(ctx.activeRole) < 0) {
    throw new Error("Your active role cannot edit roster cells.");
  }
  var validCodes = Object.keys(SHIFT_APP_CONFIG.SHIFT_CODES);
  var seen = {};
  var prepared = [];
  items.forEach(function(item) {
    var target = findEmployeeById_(item.empId);
    if (!target) throw new Error("Employee not found: " + item.empId);
    if (employeeClass_(target) !== ctx.activeClass) throw new Error("Employee " + item.empId + " is not in the selected class " + ctx.activeClass + ".");
    if (!canEditRosterCell_(ctx, target)) throw new Error("You cannot edit the roster for " + item.empId + " under the selected role.");
    var date = isoDate_(parseIsoDate_(item.date));
    if (ctx.activeRole !== "HR" && date < todayISO_()) throw new Error("Only HR can change past roster dates: " + displayDate_(date) + ".");
    var code = String(item.shiftCode || "").trim().toUpperCase();
    if (validCodes.indexOf(code) < 0) throw new Error("Invalid shift code for " + displayDate_(date) + ". Use G, A, B, D, N or O.");
    var key = employeeId_(target) + "|" + date;
    if (seen[key]) throw new Error("The pasted range contains duplicate employee/date cells.");
    seen[key] = true;
    prepared.push({ emp: target, empId: employeeId_(target), date: date, code: code });
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var overrides = prepared.map(function(item) {
      return {
        "Override ID": Utilities.getUuid(), "Emp ID": item.empId, "Shift Date": item.date,
        "Shift Code": item.code, "Source": "Roster Grid Edit",
        "Reason": "Edited through the roster spreadsheet-style grid",
        "Related Request ID": "", "Created By": ctx.empId, "Created At": new Date(),
        "Previous Shift": getShiftForDate_(item.empId, item.date), "Status": "Active"
      };
    });
    appendObjects_(SHIFT_APP_CONFIG.TABLES.OVERRIDES, overrides);
    addAudit_(ctx.empId, "ROSTER_GRID_UPDATED", prepared.map(function(item) { return item.empId; }),
      prepared.map(function(item) { return item.date; }),
      overrides.map(function(item) { return { empId: item["Emp ID"], date: item["Shift Date"], shift: item["Previous Shift"] }; }),
      prepared.map(function(item) { return { empId: item.empId, date: item.date, shift: item.code }; }),
      "Updated " + prepared.length + " roster cell(s) through the editable grid", "Success");
    return { success: true, count: prepared.length, message: prepared.length + " shift cell(s) saved." };
  } finally {
    lock.releaseLock();
  }
}

function canEditRosterCell_(ctx, target) {
  if (!ctx || !target || employeeClass_(target) !== ctx.activeClass) return false;
  if (ctx.activeRole === "HR") return hasRole_(ctx.employee, "HR");
  if (ctx.activeRole === "SIC") {
    return hasRole_(ctx.employee, "SIC") &&
      (employeeId_(target) === ctx.empId || isAssignedSicTo_(target, ctx.employee));
  }
  if (ctx.activeRole === "L1 Manager") {
    return hasRole_(ctx.employee, "L1 Manager") &&
      (employeeId_(target) === ctx.empId || fieldReferencesEmployee_(
        getEmpValue_(target, ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"]), ctx.employee));
  }
  // Employee-only users may view their roster and submit swaps, but never directly edit shifts.
  // Multi-role users can edit their own shifts when they actively use SIC, L1 Manager or HR.
  return false;
}

function getClassEmployeeList(token) {
  var ctx = requireFullSession_(token);
  requireActiveRoleOneOf_(ctx, ["HR", "SIC", "L1 Manager"]);
  return getEmployeesByClass_(ctx.activeClass).map(publicEmployee_);
}

/** Requests an additional SIC or Manager relationship; HR must approve it. */
function createDownlinerRequest(token, targetIdentity, relationshipType, comment) {
  var ctx = requireFullSession_(token);
  relationshipType = String(relationshipType || "");
  if (["SIC", "L1 Manager"].indexOf(relationshipType) < 0 || relationshipType !== ctx.activeRole) {
    throw new Error("Switch to the SIC or L1 Manager role for the relationship you want to request.");
  }
  var target = findEmployeeByIdentity_(targetIdentity);
  if (!target) throw new Error("Employee not found.");
  if (employeeId_(target) === ctx.empId) throw new Error("You cannot add yourself as a downliner.");
  if (employeeClass_(target) !== ctx.activeClass) throw new Error("Only employees in the selected class (" + ctx.activeClass + ") can be added.");
  var fieldAliases = relationshipType === "SIC"
    ? ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"]
    : ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"];
  if (fieldReferencesEmployee_(getEmpValue_(target, fieldAliases), ctx.employee)) {
    throw new Error("This employee is already assigned under you as " + relationshipType + ".");
  }
  var existing = getTableRows_(SHIFT_APP_CONFIG.TABLES.DOWNLINER_REQUESTS).find(function(row) {
    return String(row["Requester ID"]) === ctx.empId &&
      String(row["Employee ID"]) === employeeId_(target) &&
      String(row["Requester Role"]) === relationshipType &&
      String(row.Status || "") === "Pending";
  });
  if (existing) throw new Error("A request for this employee is already awaiting HR approval.");
  var requestId = Utilities.getUuid();
  appendObjects_(SHIFT_APP_CONFIG.TABLES.DOWNLINER_REQUESTS, [{
    "Request ID": requestId, "Requester ID": ctx.empId, "Requester Role": relationshipType,
    "Employee ID": employeeId_(target), "Class": ctx.activeClass, "Action": "Add",
    "Status": "Pending", "Created At": new Date(), "Decided By": "", "Decided At": "",
    "Comments": String(comment || "")
  }]);
  addAudit_(ctx.empId, "DOWNLINER_ADD_REQUESTED", [employeeId_(target)], [], "", "",
    { requestId: requestId, relationshipType: relationshipType, className: ctx.activeClass, comment: String(comment || "") }, "Pending HR approval");
  var hrs = getEmployees_().filter(function(emp) { return hasRole_(emp, "HR"); });
  hrs.forEach(function(hr) {
    sendEmployeeNotice_(hr, "Downliner assignment requires HR approval",
      employeeName_(ctx.employee) + " (" + ctx.empId + ") requested to add " + employeeName_(target) +
      " (" + employeeId_(target) + ") as a downliner under " + relationshipType + " for class " +
      ctx.activeClass + ". Open Shift Management → HR administration to approve or reject the request.");
  });
  return { success: true, requestId: requestId, message: "Request submitted to HR for approval." };
}

function getDownlinerRequests(token) {
  var ctx = requireFullSession_(token);
  requireActiveRole_(ctx, "HR");
  return getTableRows_(SHIFT_APP_CONFIG.TABLES.DOWNLINER_REQUESTS)
    .filter(function(row) { return String(row.Status || "") === "Pending" && String(row.Class || "") === ctx.activeClass; })
    .map(function(row) {
      var requester = findEmployeeById_(String(row["Requester ID"] || ""));
      var target = findEmployeeById_(String(row["Employee ID"] || ""));
      return {
        requestId: String(row["Request ID"] || ""), requesterId: String(row["Requester ID"] || ""),
        requesterName: requester ? employeeName_(requester) : String(row["Requester ID"] || ""),
        employeeId: String(row["Employee ID"] || ""),
        employeeName: target ? employeeName_(target) : String(row["Employee ID"] || ""),
        relationshipType: String(row["Requester Role"] || ""), className: String(row.Class || ""),
        action: String(row.Action || "Add"), createdAt: row["Created At"] instanceof Date ?
          Utilities.formatDate(row["Created At"], SHIFT_APP_CONFIG.TIME_ZONE, "dd/MMM/yyyy HH:mm") : String(row["Created At"] || ""),
        comments: String(row.Comments || "")
      };
    });
}

function decideDownlinerRequest(token, requestId, decision, comment) {
  var ctx = requireFullSession_(token);
  requireActiveRole_(ctx, "HR");
  decision = String(decision || "").toLowerCase();
  if (["approve", "reject"].indexOf(decision) < 0) throw new Error("Choose approve or reject.");
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var request = getTableRows_(SHIFT_APP_CONFIG.TABLES.DOWNLINER_REQUESTS).find(function(row) {
      return String(row["Request ID"] || "") === String(requestId);
    });
    if (!request) throw new Error("Downliner request not found.");
    if (String(request.Status || "") !== "Pending") throw new Error("This request has already been decided.");
    if (String(request.Class || "") !== ctx.activeClass) throw new Error("Switch to the request's employee class before deciding.");
    var requester = findEmployeeById_(String(request["Requester ID"] || ""));
    var target = findEmployeeById_(String(request["Employee ID"] || ""));
    if (!requester || !target) throw new Error("The requester or employee no longer exists.");
    var relationshipType = String(request["Requester Role"] || "");
    if (["SIC", "L1 Manager"].indexOf(relationshipType) < 0 || !hasRole_(requester, relationshipType)) {
      throw new Error("The requester's role has changed. Reject this request or correct their role first.");
    }
    if (employeeClass_(target) !== String(request.Class)) throw new Error("Employee class changed after the request was submitted.");
    if (decision === "approve") {
      var aliases = relationshipType === "SIC"
        ? ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"]
        : ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"];
      var current = String(getEmpValue_(target, aliases) || "");
      if (fieldReferencesEmployee_(current, requester)) throw new Error("This employee is already assigned to the requester.");
      var updated = current.trim() ? current.trim().replace(/[;,|]\s*$/, "") + ", " + employeeId_(requester) : employeeId_(requester);
      var key = relationshipType === "SIC" ? "SIC|Shift In Charge|Shift In-Charge|Shift Incharge" :
        "L1 Manager|L1Manager|Manager|Reporting Manager|Line Manager";
      updateEmployeeFields_(target, (function() { var map = {}; map[key] = updated; return map; })());
    }
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.DOWNLINER_REQUESTS, "Request ID", requestId, {
      "Status": decision === "approve" ? "Approved" : "Rejected",
      "Decided By": ctx.empId, "Decided At": new Date(),
      "Comments": appendDownlinerComment_(request.Comments, decision === "approve" ? "Approved" : "Rejected", ctx.empId, comment)
    });
    addAudit_(ctx.empId, decision === "approve" ? "DOWNLINER_ADD_APPROVED" : "DOWNLINER_ADD_REJECTED",
      [employeeId_(target)], [], "", decision === "approve" ? { relationshipType: relationshipType, requesterId: employeeId_(requester) } : "",
      { requestId: requestId, relationshipType: relationshipType, comment: String(comment || "") }, decision === "approve" ? "Success" : "Rejected");
    if (decision === "approve") {
      sendEmployeeNotice_(requester, "Downliner assignment approved",
        employeeName_(target) + " (" + employeeId_(target) + ") is now assigned under you as " + relationshipType + ".");
      sendEmployeeNotice_(target, "Reporting relationship updated",
        employeeName_(requester) + " (" + employeeId_(requester) + ") has been added as an additional " + relationshipType + " for your selected employee class.");
    } else {
      sendEmployeeNotice_(requester, "Downliner assignment request rejected",
        "HR rejected your request to add " + employeeName_(target) + " (" + employeeId_(target) + ") as " + relationshipType +
        ". Comment: " + String(comment || "No comment provided."));
    }
    return { success: true, message: decision === "approve" ? "Request approved. The employee has been added to the downliner list." : "Request rejected." };
  } finally {
    lock.releaseLock();
  }
}

function removeDownliner(token, targetEmpId, relationshipType) {
  var ctx = requireFullSession_(token);
  relationshipType = String(relationshipType || "");
  if (relationshipType !== ctx.activeRole || ["SIC", "L1 Manager"].indexOf(relationshipType) < 0) {
    throw new Error("Switch to the SIC or L1 Manager role to manage this relationship.");
  }
  var target = findEmployeeByIdentity_(targetEmpId);
  if (!target) throw new Error("Employee not found.");
  if (employeeClass_(target) !== ctx.activeClass) throw new Error("Employee is not in the selected class.");
  var aliases = relationshipType === "SIC"
    ? ["SIC", "Shift In Charge", "Shift In-Charge", "Shift Incharge"]
    : ["L1 Manager", "L1Manager", "Manager", "Reporting Manager", "Line Manager"];
  var current = String(getEmpValue_(target, aliases) || "");
  if (!fieldReferencesEmployee_(current, ctx.employee)) throw new Error("This employee is not currently assigned under you.");
  var identities = [
    employeeId_(ctx.employee), employeeName_(ctx.employee),
    getEmpValue_(ctx.employee, ["Official Email", "Official Email Id", "Work Email"]),
    getEmpValue_(ctx.employee, ["Personal Email", "Personal Email Id", "Email"])
  ].map(norm_).filter(Boolean);
  var remaining = current.split(/[,;|]/).map(function(value) { return value.trim(); }).filter(function(value) {
    return value && identities.indexOf(norm_(value)) < 0;
  });
  var fieldKey = relationshipType === "SIC" ? "SIC|Shift In Charge|Shift In-Charge|Shift Incharge" :
    "L1 Manager|L1Manager|Manager|Reporting Manager|Line Manager";
  var update = {}; update[fieldKey] = remaining.join(", ");
  updateEmployeeFields_(target, update);
  addAudit_(ctx.empId, "DOWNLINER_REMOVED", [employeeId_(target)], [], current, remaining.join(", "),
    { relationshipType: relationshipType, className: ctx.activeClass }, "Success");
  sendEmployeeNotice_(target, "Reporting relationship updated",
    employeeName_(ctx.employee) + " (" + ctx.empId + ") removed themselves as a " + relationshipType +
    " for your employee record. Other assigned SICs/Managers remain unchanged.");
  return { success: true, message: employeeName_(target) + " has been removed from your " + relationshipType + " downliner list." };
}

function appendDownlinerComment_(existing, decision, actorId, comment) {
  var text = String(existing || "").trim();
  var addition = "[" + displayDate_(todayISO_()) + "] " + decision + " by " + actorId +
    (String(comment || "").trim() ? ": " + String(comment).trim() : "");
  return text ? text + "\n" + addition : addition;
}
