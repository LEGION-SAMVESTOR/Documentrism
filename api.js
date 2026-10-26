"use strict";
/* ============================================================================
   API — the one layer that talks to the Apps Script backend.

   The backend URL is not baked in. Each person pastes their deployment URL
   once on the setup screen and it lives in that device's localStorage, so this
   front end can be public on Vercel without carrying anyone's address in it.

   Writes go through a serial queue. A note is drawn on screen immediately and
   sent afterwards, because a sheet write takes a second or two and that is too
   long to block typing. A failure stops the queue and keeps every job in it —
   nothing is ever dropped silently.
   ========================================================================== */
const API = (function () {
  const K_TOKEN = "documentrism.api.token";
  const K_USER  = "documentrism.api.user";

  const listeners = [];
  const state = { status: "idle", detail: "", queued: 0, stuck: false };

  /* ---------- storage, defensively ---------- */
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try {
      if (val === null || val === undefined) { localStorage.removeItem(key); }
      else { localStorage.setItem(key, JSON.stringify(val)); }
    } catch (e) { /* private window or blocked storage */ }
  }

  // The backend address comes from config.js and nowhere else. There is no way
  // to point this site at a different backend from inside the app.
  const CONFIG = (typeof window !== "undefined" && window.DOCUMENTRISM_CONFIG) || {};
  const url = () => String(CONFIG.backendUrl || "").trim();
  const token   = () => read(K_TOKEN, "") || "";
  const setToken= t => write(K_TOKEN, t || null);
  const user    = () => read(K_USER, null);
  const setUser = u => write(K_USER, u || null);

  /* ---------- write identity ----------
     A POST to Apps Script is answered with a redirect, and following it can
     replay the POST — which wrote every note twice. A retry after a timeout
     can do the same, because a request that timed out may still have landed.
     So each write carries an op_id the server uses to run it exactly once.

     The id is stamped onto the payload ONCE and reused on every retry of that
     same job. Generating a fresh one per attempt would defeat the whole thing. */
  const WRITE_ACTIONS = {
    createHead: 1, createNote: 1, updateHead: 1, updateNote: 1, moveNote: 1,
    archiveHead: 1, archiveNote: 1, addClient: 1, savePrefs: 1
  };

  function opId() {
    try { return crypto.randomUUID(); }
    catch (e) { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  }

  function stampWrite(action, payload) {
    if (!WRITE_ACTIONS[action]) { return payload; }
    const p = payload || {};
    if (!p.op_id) { p.op_id = opId(); }
    return p;
  }

  function tagged(message, code) {
    const e = new Error(message);
    e.code = code || "server";
    return e;
  }

  /* ---------- the one network primitive ----------
     No custom headers. That keeps it a "simple" request, so the browser never
     sends a preflight OPTIONS — which Apps Script cannot answer. */
  async function call(action, payload) {
    const endpoint = url();
    if (!endpoint) {
      throw tagged("This site has no backend address in config.js.", "config");
    }

    const body = Object.assign({ action }, stampWrite(action, payload) || {});
    if (body.token === undefined && token()) { body.token = token(); }
    if (!body.agent) { body.agent = navigator.userAgent.slice(0, 120); }

    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        redirect: "follow",
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw tagged("Cannot reach the backend. Check your connection and the URL.", "network");
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // HTML back from Google nearly always means the deployment is private,
      // or the URL is the /dev one instead of /exec.
      throw tagged(
        'That URL did not return data. Check the deployment is a Web app with ' +
        'access set to "Anyone", and that you copied the /exec URL.',
        "config"
      );
    }

    if (!data.ok) {
      const err = tagged(data.error || "The backend refused that.", data.code || "server");
      if (err.code === "auth") { signOut(true); }
      throw err;
    }
    return data;
  }

  /* ---------- session ---------- */
  async function signup(fields) {
    const res = await call("signup", fields);
    setToken(res.token); setUser(res.user);
    return res;
  }
  async function login(id, password) {
    const res = await call("login", { id, password });
    setToken(res.token); setUser(res.user);
    return res;
  }
  async function resetPassword(fields) {
    return call("resetPassword", fields);
  }
  function signOut(silent) {
    const had = !!token();
    clearOutbox();
    queue.length = 0;
    state.queued = 0; state.stuck = false;
    setToken(null); setUser(null);
    if (had && !silent) { emit("idle", "Signed out"); }
    listeners.forEach(fn => { try { fn(state, "signout"); } catch (e) {} });
  }

  /* ---------- write queue ----------
     The queue is kept on the device as well as in memory, so closing the tab
     or reloading mid-save does not lose the work. Each entry already carries
     an op_id, which is what makes replaying it safe: the server runs a given
     op_id once and returns the stored result for any repeat.

     localStorage rather than cookies: a cookie is capped near 4KB and is sent
     to Vercel on every request, which has no idea what a note is. */
  const K_OUT = "documentrism.outbox";
  const queue = [];
  let busy = false;

  function outboxKey() {
    const u = user();
    return u && u.user_id ? `${K_OUT}.${u.user_id}` : null;
  }

  function saveOutbox() {
    const key = outboxKey();
    if (!key) return;
    try {
      // Only what can be replayed: callbacks belong to a page that is gone.
      write(key, queue.map(j => ({ action: j.action, payload: j.payload })));
    } catch (e) {}
  }

  /** Puts anything left from last time back in the queue, oldest first. */
  function restoreOutbox() {
    const key = outboxKey();
    if (!key) return 0;
    const saved = read(key, []);
    if (!Array.isArray(saved) || !saved.length) return 0;
    saved.forEach(j => {
      if (j && j.action) queue.push({ action: j.action, payload: j.payload, restored: true });
    });
    state.queued = queue.length;
    pump();
    return saved.length;
  }

  function clearOutbox() {
    const key = outboxKey();
    if (key) write(key, null);
  }

  function enqueue(job) {           // { action, payload, done, fail, revive }
    // Stamped here, before the first attempt, so every retry of this job
    // carries the same id and the server treats them as one write.
    job.payload = stampWrite(job.action, job.payload);
    queue.push(job);
    state.queued = queue.length;
    saveOutbox();
    pump();
  }

  async function pump() {
    if (busy || state.stuck || !queue.length) { return; }
    busy = true;
    emit("saving", queue.length > 1 ? `Saving ${queue.length} changes` : "Saving");

    const job = queue[0];
    let res;
    try {
      res = await call(job.action, job.payload);
    } catch (err) {
      busy = false;
      state.stuck = true;
      runCallback(job.fail, err);
      emit("failed", err.message);
      return;
    }

    // The write landed. From here on nothing may mark the queue stuck: a
    // callback that throws is a rendering bug, and treating it as a failed
    // save would wedge every later write behind a Retry that cannot help.
    queue.shift();
    state.queued = queue.length;
    saveOutbox();                 // it is on the server now; stop holding it
    busy = false;
    runCallback(job.done, res);
    if (queue.length) { pump(); } else { emit("saved", "Saved"); }
  }

  function runCallback(fn, arg) {
    if (!fn) return;
    try { fn(arg); }
    catch (e) { console.error("documentrism: callback after a completed job threw", e); }
  }

  function retry() {
    if (!queue.length) { state.stuck = false; emit("saved", "Saved"); return; }
    state.stuck = false;
    queue.forEach(j => { if (j.revive) { j.revive(); } });
    pump();
  }

  /* ---------- status ---------- */
  function emit(status, detail) {
    state.status = status;
    state.detail = detail || "";
    listeners.forEach(fn => { try { fn(state); } catch (e) {} });
  }
  function onChange(fn) { listeners.push(fn); fn(state); }

  // Nothing to warn about any more: whatever is still queued is on the device
  // and goes out the next time this account is opened here.

  return {
    call, enqueue, retry, onChange, state, restoreOutbox,
    url,
    token, user, signup, login, resetPassword, signOut,
    pending: () => queue.length,
    configured: () => !!url(),
    signedIn: () => !!token()
  };
})();
