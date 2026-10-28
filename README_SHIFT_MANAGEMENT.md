# Shift Management Apps Script

This project adds a Google Apps Script web application to the existing Shift-Management repository. Code.gs remains unchanged; it continues to sync employee CSV records into the existing spreadsheet.

## Features implemented

- Employee login by employee ID, official email, personal email, or matching name.
- Salted, iteratively hashed passwords and secret answers; temporary-password enforcement; password change and secret-question password recovery.
- HR role assignment for Employee, SIC, L1 Manager, and HR (Super Admin), with top-bar active-role and employee-class selectors.
- Role-specific downline rosters for SIC and L1 Manager users; searchable employee selectors by name or ID.
- Class separation for National, Expat and Contract. Roster, scheduling, HR administration, imports/exports and swap requests are scoped to the selected class; shift swaps are only permitted between employees in the same class.
- Spreadsheet-style roster editing: select cells, type approved shift codes, paste TSV ranges, copy selected ranges and drag/select multiple cells. The server validates G, A, B, D, N and O codes and permission per employee/class.
- Employee-only role is read-only for shift cells and can request swaps; users with multiple roles can edit their own shift only after switching to an assigned SIC, L1 Manager or HR role. Employees needing a direct shift change must contact their SIC, L1 Manager or HR.
- Dashboard performance uses indexed shift overrides/assignments and reuses one employee-directory snapshot when building the roster and swap panel; execution duration and roster size are logged for diagnosis.
- The roster table uses a frozen month heading, vertical weekday labels and day-number row; employee ID/name columns stay frozen while scrolling dates.
- HR can assign multiple SICs and L1 Managers to an employee from HR administration. Assigning an employee as an SIC automatically adds the SIC role without removing their existing roles.
- SIC/L1 Manager downliner addition requests routed to HR for approval; approved requests append a second or additional reporting relationship without replacing existing SIC/Manager values. Self-removal only removes the current relationship.
- Role-aware Platform guide with separate instructions for every role assigned to the user, plus a developer/support contact form.
- Visible roster and notification dates use DD/MMM/YYYY where rendered as text.
- SIC/L1 Manager/HR-authorised future shift schedules; group assignments; named repeating patterns.
- Single-date shift changes are made in My roster; recurring pattern changes remain in Schedule & change. HR can correct past dates while SIC/L1 Manager edits are limited to today and the future.
- One-day shift swaps: requester, selected colleague, then required SIC and L1 Manager approvals. Roster is changed only after all approvals; original recurring patterns resume on following dates.
- HR bulk CSV import that can overwrite past, current, and future roster dates and returns row validation errors.
- Team/self roster views with selectable start/end dates (defaulting to the current month), email notifications, and audit trail.
- Calendar-and-shift selectors for multi-date corrections; HR can correct roster dates in the past or future.
- HR CSV export by date range with Emp ID, Shift Type, and one column per date. Unassigned weekdays default to G; weekends default to O. Shift Type is S if any A, B, D or N occurs in the period, otherwise G.
- HR can reset a single employee or all employee accounts to the standard temporary password; affected employees must set a new password and recovery question.

## Spreadsheets

**Employee and roster spreadsheet:**  
https://docs.google.com/spreadsheets/d/1Mzh0H6PQTq6w47fIlMJ6qUL9UT3NvpBvuoBRN_DrSA8/edit?usp=sharing

Employee sheet: `Emp_List`. The employee class field is the existing `Class` column, with validated values `National`, `Expat`, and `Contract`.

**Separate audit spreadsheet:**  
https://docs.google.com/spreadsheets/d/1X3FzlezQSJqA3a3f8Xj0Oq3bTsy0_BLbQXDE9xFclNU/edit?gid=2020960656#gid=2020960656

The audit table uses worksheet ID (gid) `2020960656`. The Google account that owns/runs the Apps Script web app must have edit access to both spreadsheets.

Run `setupShiftManagement()` once from the Apps Script editor after syncing these changes. It prepares the regular shift tables in the main spreadsheet and ensures `Shift_Audit` exists in the designated external audit worksheet. It also creates `Shift_Swap_Approval_Links` and `Shift_Downliner_Requests`. The setup runs a one-time, non-destructive migration of previous audit rows into the external audit sheet, skipping matching Audit IDs. The original audit tab/rows are left in place.

The setup also adds missing account/hierarchy columns only; it does not delete or rewrite existing employee data. `Code.gs` is kept separate.

### Employee directory requirements

Row 1 in Emp_List must contain Emp ID and preferably Emp Name, Official Email, Personal Email, and Department. Column header aliases are recognised for employee ID, name, and email.

The app expects the SIC and L1 Manager cells to contain the supervisor employee ID, name, or email (or multiple such identifiers separated by comma/semicolon/pipe). If a field currently holds only a yes/no flag, HR must replace it with the relevant SIC/manager employee identity before using team views or swap approval routing.

The app maintains these columns when missing:
- Role — Employee, SIC, L1 Manager, HR, or comma-separated combinations (for example SIC, L1 Manager).
- SIC — employee identity/identities of assigned SIC(s).
- L1 Manager — employee identity/identities of assigned manager(s).
- Password — salted password hash, never plaintext.
- Secret Question — recovery question.
- Secret Answer Hash — salted recovery-answer hash.

The current Code.gs CSV sync preserves extra columns, but verify that the source CSV sync is not overwriting these role/hierarchy columns with source fields.

## First-time deployment / bootstrap

1. In Apps Script, open Project Settings → Script Properties and add INITIAL_HR_BOOTSTRAP_KEY with a long, unique random value. Keep it private. Generate at least 32 random characters in a password manager.
2. From the Apps Script editor, run setupShiftManagement() and authorise the requested spreadsheet/email scopes.
3. From the Apps Script editor, invoke setupInitialHrAccount with these five arguments:
   - employee ID already found in Emp_List
   - the exact value of INITIAL_HR_BOOTSTRAP_KEY
   - temporary password (minimum 10 characters, at least one letter and one digit)
   - recovery question (at least 8 characters)
   - recovery answer (at least 3 characters)

   If your editor does not provide a convenient argument dialog, use a temporary helper function inside the Apps Script editor to call setupInitialHrAccount with the values, run that helper once, and remove the helper immediately afterward. Never put the bootstrap key in a committed repository file.
4. The bootstrap key is deleted after success. The selected employee gets role HR and a temporary password, then must change the password and confirm recovery settings at first login.
5. In Apps Script, create or update the Web App deployment. Execute as the script owner and set access according to company policy. A GitHub clasp push alone does not create or update a Web App deployment.
6. Confirm MailApp email sending works for the deployment owner. Notifications are sent to the employee's first usable official/personal email address. If no email exists, the roster still saves but email cannot be sent.

### Standard temporary password and account reset

The repository is public, so the temporary credential is deliberately not hard-coded into committed source. In Apps Script Project Settings → Script Properties, set `SHIFT_TEMP_PASSWORD` to the approved standard temporary password before using HR password-reset actions. Do not store the password in this repository, code comments, or documentation. Keep the Apps Script project and employee spreadsheet access restricted. The server validates that this property meets the password policy.

After signing in as HR and switching to the HR role, use HR administration → Reset employee password to reset one employee, or use Reset all employee passwords for a bulk reset. The bulk action requires typing `RESET ALL`. Both actions clear the recovery question/answer and invalidate existing sessions. All affected employees must choose a new password and set a recovery question at their next sign-in. Communicate the temporary password to employees using an approved secure channel.

### Bulk CSV format

Required header columns (header case is ignored): Emp ID,Shift Date,Shift Code

Allowed codes:
- G — 08:00–17:00
- A — 08:00–20:00
- B — 20:00–08:00 next day
- D — 07:00–19:00
- N — 19:00–07:00 next day
- O — off day

Accepted dates: YYYY-MM-DD or M/D/YYYY. HR import allows past/current/future dates. The importer processes valid rows and reports invalid/duplicate rows; successful overrides are audited. Bulk-import employee notifications are not sent by default because the BRD lists that as an HR confirmation item.

## Rules from the supplied BRD

- New schedule effective start date must be after today.
- Direct roster-cell changes and shift swap dates may be today or future for non-HR users; only HR may correct past dates. New recurring schedule start dates must be after today.
- Pattern sequences repeat indefinitely until a new pattern-level assignment is effective.
- A single date override does not change the recurring cycle on subsequent dates.
- Swap partner acceptance precedes SIC and L1 Manager approvals; the swap is applied only after all configured approvers approve.
- Automated mail uses the sender display name `Shift Management`; the underlying sender address remains the Google account that executes the web app.
- Shift-swap emails include Accept/Decline or Approve/Reject links. Links expire after 72 hours, can be used once, and open a confirmation page; the decision is recorded only after the recipient confirms, helping prevent email-security scanners from accidentally acting on a link.
- HR bulk import may override past, present, and future dates.

## Security notes and remaining configuration

- The active-role selector changes the interface scope only among roles already assigned to the signed-in employee. The class selector defaults to National for HR/SIC/Managers, and to the employee's own class for Employee-only accounts. Server-side checks validate role assignment, selected class and employee hierarchy.
- Roster view and export date ranges support up to 366 calendar days. Very large date ranges with many employees may produce wide exports.
- The external audit spreadsheet must be shared with the Apps Script execution account. If that account cannot edit the external workbook/tab, setup and audit-writing actions may fail.
- The contact form sends email to `hrtimeoffice@ng.indorama.com` with CC to `Olusegun.kehinde@indorama.com`.

- Secret questions are a recovery convenience and are weaker than multi-factor recovery. Use non-obvious answers and restrict web-app access to the workforce.
- Protect the employee spreadsheet and Apps Script project with company-controlled access. Do not share the bootstrap key or temporary passwords in public channels.
- This is a spreadsheet-backed access-control implementation. Obtain IT/security review before production release.
- The supplied BRD leaves decisions for HR confirmation (for example, swap compatibility rules across departments and bulk-import notifications). The app follows the stated requirements and processes valid bulk-import rows while reporting invalid rows. Swap requests require both employees' identifiable SIC and L1 Manager approvers.
- No Google OAuth / SSO integration is included; sign-in uses the password hash in Emp_List.

## Email action links and sender display name

- `MailApp.sendEmail()` uses `name: "Shift Management"` for the sender display name. This does not change the actual sender email address; mail is still sent by the Google account that executes the deployed web app.
- After deploying the updated scripts, run `setupShiftManagement()` once from the Apps Script editor to create the `Shift_Swap_Approval_Links` sheet.
- Update the web-app deployment to execute as the new project owner. Configure the deployment audience so recipients can open the action links under company access policy. Because these links are bearer credentials, do not forward them; they expire after 72 hours, are single-use, and should only be sent to the designated approver email address.
- Email links do not alter the roster on a simple GET/open. The recipient sees a request summary and must click the confirmation button on the web page to record Accept, Decline, Approve, or Reject. No Shift Management password is required on that confirmation page.
- Verify a partner acceptance, partner decline, SIC approval, L1 Manager approval, rejection, expiry, and replayed-link attempt before production rollout.

## GitHub deployment

The existing .github/workflows/deploy.yml uses clasp push -f on commits to main/master. These files will be pushed to the configured Apps Script project by that workflow if SCRIPT_ID and CLASPRC_JSON are valid. Check the workflow run after commit, then update the Web App deployment version in Apps Script if needed.