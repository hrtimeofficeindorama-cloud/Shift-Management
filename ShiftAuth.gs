/**
 * Authentication, account recovery and HR role administration.
 * Passwords and recovery answers are salted and iteratively hashed; never store plaintext.
 */
var SHIFT_SESSION_TTL_SECONDS = 21600;
var SHIFT_HASH_ROUNDS = 12000;

function loginShiftApp(identity, password) {
  identity = String(identity || "").trim();
  password = String(password || "");
  if (!identity || !password) throw new Error("Enter your employee ID/email and password.");
  assertRateLimit_("LOGIN", identity, 10, 900);
  var emp = findEmployeeByIdentity_(identity);
  if (!emp) throw new Error("Invalid employee ID/email or password.");
  var stored = String(getEmpValue_(emp, ["Password", "Password Hash", "Login Password"]) || "");
  if (!stored || !verifyPassword_(password, stored)) {
    addAudit_(employeeId_(emp), "LOGIN_FAILED", [employeeId_(emp)], [], "", "", "Invalid login attempt", "Denied");
    throw new Error("Invalid employee ID/email or password. If you have not received a temporary password, contact HR.");
  }
  clearRateLimit_("LOGIN", identity);
  var token = issueSession_(emp, authVersion_(employeeId_(emp)));
  addAudit_(employeeId_(emp), "LOGIN", [employeeId_(emp)], [], "", "", "Successful login", "Success");
  return {
    token: token,
    employee: publicEmployee_(emp),
    mustChangePassword: stored.indexOf("TEMPv1$") === 0,
    needsRecoverySetup: !String(getEmpValue_(emp, ["Secret Question", "Security Question", "Recovery Question"]) || "").trim() ||
      !String(getEmpValue_(emp, ["Secret Answer Hash"]) || "").trim()
  };
}

/**
 * One-time bootstrap. Before use, set Script Property INITIAL_HR_BOOTSTRAP_KEY in
 * Apps Script Project Settings to a long random value. The key is deleted after success.
 */
function setupInitialHrAccount(employeeId, bootstrapKey, temporaryPassword, secretQuestion, secretAnswer) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty("INITIAL_HR_BOOTSTRAP_KEY");
  if (!expected || !bootstrapKey || !constantTimeEquals_(String(expected), String(bootstrapKey))) {
    throw new Error("Bootstrap key is invalid or has already been used. Set INITIAL_HR_BOOTSTRAP_KEY in Script Properties first.");
  }
  validatePassword_(temporaryPassword);
  validateRecovery_(secretQuestion, secretAnswer);
  var emp = findEmployeeByIdentity_(employeeId);
  if (!emp) throw new Error("Employee ID was not found in Emp_List.");
  updateEmployeeFields_(emp, {
    "Role|Roles|Access Role": "HR",
    "Password|Password Hash|Login Password": passwordHash_(temporaryPassword, true),
    "Secret Question|Security Question|Recovery Question": String(secretQuestion).trim(),
    "Secret Answer Hash": answerHash_(secretAnswer)
  });
  props.deleteProperty("INITIAL_HR_BOOTSTRAP_KEY");
  bumpAuthVersion_(employeeId_(emp));
  addAudit_(employeeId_(emp), "INITIAL_HR_BOOTSTRAP", [employeeId_(emp)], [], "", "", "Initial HR account bootstrapped", "Success");
  return "Initial HR account configured. Sign in using the employee ID and temporary password, then change the password.";
}

function getRecoveryQuestion(identity) {
  var emp = findEmployeeByIdentity_(String(identity || "").trim());
  if (!emp) return { found: false, message: "Account was not found." };
  var question = String(getEmpValue_(emp, ["Secret Question", "Security Question", "Recovery Question"]) || "").trim();
  if (!question) return { found: false, message: "No recovery question is set. Contact HR to reset the account." };
  return { found: true, question: question };
}

function resetPasswordWithSecret(identity, secretAnswer, newPassword) {
  assertRateLimit_("RESET", identity, 5, 900);
  var emp = findEmployeeByIdentity_(String(identity || "").trim());
  if (!emp) throw new Error("Unable to reset this account. Verify the details or contact HR.");
  validatePassword_(newPassword);
  var stored = String(getEmpValue_(emp, ["Secret Answer Hash"]) || "");
  if (!stored || !verifyAnswer_(secretAnswer, stored)) {
    addAudit_(employeeId_(emp), "PASSWORD_RESET_FAILED", [employeeId_(emp)], [], "", "", "Incorrect recovery answer", "Denied");
    throw new Error("Unable to reset this account. Verify the recovery answer or contact HR.");
  }
  updateEmployeeFields_(emp, { "Password|Password Hash|Login Password": passwordHash_(newPassword, false) });
  clearRateLimit_("RESET", identity);
  bumpAuthVersion_(employeeId_(emp));
  addAudit_(employeeId_(emp), "PASSWORD_RESET", [employeeId_(emp)], [], "", "", "Password reset using recovery question", "Success");
  return { success: true, message: "Password reset. You can now sign in." };
}

function changeMyPassword(token, currentPassword, newPassword, secretQuestion, secretAnswer) {
  var ctx = getAuthContext_(token);
  var oldStored = String(getEmpValue_(ctx.employee, ["Password", "Password Hash", "Login Password"]) || "");
  if (oldStored.indexOf("TEMPv1$") !== 0 && !verifyPassword_(String(currentPassword || ""), oldStored)) {
    throw new Error("Current password is incorrect.");
  }
  validatePassword_(newPassword);
  var updates = { "Password|Password Hash|Login Password": passwordHash_(newPassword, false) };
  if (String(secretQuestion || "").trim() || String(secretAnswer || "").trim()) {
    validateRecovery_(secretQuestion, secretAnswer);
    updates["Secret Question|Security Question|Recovery Question"] = String(secretQuestion).trim();
    updates["Secret Answer Hash"] = answerHash_(secretAnswer);
  }
  updateEmployeeFields_(ctx.employee, updates);
  bumpAuthVersion_(employeeId_(ctx.employee));
  var newToken = issueSession_(ctx.employee, authVersion_(employeeId_(ctx.employee)));
  addAudit_(employeeId_(ctx.employee), "PASSWORD_CHANGED", [employeeId_(ctx.employee)], [], "", "", "Password changed while signed in", "Success");
  return { success: true, token: newToken, message: "Password and account security settings saved." };
}

function saveAccountSecurity(token, currentPassword, secretQuestion, secretAnswer) {
  var ctx = requireFullSession_(token);
  var stored = String(getEmpValue_(ctx.employee, ["Password", "Password Hash", "Login Password"]) || "");
  if (!verifyPassword_(String(currentPassword || ""), stored)) throw new Error("Current password is incorrect.");
  validateRecovery_(secretQuestion, secretAnswer);
  updateEmployeeFields_(ctx.employee, {
    "Secret Question|Security Question|Recovery Question": String(secretQuestion).trim(),
    "Secret Answer Hash": answerHash_(secretAnswer)
  });
  addAudit_(ctx.empId, "RECOVERY_SETTINGS_CHANGED", [ctx.empId], [], "", "", "Secret question and answer updated", "Success");
  return { success: true, message: "Recovery question saved." };
}

function adminSetRoles(token, targetEmpId, roles) {
  var ctx = requireFullSession_(token);
  requireRole_(ctx.employee, "HR");
  var target = findEmployeeByIdentity_(targetEmpId);
  if (!target) throw new Error("Employee ID was not found.");
  var chosen = Array.isArray(roles) ? roles : String(roles || "").split(/[,;|]/);
  chosen = chosen.map(function(role) {
    var key = norm_(role);
    if (key === "hr" || key === "superadmin") return "HR";
    if (key === "sic" || key === "shiftincharge") return "SIC";
    if (key === "l1manager" || key === "manager") return "L1 Manager";
    if (key === "employee") return "Employee";
    throw new Error("Unsupported role: " + role);
  }).filter(function(role, idx, arr) { return arr.indexOf(role) === idx; });
  if (!chosen.length) throw new Error("Select at least one role.");
  var all = getEmployees_();
  var hrCount = all.filter(function(e) { return hasRole_(e, "HR"); }).length;
  if (hasRole_(target, "HR") && chosen.indexOf("HR") === -1 && hrCount <= 1) {
    throw new Error("The last HR/Super Admin role cannot be removed.");
  }
  var oldRoles = getRoles_(target);
  updateEmployeeFields_(target, { "Role|Roles|Access Role": chosen.join(", ") });
  addAudit_(ctx.empId, "ROLE_ASSIGNED", [employeeId_(target)], [], oldRoles, chosen, "HR changed employee roles", "Success");
  return { success: true, employee: publicEmployee_(findEmployeeById_(employeeId_(target))) };
}

function adminProvisionAccount(token, targetEmpId, temporaryPassword) {
  var ctx = requireFullSession_(token);
  requireRole_(ctx.employee, "HR");
  var target = findEmployeeByIdentity_(targetEmpId);
  if (!target) throw new Error("Employee ID was not found.");
  validatePassword_(temporaryPassword);
  updateEmployeeFields_(target, {
    "Password|Password Hash|Login Password": passwordHash_(temporaryPassword, true),
    "Secret Question|Security Question|Recovery Question": "",
    "Secret Answer Hash": ""
  });
  bumpAuthVersion_(employeeId_(target));
  addAudit_(ctx.empId, "ACCOUNT_PROVISIONED", [employeeId_(target)], [], "", "", "Temporary account provisioned by HR", "Success");
  return { success: true, message: "Temporary password set. The employee must change it at first login and set a recovery question." };
}

function getAdminEmployeeList(token) {
  var ctx = requireFullSession_(token);
  requireRole_(ctx.employee, "HR");
  return getEmployees_().map(publicEmployee_);
}

function getAuthContext_(token) {
  if (!token) throw new Error("Your session has expired. Sign in again.");
  var cache = CacheService.getScriptCache();
  var sessionKey = "SHIFT_SESSION_" + sha256Text_(String(token));
  var raw = cache.get(sessionKey);
  if (!raw) throw new Error("Your session has expired. Sign in again.");
  var session;
  try { session = JSON.parse(raw); } catch (e) { throw new Error("Your session is invalid. Sign in again."); }
  if (Number(session.version) !== authVersion_(session.empId)) {
    cache.remove(sessionKey);
    throw new Error("Your session was invalidated by an account-security change. Sign in again.");
  }
  var emp = findEmployeeById_(session.empId);
  if (!emp) {
    cache.remove(sessionKey);
    throw new Error("Employee account no longer exists.");
  }
  var stored = String(getEmpValue_(emp, ["Password", "Password Hash", "Login Password"]) || "");
  return { employee: emp, empId: employeeId_(emp), mustChangePassword: stored.indexOf("TEMPv1$") === 0, token: token };
}

function requireFullSession_(token) {
  var ctx = getAuthContext_(token);
  if (ctx.mustChangePassword) throw new Error("Change your temporary password before using the application.");
  return ctx;
}

function issueSession_(emp, version) {
  var token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put("SHIFT_SESSION_" + sha256Text_(token), JSON.stringify({
    empId: employeeId_(emp), version: Number(version || 1), issued: new Date().getTime()
  }), SHIFT_SESSION_TTL_SECONDS);
  return token;
}

function authVersion_(empId) {
  var key = "SHIFT_AUTH_VERSION_" + sha256Text_(String(empId));
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value ? Number(value) : 1;
}

function bumpAuthVersion_(empId) {
  var key = "SHIFT_AUTH_VERSION_" + sha256Text_(String(empId));
  PropertiesService.getScriptProperties().setProperty(key, String(authVersion_(empId) + 1));
}

function passwordHash_(password, temporary) {
  var salt = Utilities.getUuid().replace(/-/g, "");
  return (temporary ? "TEMPv1$" : "v1$") + salt + "$" + stretchHash_(salt, String(password));
}

function answerHash_(answer) {
  var salt = Utilities.getUuid().replace(/-/g, "");
  return "v1$" + salt + "$" + stretchHash_(salt, normalizeAnswer_(answer));
}

function verifyPassword_(password, stored) {
  var text = String(stored || "");
  if (text.indexOf("TEMPv1$") === 0) text = text.substring(4);
  if (text.indexOf("v1$") !== 0) return false;
  var pieces = text.split("$");
  return pieces.length === 3 && constantTimeEquals_(stretchHash_(pieces[1], String(password)), pieces[2]);
}

function verifyAnswer_(answer, stored) {
  var pieces = String(stored || "").split("$");
  return pieces.length === 3 && pieces[0] === "v1" &&
    constantTimeEquals_(stretchHash_(pieces[1], normalizeAnswer_(answer)), pieces[2]);
}

function stretchHash_(salt, secret) {
  var value = sha256Text_(salt + "|" + secret);
  for (var i = 1; i < SHIFT_HASH_ROUNDS; i++) value = sha256Text_(salt + "|" + value);
  return value;
}

function sha256Text_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return bytes.map(function(b) {
    var unsigned = (b + 256) % 256;
    return ("0" + unsigned.toString(16)).slice(-2);
  }).join("");
}

function constantTimeEquals_(a, b) {
  a = String(a || "");
  b = String(b || "");
  var mismatch = a.length ^ b.length;
  var length = Math.max(a.length, b.length);
  for (var i = 0; i < length; i++) mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}

function assertRateLimit_(kind, identity, maxAttempts, ttlSeconds) {
  var cache = CacheService.getScriptCache();
  var key = "SHIFT_RATE_" + kind + "_" + sha256Text_(norm_(identity));
  var count = Number(cache.get(key) || 0);
  if (count >= maxAttempts) {
    throw new Error("Too many attempts. Please wait 15 minutes before trying again.");
  }
  cache.put(key, String(count + 1), ttlSeconds);
}

function clearRateLimit_(kind, identity) {
  var key = "SHIFT_RATE_" + kind + "_" + sha256Text_(norm_(identity));
  CacheService.getScriptCache().remove(key);
}

function normalizeAnswer_(answer) {
  return String(answer || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function validatePassword_(password) {
  var value = String(password || "");
  if (value.length < 10) throw new Error("Password must contain at least 10 characters.");
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) throw new Error("Password must contain at least one letter and one number.");
}

function validateRecovery_(question, answer) {
  if (String(question || "").trim().length < 8) throw new Error("Enter a meaningful recovery question (at least 8 characters).");
  if (String(answer || "").trim().length < 3) throw new Error("Recovery answer must contain at least 3 characters.");
}