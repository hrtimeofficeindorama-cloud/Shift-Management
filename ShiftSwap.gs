/**
 * One-day shift swap workflow: requester -> partner -> SIC and L1 Manager approvals.
 * No roster change is applied until every required approval is complete.
 */
function submitShiftSwap(token, partnerEmpId, shiftDate, comment) {
  var ctx = requireFullSession_(token);
  var requester = ctx.employee;
  var partner = findEmployeeByIdentity_(partnerEmpId);
  if (!partner) throw new Error("Selected employee was not found.");
  if (employeeId_(requester) === employeeId_(partner)) throw new Error("You cannot swap a shift with yourself.");
  var date = isoDate_(parseIsoDate_(shiftDate));
  if (date < todayISO_()) throw new Error("Shift swaps cannot be requested for past dates.");
  var partners = getAllowedSwapPartners_(requester, getEmployees_());
  if (!partners.some(function(e) { return employeeId_(e) === employeeId_(partner); })) {
    throw new Error("This employee is not an eligible swap partner. Choose a direct downliner, or—if you have none—a colleague sharing your immediate SIC or L1 Manager.");
  }
  var requesterShift = getShiftForDate_(employeeId_(requester), date);
  var partnerShift = getShiftForDate_(employeeId_(partner), date);
  if (!requesterShift || !partnerShift) {
    throw new Error("Both employees need a scheduled shift for " + date + " before a swap can be requested.");
  }
  var sicApprovers = getSwapApprovers_(requester, partner, "SIC");
  var managerApprovers = getSwapApprovers_(requester, partner, "L1 Manager");
  if (!sicApprovers.length || !managerApprovers.length) {
    throw new Error("The request cannot be routed yet. HR must check both employees' SIC and L1 Manager hierarchy fields and role assignments.");
  }
  var requestId = Utilities.getUuid();
  appendObjects_(SHIFT_APP_CONFIG.TABLES.SWAPS, [{
    "Request ID": requestId,
    "Requester ID": employeeId_(requester),
    "Partner ID": employeeId_(partner),
    "Shift Date": date,
    "Requester Original Shift": requesterShift,
    "Partner Original Shift": partnerShift,
    "Status": "Pending Partner",
    "Partner Decision": "Pending",
    "SIC Approver IDs": sicApprovers.map(employeeId_).join(","),
    "Manager Approver IDs": managerApprovers.map(employeeId_).join(","),
    "SIC Decisions JSON": "{}",
    "Manager Decisions JSON": "{}",
    "Created By": ctx.empId,
    "Created At": new Date(),
    "Partner Responded At": "",
    "Completed At": "",
    "Comments": String(comment || "")
  }]);
  sendEmployeeNotice_(partner, "Shift swap approval requested",
    employeeName_(requester) + " (" + employeeId_(requester) + ") has requested to exchange shift with you on " + date +
    ". Your shift: " + partnerShift + "; requester shift: " + requesterShift +
    ". Sign in to Shift Management to accept or decline.");
  addAudit_(ctx.empId, "SHIFT_SWAP_SUBMITTED", [employeeId_(requester), employeeId_(partner)], [date],
    { requester: requesterShift, partner: partnerShift }, "",
    { requestId: requestId, comment: String(comment || "") }, "Pending Partner");
  return { success: true, requestId: requestId, message: "Swap request sent to " + employeeName_(partner) + " for partner acceptance." };
}

function getMySwapRequests(token) {
  var ctx = requireFullSession_(token);
  var actorId = ctx.empId;
  var records = getTableRows_(SHIFT_APP_CONFIG.TABLES.SWAPS);
  var out = [];
  records.forEach(function(rec) {
    var requesterId = String(rec["Requester ID"] || "");
    var partnerId = String(rec["Partner ID"] || "");
    var isRequester = requesterId === actorId;
    var isPartner = partnerId === actorId;
    var sicIds = splitIds_(rec["SIC Approver IDs"]);
    var mgrIds = splitIds_(rec["Manager Approver IDs"]);
    var sicDec = parseJsonObject_(rec["SIC Decisions JSON"]);
    var mgrDec = parseJsonObject_(rec["Manager Decisions JSON"]);
    var isSicApprover = sicIds.indexOf(actorId) !== -1 && hasRole_(ctx.employee, "SIC");
    var isManagerApprover = mgrIds.indexOf(actorId) !== -1 && hasRole_(ctx.employee, "L1 Manager");
    if (!isRequester && !isPartner && !isSicApprover && !isManagerApprover && !hasRole_(ctx.employee, "HR")) return;
    var reqEmp = findEmployeeById_(requesterId);
    var parEmp = findEmployeeById_(partnerId);
    out.push({
      requestId: String(rec["Request ID"]),
      requesterId: requesterId,
      requesterName: reqEmp ? employeeName_(reqEmp) : requesterId,
      partnerId: partnerId,
      partnerName: parEmp ? employeeName_(parEmp) : partnerId,
      date: normalizeSheetDate_(rec["Shift Date"]),
      requesterShift: String(rec["Requester Original Shift"] || ""),
      partnerShift: String(rec["Partner Original Shift"] || ""),
      status: String(rec.Status || ""),
      partnerDecision: String(rec["Partner Decision"] || ""),
      comment: String(rec.Comments || ""),
      createdAt: rec["Created At"] instanceof Date ? Utilities.formatDate(rec["Created At"], SHIFT_APP_CONFIG.TIME_ZONE, "yyyy-MM-dd HH:mm") : String(rec["Created At"] || ""),
      isRequester: isRequester,
      isPartner: isPartner,
      canRespondAsPartner: isPartner && String(rec.Status) === "Pending Partner",
      canApproveAsSic: isSicApprover && String(rec.Status) === "Pending Approvals" && !sicDec[actorId],
      canApproveAsManager: isManagerApprover && String(rec.Status) === "Pending Approvals" && !mgrDec[actorId],
      sicProgress: summarizeDecisions_(sicIds, sicDec),
      managerProgress: summarizeDecisions_(mgrIds, mgrDec),
      sicDecision: sicDec[actorId] || "",
      managerDecision: mgrDec[actorId] || ""
    });
  });
  out.sort(function(a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  return out;
}

function respondToSwapPartner(token, requestId, decision, comment) {
  var ctx = requireFullSession_(token);
  decision = String(decision || "").toLowerCase();
  if (decision !== "accept" && decision !== "decline") throw new Error("Choose accept or decline.");
  var rec = findSwap_(requestId);
  if (String(rec["Partner ID"]) !== ctx.empId) throw new Error("Only the selected swap partner can act on this request.");
  if (String(rec.Status) !== "Pending Partner") throw new Error("This request is no longer awaiting partner response.");
  var requester = findEmployeeById_(rec["Requester ID"]);
  var partner = findEmployeeById_(rec["Partner ID"]);
  if (decision === "decline") {
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
      "Status": "Declined by Partner", "Partner Decision": "Declined",
      "Partner Responded At": new Date(), "Comments": appendComment_(rec.Comments, comment)
    });
    sendEmployeeNotice_(requester, "Shift swap declined", employeeName_(partner) + " declined your shift swap for " + normalizeSheetDate_(rec["Shift Date"]) + ".");
    addAudit_(ctx.empId, "SHIFT_SWAP_PARTNER_DECLINED", [employeeId_(requester), employeeId_(partner)], [normalizeSheetDate_(rec["Shift Date"])],
      { requester: rec["Requester Original Shift"], partner: rec["Partner Original Shift"] }, "",
      { requestId: requestId, comment: comment || "" }, "Declined");
    return { success: true, message: "Request declined. Neither shift was changed." };
  }
  var sicIds = splitIds_(rec["SIC Approver IDs"]);
  var mgrIds = splitIds_(rec["Manager Approver IDs"]);
  if (!sicIds.length || !mgrIds.length) throw new Error("Required SIC and L1 Manager approvers are missing. Ask HR to correct the hierarchy.");
  var sicDec = {};
  var mgrDec = {};
  sicIds.forEach(function(id) { sicDec[id] = "Pending"; });
  mgrIds.forEach(function(id) { mgrDec[id] = "Pending"; });
  updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
    "Status": "Pending Approvals", "Partner Decision": "Accepted",
    "Partner Responded At": new Date(),
    "SIC Decisions JSON": JSON.stringify(sicDec), "Manager Decisions JSON": JSON.stringify(mgrDec),
    "Comments": appendComment_(rec.Comments, comment)
  });
  sicIds.concat(mgrIds).filter(function(id, idx, arr) { return arr.indexOf(id) === idx; }).forEach(function(id) {
    var approver = findEmployeeById_(id);
    if (approver) sendEmployeeNotice_(approver, "Shift swap requires approval",
      employeeName_(requester) + " and " + employeeName_(partner) + " accepted a request to swap shifts on " +
      normalizeSheetDate_(rec["Shift Date"]) + ". Please sign in to review it.");
  });
  sendEmployeeNotice_(requester, "Shift swap accepted by colleague", employeeName_(partner) + " accepted the request. It has been routed to the SIC(s) and L1 Manager(s) for approval.");
  addAudit_(ctx.empId, "SHIFT_SWAP_PARTNER_ACCEPTED", [employeeId_(requester), employeeId_(partner)], [normalizeSheetDate_(rec["Shift Date"])],
    "", "", { requestId: requestId, comment: comment || "" }, "Pending Approvals");
  return { success: true, message: "Partner accepted. The request is now with the SIC(s) and L1 Manager(s)." };
}

function decideSwapApproval(token, requestId, approverType, decision, comment) {
  var ctx = requireFullSession_(token);
  approverType = String(approverType || "");
  decision = String(decision || "").toLowerCase();
  if (["SIC", "L1 Manager"].indexOf(approverType) === -1) throw new Error("Invalid approval type.");
  if (decision !== "approve" && decision !== "reject") throw new Error("Choose approve or reject.");
  requireRole_(ctx.employee, approverType);
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rec = findSwap_(requestId);
    if (String(rec.Status) !== "Pending Approvals") throw new Error("This request is not awaiting management approval.");
    var requesterId = String(rec["Requester ID"]);
    var partnerId = String(rec["Partner ID"]);
    var requester = findEmployeeById_(requesterId);
    var partner = findEmployeeById_(partnerId);
    var ids = splitIds_(rec[approverType === "SIC" ? "SIC Approver IDs" : "Manager Approver IDs"]);
    if (ids.indexOf(ctx.empId) === -1) throw new Error("You are not an assigned approver for this request.");
    var field = approverType === "SIC" ? "SIC Decisions JSON" : "Manager Decisions JSON";
    var dec = parseJsonObject_(rec[field]);
    if (dec[ctx.empId] && dec[ctx.empId] !== "Pending") throw new Error("You have already acted on this request.");
    dec[ctx.empId] = decision === "approve" ? "Approved" : "Rejected";
    if (decision === "reject") {
      updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
        [field]: JSON.stringify(dec), "Status": "Rejected by " + approverType, "Completed At": new Date(),
        "Comments": appendComment_(rec.Comments, approverType + " rejected: " + (comment || ""))
      });
      [requester, partner].forEach(function(emp) {
        if (emp) sendEmployeeNotice_(emp, "Shift swap rejected", "The shift swap request for " +
          normalizeSheetDate_(rec["Shift Date"]) + " was rejected by an approver (" + approverType + "). Neither roster was changed.");
      });
      addAudit_(ctx.empId, "SHIFT_SWAP_REJECTED", [requesterId, partnerId], [normalizeSheetDate_(rec["Shift Date"])],
        { requester: rec["Requester Original Shift"], partner: rec["Partner Original Shift"] }, "",
        { requestId: requestId, approverType: approverType, comment: comment || "" }, "Rejected");
      return { success: true, message: "Request rejected. No roster changes were made." };
    }
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
      [field]: JSON.stringify(dec),
      "Comments": appendComment_(rec.Comments, approverType + " approved by " + ctx.empId + ": " + (comment || ""))
    });
    rec[field] = JSON.stringify(dec);
    addAudit_(ctx.empId, "SHIFT_SWAP_APPROVAL_RECORDED", [requesterId, partnerId],
      [normalizeSheetDate_(rec["Shift Date"])], "", "",
      { requestId: requestId, approverType: approverType, decision: "Approved", comment: comment || "" },
      "Approval recorded");
    var allSicApproved = allApproved_(splitIds_(rec["SIC Approver IDs"]), parseJsonObject_(rec["SIC Decisions JSON"]));
    var allMgrApproved = allApproved_(splitIds_(rec["Manager Approver IDs"]), parseJsonObject_(rec["Manager Decisions JSON"]));
    if (allSicApproved && allMgrApproved) {
      var date = normalizeSheetDate_(rec["Shift Date"]);
      if (!requester || !partner) throw new Error("One of the employees could not be located; HR must review this request.");
      var currentReq = getShiftForDate_(requesterId, date);
      var currentPar = getShiftForDate_(partnerId, date);
      if (currentReq !== String(rec["Requester Original Shift"]) || currentPar !== String(rec["Partner Original Shift"])) {
        updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
          "Status": "Needs Review - Shifts Changed", "Completed At": new Date()
        });
        [requester, partner].forEach(function(emp) {
          sendEmployeeNotice_(emp, "Shift swap needs review", "A roster entry changed while the swap was awaiting approval for " + date + ". The swap was not applied; contact HR/SIC.");
        });
        addAudit_(ctx.empId, "SHIFT_SWAP_NEEDS_REVIEW", [requesterId, partnerId], [date],
          { requester: rec["Requester Original Shift"], partner: rec["Partner Original Shift"] },
          { requester: currentReq, partner: currentPar }, "Roster changed while request was pending", "Not applied");
        return { success: true, message: "Approval saved, but roster values changed while pending. The swap was not applied and needs review." };
      }
      appendObjects_(SHIFT_APP_CONFIG.TABLES.OVERRIDES, [
        { "Override ID": Utilities.getUuid(), "Emp ID": requesterId, "Shift Date": date,
          "Shift Code": currentPar, "Source": "Approved Swap", "Reason": "Approved shift swap",
          "Related Request ID": requestId, "Created By": ctx.empId, "Created At": new Date(),
          "Previous Shift": currentReq, "Status": "Active" },
        { "Override ID": Utilities.getUuid(), "Emp ID": partnerId, "Shift Date": date,
          "Shift Code": currentReq, "Source": "Approved Swap", "Reason": "Approved shift swap",
          "Related Request ID": requestId, "Created By": ctx.empId, "Created At": new Date(),
          "Previous Shift": currentPar, "Status": "Active" }
      ]);
      updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
        "Status": "Approved and Applied", "Completed At": new Date()
      });
      [requester, partner].forEach(function(emp) {
        sendEmployeeNotice_(emp, "Shift swap approved", "Your shift swap for " + date + " was approved and applied. The shifts were exchanged for that date only.");
      });
      addAudit_(ctx.empId, "SHIFT_SWAP_APPLIED", [requesterId, partnerId], [date],
        { requester: currentReq, partner: currentPar }, { requester: currentPar, partner: currentReq },
        { requestId: requestId }, "Success");
      return { success: true, message: "All approvals are complete. Shifts were exchanged for the selected date only." };
    }
    return { success: true, message: "Approval saved. The swap remains pending other required approvals." };
  } finally {
    lock.releaseLock();
  }
}

function findSwap_(requestId) {
  var rec = getTableRows_(SHIFT_APP_CONFIG.TABLES.SWAPS).find(function(r) {
    return String(r["Request ID"]) === String(requestId);
  });
  if (!rec) throw new Error("Shift swap request not found.");
  return rec;
}

function splitIds_(value) {
  return String(value || "").split(/[,;|]/).map(function(v) { return v.trim(); }).filter(Boolean);
}

function parseJsonObject_(value) {
  try { var out = JSON.parse(String(value || "{}")); return out && typeof out === "object" ? out : {}; }
  catch (err) { return {}; }
}

function allApproved_(ids, decisions) {
  return ids.length > 0 && ids.every(function(id) { return decisions[id] === "Approved"; });
}

function summarizeDecisions_(ids, decisions) {
  if (!ids.length) return "No approvers";
  var approved = ids.filter(function(id) { return decisions[id] === "Approved"; }).length;
  var rejected = ids.filter(function(id) { return decisions[id] === "Rejected"; }).length;
  return approved + "/" + ids.length + " approved" + (rejected ? ", " + rejected + " rejected" : "");
}

function appendComment_(existing, comment) {
  var addition = String(comment || "").trim();
  if (!addition) return String(existing || "");
  var stamp = Utilities.formatDate(new Date(), SHIFT_APP_CONFIG.TIME_ZONE, "yyyy-MM-dd HH:mm");
  return (String(existing || "").trim() ? String(existing).trim() + "\n" : "") + "[" + stamp + "] " + addition;
}