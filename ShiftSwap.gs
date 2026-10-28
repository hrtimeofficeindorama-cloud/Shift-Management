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
  if (!sameEmployeeClass_(requester, partner)) throw new Error("Shift swaps are only allowed between employees in the same class (National, Expat or Contract).");
  if (employeeClass_(requester) !== ctx.activeClass) throw new Error("Switch the workspace class filter to your own class (" + employeeClass_(requester) + ") before requesting a swap.");
  var date = isoDate_(parseIsoDate_(shiftDate));
  if (date < todayISO_()) throw new Error("Shift swaps cannot be requested for past dates.");
  var partners = getAllowedSwapPartners_(requester, getEmployees_()).filter(function(emp) {
    return employeeClass_(emp) === employeeClass_(requester);
  });
  if (!partners.some(function(e) { return employeeId_(e) === employeeId_(partner); })) {
    throw new Error("This employee is not an eligible swap partner. Choose a direct downliner, or—if you have none—a colleague sharing your immediate SIC or L1 Manager.");
  }
  var requesterShift = getShiftForDate_(employeeId_(requester), date);
  var partnerShift = getShiftForDate_(employeeId_(partner), date);
  if (!requesterShift || !partnerShift) {
    throw new Error("Both employees need a scheduled shift for " + displayDate_(date) + " before a swap can be requested.");
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
  sendSwapActionNotice_(partner, requestId, "Partner", "Shift swap approval requested",
    employeeName_(requester) + " (" + employeeId_(requester) + ") has requested to exchange shifts with you on " + displayDate_(date) +
    ". Your shift: " + partnerShift + "; requester shift: " + requesterShift +
    ". Review the request and choose Accept or Decline below.");
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
    var reqEmp = findEmployeeById_(requesterId);
    var parEmp = findEmployeeById_(partnerId);
    if (!reqEmp || !parEmp || !sameEmployeeClass_(reqEmp, parEmp) ||
        employeeClass_(reqEmp) !== ctx.activeClass) return;
    var isRequester = requesterId === actorId;
    var isPartner = partnerId === actorId;
    var sicIds = splitIds_(rec["SIC Approver IDs"]);
    var mgrIds = splitIds_(rec["Manager Approver IDs"]);
    var sicDec = parseJsonObject_(rec["SIC Decisions JSON"]);
    var mgrDec = parseJsonObject_(rec["Manager Decisions JSON"]);
    var isSicApprover = ctx.activeRole === "SIC" && sicIds.indexOf(actorId) !== -1 && hasRole_(ctx.employee, "SIC");
    var isManagerApprover = ctx.activeRole === "L1 Manager" && mgrIds.indexOf(actorId) !== -1 && hasRole_(ctx.employee, "L1 Manager");
    if (!isRequester && !isPartner && !isSicApprover && !isManagerApprover && !(ctx.activeRole === "HR" && hasRole_(ctx.employee, "HR"))) return;
    out.push({
      requestId: String(rec["Request ID"]),
      requesterId: requesterId,
      requesterName: reqEmp ? employeeName_(reqEmp) : requesterId,
      partnerId: partnerId,
      partnerName: parEmp ? employeeName_(parEmp) : partnerId,
      date: displayDate_(normalizeSheetDate_(rec["Shift Date"])),
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
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
  decision = String(decision || "").toLowerCase();
  if (decision !== "accept" && decision !== "decline") throw new Error("Choose accept or decline.");
  var rec = findSwap_(requestId);
  if (String(rec["Partner ID"]) !== ctx.empId) throw new Error("Only the selected swap partner can act on this request.");
  var requesterClass = employeeClass_(findEmployeeById_(String(rec["Requester ID"] || "")));
  var partnerClass = employeeClass_(findEmployeeById_(String(rec["Partner ID"] || "")));
  if (!requesterClass || requesterClass !== partnerClass || requesterClass !== ctx.activeClass) {
    throw new Error("Switch to the employee's class to process this swap. Swaps must remain within one class.");
  }
  if (String(rec.Status) !== "Pending Partner") throw new Error("This request is no longer awaiting partner response.");
  var requester = findEmployeeById_(rec["Requester ID"]);
  var partner = findEmployeeById_(rec["Partner ID"]);
  if (decision === "decline") {
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
      "Status": "Declined by Partner", "Partner Decision": "Declined",
      "Partner Responded At": new Date(), "Comments": appendComment_(rec.Comments, comment)
    });
    sendEmployeeNotice_(requester, "Shift swap declined", employeeName_(partner) + " declined your shift swap for " + displayDate_(normalizeSheetDate_(rec["Shift Date"])) + ".");
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
  sicIds.forEach(function(id) {
    var approver = findEmployeeById_(id);
    if (approver) sendSwapActionNotice_(approver, requestId, "SIC", "Shift swap requires SIC approval",
      employeeName_(requester) + " and " + employeeName_(partner) + " accepted a request to swap shifts on " +
      displayDate_(normalizeSheetDate_(rec["Shift Date"])) + ". Please review the shift details and choose Approve or Reject below.");
  });
  mgrIds.forEach(function(id) {
    var approver = findEmployeeById_(id);
    if (approver) sendSwapActionNotice_(approver, requestId, "L1 Manager", "Shift swap requires L1 Manager approval",
      employeeName_(requester) + " and " + employeeName_(partner) + " accepted a request to swap shifts on " +
      displayDate_(normalizeSheetDate_(rec["Shift Date"])) + ". Please review the shift details and choose Approve or Reject below.");
  });
  sendEmployeeNotice_(requester, "Shift swap accepted by colleague", employeeName_(partner) + " accepted the request. It has been routed to the SIC(s) and L1 Manager(s) for approval.");
  addAudit_(ctx.empId, "SHIFT_SWAP_PARTNER_ACCEPTED", [employeeId_(requester), employeeId_(partner)], [normalizeSheetDate_(rec["Shift Date"])],
    "", "", { requestId: requestId, comment: comment || "" }, "Pending Approvals");
  return { success: true, message: "Partner accepted. The request is now with the SIC(s) and L1 Manager(s)." };
  } finally {
    lock.releaseLock();
  }
}

function decideSwapApproval(token, requestId, approverType, decision, comment) {
  var ctx = requireFullSession_(token);
  approverType = String(approverType || "");
  decision = String(decision || "").toLowerCase();
  if (["SIC", "L1 Manager"].indexOf(approverType) === -1) throw new Error("Invalid approval type.");
  if (decision !== "approve" && decision !== "reject") throw new Error("Choose approve or reject.");
  requireActiveRole_(ctx, approverType);
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rec = findSwap_(requestId);
    if (String(rec.Status) !== "Pending Approvals") throw new Error("This request is not awaiting management approval.");
    var requesterId = String(rec["Requester ID"]);
    var partnerId = String(rec["Partner ID"]);
    var requester = findEmployeeById_(requesterId);
    var partner = findEmployeeById_(partnerId);
    if (!requester || !partner || !sameEmployeeClass_(requester, partner) ||
        employeeClass_(requester) !== ctx.activeClass) {
      throw new Error("Switch to the employee's class and confirm that both employees remain in the same class.");
    }
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
          displayDate_(normalizeSheetDate_(rec["Shift Date"])) + " was rejected by an approver (" + approverType + "). Neither roster was changed.");
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
          sendEmployeeNotice_(emp, "Shift swap needs review", "A roster entry changed while the swap was awaiting approval for " + displayDate_(date) + ". The swap was not applied; contact HR/SIC.");
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
        sendEmployeeNotice_(emp, "Shift swap approved", "Your shift swap for " + displayDate_(date) + " was approved and applied. The shifts were exchanged for that date only.");
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

/**
 * Email approvals use short-lived, single-use bearer links. Opening a link only
 * displays a confirmation page; a person must explicitly confirm the decision.
 */
var SWAP_EMAIL_APPROVAL_TTL_HOURS = 72;

function sendSwapActionNotice_(emp, requestId, approverType, subject, body) {
  var links = createSwapApprovalLinks_(requestId, employeeId_(emp), approverType);
  var message = body;
  if (!links.length) {
    message += "\n\nThe approval link could not be generated. Sign in to Shift Management to review this request.";
  }
  sendEmployeeNotice_(emp, subject, message, links);
}

function createSwapApprovalLinks_(requestId, approverId, approverType) {
  try { tableSheet_(SHIFT_APP_CONFIG.TABLES.APPROVAL_LINKS); }
  catch (setupError) {
    console.error("Email approval link storage is not set up. Run setupShiftManagement(): " + setupError.message);
    return [];
  }
  var appUrl = "";
  try { appUrl = String(ScriptApp.getService().getUrl() || "").trim(); } catch (err) {}
  if (!appUrl) return [];
  var decisions = approverType === "Partner" ? ["accept", "decline"] : ["approve", "reject"];
  var now = new Date();
  return decisions.map(function(decision) {
    var token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    var url = appUrl + (appUrl.indexOf("?") >= 0 ? "&" : "?") + "approvalToken=" + encodeURIComponent(token);
    var label = decision === "accept" ? "Accept" : decision === "decline" ? "Decline" :
      decision === "approve" ? "Approve" : "Reject";
    appendObjects_(SHIFT_APP_CONFIG.TABLES.APPROVAL_LINKS, [{
      "Link ID": Utilities.getUuid(),
      "Token Hash": sha256Text_(token),
      "Request ID": String(requestId),
      "Approver ID": String(approverId),
      "Approver Type": String(approverType),
      "Decision": decision,
      "Expires At": new Date(now.getTime() + SWAP_EMAIL_APPROVAL_TTL_HOURS * 60 * 60 * 1000),
      "Status": "Pending",
      "Created At": now,
      "Used At": ""
    }]);
    return { label: label, decision: decision, url: url };
  });
}

function getEmailApprovalPreview(token) {
  var link = findEmailApprovalLinkByToken_(token);
  var rec = findSwap_(String(link["Request ID"] || ""));
  validateEmailApprovalContext_(link, rec);
  var requester = findEmployeeById_(String(rec["Requester ID"]));
  var partner = findEmployeeById_(String(rec["Partner ID"]));
  var decision = String(link.Decision || "");
  return {
    actionLabel: decision === "accept" ? "Accept shift swap" :
      decision === "decline" ? "Decline shift swap" :
      decision === "approve" ? "Approve shift swap" : "Reject shift swap",
    confirmButtonLabel: decision === "accept" ? "Confirm Accept" :
      decision === "decline" ? "Confirm Decline" :
      decision === "approve" ? "Confirm Approve" : "Confirm Reject",
    isNegative: decision === "reject" || decision === "decline",
    requestId: String(rec["Request ID"]),
    requesterId: String(rec["Requester ID"]),
    requesterName: requester ? employeeName_(requester) : String(rec["Requester ID"]),
    partnerId: String(rec["Partner ID"]),
    partnerName: partner ? employeeName_(partner) : String(rec["Partner ID"]),
    date: displayDate_(normalizeSheetDate_(rec["Shift Date"])),
    requesterShift: String(rec["Requester Original Shift"] || ""),
    partnerShift: String(rec["Partner Original Shift"] || ""),
    approverTypeLabel: String(link["Approver Type"]) === "Partner" ? "Selected swap partner" : String(link["Approver Type"])
  };
}

function processEmailApproval(token) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var link = findEmailApprovalLinkByToken_(token);
    var requestId = String(link["Request ID"] || "");
    var rec = findSwap_(requestId);
    validateEmailApprovalContext_(link, rec);

    var actorId = String(link["Approver ID"] || "");
    var type = String(link["Approver Type"] || "");
    var decision = String(link.Decision || "");
    var message;
    if (type === "Partner") {
      message = processPartnerDecisionFromEmail_(actorId, rec, decision);
    } else {
      message = processManagementDecisionFromEmail_(actorId, rec, type, decision);
    }

    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.APPROVAL_LINKS, "Link ID", link["Link ID"], {
      "Status": "Used", "Used At": new Date()
    });
    updateEmailApprovalLinkStatuses_(function(row) {
      return String(row["Link ID"]) !== String(link["Link ID"]) &&
        String(row["Request ID"]) === requestId &&
        String(row["Approver ID"]) === actorId &&
        String(row["Approver Type"]) === type &&
        String(row.Status || "") === "Pending";
    }, "Superseded");

    var latest = findSwap_(requestId);
    if (["Pending Partner", "Pending Approvals"].indexOf(String(latest.Status || "")) < 0) {
      updateEmailApprovalLinkStatuses_(function(row) {
        return String(row["Request ID"]) === requestId && String(row.Status || "") === "Pending";
      }, "Revoked");
    }
    return { success: true, message: message };
  } finally {
    lock.releaseLock();
  }
}

function findEmailApprovalLinkByToken_(token) {
  token = String(token || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("This approval link is invalid or incomplete.");
  var tokenHash = sha256Text_(token);
  var rows = getTableRows_(SHIFT_APP_CONFIG.TABLES.APPROVAL_LINKS);
  var link = rows.find(function(row) {
    return constantTimeEquals_(String(row["Token Hash"] || ""), tokenHash);
  });
  if (!link) throw new Error("This approval link is invalid. Ask the requester to resend the notification.");
  if (String(link.Status || "") !== "Pending") throw new Error("This approval link has already been used or cancelled.");
  var expires = link["Expires At"] instanceof Date ? link["Expires At"].getTime() : new Date(link["Expires At"]).getTime();
  if (!expires || expires < new Date().getTime()) {
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.APPROVAL_LINKS, "Link ID", link["Link ID"], { "Status": "Expired" });
    throw new Error("This approval link has expired. Ask the requester to resend the notification.");
  }
  return link;
}

function validateEmailApprovalContext_(link, rec) {
  var type = String(link["Approver Type"] || "");
  var decision = String(link.Decision || "");
  var actorId = String(link["Approver ID"] || "");
  if (!rec || !actorId) throw new Error("The approval request could not be found.");
  var requestEmployee = findEmployeeById_(String(rec["Requester ID"] || ""));
  var partnerEmployee = findEmployeeById_(String(rec["Partner ID"] || ""));
  if (!requestEmployee || !partnerEmployee || !sameEmployeeClass_(requestEmployee, partnerEmployee)) {
    throw new Error("This legacy request cannot be approved because the employees are not in the same class. Ask HR to review it.");
  }
  if (type === "Partner") {
    if (["accept", "decline"].indexOf(decision) < 0) throw new Error("Invalid partner decision link.");
    if (String(rec["Partner ID"] || "") !== actorId || String(rec.Status || "") !== "Pending Partner") {
      throw new Error("This request is no longer awaiting the selected colleague's response.");
    }
    return true;
  }
  if (["SIC", "L1 Manager"].indexOf(type) < 0 || ["approve", "reject"].indexOf(decision) < 0) {
    throw new Error("Invalid management approval link.");
  }
  if (String(rec.Status || "") !== "Pending Approvals") {
    throw new Error("This request is no longer awaiting management approval.");
  }
  var approver = findEmployeeById_(actorId);
  if (!approver || !hasRole_(approver, type)) throw new Error("Your assigned approver role has changed. Ask HR to review this request.");
  var ids = splitIds_(rec[type === "SIC" ? "SIC Approver IDs" : "Manager Approver IDs"]);
  if (ids.indexOf(actorId) < 0) throw new Error("You are not an assigned approver for this request.");
  var decisions = parseJsonObject_(rec[type === "SIC" ? "SIC Decisions JSON" : "Manager Decisions JSON"]);
  if (decisions[actorId] && decisions[actorId] !== "Pending") {
    throw new Error("You have already made a decision on this request.");
  }
  return true;
}

function processPartnerDecisionFromEmail_(actorId, rec, decision) {
  var requestId = String(rec["Request ID"]);
  var requesterId = String(rec["Requester ID"]);
  var partnerId = String(rec["Partner ID"]);
  var requester = findEmployeeById_(requesterId);
  var partner = findEmployeeById_(partnerId);
  var date = normalizeSheetDate_(rec["Shift Date"]);
  if (decision === "decline") {
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
      "Status": "Declined by Partner", "Partner Decision": "Declined",
      "Partner Responded At": new Date(),
      "Completed At": new Date(),
      "Comments": appendComment_(rec.Comments, "Partner declined via email approval link")
    });
    if (requester && partner) sendEmployeeNotice_(requester, "Shift swap declined",
      employeeName_(partner) + " declined your shift swap for " + displayDate_(date) + ".");
    addAudit_(actorId, "SHIFT_SWAP_PARTNER_DECLINED", [requesterId, partnerId], [date],
      { requester: rec["Requester Original Shift"], partner: rec["Partner Original Shift"] }, "",
      { requestId: requestId, method: "Email approval link" }, "Declined");
    return "The request was declined. Neither employee's shift was changed.";
  }

  var sicIds = splitIds_(rec["SIC Approver IDs"]);
  var mgrIds = splitIds_(rec["Manager Approver IDs"]);
  if (!sicIds.length || !mgrIds.length) throw new Error("Required SIC and L1 Manager approvers are missing. Ask HR to correct the hierarchy.");
  var sicDecisions = {};
  var managerDecisions = {};
  sicIds.forEach(function(id) { sicDecisions[id] = "Pending"; });
  mgrIds.forEach(function(id) { managerDecisions[id] = "Pending"; });
  updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
    "Status": "Pending Approvals", "Partner Decision": "Accepted",
    "Partner Responded At": new Date(),
    "SIC Decisions JSON": JSON.stringify(sicDecisions),
    "Manager Decisions JSON": JSON.stringify(managerDecisions),
    "Comments": appendComment_(rec.Comments, "Partner accepted via email approval link")
  });
  sicIds.forEach(function(id) {
    var approver = findEmployeeById_(id);
    if (approver) sendSwapActionNotice_(approver, requestId, "SIC", "Shift swap requires SIC approval",
      employeeName_(requester || { "Emp ID": requesterId }) + " and " +
      employeeName_(partner || { "Emp ID": partnerId }) + " accepted a request to swap shifts on " + displayDate_(date) +
      ". Please review the shift details and choose Approve or Reject below.");
  });
  mgrIds.forEach(function(id) {
    var approver = findEmployeeById_(id);
    if (approver) sendSwapActionNotice_(approver, requestId, "L1 Manager", "Shift swap requires L1 Manager approval",
      employeeName_(requester || { "Emp ID": requesterId }) + " and " +
      employeeName_(partner || { "Emp ID": partnerId }) + " accepted a request to swap shifts on " + displayDate_(date) +
      ". Please review the shift details and choose Approve or Reject below.");
  });
  if (requester) sendEmployeeNotice_(requester, "Shift swap accepted by colleague",
    employeeName_(partner || { "Emp ID": partnerId }) + " accepted the request. It has been routed to the SIC(s) and L1 Manager(s) for approval.");
  addAudit_(actorId, "SHIFT_SWAP_PARTNER_ACCEPTED", [requesterId, partnerId], [date],
    "", "", { requestId: requestId, method: "Email approval link" }, "Pending Approvals");
  return "The swap request was accepted and sent to the SIC(s) and L1 Manager(s) for approval.";
}

function processManagementDecisionFromEmail_(actorId, rec, approverType, decision) {
  var requestId = String(rec["Request ID"]);
  var requesterId = String(rec["Requester ID"]);
  var partnerId = String(rec["Partner ID"]);
  var requester = findEmployeeById_(requesterId);
  var partner = findEmployeeById_(partnerId);
  var date = normalizeSheetDate_(rec["Shift Date"]);
  var field = approverType === "SIC" ? "SIC Decisions JSON" : "Manager Decisions JSON";
  var decisions = parseJsonObject_(rec[field]);
  decisions[actorId] = decision === "approve" ? "Approved" : "Rejected";

  if (decision === "reject") {
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
      [field]: JSON.stringify(decisions),
      "Status": "Rejected by " + approverType,
      "Completed At": new Date(),
      "Comments": appendComment_(rec.Comments, approverType + " rejected via email approval link")
    });
    [requester, partner].forEach(function(emp) {
      if (emp) sendEmployeeNotice_(emp, "Shift swap rejected",
        "The shift swap request for " + displayDate_(date) + " was rejected by an approver (" + approverType + "). Neither roster was changed.");
    });
    addAudit_(actorId, "SHIFT_SWAP_REJECTED", [requesterId, partnerId], [date],
      { requester: rec["Requester Original Shift"], partner: rec["Partner Original Shift"] }, "",
      { requestId: requestId, approverType: approverType, method: "Email approval link" }, "Rejected");
    return "The request was rejected. Neither employee's shift was changed.";
  }

  updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
    [field]: JSON.stringify(decisions),
    "Comments": appendComment_(rec.Comments, approverType + " approved via email approval link")
  });
  rec[field] = JSON.stringify(decisions);
  var allSicApproved = allApproved_(splitIds_(rec["SIC Approver IDs"]), parseJsonObject_(rec["SIC Decisions JSON"]));
  var allMgrApproved = allApproved_(splitIds_(rec["Manager Approver IDs"]), parseJsonObject_(rec["Manager Decisions JSON"]));
  addAudit_(actorId, "SHIFT_SWAP_APPROVAL_RECORDED", [requesterId, partnerId], [date], "", "",
    { requestId: requestId, approverType: approverType, decision: "Approved", method: "Email approval link" },
    "Approval recorded");

  if (allSicApproved && allMgrApproved) {
    if (!requester || !partner) throw new Error("One of the employees could not be located; HR must review this request.");
    var currentReq = getShiftForDate_(requesterId, date);
    var currentPar = getShiftForDate_(partnerId, date);
    if (currentReq !== String(rec["Requester Original Shift"]) || currentPar !== String(rec["Partner Original Shift"])) {
      updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
        "Status": "Needs Review - Shifts Changed", "Completed At": new Date()
      });
      [requester, partner].forEach(function(emp) {
        sendEmployeeNotice_(emp, "Shift swap needs review",
          "A roster entry changed while the swap was awaiting approval for " + displayDate_(date) + ". The swap was not applied; contact HR/SIC.");
      });
      addAudit_(actorId, "SHIFT_SWAP_NEEDS_REVIEW", [requesterId, partnerId], [date],
        { requester: rec["Requester Original Shift"], partner: rec["Partner Original Shift"] },
        { requester: currentReq, partner: currentPar }, "Roster changed while request was pending", "Not applied");
      return "Your approval was recorded, but the shifts changed while the request was pending. The swap was not applied and needs review.";
    }
    appendObjects_(SHIFT_APP_CONFIG.TABLES.OVERRIDES, [
      { "Override ID": Utilities.getUuid(), "Emp ID": requesterId, "Shift Date": date,
        "Shift Code": currentPar, "Source": "Approved Swap", "Reason": "Approved shift swap",
        "Related Request ID": requestId, "Created By": actorId, "Created At": new Date(),
        "Previous Shift": currentReq, "Status": "Active" },
      { "Override ID": Utilities.getUuid(), "Emp ID": partnerId, "Shift Date": date,
        "Shift Code": currentReq, "Source": "Approved Swap", "Reason": "Approved shift swap",
        "Related Request ID": requestId, "Created By": actorId, "Created At": new Date(),
        "Previous Shift": currentPar, "Status": "Active" }
    ]);
    updateTableRecord_(SHIFT_APP_CONFIG.TABLES.SWAPS, "Request ID", requestId, {
      "Status": "Approved and Applied", "Completed At": new Date()
    });
    [requester, partner].forEach(function(emp) {
      sendEmployeeNotice_(emp, "Shift swap approved",
        "Your shift swap for " + displayDate_(date) + " was approved and applied. The shifts were exchanged for that date only.");
    });
    addAudit_(actorId, "SHIFT_SWAP_APPLIED", [requesterId, partnerId], [date],
      { requester: currentReq, partner: currentPar }, { requester: currentPar, partner: currentReq },
      { requestId: requestId, method: "Email approval link" }, "Success");
    return "All required approvals are complete. The shifts were exchanged for the selected date only.";
  }
  return "Your approval was recorded. The swap remains pending other required approvals.";
}

function updateEmailApprovalLinkStatuses_(predicate, status) {
  getTableRows_(SHIFT_APP_CONFIG.TABLES.APPROVAL_LINKS).forEach(function(row) {
    if (predicate(row)) {
      updateTableRecord_(SHIFT_APP_CONFIG.TABLES.APPROVAL_LINKS, "Link ID", row["Link ID"], { "Status": status });
    }
  });
}
