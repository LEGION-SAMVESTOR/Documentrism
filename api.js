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
  const K_URL   = "documentrism.api.url";
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

  // config.js may carry a default backend URL so nobody has to paste one. A
  // URL this person pasted themselves always wins over the shipped default.
  const CONFIG = (typeof window !== "undefined" && window.DOCUMENTRISM_CONFIG) || {};
  const shippedUrl = () => String(CONFIG.backendUrl || "").trim();
  const urlIsLocked = () => !!CONFIG.lockBackendUrl && !!shippedUrl();

  const url     = () => (urlIsLocked() ? shippedUrl() : (read(K_URL, "") || shippedUrl()));
  const setUrl  = u => write(K_URL, String(u || "").trim());
  const clearUrl = () => write(K_URL, null);
  const token   = () => read(K_TOKEN, "") || "";
  const setToken= t => write(K_TOKEN, t || null);
  const user    = () => read(K_USER, null);
  const setUser = u => write(K_USER, u || null);

  function tagged(message, code) {
    const e = new Error(message);
    e.code = code || "server";
    return e;
  }

  /* ---------- the one network primitive ----------
     No custom headers. That keeps it a "simple" request, so the browser never
     sends a preflight OPTIONS — which Apps Script cannot answer. */
  async function call(action, payload, opts) {
    const endpoint = (opts && opts.url) || url();
    if (!endpoint) { throw tagged("No backend URL set yet.", "config"); }

    const body = Object.assign({ action }, payload || {});
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

  /** Checks a pasted URL really is a Documentrism backend before saving it. */
  async function verifyUrl(candidate) {
    const clean = String(candidate || "").trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(clean)) {
      throw tagged(
        "That does not look like a deployment URL. It should start with " +
        "https://script.google.com/macros/s/ and end with /exec",
        "config"
      );
    }
    const res = await call("ping", {}, { url: clean });
    if (res.app !== "documentrism") {
      throw tagged("That URL answered, but it is not a Documentrism backend.", "config");
    }
    setUrl(clean);
    return res;
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
    queue.length = 0;
    state.queued = 0; state.stuck = false;
    setToken(null); setUser(null);
    if (had && !silent) { emit("idle", "Signed out"); }
    listeners.forEach(fn => { try { fn(state, "signout"); } catch (e) {} });
  }

  /* ---------- write queue ---------- */
  const queue = [];
  let busy = false;

  function enqueue(job) {           // { action, payload, done, fail, revive }
    queue.push(job);
    state.queued = queue.length;
    pump();
  }

  async function pump() {
    if (busy || state.stuck || !queue.length) { return; }
    busy = true;
    emit("saving", queue.length > 1 ? `Saving ${queue.length} changes` : "Saving");

    const job = queue[0];
    try {
      const res = await call(job.action, job.payload);
      queue.shift();
      state.queued = queue.length;
      busy = false;
      if (job.done) { job.done(res); }
      if (queue.length) { pump(); } else { emit("saved", "Saved"); }
    } catch (err) {
      busy = false;
      state.stuck = true;
      if (job.fail) { job.fail(err); }
      emit("failed", err.message);
    }
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

  // A queued write must not vanish with the tab without a word.
  window.addEventListener("beforeunload", e => {
    if (queue.length) { e.preventDefault(); e.returnValue = ""; }
  });

  return {
    call, enqueue, retry, onChange, state,
    url, setUrl, clearUrl, verifyUrl, urlIsLocked,
    token, user, signup, login, resetPassword, signOut,
    pending: () => queue.length,
    configured: () => !!url(),
    signedIn: () => !!token()
  };
})();
