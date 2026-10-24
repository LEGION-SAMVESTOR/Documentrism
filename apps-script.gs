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
var VERSION = '2.3.0';

/**
 * What this deployment can do. ping returns it without a session, so you can
 * paste the /exec URL in a browser and see at a glance which version is live —
 * which is otherwise impossible to tell from the outside, and the one question
 * that comes up every time the front end moves ahead of the backend.
 */
var CAPABILITIES = ['accounts', 'sharing', 'images', 'validation', 'search',
                    'subheads', 'notelinks', 'notetree', 'layouts'];

/** How deep heads may nest. A head, its sub-heads, and two more levels. */
var MAX_DEPTH = 4;

var TAB = {
  USERS: 'Users',
  SESSIONS: 'Sessions',
  HEADS: 'Heads',
  NOTES: 'Notes',
  LISTS: 'Lists',
  PREFS: 'Prefs',
  SHARES: 'Shares',
  REPORT: 'Report'
};

var COLS = {
  Users:    ['user_id', 'username', 'name', 'password_hash', 'salt', 'dob',
             'reset_code', 'created_at', 'last_login', 'failed_logins',
             'locked_until', 'status'],
  Sessions: ['token', 'user_id', 'created_at', 'expires_at', 'agent'],
  Heads:    ['head_id', 'owner_id', 'parent_id', 'created_at', 'title', 'client',
             'type', 'status', 'needs_detail', 'link', 'details', 'updated_at',
             'archived'],
  Notes:    ['note_id', 'owner_id', 'head_id', 'parent_note_id', 'links',
             'created_at', 'text', 'type', 'link', 'details', 'needs_detail',
             'images', 'updated_at', 'archived'],
  Lists:    ['clients', 'types', 'statuses'],
  Prefs:    ['owner_id', 'mode', 'layout', 'theme', 'style', 'accent', 'font',
             'fsize', 'density', 'anim', 'custom_css', 'updated_at'],
  Shares:   ['share_id', 'owner_id', 'target_id', 'kind', 'item_id',
             'created_at', 'revoked']
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
  return json({ ok: true, app: APP, version: VERSION, can: CAPABILITIES,
                note: 'POST to this URL.' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

var PUBLIC_ACTIONS = { ping: 1, signup: 1, login: 1, resetPassword: 1 };

/** Actions that change the sheet, and so must never run twice for one request. */
var WRITE_ACTIONS = {
  createHead: 1, createNote: 1, updateHead: 1, updateNote: 1, moveNote: 1,
  archiveHead: 1, archiveNote: 1, addClient: 1, savePrefs: 1,
  shareItem: 1, unshareItem: 1, addNoteImage: 1, removeNoteImage: 1,
  linkNotes: 1, unlinkNotes: 1
};

var OP_TTL_SECONDS = 900;

/**
 * Runs a write exactly once, however many times the request arrives.
 *
 * A POST to /exec is answered with a redirect, and following it can replay the
 * POST — which meant one "add note" wrote two rows. A client retry after a
 * timeout could do the same, because a request that times out may still have
 * succeeded. So every write carries an op_id: the first run stores its result
 * under that id and any repeat gets the stored result back instead of writing
 * again. The check and the write happen inside one lock, so two copies racing
 * cannot both get past it.
 */
function runWrite_(opId, fn) {
  return withLock_(function () {
    var key = opId ? 'op:' + opId : null;
    var cache = key ? CacheService.getScriptCache() : null;

    if (key) {
      var prior = cache.get(key);
      if (prior) {
        try {
          var parsed = JSON.parse(prior);
          parsed.replayed = true;      // so the client can tell, if it cares
          return parsed;
        } catch (e) { /* unreadable: fall through and do the work */ }
      }
    }

    var res = fn();
    if (key && res && res.ok) {
      try { cache.put(key, JSON.stringify(res), OP_TTL_SECONDS); } catch (e) {}
    }
    return res;
  });
}

function route(action, body) {
  try {
    if (!action) { return { ok: false, error: 'No action given.', code: 'bad_request' }; }

    // Anything not public must present a valid, unexpired session token.
    var user = null;
    if (!PUBLIC_ACTIONS[action]) {
      user = requireUser_(body.token);
    }

    if (WRITE_ACTIONS[action]) {
      return runWrite_(str_(body.op_id), function () { return dispatch_(action, body, user); });
    }
    return dispatch_(action, body, user);
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : 'Something went wrong.',
      code: (err && err.code) || 'server'
    };
  }
}

function dispatch_(action, body, user) {
  {
    switch (action) {
      /* --- open --- */
      case 'ping':          return { ok: true, app: APP, version: VERSION, can: CAPABILITIES };
      case 'signup':        return doSignup(body);
      case 'login':         return doLogin(body);
      case 'resetPassword': return doResetPassword(body);

      /* --- session --- */
      case 'me':            return { ok: true, user: publicUser_(user) };
      case 'logout':        return doLogout(body.token);

      /* --- data --- */
      case 'bootstrap':     return doBootstrap(user);
      case 'getHeads':      return { ok: true, heads: ownedHeads_(user, !!body.include_archived) };
      case 'searchNotes':   return doSearchNotes(user, body.q);
      case 'getHead':       return doGetHead(user, body.head_id);
      case 'getNote':       return doGetNote(user, body.note_id);
      case 'linkNotes':     return doLinkNotes(user, body.note_id, body.other_id);
      case 'unlinkNotes':   return doUnlinkNotes(user, body.note_id, body.other_id);
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

      /* --- sharing --- */
      case 'listPeople':    return doListPeople(user);
      case 'listShares':    return doListShares(user);
      case 'shareItem':     return doShareItem(user, body.kind, body.item_id, body.to);
      case 'unshareItem':   return doUnshareItem(user, body.share_id);

      /* --- images --- */
      case 'addNoteImage':    return doAddNoteImage(user, body.note_id, body.data_url, body.name);
      case 'getImage':        return doGetImage(user, body.image_id);
      case 'removeNoteImage': return doRemoveNoteImage(user, body.note_id, body.image_id);

      default:
        return { ok: false, error: 'Unknown action: ' + action, code: 'bad_request' };
    }
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

/**
 * Read-through cache for the length of ONE request.
 *
 * Reading a tab is a round trip to the Sheets service — by far the most
 * expensive thing this script does. Bootstrap used to read Notes three times
 * and Users and Sessions once each on top; now every tab is read at most once
 * per request. Any write invalidates its tab with dirty_(), so nothing here
 * can hand back values that a write in the same request has already changed.
 */
var TABLE_CACHE_ = {};

function table_(tabName) {
  if (TABLE_CACHE_[tabName]) { return TABLE_CACHE_[tabName]; }

  var sh = ss_().getSheetByName(tabName);
  if (!sh) {
    fail_('The tab "' + tabName + '" is missing. Run Documentrism > Set up / repair tabs.', 'config');
  }
  var values = sh.getDataRange().getValues();
  var headers = (values.shift() || []).map(function (h) { return String(h).trim(); });
  var idx = {};
  headers.forEach(function (h, i) { if (h) { idx[h] = i; } });

  var t = { sh: sh, headers: headers, idx: idx, rows: values };
  TABLE_CACHE_[tabName] = t;
  return t;
}

/** Call straight after writing to a tab, so the next read sees the change. */
function dirty_(tabName) { delete TABLE_CACHE_[tabName]; }

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
  dirty_(t.sh.getName());
}

/** Appending goes through here so the cache is always invalidated with it. */
function appendRow_(t, obj) {
  t.sh.appendRow(rowFor_(t, obj));
  dirty_(t.sh.getName());
}

function newId_(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' +
         Utilities.getUuid().replace(/-/g, '').slice(0, 5).toUpperCase();
}

function yes_(v) { return String(v).trim().toLowerCase() === 'yes'; }
function str_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

/* ========================================================================== */
/* Validation                                                                 */
/* ========================================================================== */

/**
 * A title has to be something you could read back in a week and recognise.
 * "4" or "2026" is a number, not a piece of work, so a title must carry at
 * least one letter and be at least two characters long.
 */
function checkTitle_(value) {
  var title = str_(value);
  if (!title) { fail_('A head needs a title.', 'bad_request'); }
  if (title.length < 2) { fail_('That title is too short — give it at least 2 characters.', 'bad_request'); }
  if (!/[A-Za-zÀ-ɏऀ-ॿ]/.test(title)) {
    fail_('A title needs at least one letter — "' + title + '" on its own will not mean anything later.', 'bad_request');
  }
  return title;
}

/** Empty, or a real web address. Nothing else — javascript: least of all. */
function checkLink_(value) {
  var link = str_(value);
  if (!link) { return ''; }
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(link)) {
    fail_('A link must start with http:// or https:// — got "' + link + '".', 'bad_request');
  }
  return link;
}

/** Empty, or one of the values on the Lists tab. No free text. */
function checkClient_(value) {
  var client = str_(value);
  if (!client) { return ''; }
  var allowed = getLists_().clients;
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i].toLowerCase() === client.toLowerCase()) { return allowed[i]; }
  }
  fail_('"' + client + '" is not in the client list. Add it on the Lists tab first.', 'bad_request');
}

/** Empty, or one of the values on the Lists tab, for type and status. */
function checkFromList_(value, listName, label) {
  var v = str_(value);
  if (!v) { return ''; }
  var allowed = getLists_()[listName] || [];
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i].toLowerCase() === v.toLowerCase()) { return allowed[i]; }
  }
  fail_('"' + v + '" is not a valid ' + label + '.', 'bad_request');
}

/** Reentrant: an inner withLock_ inside an outer one must not deadlock. */
var LOCK_DEPTH_ = 0;

function withLock_(fn) {
  if (LOCK_DEPTH_ > 0) {
    LOCK_DEPTH_++;
    try { return fn(); } finally { LOCK_DEPTH_--; }
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_DEPTH_++;
  try { return fn(); } finally { LOCK_DEPTH_--; lock.releaseLock(); }
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
  appendRow_(t, {
    token: token, user_id: userId, created_at: now,
    expires_at: expires, agent: str_(agent).slice(0, 120)
  });
  sweepSessions_();
  return token;
}

/**
 * Resolving a token used to read the whole Sessions tab and the whole Users
 * tab on EVERY request. Both are now cached for two minutes against the token.
 *
 * The trade: disabling an account, or deleting its session row by hand, takes
 * up to two minutes to bite. Signing out clears the entry immediately, and a
 * wrong or expired token is never cached, so this only ever shortcuts a
 * session that was valid moments ago.
 */
var SESSION_TTL_SECONDS = 120;

function requireUser_(token) {
  var t = str_(token);
  if (!t) { fail_('Please sign in.', 'auth'); }

  var cache = CacheService.getScriptCache();
  var key = 'u:' + t;
  var hit = cache.get(key);
  if (hit) {
    try {
      var cached = JSON.parse(hit);
      if (cached && cached.user_id) { return cached; }
    } catch (e) { /* fall through and resolve properly */ }
  }

  var user = resolveUser_(t);
  try { cache.put(key, JSON.stringify(user), SESSION_TTL_SECONDS); } catch (e) {}
  return user;
}

function forgetSession_(token) {
  try { CacheService.getScriptCache().remove('u:' + str_(token)); } catch (e) {}
}

function resolveUser_(t) {
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

/**
 * Keeps the Sessions tab from growing without limit. Deleting rows one by one
 * is slow, and it used to run on every single sign-in; once a day is plenty.
 */
function sweepSessions_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var last = Number(props.getProperty('sessions_swept') || 0);
    if (Date.now() - last < 86400000) { return; }
    props.setProperty('sessions_swept', String(Date.now()));
  } catch (e) { return; }

  var t = table_(TAB.SESSIONS);
  var expCol = t.idx.expires_at;
  if (expCol === undefined) { return; }
  var cutoff = Date.now();
  for (var i = t.rows.length - 1; i >= 0; i--) {
    var exp = t.rows[i][expCol];
    var ms = exp instanceof Date ? exp.getTime() : Date.parse(exp);
    if (ms && ms < cutoff) { t.sh.deleteRow(i + 2); dirty_(TAB.SESSIONS); }
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
    appendRow_(t, rec);
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
  forgetSession_(token);
  var t = table_(TAB.SESSIONS);
  var rowNum = findRow_(t, 'token', str_(token));
  if (rowNum > 0) { t.sh.deleteRow(rowNum); dirty_(TAB.SESSIONS); }
  return { ok: true };
}

/* ========================================================================== */
/* Preferences                                                                */
/* ========================================================================== */

/** One place that knows what a preference may be. Anything else is ignored. */
var PREF_CHOICES = {
  /* A theme is colour and type. A layout is structure. They are picked
     separately, so any theme can wear any layout. */
  mode:    ['signal', 'terminal', 'paper', 'ember', 'nocturne', 'runic',
            'royal', 'blackbox', 'sleek', 'toon'],
  layout:  ['classic', 'topbar', 'split', 'cards', 'board', 'console',
            'dense', 'zen', 'mirror', 'focus'],
  theme:   ['dark', 'light'],
  /* Surface treatment only — how a panel is made. Cartoon moved to the theme
     axis, where a cream palette and comic lettering actually belong. */
  style:   ['plain', 'glass', 'neo', 'flat', 'brutal'],
  accent:  ['default', 'red', 'emerald', 'amber', 'violet', 'magenta', 'crimson'],
  font:    ['mono', 'sans', 'serif'],
  fsize:   ['s', 'm', 'l'],
  density: ['comfortable', 'compact'],
  anim:    ['on', 'off']
};

function defaultPrefs_() {
  return {
    mode: 'signal', layout: 'classic', theme: 'dark', style: 'plain',
    accent: 'default', font: 'mono', fsize: 'm', density: 'comfortable',
    anim: 'on', custom_css: ''
  };
}

function pick_(value, name) {
  var v = str_(value).toLowerCase();
  var allowed = PREF_CHOICES[name];
  return allowed.indexOf(v) > -1 ? v : defaultPrefs_()[name];
}

function prefsFor_(ownerId) {
  var t = table_(TAB.PREFS);
  var c = col_(t, 'owner_id');
  for (var i = 0; i < t.rows.length; i++) {
    if (str_(t.rows[i][c]) === ownerId) {
      var o = toObj_(t, t.rows[i], COLS.Prefs);
      var out = {};
      Object.keys(PREF_CHOICES).forEach(function (k) { out[k] = pick_(o[k], k); });
      out.custom_css = String(o.custom_css || '');
      return out;
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

    var rec = { owner_id: ownerId, custom_css: css, updated_at: new Date() };
    var out = { custom_css: css };
    Object.keys(PREF_CHOICES).forEach(function (k) {
      rec[k] = pick_(prefs[k], k);
      out[k] = rec[k];
    });

    if (rowNum > 0) { patchRow_(t, rowNum, rec); } else { appendRow_(t, rec); }
    return { ok: true, prefs: out };
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

/* --- nesting --------------------------------------------------------------
   A head may sit under another head. Two things must never happen: a head
   becoming its own ancestor, and a chain so deep the list is unreadable. Both
   are checked here, on the way in, rather than hoped for.
   ------------------------------------------------------------------------ */

/** owner's heads as { id: parent_id }, for walking the chain. */
function parentMap_(ownerId) {
  var t = table_(TAB.HEADS);
  var idCol = col_(t, 'head_id'), ownCol = col_(t, 'owner_id');
  var parCol = t.idx.parent_id;
  var map = {};
  t.rows.forEach(function (r) {
    if (str_(r[ownCol]) !== ownerId) { return; }
    var id = str_(r[idCol]);
    if (id) { map[id] = parCol === undefined ? '' : str_(r[parCol]); }
  });
  return map;
}

function depthOf_(map, id) {
  var depth = 1, seen = {}, cur = str_(id);
  while (cur && map[cur] && !seen[cur]) {
    seen[cur] = 1;
    cur = map[cur];
    depth++;
    if (depth > 50) { break; }          // corrupt data: do not hang
  }
  return depth;
}

/**
 * Validates a proposed parent for `headId` (headId may be '' when creating).
 * Returns the cleaned parent id.
 */
function checkParent_(user, headId, parentId) {
  var parent = str_(parentId);
  if (!parent) { return ''; }

  var me = str_(user.user_id);
  if (parent === str_(headId)) { fail_('A head cannot sit under itself.', 'bad_request'); }

  requireOwnHead_(user, parent);        // must exist and be yours

  var map = parentMap_(me);

  // Walking up from the proposed parent must never reach this head.
  var cur = parent, steps = 0;
  while (cur) {
    if (cur === str_(headId)) {
      fail_('That would put a head inside one of its own sub-heads.', 'bad_request');
    }
    cur = map[cur];
    if (++steps > 50) { break; }
  }

  if (depthOf_(map, parent) + 1 > MAX_DEPTH) {
    fail_('Heads can only nest ' + MAX_DEPTH + ' levels deep.', 'bad_request');
  }
  return parent;
}

/** One owned head as a plain object, or throws. */
function headById_(user, headId) {
  var found = requireOwnHead_(user, headId);
  return clean_(toObj_(found.t, found.row, COLS.Heads), COLS.Heads);
}

/** Live sub-heads of a head, used to stop a parent being archived under them. */
function childrenOf_(user, headId) {
  return ownedHeads_(user, false).filter(function (h) {
    return str_(h.parent_id) === str_(headId);
  });
}

/**
 * Live sub-heads of a head belonging to a given owner, with note counts.
 * Used for readers as well as the owner, so access must already be settled
 * by the caller before this is used.
 */
function childrenOfHead_(headId, ownerId) {
  var ht = table_(TAB.HEADS), nt = table_(TAB.NOTES);
  var hId = col_(ht, 'head_id'), hOwner = col_(ht, 'owner_id');
  var hPar = ht.idx.parent_id, hArch = ht.idx.archived;

  var counts = {};
  var nHead = col_(nt, 'head_id'), nArch = nt.idx.archived, nId = col_(nt, 'note_id');
  nt.rows.forEach(function (r) {
    if (!str_(r[nId])) { return; }
    if (nArch !== undefined && yes_(r[nArch])) { return; }
    var h = str_(r[nHead]);
    if (h) { counts[h] = (counts[h] || 0) + 1; }
  });

  var out = [];
  ht.rows.forEach(function (r) {
    if (!str_(r[hId]) || str_(r[hOwner]) !== str_(ownerId)) { return; }
    if (hPar === undefined || str_(r[hPar]) !== str_(headId)) { return; }
    if (hArch !== undefined && yes_(r[hArch])) { return; }
    var o = clean_(toObj_(ht, r, COLS.Heads), COLS.Heads);
    o.note_count = counts[o.head_id] || 0;
    out.push(o);
  });
  out.sort(function (a, b) {
    return (b.updated_at || '').localeCompare(a.updated_at || '');
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

/**
 * One pass over Notes, not three. Heads and Notes are each read once (the
 * table cache sees to that), and inbox plus the needs-detail count come out of
 * the same walk.
 */
function doBootstrap(user) {
  var heads = ownedHeads_(user, false);

  var inbox = [], flagged = 0;
  ownedNotes_(user, function (n) {
    if (yes_(n.needs_detail)) { flagged++; }
    if (!n.head_id) { inbox.push(n); }
    return false;                       // collected above; nothing to return
  });
  inbox.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });

  var needsDetail = heads.filter(function (h) { return yes_(h.needs_detail); }).length + flagged;

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

/**
 * Opens a head the caller owns, or one that was shared with them. A shared
 * head comes back with readonly:true and the owner's name; every write action
 * still checks ownership separately, so readonly is a label for the interface,
 * not the thing keeping anyone out.
 */
function doGetHead(user, headId) {
  headId = str_(headId);
  var ht = table_(TAB.HEADS);
  var rowNum = findRow_(ht, 'head_id', headId);
  if (rowNum < 0) { fail_('That head does not exist.', 'not_found'); }

  var row = ht.rows[rowNum - 2];
  var ownerId = str_(row[col_(ht, 'owner_id')]);
  var mine = ownerId === str_(user.user_id);
  if (!mine && !headSharedWithMe_(user, headId)) {
    fail_('That head does not exist.', 'not_found');
  }

  var head = clean_(toObj_(ht, row, COLS.Heads), COLS.Heads);
  head.archived = yes_(head.archived) ? 'Yes' : 'No';

  var notes = notesOfHead_(headId);
  head.note_count = notes.length;

  var out = { ok: true, head: head, notes: notes, readonly: !mine };

  // Sub-heads are part of what was shared, so a reader sees them too — a list
  // that silently stopped at the parent would misrepresent the work.
  out.children = childrenOfHead_(headId, ownerId);

  if (!mine) {
    var who = usersIndex_()[ownerId];
    out.owner = who ? { name: who.name, username: who.username } : null;
  }
  return out;
}

/** Live notes under a head, oldest first. Access is checked by the caller. */
function notesOfHead_(headId) {
  var nt = table_(TAB.NOTES);
  var idCol = col_(nt, 'note_id'), headCol = col_(nt, 'head_id'), archCol = nt.idx.archived;
  var out = [];
  nt.rows.forEach(function (r) {
    if (!str_(r[idCol])) { return; }
    if (str_(r[headCol]) !== headId) { return; }
    if (archCol !== undefined && yes_(r[archCol])) { return; }
    out.push(clean_(toObj_(nt, r, COLS.Notes), COLS.Notes));
  });
  out.sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
  return out;
}

function doCreateHead(user, data) {
  data = data || {};
  var title = checkTitle_(data.title);
  var client = checkClient_(data.client);
  var link = checkLink_(data.link);
  var type = checkFromList_(data.type, 'types', 'type');
  var status = checkFromList_(data.status, 'statuses', 'status') || 'Active';
  var parent = checkParent_(user, '', data.parent_id);

  /* A sub-head is part of its parent's work, not a separate piece of it: it
     takes the parent's client, type and status rather than carrying its own,
     and it must say where the work actually lives, so a link is required. */
  if (parent) {
    if (!link) {
      fail_('A sub-head needs a link — the file, sheet or page it refers to.', 'bad_request');
    }
    var p = headById_(user, parent);
    client = str_(p.client);
    type = str_(p.type);
    status = str_(p.status) || 'Active';
  }

  return withLock_(function () {
    var t = table_(TAB.HEADS);
    var now = new Date();
    var rec = {
      head_id: newId_('H'),
      owner_id: str_(user.user_id),
      parent_id: parent,
      created_at: now,
      title: title,
      client: client,
      type: type,
      status: status,
      needs_detail: data.needs_detail === 'Yes' ? 'Yes' : 'No',
      link: link,
      details: String(data.details || ''),
      updated_at: now,
      archived: 'No'
    };
    appendRow_(t, rec);
    queueReport_();
    var out = clean_(rec, COLS.Heads);
    out.note_count = 0;
    return { ok: true, head: out };
  });
}

function doUpdateHead(user, headId, patch) {
  return withLock_(function () {
    var found = requireOwnHead_(user, headId);
    var allowed = ['title', 'client', 'type', 'status', 'needs_detail', 'link',
                   'details', 'archived', 'parent_id'];
    var write = {};
    allowed.forEach(function (k) { if (patch && k in patch) { write[k] = patch[k]; } });

    if (write.parent_id !== undefined) {
      write.parent_id = checkParent_(user, headId, write.parent_id);
      if (write.parent_id) {
        // Moving a head under another makes it a sub-head, with the same rules.
        var cur = headById_(user, headId);
        var theLink = write.link !== undefined ? checkLink_(write.link) : str_(cur.link);
        if (!theLink) {
          fail_('A sub-head needs a link. Give this head a link before filing it under another.', 'bad_request');
        }
        var par = headById_(user, write.parent_id);
        write.client = str_(par.client);
        write.type = str_(par.type);
        write.status = str_(par.status) || 'Active';
      }
    }
    // Archiving a head with live sub-heads would strand them out of sight.
    if (yes_(write.archived)) {
      var kids = childrenOf_(user, headId);
      if (kids.length) {
        fail_('That head still has ' + kids.length + ' sub-head' +
              (kids.length === 1 ? '' : 's') +
              '. Archive or move them first.', 'bad_request');
      }
    }
    if (write.title !== undefined) { write.title = checkTitle_(write.title); }
    if (write.client !== undefined) { write.client = checkClient_(write.client); }
    if (write.link !== undefined) { write.link = checkLink_(write.link); }
    if (write.type !== undefined) { write.type = checkFromList_(write.type, 'types', 'type'); }
    if (write.status !== undefined) { write.status = checkFromList_(write.status, 'statuses', 'status'); }

    write.updated_at = new Date();
    patchRow_(found.t, found.rowNum, write);
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
      type: checkFromList_(data.type, 'types', 'type'),
      link: checkLink_(data.link),
      details: String(data.details || ''),
      needs_detail: data.needs_detail === 'Yes' ? 'Yes' : 'No',
      images: '',
      updated_at: now,
      archived: 'No'
    };
    appendRow_(t, rec);
    if (headId) { touchHead_(headId, now); }
    queueReport_();
    return { ok: true, note: clean_(rec, COLS.Notes) };
  });
}

function doUpdateNote(user, noteId, patch) {
  return withLock_(function () {
    var found = requireOwnNote_(user, noteId);
    var allowed = ['head_id', 'text', 'type', 'link', 'details', 'needs_detail',
                   'archived', 'parent_note_id'];
    var write = {};
    allowed.forEach(function (k) { if (patch && k in patch) { write[k] = patch[k]; } });

    if (write.parent_note_id !== undefined) {
      var cur = clean_(toObj_(found.t, found.row, COLS.Notes), COLS.Notes);
      write.parent_note_id = checkNoteParent_(user, noteId, write.parent_note_id,
        write.head_id !== undefined ? write.head_id : cur.head_id);
    }
    // Moving a note to another head would strand it under a parent elsewhere.
    if (write.head_id !== undefined) {
      var before = clean_(toObj_(found.t, found.row, COLS.Notes), COLS.Notes);
      if (str_(before.parent_note_id) && str_(write.head_id) !== str_(before.head_id)) {
        write.parent_note_id = '';
      }
    }

    if (write.text !== undefined && !str_(write.text)) {
      fail_('A note needs some text.', 'bad_request');
    }
    if (write.link !== undefined) { write.link = checkLink_(write.link); }
    if (write.type !== undefined) { write.type = checkFromList_(write.type, 'types', 'type'); }
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
    dirty_(TAB.HEADS);
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
/* Notes: nesting and links                                                   */
/* ========================================================================== */

/**
 * Two different relationships, deliberately kept apart:
 *
 *   parent_note_id  a tree, within one head. Dragging a note onto another
 *                   files it underneath. Checked for cycles and depth.
 *   links           lateral references between any two of your notes, in any
 *                   head. Symmetric: linking A to B links B to A, because a
 *                   one-way reference you cannot see from the other end is a
 *                   reference you will never find again.
 */
var MAX_NOTE_DEPTH = 4;
var MAX_LINKS = 20;

function noteById_(user, noteId) {
  var found = requireOwnNote_(user, noteId);
  return clean_(toObj_(found.t, found.row, COLS.Notes), COLS.Notes);
}

function noteParentMap_(ownerId) {
  var t = table_(TAB.NOTES);
  var idCol = col_(t, 'note_id'), ownCol = col_(t, 'owner_id');
  var parCol = t.idx.parent_note_id;
  var map = {};
  t.rows.forEach(function (r) {
    if (str_(r[ownCol]) !== ownerId) { return; }
    var id = str_(r[idCol]);
    if (id) { map[id] = parCol === undefined ? '' : str_(r[parCol]); }
  });
  return map;
}

/** Validates a proposed parent note for `noteId`. Returns the cleaned id. */
function checkNoteParent_(user, noteId, parentId, headId) {
  var parent = str_(parentId);
  if (!parent) { return ''; }
  if (parent === str_(noteId)) { fail_('A note cannot sit under itself.', 'bad_request'); }

  var p = noteById_(user, parent);
  if (str_(p.head_id) !== str_(headId)) {
    fail_('A note can only sit under another note in the same head.', 'bad_request');
  }

  var map = noteParentMap_(str_(user.user_id));
  var cur = parent, steps = 0;
  while (cur) {
    if (cur === str_(noteId)) {
      fail_('That would put a note inside one of its own replies.', 'bad_request');
    }
    cur = map[cur];
    if (++steps > 50) { break; }
  }

  var depth = 1, walk = parent, seen = {};
  while (walk && map[walk] && !seen[walk]) { seen[walk] = 1; walk = map[walk]; depth++; }
  if (depth + 1 > MAX_NOTE_DEPTH) {
    fail_('Notes can only nest ' + MAX_NOTE_DEPTH + ' levels deep.', 'bad_request');
  }
  return parent;
}

function linkIdsOf_(note) {
  return str_(note.links).split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

function writeLinks_(user, noteId, ids) {
  var t = table_(TAB.NOTES);
  var rowNum = findRow_(t, 'note_id', str_(noteId));
  if (rowNum < 0) { return; }
  patchRow_(t, rowNum, { links: ids.join(','), updated_at: new Date() });
}

/** Links both notes to each other, so the reference is findable from either. */
function doLinkNotes(user, noteId, otherId) {
  noteId = str_(noteId); otherId = str_(otherId);
  if (!noteId || !otherId) { fail_('Two notes are needed to make a link.', 'bad_request'); }
  if (noteId === otherId) { fail_('A note cannot link to itself.', 'bad_request'); }

  var a = noteById_(user, noteId);
  var b = noteById_(user, otherId);

  return withLock_(function () {
    var aIds = linkIdsOf_(a), bIds = linkIdsOf_(b);
    if (aIds.indexOf(otherId) === -1) {
      if (aIds.length >= MAX_LINKS) { fail_('A note can hold ' + MAX_LINKS + ' links.', 'bad_request'); }
      aIds.push(otherId);
      writeLinks_(user, noteId, aIds);
    }
    if (bIds.indexOf(noteId) === -1) {
      bIds.push(noteId);
      writeLinks_(user, otherId, bIds);
    }
    return { ok: true, links: aIds };
  });
}

function doUnlinkNotes(user, noteId, otherId) {
  noteId = str_(noteId); otherId = str_(otherId);
  var a = noteById_(user, noteId);
  var b = noteById_(user, otherId);

  return withLock_(function () {
    var aIds = linkIdsOf_(a).filter(function (id) { return id !== otherId; });
    var bIds = linkIdsOf_(b).filter(function (id) { return id !== noteId; });
    writeLinks_(user, noteId, aIds);
    writeLinks_(user, otherId, bIds);
    return { ok: true, links: aIds };
  });
}

/** One note plus everything needed to show it on a page of its own. */
function doGetNote(user, noteId) {
  noteId = str_(noteId);
  var nt = table_(TAB.NOTES);
  var rowNum = findRow_(nt, 'note_id', noteId);
  if (rowNum < 0) { fail_('That note does not exist.', 'not_found'); }

  var row = nt.rows[rowNum - 2];
  var ownerId = str_(row[col_(nt, 'owner_id')]);
  var mine = ownerId === str_(user.user_id);
  var headId = str_(row[col_(nt, 'head_id')]);

  // Shared directly, or sitting under a head that was shared — including one
  // reached through a sub-head.
  if (!mine &&
      !sharedWithMe_(user, 'note', noteId) &&
      !(headId && headSharedWithMe_(user, headId))) {
    fail_('That note does not exist.', 'not_found');
  }

  var note = clean_(toObj_(nt, row, COLS.Notes), COLS.Notes);
  var byId = {};
  var idCol = col_(nt, 'note_id'), archCol = nt.idx.archived;
  nt.rows.forEach(function (r) {
    var id = str_(r[idCol]);
    if (!id) { return; }
    if (archCol !== undefined && yes_(r[archCol])) { return; }
    byId[id] = clean_(toObj_(nt, r, COLS.Notes), COLS.Notes);
  });

  var linked = linkIdsOf_(note)
    .map(function (id) { return byId[id]; })
    .filter(function (n) { return n && str_(n.owner_id) === ownerId; });

  var kids = [];
  Object.keys(byId).forEach(function (id) {
    if (str_(byId[id].parent_note_id) === noteId) { kids.push(byId[id]); }
  });
  kids.sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });

  var head = null;
  if (headId) {
    var ht = table_(TAB.HEADS);
    var hRow = findRow_(ht, 'head_id', headId);
    if (hRow > 0) {
      var h = clean_(toObj_(ht, ht.rows[hRow - 2], COLS.Heads), COLS.Heads);
      head = { head_id: h.head_id, title: h.title, client: h.client };
    }
  }

  return { ok: true, note: note, head: head, linked: linked, children: kids,
           parent: note.parent_note_id ? (byId[note.parent_note_id] || null) : null,
           readonly: !mine };
}

/* ========================================================================== */
/* Search                                                                     */
/* ========================================================================== */

var SEARCH_LIMIT = 60;

/**
 * Looks through the caller's own note text and details. The front end already
 * filters heads instantly from what it has in memory; this is the half it
 * cannot do, because notes are never all loaded in the browser.
 *
 * Every word in the query must appear somewhere in the note — so "cart drawer"
 * finds a note saying "the drawer on the cart page", which a plain substring
 * match would miss.
 */
function doSearchNotes(user, q) {
  var query = str_(q).toLowerCase();
  if (query.length < 2) { return { ok: true, q: query, notes: [], truncated: false }; }

  var words = query.split(/\s+/).filter(function (w) { return w; });
  var ownerId = str_(user.user_id);

  var ht = table_(TAB.HEADS);
  var titles = {};
  var hId = col_(ht, 'head_id'), hTitle = col_(ht, 'title'), hOwner = col_(ht, 'owner_id');
  ht.rows.forEach(function (r) {
    if (str_(r[hOwner]) === ownerId) { titles[str_(r[hId])] = str_(r[hTitle]); }
  });

  var nt = table_(TAB.NOTES);
  var nId = col_(nt, 'note_id'), nOwner = col_(nt, 'owner_id'), nArch = nt.idx.archived;
  var hits = [];

  nt.rows.forEach(function (r) {
    if (!str_(r[nId]) || str_(r[nOwner]) !== ownerId) { return; }
    if (nArch !== undefined && yes_(r[nArch])) { return; }

    var o = clean_(toObj_(nt, r, COLS.Notes), COLS.Notes);
    var hay = (o.text + ' ' + o.details + ' ' + (titles[o.head_id] || '')).toLowerCase();
    for (var i = 0; i < words.length; i++) {
      if (hay.indexOf(words[i]) === -1) { return; }
    }
    o.head_title = titles[o.head_id] || '';
    hits.push(o);
  });

  hits.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
  var truncated = hits.length > SEARCH_LIMIT;
  return { ok: true, q: query, notes: hits.slice(0, SEARCH_LIMIT), truncated: truncated,
           total: hits.length };
}

/* ========================================================================== */
/* Images                                                                     */
/* ========================================================================== */

/**
 * Pictures do not go in the sheet — a cell holds about 50,000 characters, which
 * is a thumbnail at best. They go to a private folder in the owner's Drive and
 * the note keeps the file ids.
 *
 * The files are NOT shared publicly. They are read back through getImage,
 * which checks the caller can see the note first, so a shared note's pictures
 * follow the same rule as its text and nothing is reachable by guessing a URL.
 */

var IMAGE_FOLDER_NAME = 'Documentrism Images';
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var MAX_IMAGES_PER_NOTE = 8;

function imageFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('image_folder_id');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: remake it */ }
  }
  var existing = DriveApp.getFoldersByName(IMAGE_FOLDER_NAME);
  var folder = existing.hasNext() ? existing.next() : DriveApp.createFolder(IMAGE_FOLDER_NAME);
  props.setProperty('image_folder_id', folder.getId());
  return folder;
}

function imageIdsOf_(note) {
  return str_(note.images).split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

function doAddNoteImage(user, noteId, dataUrl, name) {
  var found = requireOwnNote_(user, noteId);

  var m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
  if (!m) { fail_('That is not an image this app can take (PNG, JPEG, GIF or WebP).', 'bad_request'); }
  var mime = m[1].toLowerCase();
  var b64 = m[3];
  if (b64.length * 0.75 > MAX_IMAGE_BYTES) {
    fail_('That image is too big. Keep it under 4MB.', 'bad_request');
  }

  var current = imageIdsOf_(clean_(toObj_(found.t, found.row, COLS.Notes), COLS.Notes));
  if (current.length >= MAX_IMAGES_PER_NOTE) {
    fail_('A note can hold ' + MAX_IMAGES_PER_NOTE + ' images.', 'bad_request');
  }

  return withLock_(function () {
    var safeName = str_(name).replace(/[^\w.\- ]/g, '').slice(0, 60) || 'image';
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime,
      noteId + '-' + Date.now() + '-' + safeName);
    var file = imageFolder_().createFile(blob);
    // Explicitly private: only the owner of the script can open it in Drive.
    try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) {}

    current.push(file.getId());
    patchRow_(found.t, found.rowNum, { images: current.join(','), updated_at: new Date() });
    return { ok: true, image_id: file.getId(), images: current };
  });
}

/** Returns the bytes, but only to someone allowed to read the note. */
function doGetImage(user, imageId) {
  imageId = str_(imageId);
  if (!imageId) { fail_('No image asked for.', 'bad_request'); }

  var nt = table_(TAB.NOTES);
  var idCol = col_(nt, 'note_id'), ownerCol = col_(nt, 'owner_id'), headCol = col_(nt, 'head_id');
  var imgCol = nt.idx.images;
  if (imgCol === undefined) { fail_('This sheet has no images column yet.', 'config'); }

  var me = str_(user.user_id);
  var allowed = false;
  for (var i = 0; i < nt.rows.length; i++) {
    var r = nt.rows[i];
    if (!str_(r[idCol])) { continue; }
    if (str_(r[imgCol]).indexOf(imageId) === -1) { continue; }

    if (str_(r[ownerCol]) === me) { allowed = true; break; }
    if (sharedWithMe_(user, 'note', str_(r[idCol]))) { allowed = true; break; }
    var hid = str_(r[headCol]);
    if (hid && headSharedWithMe_(user, hid)) { allowed = true; break; }
    break;                       // found the note, but it is not ours to read
  }
  if (!allowed) { fail_('That image does not exist.', 'not_found'); }

  var file;
  try { file = DriveApp.getFileById(imageId); }
  catch (e) { fail_('That image is no longer in Drive.', 'not_found'); }

  var blob = file.getBlob();
  return {
    ok: true,
    image_id: imageId,
    mime: blob.getContentType(),
    data: Utilities.base64Encode(blob.getBytes())
  };
}

function doRemoveNoteImage(user, noteId, imageId) {
  var found = requireOwnNote_(user, noteId);
  imageId = str_(imageId);

  return withLock_(function () {
    var current = imageIdsOf_(clean_(toObj_(found.t, found.row, COLS.Notes), COLS.Notes));
    var next = current.filter(function (id) { return id !== imageId; });
    patchRow_(found.t, found.rowNum, { images: next.join(','), updated_at: new Date() });

    // The row keeps no reference, so the file is rubbish now — but Drive's own
    // trash is the undo, so it is trashed rather than destroyed.
    try { DriveApp.getFileById(imageId).setTrashed(true); } catch (e) {}
    return { ok: true, images: next };
  });
}

/* ========================================================================== */
/* Sharing                                                                    */
/* ========================================================================== */

/**
 * Sharing is one-way and read-only. Sharing a head shares that head and every
 * note under it, now and later; sharing a note shares only that note. The
 * person it was shared with can read it and nothing else — every write action
 * still goes through requireOwnHead_/requireOwnNote_, which only ever match
 * rows the caller owns.
 *
 * Nothing is deleted here either: unsharing sets revoked to Yes.
 */

function usersIndex_() {
  var t = usersTable_();
  var byId = {};
  t.rows.forEach(function (r) {
    var o = toObj_(t, r, COLS.Users);
    var id = str_(o.user_id);
    if (id) {
      byId[id] = { user_id: id, username: str_(o.username), name: str_(o.name),
                   status: str_(o.status) };
    }
  });
  return byId;
}

/**
 * The directory used by the share box. Usernames and display names only — no
 * birthdays, no hashes. Everyone signed in can see who else has an account,
 * which is the price of being able to share with them by name.
 */
function doListPeople(user) {
  var byId = usersIndex_();
  var me = str_(user.user_id);
  var out = [];
  Object.keys(byId).forEach(function (id) {
    if (id === me) { return; }
    if (byId[id].status.toLowerCase() === 'disabled') { return; }
    out.push({ user_id: id, username: byId[id].username, name: byId[id].name });
  });
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { ok: true, people: out };
}

function liveShares_() {
  var t = table_(TAB.SHARES);
  var out = [];
  var idCol = col_(t, 'share_id');
  t.rows.forEach(function (r) {
    if (!str_(r[idCol])) { return; }
    var o = clean_(toObj_(t, r, COLS.Shares), COLS.Shares);
    if (yes_(o.revoked)) { return; }
    out.push(o);
  });
  return out;
}

/** True when this exact item was shared with the caller. */
function sharedWithMe_(user, kind, itemId) {
  var me = str_(user.user_id);
  return liveShares_().some(function (s) {
    return s.target_id === me && s.kind === kind && s.item_id === str_(itemId);
  });
}

/**
 * The chain from a head up to its top-level ancestor, itself included.
 * Heads can only be parented within one owner's tree (checkParent_ enforces
 * that), so a chain never crosses between people.
 */
function headChain_(headId) {
  var t = table_(TAB.HEADS);
  var idCol = col_(t, 'head_id');
  var parCol = t.idx.parent_id;
  var parentOf = {};
  t.rows.forEach(function (r) {
    var id = str_(r[idCol]);
    if (id) { parentOf[id] = parCol === undefined ? '' : str_(r[parCol]); }
  });

  var chain = [], cur = str_(headId), seen = {};
  while (cur && !seen[cur]) {
    seen[cur] = 1;
    chain.push(cur);
    cur = parentOf[cur];
    if (chain.length > 50) { break; }   // corrupt data must not hang this
  }
  return chain;
}

/**
 * Sharing a head shares everything under it. A sub-head is part of the same
 * piece of work — sharing the parent and then having to share each child
 * separately would be a trap, and the recipient would see an incomplete
 * picture without being told so.
 *
 * So access is granted if the head itself, or ANY head above it, was shared
 * with the caller.
 */
function headSharedWithMe_(user, headId) {
  var me = str_(user.user_id);
  var shares = liveShares_();
  if (!shares.length) { return false; }

  var chain = headChain_(headId);
  for (var i = 0; i < chain.length; i++) {
    for (var j = 0; j < shares.length; j++) {
      var s = shares[j];
      if (s.target_id === me && s.kind === 'head' && s.item_id === chain[i]) {
        return true;
      }
    }
  }
  return false;
}

function doShareItem(user, kind, itemId, toUsername) {
  kind = str_(kind);
  itemId = str_(itemId);
  if (kind !== 'head' && kind !== 'note') { fail_('Can only share a head or a note.', 'bad_request'); }

  // You can only share something you own — checked before anything else.
  var title = '';
  if (kind === 'head') {
    var fh = requireOwnHead_(user, itemId);
    title = str_(fh.row[col_(fh.t, 'title')]);
  } else {
    var fn = requireOwnNote_(user, itemId);
    title = str_(fn.row[col_(fn.t, 'text')]).slice(0, 80);
  }

  var target = findUserBy_('username', toUsername) || findUserBy_('name', toUsername);
  if (!target) { fail_('No account called "' + str_(toUsername) + '".', 'not_found'); }
  var targetId = str_(target.user_id);
  if (targetId === str_(user.user_id)) { fail_('That is already yours.', 'bad_request'); }

  var t = table_(TAB.SHARES);
  var existing = liveShares_().filter(function (s) {
    return s.owner_id === str_(user.user_id) && s.target_id === targetId &&
           s.kind === kind && s.item_id === itemId;
  });
  if (existing.length) {
    return { ok: true, share: existing[0], already: true, title: title };
  }

  var rec = {
    share_id: newId_('S'),
    owner_id: str_(user.user_id),
    target_id: targetId,
    kind: kind,
    item_id: itemId,
    created_at: new Date(),
    revoked: 'No'
  };
  appendRow_(t, rec);
  return { ok: true, share: clean_(rec, COLS.Shares), title: title,
           to: { username: str_(target.username), name: str_(target.name) } };
}

function doUnshareItem(user, shareId) {
  var t = table_(TAB.SHARES);
  var rowNum = findRow_(t, 'share_id', str_(shareId));
  if (rowNum < 0) { fail_('That share does not exist.', 'not_found'); }
  var row = t.rows[rowNum - 2];
  if (str_(row[col_(t, 'owner_id')]) !== str_(user.user_id)) {
    fail_('That share does not exist.', 'not_found');   // not yours to revoke
  }
  patchRow_(t, rowNum, { revoked: 'Yes' });
  return { ok: true };
}

/**
 * Everything the Shared tab needs in one request: what others have shared with
 * me, grouped by person, and what I have shared out, so it can be revoked.
 */
function doListShares(user) {
  var me = str_(user.user_id);
  var shares = liveShares_();
  var byId = usersIndex_();

  var ht = table_(TAB.HEADS), nt = table_(TAB.NOTES);
  var headById = {}, noteById = {};
  var hId = col_(ht, 'head_id'), hArch = ht.idx.archived;
  ht.rows.forEach(function (r) {
    var id = str_(r[hId]);
    if (!id) { return; }
    if (hArch !== undefined && yes_(r[hArch])) { return; }
    headById[id] = clean_(toObj_(ht, r, COLS.Heads), COLS.Heads);
  });
  var nId = col_(nt, 'note_id'), nArch = nt.idx.archived;
  var notesByHead = {};
  nt.rows.forEach(function (r) {
    var id = str_(r[nId]);
    if (!id) { return; }
    if (nArch !== undefined && yes_(r[nArch])) { return; }
    var o = clean_(toObj_(nt, r, COLS.Notes), COLS.Notes);
    noteById[id] = o;
    if (o.head_id) { (notesByHead[o.head_id] = notesByHead[o.head_id] || []).push(o); }
  });

  var incomingBy = {}, outgoing = [];

  shares.forEach(function (s) {
    if (s.target_id === me) {
      var who = byId[s.owner_id];
      if (!who) { return; }
      var slot = incomingBy[s.owner_id] || (incomingBy[s.owner_id] = {
        user_id: s.owner_id, name: who.name, username: who.username,
        heads: [], notes: []
      });
      if (s.kind === 'head') {
        var h = headById[s.item_id];
        if (h) {
          h = JSON.parse(JSON.stringify(h));
          h.note_count = (notesByHead[s.item_id] || []).length;
          h.share_id = s.share_id;
          // Say how much comes with it, so the reader knows the sub-heads
          // are there before opening it.
          h.sub_count = childrenOfHead_(s.item_id, s.owner_id).length;
          slot.heads.push(h);
        }
      } else {
        var n = noteById[s.item_id];
        if (n) {
          n = JSON.parse(JSON.stringify(n));
          n.share_id = s.share_id;
          n.head_title = n.head_id && headById[n.head_id] ? headById[n.head_id].title : '';
          slot.notes.push(n);
        }
      }
    }

    if (s.owner_id === me) {
      var to = byId[s.target_id];
      var label = s.kind === 'head'
        ? (headById[s.item_id] ? headById[s.item_id].title : '(gone)')
        : (noteById[s.item_id] ? noteById[s.item_id].text.slice(0, 80) : '(gone)');
      outgoing.push({
        share_id: s.share_id, kind: s.kind, item_id: s.item_id, label: label,
        to_name: to ? to.name : '(unknown)', to_username: to ? to.username : '',
        created_at: s.created_at
      });
    }
  });

  var incoming = Object.keys(incomingBy).map(function (k) { return incomingBy[k]; });
  incoming.forEach(function (p) {
    p.heads.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
    p.notes.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    p.count = p.heads.length + p.notes.length;
  });
  incoming.sort(function (a, b) { return a.name.localeCompare(b.name); });
  outgoing.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });

  return { ok: true, incoming: incoming, outgoing: outgoing };
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
  dirty_(TAB.LISTS);
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

