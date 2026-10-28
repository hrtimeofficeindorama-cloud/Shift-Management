/**
 * Shift Management configuration.
 * Keep this separate from Code.gs because Code.gs owns employee CSV synchronization.
 */
var SHIFT_APP_CONFIG = {
  SPREADSHEET_ID: "1Mzh0H6PQTq6w47fIlMJ6qUL9UT3NvpBvuoBRN_DrSA8",
  AUDIT_SPREADSHEET_ID: "1X3FzlezQSJqA3a3f8Xj0Oq3bTsy0_BLbQXDE9xFclNU",
  AUDIT_SHEET_ID: 2020960656,
  EMPLOYEE_SHEET: "Emp_List",
  CLASSES: ["National", "Expat", "Contract"],
  TIME_ZONE: "Africa/Lagos",
  TABLES: {
    ASSIGNMENTS: "Shift_Assignments",
    OVERRIDES: "Shift_Overrides",
    SWAPS: "Shift_Swap_Requests",
    AUDIT: "Shift_Audit",
    APPROVAL_LINKS: "Shift_Swap_Approval_Links",
    DOWNLINER_REQUESTS: "Shift_Downliner_Requests"
  },
  SHIFT_CODES: {
    G: { label: "General", in: "08:00", out: "17:00" },
    A: { label: "Shift A", in: "08:00", out: "20:00" },
    B: { label: "Shift B", in: "20:00", out: "08:00 next day" },
    D: { label: "Day Shift", in: "07:00", out: "19:00" },
    N: { label: "Night Shift", in: "19:00", out: "07:00 next day" },
    O: { label: "Off Day", in: "", out: "" }
  },
  PATTERNS: {
    "General": "GGGGGOO",
    "IFL Shift A": "AAOOBBOO",
    "IFL Shift B": "AAAAOOOOBBBBOOOO",
    "IFL Shift C": "AAAAOOOO",
    "IPL Shift A": "DDNNOOOO",
    "IPL Shift B": "DDDDOOOONNNNOOOO",
    "IPL Shift C": "DDDDOOOO"

  },
  ROLES: ["Employee", "SIC", "L1 Manager", "HR"]
};

/**
 * Run this once from the Apps Script editor to create data tables and required
 * employee account columns. It preserves existing employee data.
 */
function setupShiftManagement() {
  ensureAllTables_();
  var migratedAudits = migrateLegacyAuditRows_();
  // Running setup from the editor prompts for the email permission needed by notifications.
  MailApp.getRemainingDailyQuota();
  return "Shift Management setup completed. Audit storage is configured in the separate audit spreadsheet. Migrated " +
    migratedAudits + " existing audit row(s). Review Emp_List and ensure at least one employee has Role = HR.";
}
