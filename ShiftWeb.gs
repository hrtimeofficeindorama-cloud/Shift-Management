/**
 * Web app entry point and dashboard aggregation.
 */
function doGet(e) {
  var hasApprovalParam = !!(e && e.parameter && Object.prototype.hasOwnProperty.call(e.parameter, "approvalToken"));
  if (hasApprovalParam) {
    var approvalToken = String(e.parameter.approvalToken || "");
    if (!/^[a-f0-9]{64}$/i.test(approvalToken)) approvalToken = "";
    var template = HtmlService.createTemplateFromFile("EmailApproval");
    template.approvalToken = approvalToken;
    return template.evaluate()
      .setTitle("Shift Management | Email Approval")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Shift Management")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function getDashboardData(token, fromDate, toDate) {
  var ctx = requireFullSession_(token);
  var today = todayISO_();
  var defaults = currentMonthRange_();
  var start = fromDate || defaults.start;
  var end = toDate || defaults.end;
  var roster = getRosterData(token, start, end);
  return {
    employee: publicEmployee_(ctx.employee),
    today: today, rosterFrom: start, rosterTo: end,
    currentShift: getShiftForDate_(ctx.empId, today) || "Not scheduled",
    roster: roster,
    swaps: getMySwapRequests(token)
  };
}

function getAuditRows(token, limit) {
  var ctx = requireFullSession_(token);
  requireActiveRole_(ctx, "HR");
  var rows = getTableRows_(SHIFT_APP_CONFIG.TABLES.AUDIT);
  rows.sort(function(a, b) {
    var da = a.Timestamp instanceof Date ? a.Timestamp.getTime() : 0;
    var db = b.Timestamp instanceof Date ? b.Timestamp.getTime() : 0;
    return db - da;
  });
  return rows.slice(0, Math.min(Number(limit || 100), 500)).map(function(r) {
    return {
      id: String(r["Audit ID"] || ""), actor: String(r["Actor ID"] || ""),
      action: String(r.Action || ""), employees: String(r["Employee IDs"] || ""),
      dates: String(r["Effective Dates"] || ""), details: String(r.Details || ""),
      timestamp: r.Timestamp instanceof Date ? Utilities.formatDate(r.Timestamp, SHIFT_APP_CONFIG.TIME_ZONE, "yyyy-MM-dd HH:mm:ss") : String(r.Timestamp || ""),
      outcome: String(r.Outcome || "")
    };
  });
}