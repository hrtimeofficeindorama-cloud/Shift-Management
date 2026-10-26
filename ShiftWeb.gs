/**
 * Web app entry point and dashboard aggregation.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Indorama | Shift Management")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function getDashboardData(token) {
  var ctx = requireFullSession_(token);
  var today = todayISO_();
  var end = datePlusDays_(today, 13);
  return {
    employee: publicEmployee_(ctx.employee),
    today: today,
    currentShift: getShiftForDate_(ctx.empId, today) || "Not scheduled",
    roster: getRosterData(token, today, end),
    swaps: getMySwapRequests(token)
  };
}

function getAuditRows(token, limit) {
  var ctx = requireFullSession_(token);
  requireRole_(ctx.employee, "HR");
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