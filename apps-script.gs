/**
 * DOCUMENTRISM — Apps Script backend
 * =============================================================================
 * One spreadsheet, many people. The front end lives on Vercel and talks to this
 * script over a single POST endpoint; the person pastes this deployment's URL
 * into the app once and it is remembered on their device.
 *
 * WHAT THIS FILE GUARANTEES
 *   - Columns are found by header NAME, never by position.
 *   - No row is ever deleted. `archived` is set to "Yes" instead.
 *   - IDs are generated here, once, and never rewritten.
 *   - Every data action resolves the caller from their session token and can
 *     only ever see or touch rows stamped with their own owner_id.
 *   - Passwords are stored as a per-user salted, iterated SHA-256 hash. The
 *     plain password is never written anywhere.
 *
 * WHAT IT CANNOT GUARANTEE — read this before sharing the spreadsheet
 *   Hiding and protecting a tab only affects the Sheets UI. Anyone you give
 *   view access to this spreadsheet can unhide the Users tab, and can read
 *   every person's rows regardless of owner_id. The per-user isolation below
 *   holds through this API only. DO NOT SHARE THIS SPREADSHEET. Share exports.
 */

var APP = 'documentrism';
var VERSION = '2.0.0';

var TAB = {
  USERS: 'Users',
  SESSIONS: 'Sessions',
  HEADS: 'Heads',
  NOTES: 'Notes',
  LISTS: 'Lists',
  PREFS: 'Prefs',
  REPORT: 'Report'
};

var COLS = {
  Users:    ['user_id', 'username', 'name', 'password_hash', 'salt', 'dob',
             'reset_code', 'created_at', 'last_login', 'failed_logins',
             'locked_until', 'status'],
  Sessions: ['token', 'user_id', 'created_at', 'expires_at', 'agent'],
  Heads:    ['head_id', 'owner_id', 'created_at', 'title', 'client', 'type',
             'status', 'needs_detail', 'link', 'details', 'updated_at', 'archived'],
  Notes:    ['note_id', 'owner_id', 'head_id', 'created_at', 'text', 'type',
             'link', 'details', 'needs_detail', 'updated_at', 'archived'],
  Lists:    ['clients', 'types', 'statuses'],
  Prefs:    ['owner_id', 'mode', 'theme', 'custom_css', 'updated_at']
};

/** Columns that must never leave this file. */
var USER_SECRETS = ['password_hash', 'salt', 'reset_code', 'failed_logins', 'locked_until'];

var SEED = {
  types:    ['Section', 'Template', 'Update', 'Research', 'Bug', 'Other'],
  statuses: ['Active', 'Paused', 'Done']
};

var SESSION_DAYS = 30;
var HASH_ROUNDS = 1200;        // ~15ms in Apps Script; enough to make a stolen
                               // hash expensive to attack, cheap enough to log in
var MAX_FAILED = 8;
var LOCK_MINUTES = 15;
var MAX_CSS = 20000;

/* ========================================================================== */
/* HTTP                                                                       */
/* ========================================================================== */

/**
 * The only endpoint. The browser sends a POST with no custom headers, which
 * keeps it a "simple" request — Apps Script cannot answer a CORS preflight, so
 * anything that triggers one will fail.
 */
function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'That request was not valid JSON.', code: 'bad_request' });
  }
  return json(route(String(body.action || ''), body));
}

/** A browser hitting the URL directly gets a health check, never data. */
function doGet() {
  return json({ ok: true, app: APP, version: VERSION, note: 'POST to this URL.' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

var PUBLIC_ACTIONS = { ping: 1, signup: 1, login: 1, resetPassword: 1 };

function route(action, body) {
  try {
    if (!action) { return { ok: false, error: 'No action given.', code: 'bad_request' }; }

    // Anything not public must present a valid, unexpired session token.
    var user = null;
    if (!PUBLIC_ACTIONS[action]) {
      user = requireUser_(body.token);
    }

    switch (action) {
      /* --- open --- */
      case 'ping':          return { ok: true, app: APP, version: VERSION };
      case 'signup':        return doSignup(body);
      case 'login':         return doLogin(body);
      case 'resetPassword': return doResetPassword(body);

      /* --- session --- */
      case 'me':            return { ok: true, user: publicUser_(user) };
      case 'logout':        return doLogout(body.token);

      /* --- data --- */
      case 'bootstrap':     return doBootstrap(user);
      case 'getHeads':      return { ok: true, heads: ownedHeads_(user, !!body.include_archived) };
      case 'getHead':       return doGetHead(user, body.head_id);
      case 'createHead':    return doCreateHead(user, body.data);
      case 'updateHead':    return doUpdateHead(user, body.head_id, body.patch);
      case 'createNote':    return doCreateNote(user, body.data);
      case 'updateNote':    return doUpdateNote(user, body.note_id, body.patch);
      case 'moveNote':      return doUpdateNote(user, body.note_id, { head_id: body.head_id });
      case 'archiveHead':   return doUpdateHead(user, body.head_id, { archived: 'Yes' });
      case 'archiveNote':   return doUpdateNote(user, body.note_id, { archived: 'Yes' });
      case 'addClient':     return doAddClient(user, body.name);
      case 'savePrefs':     return doSavePrefs(user, body.prefs);
      case 'exportAll':     return doExportAll(user);

      default:
        return { ok: false, error: 'Unknown action: ' + action, code: 'bad_request' };
    }
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : 'Something went wrong.',
      code: (err && err.code) || 'server'
    };
  }
}

function fail_(message, code) {
  var e = new Error(message);
  e.code = code || 'server';
  throw e;
}

/* ========================================================================== */
/* Sheet plumbing                                                             */
/* ========================================================================== */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function table_(tabName) {
  var sh = ss_().getSheetByName(tabName);
  if (!sh) {
    fail_('The tab "' + tabName + '" is missing. Run Documentrism > Set up / repair tabs.', 'config');
  }
  var values = sh.getDataRange().getValues();
  var headers = (values.shift() || []).map(function (h) { return String(h).trim(); });
  var idx = {};
  headers.forEach(function (h, i) { if (h) { idx[h] = i; } });
  return { sh: sh, headers: headers, idx: idx, rows: values };
}

function col_(t, name) {
  if (!(name in t.idx)) {
    fail_('The column "' + name + '" is missing from "' + t.sh.getName() +
          '". Do not rename the header row.', 'config');
  }
  return t.idx[name];
}

function toObj_(t, row, fields) {
  var o = {};
  fields.forEach(function (f) { o[f] = f in t.idx ? row[t.idx[f]] : ''; });
  return o;
}

function iso_(v) {
  if (v instanceof Date) { return v.toISOString(); }
  return v === null || v === undefined ? '' : String(v);
}

function clean_(obj, fields) {
  var o = {};
  fields.forEach(function (f) { o[f] = iso_(obj[f]); });
  return o;
}

function rowFor_(t, obj) {
  var row = new Array(t.headers.length).fill('');
  Object.keys(obj).forEach(function (k) {
    if (k in t.idx) { row[t.idx[k]] = obj[k]; }
  });
  return row;
}

function findRow_(t, idCol, id) {
  var c = col_(t, idCol);
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][c]).trim() === id) { return i + 2; }
  }
  return -1;
}

function patchRow_(t, rowNum, patch) {
  Object.keys(patch).forEach(function (k) {
    if (k in t.idx) { t.sh.getRange(rowNum, t.idx[k] + 1).setValue(patch[k]); }
  });
}

function newId_(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' +
         Utilities.getUuid().replace(/-/g, '').slice(0, 5).toUpperCase();
}

function yes_(v) { return String(v).trim().toLowerCase() === 'yes'; }
function str_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ========================================================================== */
/* Passwords and sessions                                                     */
/* ========================================================================== */

function randomHex_(bytes) {
  var out = '';
  while (out.length < bytes * 2) {
    out += Utilities.getUuid().replace(/-/g, '');
  }
  return out.slice(0, bytes * 2);
}

function toHex_(bytes) {
  return bytes.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

/**
 * Salted and iterated SHA-256. Iteration is what makes a leaked hash expensive
 * to brute force; a single round of SHA-256 over a short password is not.
 */
function hashPassword_(password, salt) {
  var acc = salt + '::' + password;
  for (var i = 0; i < HASH_ROUNDS; i++) {
    acc = toHex_(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, acc, Utilities.Charset.UTF_8));
  }
  return acc;
}

/** Compares in constant time, so timing cannot reveal how much matched. */
function sameSecret_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) { return false; }
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function usersTable_() { return table_(TAB.USERS); }

function findUserBy_(field, value) {
  var t = usersTable_();
  if (!(field in t.idx)) { return null; }
  var c = t.idx[field];
  var want = str_(value).toLowerCase();
  if (!want) { return null; }
  for (var i = 0; i < t.rows.length; i++) {
    if (str_(t.rows[i][c]).toLowerCase() === want) {
      var o = toObj_(t, t.rows[i], COLS.Users);
      o._row = i + 2;
      return o;
    }
  }
  return null;
}

/** Login accepts the username or the display name, as asked. */
function findUserForLogin_(id) {
  return findUserBy_('username', id) || findUserBy_('name', id);
}

function publicUser_(u) {
  var out = {};
  COLS.Users.forEach(function (f) {
    if (USER_SECRETS.indexOf(f) === -1) { out[f] = iso_(u[f]); }
  });
  return out;
}

function newSession_(userId, agent) {
  var t = table_(TAB.SESSIONS);
  var token = randomHex_(32);
  var now = new Date();
  var expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  t.sh.appendRow(rowFor_(t, {
    token: token, user_id: userId, created_at: now,
    expires_at: expires, agent: str_(agent).slice(0, 120)
  }));
  sweepSessions_();
  return token;
}

function requireUser_(token) {
  var t = str_(token);
  if (!t) { fail_('Please sign in.', 'auth'); }

  var st = table_(TAB.SESSIONS);
  var tokCol = col_(st, 'token'), uidCol = col_(st, 'user_id'), expCol = col_(st, 'expires_at');
  var userId = null;
  for (var i = 0; i < st.rows.length; i++) {
    if (sameSecret_(str_(st.rows[i][tokCol]), t)) {
      var exp = st.rows[i][expCol];
      var expMs = exp instanceof Date ? exp.getTime() : Date.parse(exp);
      if (expMs && expMs < Date.now()) { fail_('Your session has expired. Sign in again.', 'auth'); }
      userId = str_(st.rows[i][uidCol]);
      break;
    }
  }
  if (!userId) { fail_('Your session is no longer valid. Sign in again.', 'auth'); }

  var user = findUserBy_('user_id', userId);
  if (!user) { fail_('That account no longer exists.', 'auth'); }
  if (str_(user.status).toLowerCase() === 'disabled') {
    fail_('That account has been disabled.', 'auth');
  }
  return user;
}

/** Keeps the Sessions tab from growing without limit. */
function sweepSessions_() {
  var t = table_(TAB.SESSIONS);
  var expCol = t.idx.expires_at;
  if (expCol === undefined) { return; }
  var cutoff = Date.now();
  for (var i = t.rows.length - 1; i >= 0; i--) {
    var exp = t.rows[i][expCol];
    var ms = exp instanceof Date ? exp.getTime() : Date.parse(exp);
    if (ms && ms < cutoff) { t.sh.deleteRow(i + 2); }
  }
}

/* ========================================================================== */
/* Accounts                                                                   */
/* ========================================================================== */

function doSignup(body) {
  var username = str_(body.username).toLowerCase();
  var name = str_(body.name);
  var password = String(body.password || '');
  var dob = str_(body.dob);

  if (!/^[a-z0-9._-]{3,24}$/.test(username)) {
    fail_('Username must be 3 to 24 characters: letters, numbers, dot, dash or underscore.', 'bad_request');
  }
  if (!name) { fail_('Please enter your name.', 'bad_request'); }
  if (password.length < 8) { fail_('Password must be at least 8 characters.', 'bad_request'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) { fail_('Please give your date of birth.', 'bad_request'); }

  return withLock_(function () {
    if (findUserBy_('username', username)) {
      fail_('That username is taken.', 'bad_request');
    }
    var t = usersTable_();
    var salt = randomHex_(16);
    var now = new Date();
    var rec = {
      user_id: newId_('U'),
      username: username,
      name: name,
      password_hash: hashPassword_(password, salt),
      salt: salt,
      dob: dob,
      reset_code: '',
      created_at: now,
      last_login: now,
      failed_logins: 0,
      locked_until: '',
      status: 'Active'
    };
    t.sh.appendRow(rowFor_(t, rec));
    var token = newSession_(rec.user_id, body.agent);
    return { ok: true, token: token, user: publicUser_(rec), prefs: defaultPrefs_() };
  });
}

function doLogin(body) {
  var id = str_(body.id);
  var password = String(body.password || '');
  if (!id || !password) { fail_('Enter your username and password.', 'bad_request'); }

  return withLock_(function () {
    var user = findUserForLogin_(id);

    // Always do the hashing work, even with no such user, so a wrong username
    // and a wrong password take the same time and cannot be told apart.
    var salt = user ? str_(user.salt) : randomHex_(16);
    var attempt = hashPassword_(password, salt);

    if (!user) { fail_('That username or password is wrong.', 'auth'); }

    var lockedUntil = user.locked_until instanceof Date
      ? user.locked_until.getTime() : Date.parse(user.locked_until);
    if (lockedUntil && lockedUntil > Date.now()) {
      var mins = Math.ceil((lockedUntil - Date.now()) / 60000);
      fail_('Too many wrong tries. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.', 'auth');
    }

    if (!sameSecret_(attempt, str_(user.password_hash))) {
      var t = usersTable_();
      var failed = Number(user.failed_logins || 0) + 1;
      var patch = { failed_logins: failed };
      if (failed >= MAX_FAILED) {
        patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000);
        patch.failed_logins = 0;
      }
      patchRow_(t, user._row, patch);
      fail_('That username or password is wrong.', 'auth');
    }

    patchRow_(usersTable_(), user._row, {
      failed_logins: 0, locked_until: '', last_login: new Date()
    });
    var token = newSession_(str_(user.user_id), body.agent);
    return { ok: true, token: token, user: publicUser_(user), prefs: prefsFor_(str_(user.user_id)) };
  });
}

/**
 * Two ways back in: the date of birth given at signup, or a reset code the
 * spreadsheet owner writes into the Users tab. The code is the safer one — a
 * date of birth is often guessable — so it is checked first and cleared on use.
 */
function doResetPassword(body) {
  var id = str_(body.id);
  var dob = str_(body.dob);
  var code = str_(body.reset_code);
  var newPassword = String(body.new_password || '');

  if (newPassword.length < 8) { fail_('New password must be at least 8 characters.', 'bad_request'); }
  if (!dob && !code) { fail_('Give your date of birth, or a reset code.', 'bad_request'); }

  return withLock_(function () {
    var user = findUserForLogin_(id);
    if (!user) { fail_('No account matches that, or the details are wrong.', 'auth'); }

    var ok = false;
    var stored = str_(user.reset_code);
    if (code && stored && sameSecret_(code.toUpperCase(), stored.toUpperCase())) { ok = true; }
    else if (dob && sameSecret_(dob, normDob_(user.dob))) { ok = true; }

    if (!ok) { fail_('No account matches that, or the details are wrong.', 'auth'); }

    var salt = randomHex_(16);
    patchRow_(usersTable_(), user._row, {
      salt: salt,
      password_hash: hashPassword_(newPassword, salt),
      reset_code: '',
      failed_logins: 0,
      locked_until: ''
    });
    return { ok: true, message: 'Password changed. Sign in with the new one.' };
  });
}

/** A date of birth may come back from the sheet as a Date or as text. */
function normDob_(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' +
           ('0' + (v.getMonth() + 1)).slice(-2) + '-' +
           ('0' + v.getDate()).slice(-2);
  }
  return str_(v);
}

function doLogout(token) {
  var t = table_(TAB.SESSIONS);
  var rowNum = findRow_(t, 'token', str_(token));
  if (rowNum > 0) { t.sh.deleteRow(rowNum); }
  return { ok: true };
}

/* ========================================================================== */
/* Preferences                                                                */
/* ========================================================================== */

function defaultPrefs_() {
  return { mode: 'signal', theme: 'dark', custom_css: '' };
}

function prefsFor_(ownerId) {
  var t = table_(TAB.PREFS);
  var c = col_(t, 'owner_id');
  for (var i = 0; i < t.rows.length; i++) {
    if (str_(t.rows[i][c]) === ownerId) {
      var o = toObj_(t, t.rows[i], COLS.Prefs);
      return {
        mode: str_(o.mode) || 'signal',
        theme: str_(o.theme) || 'dark',
        custom_css: String(o.custom_css || '')
      };
    }
  }
  return defaultPrefs_();
}

function doSavePrefs(user, prefs) {
  prefs = prefs || {};
  var css = String(prefs.custom_css || '');
  if (css.length > MAX_CSS) {
    fail_('Custom CSS is too long. Keep it under ' + MAX_CSS + ' characters.', 'bad_request');
  }
  css = sanitizeCss_(css);

  return withLock_(function () {
    var t = table_(TAB.PREFS);
    var ownerId = str_(user.user_id);
    var rowNum = findRow_(t, 'owner_id', ownerId);
    var rec = {
      owner_id: ownerId,
      mode: str_(prefs.mode) || 'signal',
      theme: str_(prefs.theme) || 'dark',
      custom_css: css,
      updated_at: new Date()
    };
    if (rowNum > 0) { patchRow_(t, rowNum, rec); } else { t.sh.appendRow(rowFor_(t, rec)); }
    return { ok: true, prefs: { mode: rec.mode, theme: rec.theme, custom_css: css } };
  });
}

/**
 * Keeps custom styling to styling. The front end checks this too, but the
 * server is the copy that matters: anything stored here is served back to the
 * browser later, so it must not be able to carry script or markup.
 */
function sanitizeCss_(css) {
  var s = String(css);

  // Markup would let the value break out of the <style> element it lands in.
  if (/[<>]/.test(s)) {
    fail_('Custom CSS cannot contain < or >. CSS only, no HTML.', 'bad_request');
  }
  var banned = [
    /javascript\s*:/i,
    /expression\s*\(/i,
    /-moz-binding/i,
    /behavior\s*:/i,
    /@import/i,
    /<\/?\s*style/i
  ];
  for (var i = 0; i < banned.length; i++) {
    if (banned[i].test(s)) {
      fail_('That custom CSS contains something that is not allowed. ' +
            'Remove any @import, javascript:, expression() or behavior: rule.', 'bad_request');
    }
  }
  // url() may only reference an inline image or an https image.
  var urls = s.match(/url\s*\(([^)]*)\)/gi) || [];
  for (var j = 0; j < urls.length; j++) {
    var inner = urls[j].replace(/^url\s*\(/i, '').replace(/\)$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!/^data:image\//i.test(inner) && !/^https:\/\//i.test(inner)) {
      fail_('url() in custom CSS must be an https: address or a data:image. Found: ' + inner, 'bad_request');
    }
  }
  return s;
}

/* ========================================================================== */
/* Data — every one of these is scoped to the caller                          */
/* ========================================================================== */

function ownedHeads_(user, includeArchived) {
  var ht = table_(TAB.HEADS);
  var nt = table_(TAB.NOTES);
  var ownerId = str_(user.user_id);

  var counts = {};
  var nHead = col_(nt, 'head_id'), nOwner = col_(nt, 'owner_id'), nArch = nt.idx.archived;
  nt.rows.forEach(function (r) {
    if (str_(r[nOwner]) !== ownerId) { return; }
    if (nArch !== undefined && yes_(r[nArch])) { return; }
    var hid = str_(r[nHead]);
    if (hid) { counts[hid] = (counts[hid] || 0) + 1; }
  });

  var hId = col_(ht, 'head_id'), hOwner = col_(ht, 'owner_id');
  var out = [];
  ht.rows.forEach(function (r) {
    if (!str_(r[hId]) || str_(r[hOwner]) !== ownerId) { return; }
    var o = clean_(toObj_(ht, r, COLS.Heads), COLS.Heads);
    o.archived = yes_(o.archived) ? 'Yes' : 'No';
    if (o.archived === 'Yes' && !includeArchived) { return; }
    o.note_count = counts[o.head_id] || 0;
    out.push(o);
  });

  out.sort(function (a, b) {
    return (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '');
  });
  return out;
}

function ownedNotes_(user, pred) {
  var nt = table_(TAB.NOTES);
  var ownerId = str_(user.user_id);
  var idCol = col_(nt, 'note_id'), oCol = col_(nt, 'owner_id');
  var out = [];
  nt.rows.forEach(function (r) {
    if (!str_(r[idCol]) || str_(r[oCol]) !== ownerId) { return; }
    var o = clean_(toObj_(nt, r, COLS.Notes), COLS.Notes);
    o.head_id = str_(o.head_id);
    o.archived = yes_(o.archived) ? 'Yes' : 'No';
    if (o.archived === 'Yes') { return; }
    if (pred(o)) { out.push(o); }
  });
  return out;
}

/** Throws unless this head exists AND belongs to the caller. */
function requireOwnHead_(user, headId) {
  var ht = table_(TAB.HEADS);
  var rowNum = findRow_(ht, 'head_id', str_(headId));
  if (rowNum < 0) { fail_('That head does not exist.', 'not_found'); }
  var row = ht.rows[rowNum - 2];
  if (str_(row[col_(ht, 'owner_id')]) !== str_(user.user_id)) {
    fail_('That head does not exist.', 'not_found');   // same message: reveals nothing
  }
  return { t: ht, rowNum: rowNum, row: row };
}

function requireOwnNote_(user, noteId) {
  var nt = table_(TAB.NOTES);
  var rowNum = findRow_(nt, 'note_id', str_(noteId));
  if (rowNum < 0) { fail_('That note does not exist.', 'not_found'); }
  var row = nt.rows[rowNum - 2];
  if (str_(row[col_(nt, 'owner_id')]) !== str_(user.user_id)) {
    fail_('That note does not exist.', 'not_found');
  }
  return { t: nt, rowNum: rowNum, row: row };
}

function doBootstrap(user) {
  var heads = ownedHeads_(user, false);
  var inbox = ownedNotes_(user, function (n) { return !n.head_id; });
  inbox.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });

  var needsDetail = heads.filter(function (h) { return yes_(h.needs_detail); }).length +
                    ownedNotes_(user, function (n) { return yes_(n.needs_detail); }).length;

  return {
    ok: true,
    user: publicUser_(user),
    prefs: prefsFor_(str_(user.user_id)),
    lists: getLists_(),
    heads: heads,
    inbox: inbox,
    stats: {
      heads: heads.length,
      active: heads.filter(function (h) { return str_(h.status) === 'Active'; }).length,
      inbox: inbox.length,
      needs_detail: needsDetail
    },
    server_time: new Date().toISOString()
  };
}

function doGetHead(user, headId) {
  var found = requireOwnHead_(user, headId);
  var head = clean_(toObj_(found.t, found.row, COLS.Heads), COLS.Heads);
  head.archived = yes_(head.archived) ? 'Yes' : 'No';

  var notes = ownedNotes_(user, function (n) { return n.head_id === str_(headId); });
  notes.sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
  head.note_count = notes.length;
  return { ok: true, head: head, notes: notes };
}

function doCreateHead(user, data) {
  data = data || {};
  var title = str_(data.title);
  if (!title) { fail_('A head needs a title.', 'bad_request'); }

  return withLock_(function () {
    var t = table_(TAB.HEADS);
    var now = new Date();
    var rec = {
      head_id: newId_('H'),
      owner_id: str_(user.user_id),
      created_at: now,
      title: title,
      client: str_(data.client),
      type: str_(data.type),
      status: str_(data.status) || 'Active',
      needs_detail: data.needs_detail === 'Yes' ? 'Yes' : 'No',
      link: str_(data.link),
      details: String(data.details || ''),
      updated_at: now,
      archived: 'No'
    };
    t.sh.appendRow(rowFor_(t, rec));
    if (rec.client) { ensureListValue_('clients', rec.client); }
    queueReport_();
    var out = clean_(rec, COLS.Heads);
    out.note_count = 0;
    return { ok: true, head: out };
  });
}

function doUpdateHead(user, headId, patch) {
  return withLock_(function () {
    var found = requireOwnHead_(user, headId);
    var allowed = ['title', 'client', 'type', 'status', 'needs_detail', 'link', 'details', 'archived'];
    var write = {};
    allowed.forEach(function (k) { if (patch && k in patch) { write[k] = patch[k]; } });
    if (write.title !== undefined && !str_(write.title)) {
      fail_('A head needs a title.', 'bad_request');
    }
    write.updated_at = new Date();
    patchRow_(found.t, found.rowNum, write);
    if (write.client) { ensureListValue_('clients', str_(write.client)); }
    queueReport_();
    return { ok: true, updated_at: write.updated_at.toISOString() };
  });
}

function doCreateNote(user, data) {
  data = data || {};
  var text = str_(data.text);
  if (!text) { fail_('A note needs some text.', 'bad_request'); }

  var headId = str_(data.head_id);
  if (headId) { requireOwnHead_(user, headId); }   // cannot file into someone else's head

  return withLock_(function () {
    var t = table_(TAB.NOTES);
    var now = new Date();
    var rec = {
      note_id: newId_('N'),
      owner_id: str_(user.user_id),
      head_id: headId,
      created_at: now,
      text: text,
      type: str_(data.type),
      link: str_(data.link),
      details: String(data.details || ''),
      needs_detail: data.needs_detail === 'Yes' ? 'Yes' : 'No',
      updated_at: now,
      archived: 'No'
    };
    t.sh.appendRow(rowFor_(t, rec));
    if (headId) { touchHead_(headId, now); }
    queueReport_();
    return { ok: true, note: clean_(rec, COLS.Notes) };
  });
}

function doUpdateNote(user, noteId, patch) {
  return withLock_(function () {
    var found = requireOwnNote_(user, noteId);
    var allowed = ['head_id', 'text', 'type', 'link', 'details', 'needs_detail', 'archived'];
    var write = {};
    allowed.forEach(function (k) { if (patch && k in patch) { write[k] = patch[k]; } });

    if (write.text !== undefined && !str_(write.text)) {
      fail_('A note needs some text.', 'bad_request');
    }
    if (write.head_id) { requireOwnHead_(user, write.head_id); }

    var now = new Date();
    write.updated_at = now;
    var previousHead = str_(found.row[col_(found.t, 'head_id')]);
    patchRow_(found.t, found.rowNum, write);

    if (write.head_id) { touchHead_(str_(write.head_id), now); }
    if (previousHead && previousHead !== str_(write.head_id || '')) { touchHead_(previousHead, now); }
    queueReport_();
    return { ok: true, updated_at: now.toISOString() };
  });
}

function touchHead_(headId, when) {
  var t = table_(TAB.HEADS);
  var rowNum = findRow_(t, 'head_id', headId);
  if (rowNum > 0) {
    t.sh.getRange(rowNum, col_(t, 'updated_at') + 1).setValue(when || new Date());
  }
}

function doAddClient(user, name) {
  return withLock_(function () {
    ensureListValue_('clients', name);
    return { ok: true, lists: getLists_() };
  });
}

function doExportAll(user) {
  var ownerId = str_(user.user_id);
  var ht = table_(TAB.HEADS), nt = table_(TAB.NOTES);
  var heads = [], notes = [];

  var hId = col_(ht, 'head_id'), hOwner = col_(ht, 'owner_id');
  ht.rows.forEach(function (r) {
    if (str_(r[hId]) && str_(r[hOwner]) === ownerId) {
      heads.push(clean_(toObj_(ht, r, COLS.Heads), COLS.Heads));
    }
  });
  var nId = col_(nt, 'note_id'), nOwner = col_(nt, 'owner_id');
  nt.rows.forEach(function (r) {
    if (str_(r[nId]) && str_(r[nOwner]) === ownerId) {
      notes.push(clean_(toObj_(nt, r, COLS.Notes), COLS.Notes));
    }
  });

  return {
    ok: true,
    data: {
      app: APP,
      generated_at: new Date().toISOString(),
      account: publicUser_(user),
      lists: getLists_(),
      heads: heads,
      notes: notes
    }
  };
}

/* ========================================================================== */
/* Lists                                                                      */
/* ========================================================================== */

function getLists_() {
  var t = table_(TAB.LISTS);
  var out = { clients: [], types: [], statuses: [] };
  COLS.Lists.forEach(function (name) {
    if (!(name in t.idx)) { return; }
    var c = t.idx[name], seen = {};
    t.rows.forEach(function (r) {
      var v = str_(r[c]);
      if (v && !seen[v]) { seen[v] = 1; out[name].push(v); }
    });
  });
  if (!out.types.length) { out.types = SEED.types.slice(); }
  if (!out.statuses.length) { out.statuses = SEED.statuses.slice(); }
  return out;
}

function ensureListValue_(listName, value) {
  value = str_(value);
  if (!value) { return; }
  var t = table_(TAB.LISTS);
  if (!(listName in t.idx)) { return; }
  var c = t.idx[listName], lastRow = 1;
  for (var i = 0; i < t.rows.length; i++) {
    var v = str_(t.rows[i][c]);
    if (v.toLowerCase() === value.toLowerCase()) { return; }
    if (v) { lastRow = i + 2; }
  }
  t.sh.getRange(lastRow + 1, c + 1).setValue(value);
}

/* ========================================================================== */
/* Report tab                                                                 */
/* ========================================================================== */

/**
 * Written by the script rather than by formulas: a formula cannot reliably
 * group notes under their head, and a broken one would show wrong work with no
 * error at all.
 *
 * NOTE: this tab contains EVERY user's work, grouped by person. It exists for
 * you, the spreadsheet owner. Do not share the spreadsheet to share a report —
 * use each person's own Export instead.
 */
function rebuildReport() {
  var sh = ss_().getSheetByName(TAB.REPORT) || ss_().insertSheet(TAB.REPORT);
  var tz = ss_().getSpreadsheetTimeZone();

  function when(v) {
    if (!v) { return ''; }
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v) : Utilities.formatDate(d, tz, 'dd MMM yyyy, HH:mm');
  }

  var ut = usersTable_();
  var users = [];
  ut.rows.forEach(function (r) {
    var o = toObj_(ut, r, COLS.Users);
    if (str_(o.user_id)) { users.push({ id: str_(o.user_id), name: str_(o.name) || str_(o.username) }); }
  });

  var ht = table_(TAB.HEADS), nt = table_(TAB.NOTES);
  var notesByHead = {}, inboxByOwner = {};
  var nId = col_(nt, 'note_id'), nArch = nt.idx.archived;
  nt.rows.forEach(function (r) {
    if (!str_(r[nId])) { return; }
    if (nArch !== undefined && yes_(r[nArch])) { return; }
    var o = clean_(toObj_(nt, r, COLS.Notes), COLS.Notes);
    if (o.head_id) { (notesByHead[o.head_id] = notesByHead[o.head_id] || []).push(o); }
    else { (inboxByOwner[o.owner_id] = inboxByOwner[o.owner_id] || []).push(o); }
  });

  var headsByOwner = {};
  var hId = col_(ht, 'head_id'), hArch = ht.idx.archived;
  ht.rows.forEach(function (r) {
    if (!str_(r[hId])) { return; }
    if (hArch !== undefined && yes_(r[hArch])) { return; }
    var o = clean_(toObj_(ht, r, COLS.Heads), COLS.Heads);
    (headsByOwner[o.owner_id] = headsByOwner[o.owner_id] || []).push(o);
  });

  var rows = [['DOCUMENTRISM — REPORT', '', '', '', 'Updated ' + when(new Date()), '']];
  rows.push(['', '', '', '', '', '']);
  rows.push(['WORK / ENTRY', 'CLIENT', 'TYPE', 'STATUS', 'DATE', 'LINK']);
  var personRows = [], headRows = [];

  users.forEach(function (u) {
    var mine = (headsByOwner[u.id] || []).sort(function (a, b) {
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
    var inbox = inboxByOwner[u.id] || [];
    if (!mine.length && !inbox.length) { return; }

    personRows.push(rows.length + 1);
    rows.push([u.name.toUpperCase(), '', '', '', '', '']);

    mine.forEach(function (h) {
      headRows.push(rows.length + 1);
      rows.push(['  ' + h.title, h.client, h.type, h.status,
                 when(h.updated_at || h.created_at), h.link]);
      var ns = (notesByHead[h.head_id] || []).sort(function (a, b) {
        return (b.created_at || '').localeCompare(a.created_at || '');
      });
      if (!ns.length) { rows.push(['      (no notes yet)', '', '', '', '', '']); }
      ns.forEach(function (n) {
        rows.push(['      ' + n.text, '', n.type, '', when(n.created_at), n.link]);
      });
    });

    if (inbox.length) {
      headRows.push(rows.length + 1);
      rows.push(['  Inbox — not filed yet', '', '', '', '', '']);
      inbox.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
      inbox.forEach(function (n) {
        rows.push(['      ' + n.text, '', n.type, '', when(n.created_at), n.link]);
      });
    }
    rows.push(['', '', '', '', '', '']);
  });

  sh.clear();
  sh.getRange(1, 1, rows.length, 6).setValues(rows);
  sh.setFrozenRows(3);
  sh.getRange('A1:F1').merge().setFontSize(14).setFontWeight('bold');
  sh.getRange('A3:F3').setFontWeight('bold').setFontSize(9)
    .setBackground('#f1f3f5').setFontColor('#495057');
  personRows.forEach(function (r) {
    sh.getRange(r, 1, 1, 6).setFontWeight('bold').setFontSize(11).setBackground('#e7f5ff');
  });
  headRows.forEach(function (r) {
    sh.getRange(r, 1, 1, 6).setFontWeight('bold').setBackground('#f8f9fa');
  });
  sh.getRange(1, 1, rows.length, 6).setVerticalAlignment('top').setWrap(true);
  [460, 130, 110, 90, 150, 220].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return rows.length;
}

function queueReport_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var pending = props.getProperty('report_pending');
    var now = Date.now();
    if (pending && now - Number(pending) < 25000) { return; }
    props.setProperty('report_pending', String(now));
    ScriptApp.newTrigger('flushReport_').timeBased().after(8000).create();
  } catch (e) {
    Logger.log('queueReport_: ' + e.message);   // never fail a user's save over this
  }
}

function flushReport_() {
  PropertiesService.getScriptProperties().deleteProperty('report_pending');
  cleanupTriggers_('flushReport_');
  rebuildReport();
}

function cleanupTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) { ScriptApp.deleteTrigger(t); }
  });
}

function onEditTrigger(e) {
  if (!e || !e.range) { return; }
  var name = e.range.getSheet().getName();
  if (name === TAB.HEADS || name === TAB.NOTES) { queueReport_(); }
}

/* ========================================================================== */
/* Setup and owner tools                                                      */
/* ========================================================================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Documentrism')
    .addItem('Set up / repair tabs', 'setupSheet')
    .addItem('Rebuild Report tab', 'rebuildReport')
    .addSeparator()
    .addItem('Issue a password reset code', 'issueResetCode')
    .addItem('Show hidden tabs', 'showHiddenTabs')
    .addItem('Hide account tabs again', 'hideAccountTabs')
    .addToUi();
}

function setupSheet() {
  var book = ss_();
  Object.keys(COLS).forEach(function (key) {
    var name = TAB[key.toUpperCase()];
    var sh = book.getSheetByName(name) || book.insertSheet(name);
    var width = Math.max(sh.getLastColumn(), 1);
    var existing = sh.getRange(1, 1, 1, width).getValues()[0]
      .map(function (h) { return String(h).trim(); });

    var missing = COLS[key].filter(function (c) { return existing.indexOf(c) === -1; });
    if (missing.length) {
      var startCol = existing.filter(String).length + 1;
      var need = startCol + missing.length - 1;
      if (sh.getMaxColumns() < need) { sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns()); }
      sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
    }
    sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), COLS[key].length))
      .setFontWeight('bold').setBackground('#f1f3f5').setFontSize(10);
    sh.setFrozenRows(1);
  });

  // Seed the shared dropdowns once.
  var lt = table_(TAB.LISTS);
  ['types', 'statuses'].forEach(function (name) {
    if (!(name in lt.idx)) { return; }
    var c = lt.idx[name];
    var has = lt.rows.some(function (r) { return str_(r[c]); });
    if (!has) {
      lt.sh.getRange(2, c + 1, SEED[name].length, 1)
        .setValues(SEED[name].map(function (v) { return [v]; }));
    }
  });

  if (!book.getSheetByName(TAB.REPORT)) { book.insertSheet(TAB.REPORT); }

  cleanupTriggers_('onEditTrigger');
  ScriptApp.newTrigger('onEditTrigger').forSpreadsheet(book).onEdit().create();

  hideAccountTabs();
  rebuildReport();
  return 'Documentrism is ready. Deploy the web app, then paste its URL into the app.';
}

/**
 * Hiding is housekeeping, not security — see the warning at the top of this
 * file. It keeps credentials out of your way, nothing more.
 */
function hideAccountTabs() {
  [TAB.USERS, TAB.SESSIONS, TAB.PREFS].forEach(function (name) {
    var sh = ss_().getSheetByName(name);
    if (sh) {
      sh.hideSheet();
      try {
        var p = sh.protect().setDescription(name + ' — managed by Documentrism');
        p.removeEditors(p.getEditors().filter(function (u) {
          return u.getEmail() !== Session.getEffectiveUser().getEmail();
        }));
      } catch (e) { Logger.log('protect ' + name + ': ' + e.message); }
    }
  });
  return 'Account tabs hidden.';
}

function showHiddenTabs() {
  [TAB.USERS, TAB.SESSIONS, TAB.PREFS].forEach(function (name) {
    var sh = ss_().getSheetByName(name);
    if (sh) { sh.showSheet(); }
  });
  return 'Account tabs visible. Hide them again when you are done.';
}

/**
 * The safer way back in for someone locked out. Writes a one-time code into
 * their row; they type it on the reset screen and it is cleared on use.
 */
function issueResetCode() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Password reset', 'Username of the person who is locked out:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) { return; }

  var username = str_(res.getResponseText()).toLowerCase();
  var user = findUserBy_('username', username);
  if (!user) { ui.alert('No account with the username "' + username + '".'); return; }

  var code = randomHex_(4).toUpperCase();
  patchRow_(usersTable_(), user._row, {
    reset_code: code, failed_logins: 0, locked_until: ''
  });
  ui.alert('Reset code for ' + username + ':\n\n' + code +
           '\n\nGive this to them in person or over a channel you trust. ' +
           'It works once, on the "Forgot password" screen.');
}
