"use strict";
/* ============================================================================
   DOCUMENTRISM — app

   Three layers, in order:
     gate    pick a backend, then sign up or sign in
     shell   heads, head page, inbox, quick add
     skin    design mode, light/dark, and the user's own CSS

   Everything the screen shows belongs to the signed-in account. The server
   enforces that; this file never asks for anyone else's rows.
   ========================================================================== */
(function () {

/* --- state ---------------------------------------------------------------- */
const S = {
  user: null,
  prefs: {
    mode: "signal", layout: "classic", theme: "dark", style: "plain",
    accent: "default", font: "mono", fsize: "m", density: "comfortable",
    anim: "on", custom_css: ""
  },
  // Appearance is the one thing the user changes faster than the server can be
  // told. While a change is unsaved or in flight, a refresh must leave it alone
  // — otherwise the background catch-up puts the old look back and it reads as
  // "the theme keeps changing by itself".
  prefsDirty: false,
  prefsSaving: 0,
  // Anything the user has started typing and not yet saved. A background
  // catch-up must never run while this has something in it — re-rendering
  // throws away whatever is half-written.
  editing: new Set(),
  shares: { incoming: [], outgoing: [] },
  sharedPerson: null,      // whose shared items are open, if any
  note: null,              // the note open on its own page, if any
  lastLayout: undefined,   // so a layout change can redraw what it must
  readonly: false,         // the head or note on screen belongs to someone else
  lists: { clients: [], types: [], statuses: [] },
  heads: [],
  inbox: [],
  current: null,
  view: "heads",
  // needs_detail spans heads AND every note, including ones not loaded here,
  // so the count comes from the server and is nudged as things change.
  needsDetail: 0,
  lastSync: 0,
  filters: { q: "", client: "", type: "", status: "", flag: false, archived: false },
  mru: [],
  lastList: []            // what the console last printed, so `open 2` works
};

const HEADINGS = {
  Section:  ["Files used", "Settings", "Known issues"],
  Template: ["When to use", "How to use", "Owner"],
  Update:   ["Before → After", "Why", "How to undo"],
  Research: ["Question", "Answer in 3 bullets", "Sources", "Decision"],
  Bug:      ["Problem", "Cause", "Fix"],
  Other:    []
};

/* --- dom helpers ---------------------------------------------------------- */
const $  = (sel, scope) => (scope || document).querySelector(sel);
const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));
const on = (el, ev, fn) => { if (el) el.addEventListener(ev, fn); };
const esc = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ==========================================================================
   Local cache

   An Apps Script round trip costs about a second before it even opens the
   sheet, so waiting for one to draw the first screen is a second of nothing.
   The last known heads, inbox and lists are kept per account and painted
   immediately; the real data lands a moment later and redraws only if it
   differs.

   localStorage, not cookies: cookies are capped near 4KB and are sent with
   every request to Vercel, which has no idea what a head is. This never leaves
   the device.
   ========================================================================== */
const CACHE_VERSION = 1;

function cacheKey() { return S.user ? `cache.v${CACHE_VERSION}.${S.user.user_id}` : null; }
function notesKey(headId) {
  return S.user ? `notes.v${CACHE_VERSION}.${S.user.user_id}.${headId}` : null;
}

function saveCache() {
  const key = cacheKey();
  if (!key) return;
  local(key, {
    // A head still on its way to the sheet is left out: it has no real id, so
    // a cached copy of it would reappear on every load as a row that opens
    // nothing. The write itself is kept safe by the outbox in api.js.
    heads: S.heads.filter(h => !h._pending),
    inbox: S.inbox, lists: S.lists,
    needsDetail: S.needsDetail, at: Date.now()
  });
}

/** Draws the last known state at once. Returns false if there is none. */
function paintFromCache() {
  const key = cacheKey();
  const c = key && local(key);
  if (!c || !Array.isArray(c.heads)) return false;

  S.heads = c.heads;
  S.inbox = c.inbox || [];
  S.lists = c.lists || S.lists;
  S.needsDetail = c.needsDetail || 0;

  refreshLists();
  refreshHeadPickers();
  renderHeads();
  renderInbox();
  paintStats();

  // The moment the user actually has something to look at. Readable in
  // devtools as performance.getEntriesByName("documentrism:painted").
  try { performance.mark("documentrism:painted"); } catch (e) {}
  return true;
}

function local(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem("documentrism." + key));
    localStorage.setItem("documentrism." + key, JSON.stringify(val));
  } catch (e) {}
  return null;
}

/* --- time ----------------------------------------------------------------- */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const d2 = n => (n < 10 ? "0" : "") + n;

function asDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
const clockOf = iso => { const d = asDate(iso); return d ? d2(d.getHours()) + ":" + d2(d.getMinutes()) : ""; };
const dateOf  = iso => { const d = asDate(iso); return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ""; };
const fullOf  = iso => { const d = asDate(iso); return d ? `${dateOf(iso)}, ${clockOf(iso)}` : "—"; };
const dayKey  = iso => { const d = asDate(iso); return d ? `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}` : "unknown"; };

function dayLabel(iso) {
  const d = asDate(iso);
  if (!d) return "No date";
  const today = new Date(), y = new Date(Date.now() - 86400000);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(y.toISOString())) return "Yesterday";
  return DAYS[d.getDay()] + " " + dateOf(iso);
}

function ago(iso) {
  const d = asDate(iso);
  if (!d) return "—";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hrs / 24);
  if (days < 8) return days + (days === 1 ? " day ago" : " days ago");
  return dateOf(iso);
}

/* --- chrome --------------------------------------------------------------- */
function toast(msg, kind, action) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.innerHTML = `<span class="dot"></span><span>${esc(msg)}</span>` +
    (action ? `<button class="linkish" style="font-size:11px">${esc(action.label)}</button>` : "");
  $("#toasts").appendChild(el);
  if (action) {
    on(el.querySelector("button"), "click", () => { el.remove(); action.run(); });
  }
  setTimeout(() => el.remove(), action ? 8000 : 4200);
  return el;
}

function showErr(sel, message) {
  const el = $(sel);
  el.textContent = message;
  el.classList.add("on");
}
function clearErr(sel) { $(sel).classList.remove("on"); }

function sync(state, text) {
  const box = $("#sync");
  if (!box) return;
  box.dataset.state = state;
  $("#syncText").textContent = text || "";
  $("#syncRetry").style.display = state === "failed" ? "" : "none";
}

/* ==========================================================================
   Skin — mode, theme, custom CSS
   ========================================================================== */
const SKIN_KEYS = ["mode", "layout", "theme", "style", "accent", "font",
                   "fsize", "density", "anim"];

function applySkin() {
  const d = document.documentElement.dataset;
  SKIN_KEYS.forEach(k => { d[k] = S.prefs[k] || ""; });
  applyCustomCss(S.prefs.custom_css || "");

  // reflect the current values back into the Appearance panel
  const set = (sel, val) => { const el = $(sel); if (el && el.value !== val) el.value = val; };
  const t = $("#stTheme");
  if (t) t.textContent = S.prefs.theme === "dark" ? "Dark" : "Light";
  $$("[data-mode-pick]").forEach(b => b.classList.toggle("on", b.dataset.modePick === S.prefs.mode));
  set("#stLayout", S.prefs.layout);
  applySplit();          // the split arrangement depends on the layout too

  // Board builds different markup, so changing to or from it has to redraw
  // the list — a stylesheet cannot group rows into columns by itself.
  if (S.user && S.lastLayout !== undefined && S.lastLayout !== S.prefs.layout) {
    renderHeads();
  }
  S.lastLayout = S.prefs.layout;
  set("#stStyle", S.prefs.style);
  set("#stAccent", S.prefs.accent);
  set("#stFont", S.prefs.font);
  set("#stSize", S.prefs.fsize);
  set("#stDensity", S.prefs.density);
  const anim = $("#stAnim");
  if (anim) anim.checked = S.prefs.anim !== "off";
  const cssIn = $("#cssIn");
  if (cssIn && cssIn.value !== (S.prefs.custom_css || "")) cssIn.value = S.prefs.custom_css || "";

  // the browser's own chrome follows the mode, so it does not sit on a page
  // of a completely different colour
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc && bg) tc.setAttribute("content", bg);

  // keep a copy on the device so the next load paints correctly before login
  const skin = { custom_css: S.prefs.custom_css };
  SKIN_KEYS.forEach(k => { skin[k] = S.prefs[k]; });
  local("skin", skin);
}

/** Written as TEXT into a <style> element — never as markup, anywhere. */
function applyCustomCss(css) {
  const slot = $("#customCss");
  if (slot) slot.textContent = String(css || "");
}

/**
 * The same rules the server enforces. Checking here too means the person sees
 * what is wrong as they type, instead of after a round trip.
 */
function cssProblem(css) {
  const s = String(css || "");
  if (s.length > 20000) return "Too long — keep custom CSS under 20,000 characters.";
  if (/[<>]/.test(s)) return "CSS cannot contain < or >. This box takes CSS only, not HTML.";
  const banned = [
    [/@import/i, "@import is not allowed."],
    [/javascript\s*:/i, "javascript: is not allowed."],
    [/expression\s*\(/i, "expression() is not allowed."],
    [/-moz-binding/i, "-moz-binding is not allowed."],
    [/behavior\s*:/i, "behavior: is not allowed."]
  ];
  for (const [re, msg] of banned) if (re.test(s)) return msg;

  for (const raw of s.match(/url\s*\(([^)]*)\)/gi) || []) {
    const inner = raw.replace(/^url\s*\(/i, "").replace(/\)$/, "").trim().replace(/^['"]|['"]$/g, "");
    if (!/^data:image\//i.test(inner) && !/^https:\/\//i.test(inner)) {
      return `url() must be an https address or a data:image. Found: ${inner}`;
    }
  }
  return "";
}

const CSS_EXAMPLE = `/* One line repaints everything — every mode is built from these. */
:root {
  --accent: #ff8a3d;
  --radius: 4px;
}

/* Make the note text a little larger */
.note-text { font-size: 14.5px; }

/* Flatten the panels */
.panel, .card, .head-hero { box-shadow: 0 0 0 1px var(--line); }
`;

/* ==========================================================================
   Gate
   ========================================================================== */
function showStep(id) {
  $("#gate").classList.remove("hide");
  $("#shell").classList.add("hide");
  $$(".gate-step").forEach(s => s.classList.toggle("on", s.id === id));
  const first = $("#" + id).querySelector("input");
  if (first) setTimeout(() => first.focus(), 40);
}

function wireGate() {
  $$("[data-step]").forEach(b => on(b, "click", () => {
    ["#liErr", "#suErr", "#rsErr"].forEach(clearErr);
    $("#rsOk").classList.remove("on");
    showStep(b.dataset.step);
  }));

  /* sign in */
  on($("#liGo"), "click", async () => {
    clearErr("#liErr");
    const id = $("#liId").value.trim(), pw = $("#liPw").value;
    if (!id || !pw) return showErr("#liErr", "Enter your username and password.");
    const btn = $("#liGo");
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const res = await API.login(id, pw);
      $("#liPw").value = "";
      await enterApp(res);
    } catch (e) {
      showErr("#liErr", e.message);
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });
  ["#liId", "#liPw"].forEach(sel => on($(sel), "keydown", e => { if (e.key === "Enter") $("#liGo").click(); }));

  /* sign up */
  on($("#suGo"), "click", async () => {
    clearErr("#suErr");
    const username = $("#suUser").value.trim().toLowerCase();
    const name = $("#suName").value.trim();
    const pw = $("#suPw").value, pw2 = $("#suPw2").value;
    const dob = $("#suDob").value;

    if (!/^[a-z0-9._-]{3,24}$/.test(username))
      return showErr("#suErr", "Username must be 3 to 24 characters: letters, numbers, dot, dash or underscore.");
    if (!name) return showErr("#suErr", "Please enter your name.");
    if (pw.length < 8) return showErr("#suErr", "Password must be at least 8 characters.");
    if (pw !== pw2) return showErr("#suErr", "The two passwords are not the same.");
    if (!dob) return showErr("#suErr", "Please give your date of birth.");

    const btn = $("#suGo");
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const res = await API.signup({ username, name, password: pw, dob });
      $("#suPw").value = $("#suPw2").value = "";
      await enterApp(res);
      toast("Welcome, " + name + ".", "good");
    } catch (e) {
      showErr("#suErr", e.message);
    } finally {
      btn.disabled = false; btn.textContent = "Create account";
    }
  });

  /* reset */
  on($("#rsGo"), "click", async () => {
    clearErr("#rsErr");
    $("#rsOk").classList.remove("on");
    const id = $("#rsId").value.trim();
    const dob = $("#rsDob").value, code = $("#rsCode").value.trim();
    const pw = $("#rsPw").value, pw2 = $("#rsPw2").value;

    if (!id) return showErr("#rsErr", "Enter your username or name.");
    if (!dob && !code) return showErr("#rsErr", "Give your date of birth, or a reset code.");
    if (pw.length < 8) return showErr("#rsErr", "New password must be at least 8 characters.");
    if (pw !== pw2) return showErr("#rsErr", "The two passwords are not the same.");

    const btn = $("#rsGo");
    btn.disabled = true; btn.textContent = "Changing…";
    try {
      await API.resetPassword({ id, dob, reset_code: code, new_password: pw });
      $("#rsPw").value = $("#rsPw2").value = $("#rsCode").value = "";
      const ok = $("#rsOk");
      ok.textContent = "Password changed. Sign in with the new one.";
      ok.classList.add("on");
      setTimeout(() => showStep("stepLogin"), 1400);
    } catch (e) {
      showErr("#rsErr", e.message);
    } finally {
      btn.disabled = false; btn.textContent = "Change password";
    }
  });
}

/* ==========================================================================
   Entering and leaving the app
   ========================================================================== */

/** Runs fn once the write queue is empty — the restored writes are not in
 *  this page's state, so the screen only matches the sheet after a refresh. */
function whenQueueDrains(fn) {
  let done = false;
  API.onChange(() => {
    if (done || API.pending() || API.state.stuck) return;
    done = true;
    fn();
  });
}

async function enterApp(res) {
  if (res && res.user) S.user = res.user;
  if (res && res.prefs) S.prefs = Object.assign(S.prefs, res.prefs);
  applySkin();
  $("#gate").classList.add("hide");
  $("#shell").classList.remove("hide");

  // Anything that did not reach the sheet last time goes out now. Each job
  // still carries the op_id it was given then, so a write that did land while
  // the tab was closing is recognised and not repeated.
  const resumed = API.restoreOutbox();
  if (resumed) {
    toast(`Finishing ${resumed} change${resumed === 1 ? "" : "s"} from last time…`, "");
    whenQueueDrains(() => reload({ background: true }));
  }

  // If this account has been used on this device before, the screen is up
  // before the network is even asked.
  if (paintFromCache()) {
    sync("saving", "Checking for changes");
    reload({ background: true });
  } else {
    await reload();
    sync("saved", "Ready");
  }

  // Whatever address they arrived at is what they asked for.
  ROUTE.apply();
}

function signOut() {
  // Signing out is deliberate, so the cached copy of this person's work goes
  // with it. Someone else may be about to use this computer.
  try {
    const mine = `.v${CACHE_VERSION}.${S.user ? S.user.user_id : ""}`;
    Object.keys(localStorage)
      .filter(k => k.startsWith("documentrism.") && k.includes(mine))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) {}

  API.signOut();
  S.user = null; S.heads = []; S.inbox = []; S.current = null; S.lastSync = 0;
  S.shares = { incoming: [], outgoing: [] };
  S.sharedPerson = null; S.readonly = false;
  document.body.classList.remove("readonly");
  $("#shell").classList.add("hide");
  $("#liId").value = ""; $("#liPw").value = "";
  showStep("stepLogin");
}

/* ==========================================================================
   Option lists
   ========================================================================== */
function fillSelect(el, values, opts = {}) {
  if (!el) return;
  let html = "";
  if (opts.blank !== undefined) html += `<option value="">${esc(opts.blank)}</option>`;
  values.forEach(v => { html += `<option value="${esc(v)}">${esc(v)}</option>`; });
  el.innerHTML = html;
  if (opts.value !== undefined) el.value = opts.value;
}

function refreshLists() {
  const L = S.lists;
  fillSelect($("#fClient"), L.clients, { blank: "All clients", value: S.filters.client });
  fillSelect($("#fType"), L.types, { blank: "All types", value: S.filters.type });
  fillSelect($("#fStatus"), L.statuses, { blank: "All statuses", value: S.filters.status });
  fillSelect($("#qaType"), L.types, { blank: "No type" });
  fillSelect($("#nhType"), L.types, { blank: "No type" });
  fillSelect($("#nhStatus"), L.statuses, { value: "Active" });
  // Client is a dropdown, not free text — the server refuses anything that is
  // not on the Lists tab, so the field must not let you type one.
  fillSelect($("#nhClient"), L.clients, { blank: "No client" });
}

function refreshHeadPickers() {
  const ordered = S.heads.slice().sort((a, b) => {
    const ia = S.mru.indexOf(a.head_id), ib = S.mru.indexOf(b.head_id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  let html = `<option value="">Inbox — file it later</option>`;
  ordered.forEach(h => {
    if (h._pending) return;        // no real id yet; a note cannot be filed to it
    html += `<option value="${esc(h.head_id)}">${esc(h.title)}${h.client ? "  ·  " + esc(h.client) : ""}</option>`;
  });
  $("#qaHead").innerHTML = html;
}

function bumpMru(headId) {
  if (!headId) return;
  S.mru = [headId, ...S.mru.filter(x => x !== headId)].slice(0, 12);
  local("mru", S.mru);
}

function paintStats() {
  const live = S.heads.filter(h => h.archived !== "Yes");
  $("#cHeads").textContent = live.length;
  $("#cInbox").textContent = S.inbox.length;
  $("#sActive").textContent = live.filter(h => h.status === "Active").length;
  $("#sNeeds").textContent = Math.max(0, S.needsDetail);
  $("#sInbox").textContent = S.inbox.length;
  $("#whoName").textContent = S.user ? (S.user.name || S.user.username) : "—";
}

/* ==========================================================================
   Heads list
   ========================================================================== */
function visibleHeads() {
  const f = S.filters, q = f.q.trim().toLowerCase();
  return S.heads.filter(h => {
    // Sub-heads belong to their parent's page, not this list — they are part
    // of one piece of work, and listing them here doubles its length.
    if (h.parent_id) return false;
    if (!f.archived && h.archived === "Yes") return false;
    if (f.client && h.client !== f.client) return false;
    if (f.type && h.type !== f.type) return false;
    if (f.status && h.status !== f.status) return false;
    if (f.flag && h.needs_detail !== "Yes") return false;
    if (q && !`${h.title} ${h.client} ${h.type} ${h.status}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function statusChip(status) {
  if (!status) return `<span class="chip">—</span>`;
  const key = String(status).toLowerCase();
  const cls = key === "active" ? "st-active" : key === "paused" ? "st-paused" : key === "done" ? "st-done" : "";
  return `<span class="chip ${cls}"><span class="dot"></span>${esc(status)}</span>`;
}

/* --------------------------------------------------------------------------
   Note search

   Heads filter instantly from what is already in memory. Note text is not in
   memory and never will be, so it costs a round trip — which runs behind the
   instant half rather than holding it up.
   -------------------------------------------------------------------------- */
let searchTimer = null;
let searchSeq = 0;

function onSearchInput(value) {
  S.filters.q = value;
  renderHeads();                       // instant, from memory
  renderSuggestions(value, null);      // heads now; notes follow

  clearTimeout(searchTimer);
  const q = value.trim();
  if (q.length < 2) { hideNoteHits(); hideSuggestions(); return; }

  $("#nfRows").innerHTML = `<div class="searching">Looking through your notes…</div>`;
  $("#nfTerm").textContent = `"${q}"`;
  $("#nfCount").textContent = "";
  $("#notesFound").classList.remove("hide");

  searchTimer = setTimeout(() => findNotes(q), 400);
}

/* --- the dropdown under the search box ------------------------------------ */
let suggIndex = -1;

function hideSuggestions() {
  $("#sugg").classList.remove("on");
  $("#search").setAttribute("aria-expanded", "false");
  suggIndex = -1;
}

function renderSuggestions(value, noteHits) {
  const box = $("#sugg");
  const q = String(value || "").trim();
  if (q.length < 2) { hideSuggestions(); return; }

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const heads = S.heads
    .filter(h => h.archived !== "Yes")
    .filter(h => words.every(w => `${h.title} ${h.client} ${h.type}`.toLowerCase().includes(w)))
    .slice(0, 5);

  let html = "";
  if (heads.length) {
    html += `<div class="sugg-head">Heads</div>`;
    html += heads.map(h => `
      <button class="sugg-item" data-kind="head" data-id="${esc(h.head_id)}">
        <div class="t">${highlight(h.title, words)}</div>
        <div class="m">${h.client ? esc(h.client) + " · " : ""}${h.note_count} note${
          h.note_count === 1 ? "" : "s"}${h.parent_id ? " · sub-head" : ""}</div>
      </button>`).join("");
  }

  if (noteHits === null) {
    html += `<div class="sugg-head">Notes</div><div class="quiet">Searching your notes…</div>`;
  } else if (noteHits.length) {
    html += `<div class="sugg-head">Notes</div>`;
    html += noteHits.slice(0, 6).map(n => `
      <button class="sugg-item" data-kind="note" data-id="${esc(n.note_id)}">
        <div class="t">${highlight(n.text, words)}</div>
        <div class="m">${esc(n.head_title || "Inbox")} · ${esc(dateOf(n.created_at))}</div>
      </button>`).join("");
  } else if (!heads.length) {
    html += `<div class="quiet">Nothing matches “${esc(q)}”.</div>`;
  }

  box.innerHTML = html;
  box.classList.add("on");
  $("#search").setAttribute("aria-expanded", "true");
  suggIndex = -1;

  $$(".sugg-item", box).forEach(el => on(el, "mousedown", e => {
    e.preventDefault();                 // keep focus until we have navigated
    pickSuggestion(el);
  }));
}

function pickSuggestion(el) {
  hideSuggestions();
  if (el.dataset.kind === "head") openHead(el.dataset.id);
  else openNote(el.dataset.id);
}

function moveSuggestion(step) {
  const items = $$(".sugg-item");
  if (!items.length) return;
  items.forEach(i => i.classList.remove("cur"));
  suggIndex = (suggIndex + step + items.length) % items.length;
  const el = items[suggIndex];
  el.classList.add("cur");
  el.scrollIntoView({ block: "nearest" });
}

function hideNoteHits() {
  clearTimeout(searchTimer);
  searchSeq++;                         // abandon any answer still in flight
  $("#notesFound").classList.add("hide");
  $("#nfRows").innerHTML = "";
}

async function findNotes(q) {
  const mine = ++searchSeq;
  try {
    const res = await API.call("searchNotes", { q });
    if (mine !== searchSeq) return;    // a newer search has replaced this one
    if (S.filters.q.trim() !== q) return;
    renderNoteHits(res);
    renderSuggestions(S.filters.q, res.notes || []);
  } catch (e) {
    if (mine !== searchSeq) return;
    $("#nfRows").innerHTML = `<div class="searching">Could not search: ${esc(e.message)}</div>`;
  }
}

function renderNoteHits(res) {
  const rows = res.notes || [];
  $("#nfCount").textContent = res.truncated
    ? `first ${rows.length} of ${res.total}`
    : `${rows.length} found`;

  if (!rows.length) {
    $("#nfRows").innerHTML = `<div class="searching">No note mentions that.</div>`;
    return;
  }

  const words = String(res.q || "").split(/\s+/).filter(Boolean);
  $("#nfRows").innerHTML = rows.map(n => `
    <button class="hit" data-hit-head="${esc(n.head_id)}" data-hit-note="${esc(n.note_id)}">
      <div class="txt">${highlight(n.text, words)}</div>
      <div class="where">
        <span>${n.head_title ? esc(n.head_title) : "Inbox"}</span>
        <span>·</span>
        <span>${esc(fullOf(n.created_at))}</span>
        ${n.details ? `<span>· has details</span>` : ""}
        ${imageIdsOf(n).length ? `<span>· ${imageIdsOf(n).length} image</span>` : ""}
      </div>
    </button>`).join("");

  $$("#nfRows .hit").forEach(el => on(el, "click", () => {
    const head = el.dataset.hitHead;
    if (head) { openHead(head); }
    else { show("inbox"); }
  }));
}

/** Highlights the searched words. Escapes first, so this cannot inject. */
function highlight(text, words) {
  let out = esc(text);
  words.forEach(w => {
    if (!w) return;
    const safe = esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
  });
  return out;
}

/** One column per status, in the order the Lists tab gives them. */
function renderBoard(box, rows) {
  const statuses = S.lists.statuses.length ? S.lists.statuses : ["Active", "Paused", "Done"];
  const buckets = new Map(statuses.map(s => [s, []]));
  const loose = [];
  rows.forEach(h => {
    if (buckets.has(h.status)) buckets.get(h.status).push(h);
    else loose.push(h);
  });
  if (loose.length) buckets.set("No status", loose);

  box.innerHTML = [...buckets.entries()].map(([status, list]) => `
    <div class="board-col">
      <div class="hd">${esc(status)}<span class="n">${list.length}</span></div>
      ${list.length
        ? list.map(h => headRowHtml(h, kidCount(h.head_id))).join("")
        : `<div class="emptyline">Nothing here.</div>`}
    </div>`).join("");

  $$("#headsRows .trow").forEach(el => on(el, "click", () => openHeadRow(el.dataset.head)));
}

/** The markup for one head row, shared by the table and the board. */
function headRowHtml(h, kids) {
  return `
    <button class="trow${h.archived === "Yes" ? " is-arch" : ""}${h._pending ? " is-pending" : ""}" data-head="${esc(h.head_id)}">
      <div>
        <div class="title">${esc(h.title)}${kids ? `<span class="kids">${kids} sub</span>` : ""}${
          h._pending ? `<span class="kids saving">saving</span>` : ""}</div>
        <div class="sub">${h._pending ? "writing to the sheet · " : ""}${h.link ? "↗ link · " : ""}created ${esc(dateOf(h.created_at))}${
          h.needs_detail === "Yes" ? " · needs detail" : ""}${
          h.archived === "Yes" ? " · archived" : ""}</div>
      </div>
      <div>${h.client ? `<span class="chip client">${esc(h.client)}</span>` : `<span class="faint">—</span>`}</div>
      <div class="c-type">${h.type ? `<span class="chip">${esc(h.type)}</span>` : `<span class="faint">—</span>`}</div>
      <div>${statusChip(h.status)}</div>
      <div class="r num c-notes">${h.note_count}</div>
      <div class="r c-when">${esc(ago(h.updated_at || h.created_at))}</div>
    </button>`;
}

function emptyState(mark, title, body, action) {
  return `<div class="empty"><div class="mark">${mark}</div><h3>${esc(title)}</h3>
          <p>${esc(body)}</p>${action || ""}</div>`;
}

/** A row click. A head that is still being written has no id to fetch yet. */
function openHeadRow(headId) {
  const h = headRow(headId);
  if (h && h._pending) { toast("That head is still being saved — one moment.", ""); return; }
  openHead(headId);
}

/** How many live sub-heads a head has, for the badge on its row. */
function kidCount(headId) {
  return S.heads.filter(h => h.parent_id === headId && h.archived !== "Yes").length;
}

function renderHeads() {
  const rows = visibleHeads();
  const box = $("#headsRows");
  S.lastList = rows;

  $("#headsNote").textContent = rows.length === S.heads.length
    ? "Every piece of work, latest activity first."
    : `${rows.length} of ${S.heads.length} heads shown.`;

  if (!rows.length) {
    box.innerHTML = S.heads.length
      ? emptyState("⊘", "Nothing matches", "Loosen a filter or clear the search box.")
      : emptyState("▢", "No heads yet",
          "A head is one piece of work. Create the first one, then add notes to it as you go.",
          `<button class="btn pri" id="emptyNew">+ New head</button>`);
    const b = $("#emptyNew");
    if (b) on(b, "click", () => openDialog("#nhScrim", "#nhTitle"));
    return;
  }

  // The board layout is the one arrangement the stylesheet cannot make on its
  // own: the rows have to be grouped into a list per status first.
  if (S.prefs.layout === "board") {
    renderBoard(box, rows);
    return;
  }

  box.innerHTML = rows.map(h => headRowHtml(h, kidCount(h.head_id))).join("");

  $$("#headsRows .trow").forEach(el => on(el, "click", () => openHeadRow(el.dataset.head)));
}

/* ==========================================================================
   Head page
   ========================================================================== */
async function openHead(headId, opts) {
  opts = opts || {};
  if (!opts.quiet) {
    show("head", { fromUrl: true });          // the address is set below, once
    const known = headRow(headId);
    if (!opts.fromUrl) ROUTE.set("head", headId, known ? known.title : "");
  }
  bumpMru(headId);

  // The row is already in the heads list, and the notes may be cached from
  // last time — so the page can be whole before the request is even sent.
  // A head opened from the Shared tab is not in your own list, so there is
  // nothing to paint from — it waits for the server, and arrives read-only.
  if (!opts.quiet) { S.readonly = false; S.currentOwner = null; applyReadonly(); }

  const known = headRow(headId);
  const cachedNotes = local(notesKey(headId));
  if (known && !opts.quiet) {
    S.current = { head: Object.assign({}, known), notes: cachedNotes || [], children: [] };
    paintHead();
    if (!cachedNotes) {
      $("#hNotes").innerHTML = `<div class="skeleton"><i></i><i></i><i></i></div>`;
    }
  } else if (!opts.quiet) {
    $("#crumbTitle").textContent = "loading…";
    $("#hNotes").innerHTML = `<div class="skeleton"><i></i><i></i><i></i></div>`;
  }

  try {
    const res = await API.call("getHead", { head_id: headId });
    if (!res || !res.head) { throw new Error("The sheet sent back an empty head."); }
    // Don't let a slow answer overwrite a head the user has since moved on from
    if (S.current && S.current.head.head_id !== headId && opts.quiet) return;
    S.current = { head: res.head, notes: res.notes, children: res.children || [] };
    S.readonly = !!res.readonly;
    // Now the title is known, put a readable slug on the address — replacing
    // rather than pushing, so Back still goes where the user came from.
    if (!opts.quiet) ROUTE.set("head", res.head.head_id, res.head.title, true);
    S.currentOwner = res.owner || null;
    if (!S.readonly) local(notesKey(headId), res.notes);   // never cache someone else's
    paintHead();
  } catch (e) {
    if (opts.quiet) return;                 // a quiet refresh keeps what is shown
    if (known && cachedNotes) { toast("Showing the last copy — " + e.message, "bad"); return; }
    toast(e.message, "bad");
    show("heads");
  }
}

function headRow(id) { return S.heads.find(h => h.head_id === id) || null; }

/** Puts the page into, or out of, read-only. CSS does the hiding. */
function applyReadonly() {
  document.body.classList.toggle("readonly", !!S.readonly);
  const banner = $("#roBanner");
  if (!banner) return;
  if (S.readonly) {
    const who = S.currentOwner ? `${S.currentOwner.name} (${S.currentOwner.username})` : "someone else";
    const kids = (S.current && S.current.children || []).length;
    banner.innerHTML = `<span class="dot" style="background:var(--blue)"></span>
      <span>Shared with you by <b>${esc(who)}</b> — you can read everything here,
      including each note's full details${
        kids ? ` and its ${kids} sub-head${kids === 1 ? "" : "s"}` : ""
      }. You cannot change any of it.</span>`;
    banner.classList.remove("hide");
  } else {
    banner.classList.add("hide");
  }
}

function paintHead() {
  const h = S.current.head;
  applyReadonly();
  $("#crumbTitle").textContent = h.title;
  $("#hId").textContent = h.head_id;
  $("#hCreated").textContent = fullOf(h.created_at);
  $("#hUpdated").textContent = fullOf(h.updated_at);
  // Never overwrite a field the user is part-way through filling in.
  if (!S.editing.has("head-link")) $("#hLink").value = h.link || "";
  if (!S.editing.has("head-details")) $("#hDetails").value = h.details || "";
  if (!S.editing.has("head-title")) $("#hTitle").value = h.title;
  $("#hFlag").checked = h.needs_detail === "Yes";
  $("#hArchive").textContent = h.archived === "Yes" ? "Restore this head" : "Archive this head";

  fillParentPicker($("#hParent"), h.head_id, h.parent_id || "");
  renderCrumb(h);
  renderKids();

  fillSelect($("#hClient"), S.lists.clients, { blank: "No client", value: h.client || "" });
  fillSelect($("#hType"), S.lists.types, { blank: "No type", value: h.type || "" });
  fillSelect($("#hStatus"), S.lists.statuses, { blank: "No status", value: h.status || "" });

  const meta = [statusChip(h.status)];
  if (h.client) meta.push(`<span class="chip client">${esc(h.client)}</span>`);
  if (h.type) meta.push(`<span class="chip">${esc(h.type)}</span>`);
  if (h.needs_detail === "Yes") meta.push(`<span class="chip flag">Needs detail</span>`);
  if (h.archived === "Yes") meta.push(`<span class="chip arch">Archived</span>`);
  meta.push(`<span class="sep"></span>`);
  meta.push(`<span class="muted" style="font-size:11.5px">Last change ${esc(ago(h.updated_at))}</span>`);
  if (h.link) meta.push(`<a href="${esc(h.link)}" target="_blank" rel="noopener" style="font-size:11.5px">Open link ↗</a>`);
  $("#hMeta").innerHTML = meta.join("");

  renderNotes();
}

/**
 * Rebuilds the timeline, but never at the cost of something half-written.
 * Open editors and their current text are lifted out first and put back
 * afterwards, so a refresh landing mid-sentence is invisible.
 */
/* --------------------------------------------------------------------------
   Sub-heads
   -------------------------------------------------------------------------- */

/**
 * Everything that could legally be this head's parent: not itself, and not one
 * of its own descendants.
 *
 * headId is "" when creating a new head, which has neither — and the empty
 * string must NOT seed the banned set, because every top-level head has
 * parent_id "" and the walk below would then ban the entire tree.
 */
function fillParentPicker(el, headId, value) {
  if (!el) return;

  const banned = new Set();
  if (headId) {
    banned.add(headId);
    let added = true;
    while (added) {
      added = false;
      S.heads.forEach(h => {
        if (h.parent_id && !banned.has(h.head_id) && banned.has(h.parent_id)) {
          banned.add(h.head_id);
          added = true;
        }
      });
    }
  }

  const choices = S.heads.filter(h => !banned.has(h.head_id) && h.archived !== "Yes");
  el.innerHTML = `<option value="">Nothing — it's a top-level head</option>` +
    choices.map(h => `<option value="${esc(h.head_id)}">${esc(h.title)}</option>`).join("");
  el.value = value || "";
}

function renderCrumb(h) {
  const box = $("#crumbParent");
  if (!box) return;
  const parent = headRow(h.parent_id);
  if (!parent) { box.innerHTML = ""; return; }
  box.innerHTML = `<span>/</span><button class="up" data-up="${esc(parent.head_id)}">${esc(parent.title)}</button>`;
  on($("[data-up]", box), "click", () => openHead(parent.head_id));
}

function renderKids() {
  const card = $("#kidsCard");
  if (!card) return;
  const kids = (S.current && S.current.children) || [];
  // Shown to readers too — sharing a head shares what is under it, and a
  // list that stopped at the parent would misrepresent the work.
  if (!kids.length) { card.classList.add("hide"); return; }

  card.classList.remove("hide");
  $("#kidsCount").textContent = kids.length + (kids.length === 1 ? " sub-head" : " sub-heads");
  $("#kidsRows").innerHTML = kids.map(h => `
    <button class="trow" data-kid="${esc(h.head_id)}" data-depth="0">
      <div>
        <div class="title">${esc(h.title)}</div>
        <div class="sub">${h.note_count} note${h.note_count === 1 ? "" : "s"} · created ${esc(dateOf(h.created_at))}</div>
      </div>
      <div>${h.client ? `<span class="chip client">${esc(h.client)}</span>` : ""}</div>
      <div class="c-type">${h.type ? `<span class="chip">${esc(h.type)}</span>` : ""}</div>
      <div>${statusChip(h.status)}</div>
      <div class="r num c-notes">${h.note_count}</div>
      <div class="r c-when">${esc(ago(h.updated_at || h.created_at))}</div>
    </button>`).join("");
  $$("#kidsRows [data-kid]").forEach(el => on(el, "click", () => openHead(el.dataset.kid)));
}

function renderNotes() {
  // A hole in this array must not take the whole timeline down with it.
  const notes = (S.current.notes || []).filter(Boolean);
  S.current.notes = notes;
  $("#hNoteCount").textContent = notes.length + (notes.length === 1 ? " entry" : " entries");
  const box = $("#hNotes");

  const keep = captureOpenEditors(box);

  if (!notes.length) {
    box.innerHTML = emptyState("○", "No notes yet",
      "Write the first line above. Date and time are added for you.");
    return;
  }

  // Top-level notes carry the day headings; replies hang under their parent
  // wherever that parent sits, so a thread stays together.
  const kidsOf = new Map();
  notes.forEach(n => {
    if (!n.parent_note_id) return;
    if (!kidsOf.has(n.parent_note_id)) kidsOf.set(n.parent_note_id, []);
    kidsOf.get(n.parent_note_id).push(n);
  });
  const known = new Set(notes.map(n => n.note_id));

  const branch = (n, depth) => {
    let out = noteHtml(n, depth);
    (kidsOf.get(n.note_id) || []).forEach(k => { out += branch(k, depth + 1); });
    return out;
  };

  let html = "", lastDay = null;
  notes.slice().reverse().forEach(n => {
    // a reply whose parent is gone is shown as a normal note, not hidden
    if (n.parent_note_id && known.has(n.parent_note_id)) return;
    const key = dayKey(n.created_at);
    if (key !== lastDay) {
      lastDay = key;
      html += `<div class="tl-day"><span class="lbl">${esc(dayLabel(n.created_at))}</span><span class="rule"></span></div>`;
    }
    html += branch(n, 0);
  });
  box.innerHTML = html;
  wireNotes(box);
  wireNoteDrag(box);
  restoreOpenEditors(box, keep);
}

/** Which notes were open, what was typed in them, and where the caret was. */
function captureOpenEditors(scope) {
  const out = {};
  $$(".note.open", scope).forEach(el => {
    const id = el.dataset.note;
    const fields = {};
    $$("[data-f]", el).forEach(f => {
      fields[f.dataset.f] = f.type === "checkbox" ? f.checked : f.value;
    });
    out[id] = {
      fields,
      focused: el.contains(document.activeElement) ? document.activeElement.dataset.f : null,
      start: document.activeElement?.selectionStart ?? null,
      end: document.activeElement?.selectionEnd ?? null
    };
  });
  return out;
}

function restoreOpenEditors(scope, keep) {
  Object.keys(keep || {}).forEach(id => {
    const el = $(`.note[data-note="${CSS.escape(id)}"]`, scope);
    if (!el) return;
    const saved = keep[id];
    el.classList.add("open");
    const btn = $('[data-act="expand"]', el);
    if (btn) btn.classList.add("on");

    Object.keys(saved.fields).forEach(name => {
      const f = $(`[data-f="${name}"]`, el);
      if (!f) return;
      if (f.type === "checkbox") f.checked = saved.fields[name];
      else f.value = saved.fields[name];
    });

    if (saved.focused) {
      const f = $(`[data-f="${saved.focused}"]`, el);
      if (f) {
        f.focus();
        try { f.setSelectionRange(saved.start, saved.end); } catch (e) {}
      }
    }
  });
}

function noteHtml(n, depth) {
  depth = depth || 0;
  const state = n._pending ? " pending" : n._failed ? " failed" : "";
  const chips = [];
  if (n.type) chips.push(`<span class="chip">${esc(n.type)}</span>`);
  if (n.needs_detail === "Yes") chips.push(`<span class="chip flag">Needs detail</span>`);
  if (n.link) chips.push(`<a class="chip" href="${esc(n.link)}" target="_blank" rel="noopener">link ↗</a>`);
  if (n.details) chips.push(`<span class="chip">has details</span>`);
  if (n._pending) chips.push(`<span class="chip">saving…</span>`);
  if (n._failed) chips.push(`<span class="chip" style="color:var(--red)">not saved</span>`);

  const links = String(n.links || "").split(",").filter(Boolean).length;
  if (links) {
    // Reachable from the timeline, not only from the note's own page.
    chips.push(`<button class="chip linkjump" data-open-links="${esc(n.note_id)}"
      title="Open this note to see what it links to">⧉ ${links} linked</button>`);
  }

  return `
  <div class="note${state}${depth ? " note-kid" : ""}" data-note="${esc(n.note_id)}"
       data-depth="${depth}"${S.readonly ? "" : ' draggable="true"'}>
    <div class="note-top">
      <div class="note-text">${esc(n.text)}</div>
      <div class="note-time num">${esc(clockOf(n.created_at))}</div>
      <div class="note-acts">
        <button class="icon-btn" data-act="open" title="Open this note on its own page">↗</button>
        <button class="icon-btn" data-act="expand" title="Quick edit here">⤢</button>
        <button class="icon-btn" data-act="share" title="Share this note">◈</button>
        <button class="icon-btn" data-act="archive" title="Archive this note">✕</button>
      </div>
    </div>
    ${chips.length ? `<div class="note-chips">${chips.join("")}</div>` : ""}
    ${shotsHtml(n)}
    <div class="note-detail">
      <div class="field"><label>Note text</label>
        <textarea class="ta" data-f="text" rows="2">${esc(n.text)}</textarea></div>
      <div class="field" style="margin-top:10px"><label>Full details</label>
        <textarea class="details-ta compact" data-f="details">${esc(n.details || "")}</textarea></div>
      <div class="row">
        <div class="field" style="flex:0 0 150px"><label>Type</label><select class="sel" data-f="type"></select></div>
        <div class="field" style="flex:1"><label>Link</label>
          <input class="inp" data-f="link" value="${esc(n.link || "")}" placeholder="https://"></div>
      </div>
      <div class="row">
        <label class="toggle"><input type="checkbox" data-f="needs_detail"${
          n.needs_detail === "Yes" ? " checked" : ""}> Needs detail</label>
        <div style="flex:1"></div>
        <button class="btn sm ghost" data-act="headings">Expand headings</button>
        <button class="btn sm pri" data-act="save">Save note</button>
      </div>
    </div>
  </div>`;
}

/** Placeholders now; hydrateImages() fetches the bytes and fills them in. */
function shotsHtml(n) {
  const ids = imageIdsOf(n);
  if (!ids.length) return "";
  const many = ids.length > 1 ? " many" : "";
  return `<div class="shots big${many}">` + ids.map(id => `
    <div class="shot" data-img="${esc(id)}" data-note="${esc(n.note_id)}">
      <span class="ph">loading</span>
      <span class="kill" title="Remove this image">✕</span>
    </div>`).join("") + `</div>`;
}

/* --------------------------------------------------------------------------
   Drag a note onto another to file it underneath; drag it to the strip at the
   top of the timeline to bring it back out.
   -------------------------------------------------------------------------- */
let dragId = null;

function wireNoteDrag(scope) {
  if (S.readonly) return;

  // Dropping on the timeline itself, rather than on a note, takes a reply
  // back out to the top level.
  on(scope, "dragover", e => {
    if (!dragId || e.target.closest(".note")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  on(scope, "drop", e => {
    if (!dragId || e.target.closest(".note")) return;
    e.preventDefault();
    const n = findNote(dragId);
    if (n && n.parent_note_id) unnestNote(dragId, "");
  });

  $$(".note[draggable]", scope).forEach(el => {
    const id = el.dataset.note;

    on(el, "dragstart", e => {
      dragId = id;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without data on the transfer
      try { e.dataTransfer.setData("text/plain", id); } catch (err) {}
    });
    on(el, "dragend", () => {
      dragId = null;
      el.classList.remove("dragging");
      $$(".note.drop-into", scope).forEach(x => x.classList.remove("drop-into"));
    });

    on(el, "dragover", e => {
      if (!dragId || dragId === id || isDescendant(id, dragId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-into");
    });
    on(el, "dragleave", () => el.classList.remove("drop-into"));
    on(el, "drop", e => {
      e.preventDefault();
      el.classList.remove("drop-into");
      if (!dragId || dragId === id || isDescendant(id, dragId)) return;
      nestNote(dragId, id);
    });
  });
}

/** True when `maybeKid` is somewhere below `rootId` — you cannot drop a note
 *  onto its own reply, which would make a loop. */
function isDescendant(maybeKid, rootId) {
  const notes = (S.current && S.current.notes) || [];
  const byId = new Map(notes.map(n => [n.note_id, n]));
  let cur = byId.get(maybeKid);
  let steps = 0;
  while (cur && cur.parent_note_id && steps++ < 50) {
    if (cur.parent_note_id === rootId) return true;
    cur = byId.get(cur.parent_note_id);
  }
  return false;
}

function nestNote(childId, parentId) {
  const n = findNote(childId);
  if (!n) return;
  const before = n.parent_note_id || "";
  n.parent_note_id = parentId;
  renderNotes();

  API.enqueue({
    action: "updateNote",
    payload: { note_id: childId, patch: { parent_note_id: parentId } },
    fail: err => {
      n.parent_note_id = before;          // put it back where it was
      renderNotes();
      toast(err.message, "bad");
    }
  });
  const parent = findNote(parentId);
  toast(`Filed under "${(parent ? parent.text : "").slice(0, 40)}".`, "good", {
    label: "Undo",
    run: () => unnestNote(childId, before)
  });
}

function unnestNote(childId, to) {
  const n = findNote(childId);
  if (!n) return;
  n.parent_note_id = to || "";
  renderNotes();
  API.enqueue({
    action: "updateNote",
    payload: { note_id: childId, patch: { parent_note_id: to || "" } }
  });
}

function findNote(id) {
  return (S.current?.notes || []).find(n => n.note_id === id) ||
         S.inbox.find(n => n.note_id === id) || null;
}

function wireNotes(scope) {
  $$(".note", scope).forEach(el => {
    const id = el.dataset.note;
    const n = findNote(id);
    if (!n) return;
    const typeSel = $('[data-f="type"]', el);
    fillSelect(typeSel, S.lists.types, { blank: "No type", value: n.type || "" });

    $$("[data-act]", el).forEach(b => on(b, "click", ev => {
      ev.stopPropagation();
      const act = b.dataset.act;
      if (act === "expand") {
        el.classList.toggle("open");
        b.classList.toggle("on");
        if (!el.classList.contains("open")) markEditing("note:" + id, false);
      }
      if (act === "open") openNote(id);
      if (act === "share") openShare("note", id, n.text.slice(0, 60));
      if (act === "archive") archiveNoteUi(id);
      if (act === "headings") {
        const ta = $('[data-f="details"]', el);
        ta.value = withHeadings(ta.value, typeSel.value || n.type);
        ta.focus();
      }
      if (act === "save") saveNoteFromUi(el, id);
    }));

    // Typing in a note marks it unsaved, which holds off background refreshes
    // until it is saved or closed.
    if (S.readonly) {
      // Readable, not editable. Marking them readonly rather than disabled
      // keeps the text selectable so it can be copied.
      $$("[data-f]", el).forEach(f => { f.readOnly = true; f.disabled = f.type === "checkbox"; });
    } else {
      $$("[data-f]", el).forEach(f => on(f, "input", () => markEditing("note:" + id, true)));
    }
    $$("[data-open-links]", el).forEach(b => on(b, "click", ev => {
      ev.stopPropagation();
      openNote(b.dataset.openLinks);
    }));

    $$(".shot .kill", el).forEach(k => on(k, "click", ev => {
      ev.stopPropagation();
      removeImage(id, k.closest(".shot").dataset.img);
    }));
  });
  hydrateImages(scope);
}

/** Keeps the Needs-detail counter true when a flag is turned on or off. */
function flagDelta(before, after) {
  if (before === after) return;
  S.needsDetail += (after === "Yes" ? 1 : -1);
}

function saveNoteFromUi(el, id) {
  const n = findNote(id);
  if (!n) return;
  const patch = {
    text: $('[data-f="text"]', el).value.trim(),
    details: $('[data-f="details"]', el).value,
    type: $('[data-f="type"]', el).value,
    link: $('[data-f="link"]', el).value.trim(),
    needs_detail: $('[data-f="needs_detail"]', el).checked ? "Yes" : "No"
  };
  if (!patch.text) { toast("A note needs some text.", "bad"); return; }
  const badLink = linkProblem(patch.link);
  if (badLink) { toast(badLink, "bad"); return; }

  flagDelta(n.needs_detail, patch.needs_detail);
  Object.assign(n, patch);
  markEditing("note:" + id, false);          // saved, so refreshes may resume
  if (S.current) renderNotes();
  renderInbox();
  paintStats();
  API.enqueue({ action: "updateNote", payload: { note_id: id, patch } });
  toast("Note saved.", "good");
}

async function archiveNoteUi(id) {
  const note = findNote(id);
  const ok = await confirmAction({
    kind: "Archive note",
    title: "Archive this note?",
    body: note ? `“${note.text.slice(0, 110)}${note.text.length > 110 ? "…" : ""}”` : "",
    note: "Nothing is deleted — the row stays in the sheet with archived set to Yes. It just leaves this list.",
    yes: "Archive it"
  });
  if (!ok) return;
  archiveNoteNow(id);
}

function archiveNoteNow(id) {
  // Keep a copy so Undo can put it back where it was, not just un-archive it.
  const note = findNote(id);
  const snapshot = note ? Object.assign({}, note) : null;
  const wasInbox = S.inbox.some(n => n.note_id === id);

  if (S.current) {
    S.current.notes = S.current.notes.filter(n => n.note_id !== id);
    renderNotes();
  }
  S.inbox = S.inbox.filter(n => n.note_id !== id);
  renderInbox();
  paintStats();
  API.enqueue({ action: "archiveNote", payload: { note_id: id } });

  toast("Note archived.", "good", {
    label: "Undo",
    run: () => {
      if (snapshot) {
        if (wasInbox) { S.inbox.unshift(snapshot); renderInbox(); }
        else if (S.current && snapshot.head_id === S.current.head.head_id) {
          S.current.notes.push(snapshot);
          S.current.notes.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
          renderNotes();
        }
        paintStats();
      }
      API.enqueue({ action: "updateNote", payload: { note_id: id, patch: { archived: "No" } } });
      toast("Put back.", "good");
    }
  });
}

function withHeadings(current, type) {
  const list = HEADINGS[type] || [];
  if (!list.length) return current;
  const out = String(current || "").replace(/\s+$/, "");
  const added = list.filter(h => !out.includes(h));
  if (!added.length) return current;
  const block = added.map(h => h + "\n\n").join("\n");
  return (out ? out + "\n\n" : "") + block;
}

function patchHead(patch, repaint) {
  const h = S.current?.head;
  if (!h) return;
  // The controls are hidden in read-only, but never rely on the interface
  // alone — the server refuses these anyway.
  if (S.readonly) { toast("This was shared with you — you can't change it.", "bad"); return; }
  if ("needs_detail" in patch) flagDelta(h.needs_detail, patch.needs_detail);
  Object.assign(h, patch);
  const row = headRow(h.head_id);
  if (row) Object.assign(row, patch);
  if (repaint !== false) { paintHead(); renderHeads(); paintStats(); }
  API.enqueue({ action: "updateHead", payload: { head_id: h.head_id, patch } });
}

/** Images pasted or dropped before the note exists wait here for its id. */
let pendingShots = [];

/**
 * Shows what is about to be attached, the way a chat app does: small chips
 * under the box, each removable before you send. Previews come from the local
 * file, so nothing is uploaded until the note is saved.
 */
function showPending() {
  const box = $("#pendShots");
  if (!box) return;

  if (!pendingShots.length) {
    box.innerHTML = "";
    box.classList.add("hide");
    return;
  }
  box.classList.remove("hide");
  box.innerHTML = `<div class="pend-label">${pendingShots.length} image${
    pendingShots.length === 1 ? "" : "s"} will attach when you save</div>` +
    pendingShots.map((f, i) => `
      <div class="shot" data-pend="${i}">
        <span class="ph">…</span>
        <span class="kill" title="Don't attach this one">✕</span>
      </div>`).join("");

  pendingShots.forEach((file, i) => {
    const cell = $(`[data-pend="${i}"]`, box);
    if (!cell) return;
    const reader = new FileReader();
    reader.onload = () => {
      const kill = cell.querySelector(".kill");
      cell.innerHTML = `<img src="${reader.result}" alt="">`;
      if (kill) cell.appendChild(kill);
      on(kill, "click", ev => {
        ev.stopPropagation();
        pendingShots.splice(i, 1);
        showPending();
      });
    };
    reader.readAsDataURL(file);
  });
}

function queueShots(files) {
  const imgs = Array.from(files).filter(f => /^image\//.test(f.type));
  if (!imgs.length) return 0;
  pendingShots = pendingShots.concat(imgs).slice(0, 8);
  showPending();
  return imgs.length;
}

function addNoteHere() {
  if (S.readonly) { toast("This was shared with you — you can't add to it.", "bad"); return; }
  const ta = $("#hNoteText");
  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  const h = S.current.head;
  ta.value = "";
  markEditing("composer", false);
  const shots = pendingShots;
  pendingShots = [];
  showPending();
  addNoteOptimistic(text, h.head_id, "", shots);
}

/** Draws the note at once, then sends it. The queue owns the retry. */
function addNoteOptimistic(text, headId, type, shots) {
  const now = new Date().toISOString();
  const temp = {
    note_id: "tmp-" + Date.now(), head_id: headId || "", created_at: now,
    text, type: type || "", link: "", details: "", needs_detail: "No",
    updated_at: now, archived: "No", _pending: true
  };

  if (headId) {
    bumpMru(headId);
    const head = headRow(headId);
    if (head) { head.note_count = (head.note_count || 0) + 1; head.updated_at = now; }
    if (S.current && S.current.head.head_id === headId) { S.current.notes.push(temp); renderNotes(); }
  } else {
    S.inbox.unshift(temp);
    renderInbox();
  }
  renderHeads();
  paintStats();

  const redraw = () => { if (S.current) renderNotes(); renderInbox(); };

  API.enqueue({
    action: "createNote",
    payload: { data: { head_id: headId || "", text, type: type || "" } },
    revive: () => { temp._failed = false; temp._pending = true; redraw(); },
    done: res => {
      const saved = res && res.note;
      if (!saved) { return; }          // nothing to swap in; the optimistic row stands
      if (S.current) {
        const i = S.current.notes.indexOf(temp);
        if (i > -1) { S.current.notes[i] = saved; renderNotes(); }
      }
      const j = S.inbox.indexOf(temp);
      if (j > -1) { S.inbox[j] = saved; renderInbox(); }
      // Images could not be attached before the note had an id.
      if (shots && shots.length) attachImages(saved.note_id, shots);
    },
    fail: () => { temp._pending = false; temp._failed = true; redraw(); }
  });
  return temp;
}

/* ==========================================================================
   The note page

   A long note deserves a page, not a two-row textarea inside a list.
   ========================================================================== */
async function openNote(noteId, opts) {
  opts = opts || {};
  show("note", { fromUrl: true });
  if (!opts.fromUrl) ROUTE.set("note", noteId);
  $("#nvText").value = "";
  $("#nvDetails").value = "";
  $("#nvLinks").innerHTML = `<div class="emptyline">Loading…</div>`;
  try {
    const res = await API.call("getNote", { note_id: noteId });
    S.note = res;
    S.readonly = !!res.readonly;
    paintNote();
  } catch (e) {
    toast(e.message, "bad");
    show("heads");
  }
}

function paintNote() {
  const { note, head, linked, children, readonly } = S.note;
  document.body.classList.toggle("readonly", !!readonly);

  if (!S.editing.has("nv-text")) $("#nvText").value = note.text || "";
  if (!S.editing.has("nv-details")) $("#nvDetails").value = note.details || "";
  if (!S.editing.has("nv-link")) $("#nvLink").value = note.link || "";
  $("#nvFlag").checked = note.needs_detail === "Yes";
  $("#nvId").textContent = note.note_id;
  $("#nvWhen").textContent = fullOf(note.created_at);
  $("#nvHead").textContent = head ? head.title : "Inbox — not filed yet";
  $("#nvCount").textContent = (note.details || "").length
    ? `${(note.details || "").length.toLocaleString()} characters` : "";

  fillSelect($("#nvType"), S.lists.types, { blank: "No type", value: note.type || "" });

  // Belt and braces: the fields themselves refuse input, not only the CSS.
  // readOnly rather than disabled, so the text can still be selected and
  // copied — reading is the whole point of a shared note.
  [["#nvText", "ro"], ["#nvDetails", "ro"], ["#nvLink", "ro"],
   ["#nvType", "dis"], ["#nvFlag", "dis"]].forEach(([sel, how]) => {
    const el = $(sel);
    if (!el) return;
    if (how === "ro") el.readOnly = !!readonly;
    else el.disabled = !!readonly;
  });

  const crumb = $("#nvCrumbHead");
  if (head) {
    crumb.innerHTML = `<span>/</span><button class="up" data-up>${esc(head.title)}</button>`;
    on($("[data-up]", crumb), "click", () => openHead(head.head_id));
  } else {
    crumb.innerHTML = `<span>/</span><button class="up" data-nav="inbox">Inbox</button>`;
    on($("[data-nav]", crumb), "click", () => show("inbox"));
  }

  const banner = $("#nvBanner");
  if (readonly) {
    const who = S.currentOwner ? S.currentOwner.name : "someone else";
    banner.textContent = `Shared with you by ${who} — you can read this, not change it.`;
    banner.classList.remove("hide");
  } else {
    banner.classList.add("hide");
  }

  /* images */
  const shots = imageIdsOf(note);
  $("#nvShotsCard").classList.toggle("hide", !shots.length);
  if (shots.length) {
    $("#nvShots").className = "shots big" + (shots.length > 1 ? " many" : "");
    $("#nvShots").innerHTML = shots.map(id => `
      <div class="shot" data-img="${esc(id)}" data-note="${esc(note.note_id)}">
        <span class="ph">loading</span>
        <span class="kill" title="Remove this image">✕</span>
      </div>`).join("");
    $$("#nvShots .kill").forEach(k => on(k, "click", ev => {
      ev.stopPropagation();
      removeImage(note.note_id, k.closest(".shot").dataset.img);
    }));
    hydrateImages($("#nvShots"));
  }

  renderLinkList("#nvLinks", linked, note.note_id, true);
  const kidsCard = $("#nvKidsCard");
  kidsCard.classList.toggle("hide", !children.length);
  if (children.length) renderLinkList("#nvKids", children, note.note_id, false);
}

function renderLinkList(sel, rows, fromId, cuttable) {
  const box = $(sel);
  if (!rows.length) {
    box.innerHTML = `<div class="emptyline">Nothing linked yet.</div>`;
    return;
  }
  box.innerHTML = rows.map(n => `
    <button class="linkrow" data-go="${esc(n.note_id)}" title="Open this note">
      ${cuttable && !S.readonly ? `<span class="cut" data-cut="${esc(n.note_id)}" title="Remove this link">✕</span>` : ""}
      <div class="t">${esc(n.text)}</div>
      <div class="m">↳ ${esc(n.head_title || "Inbox")} · ${esc(dateOf(n.created_at))}</div>
    </button>`).join("");

  $$("[data-go]", box).forEach(el => on(el, "click", ev => {
    if (ev.target.dataset.cut) return;
    openNote(el.dataset.go);
  }));
  $$("[data-cut]", box).forEach(el => on(el, "click", async ev => {
    ev.stopPropagation();
    try {
      await API.call("unlinkNotes", { note_id: fromId, other_id: el.dataset.cut });
      toast("Link removed.", "good");
      openNote(fromId);
    } catch (e) { toast(e.message, "bad"); }
  }));
}

function saveNotePage() {
  if (S.readonly) {
    toast("This was shared with you — you can read it, not change it.", "bad");
    return;
  }
  const n = S.note.note;
  const patch = {
    text: $("#nvText").value.trim(),
    details: $("#nvDetails").value,
    type: $("#nvType").value,
    link: $("#nvLink").value.trim(),
    needs_detail: $("#nvFlag").checked ? "Yes" : "No"
  };
  if (!patch.text) { toast("A note needs some text.", "bad"); return; }
  const badLink = linkProblem(patch.link);
  if (badLink) { toast(badLink, "bad"); return; }

  Object.assign(n, patch);
  ["nv-text", "nv-details", "nv-link"].forEach(k => markEditing(k, false));
  API.enqueue({ action: "updateNote", payload: { note_id: n.note_id, patch } });
  toast("Note saved.", "good");
}

/* --- the link picker ------------------------------------------------------ */
let linkTimer = null;

function openLinkPicker() {
  if (!S.note) return;
  clearErr("#lnErr");
  $("#lnSearch").value = "";
  $("#lnResults").innerHTML = `<div class="emptyline">Type to find a note.</div>`;
  openDialog("#lnScrim", "#lnSearch");
}

async function searchForLink(q) {
  const box = $("#lnResults");
  if (q.trim().length < 2) {
    box.innerHTML = `<div class="emptyline">Type at least two characters.</div>`;
    return;
  }
  box.innerHTML = `<div class="emptyline">Looking…</div>`;
  try {
    const res = await API.call("searchNotes", { q });
    const me = S.note.note.note_id;
    const already = new Set((S.note.linked || []).map(n => n.note_id));
    const rows = (res.notes || []).filter(n => n.note_id !== me && !already.has(n.note_id));
    if (!rows.length) { box.innerHTML = `<div class="emptyline">Nothing else matches.</div>`; return; }

    box.innerHTML = rows.slice(0, 12).map(n => `
      <button class="linkrow" data-pick="${esc(n.note_id)}">
        <div class="t">${esc(n.text)}</div>
        <div class="m">${esc(n.head_title || "Inbox")} · ${esc(dateOf(n.created_at))}</div>
      </button>`).join("");

    $$("[data-pick]", box).forEach(el => on(el, "click", async () => {
      try {
        await API.call("linkNotes", { note_id: me, other_id: el.dataset.pick });
        closeDialog("#lnScrim");
        toast("Linked.", "good");
        openNote(me);
      } catch (e) { showErr("#lnErr", e.message); }
    }));
  } catch (e) {
    box.innerHTML = `<div class="emptyline">${esc(e.message)}</div>`;
  }
}

/* ==========================================================================
   Inbox
   ========================================================================== */
function renderInbox() {
  const box = $("#inboxPanel");
  if (!box) return;
  if (!S.inbox.length) {
    box.innerHTML = emptyState("✓", "Inbox is clear",
      "Notes saved without a head land here. Nothing is waiting.");
    return;
  }
  const opts = S.heads.filter(h => h.archived !== "Yes");
  box.innerHTML = S.inbox.map(n => `
    <div class="inbox-item" data-inbox="${esc(n.note_id)}">
      <div class="body">
        <div class="txt">${esc(n.text)}</div>
        <div class="when">${esc(fullOf(n.created_at))} · ${esc(ago(n.created_at))}${
          n.type ? " · " + esc(n.type) : ""}</div>
        ${shotsHtml(n)}
      </div>
      <div class="mover">
        <select class="sel" data-move><option value="">Move to head…</option>
          ${opts.map(h => `<option value="${esc(h.head_id)}">${esc(h.title)}</option>`).join("")}
        </select>
        <button class="btn sm" data-go>Move</button>
        <button class="icon-btn" data-drop title="Archive">✕</button>
      </div>
    </div>`).join("");

  $$(".inbox-item", box).forEach(el => {
    const id = el.dataset.inbox;
    on($("[data-go]", el), "click", () => {
      const sel = $("[data-move]", el);
      if (!sel.value) { sel.focus(); return; }
      moveFromInbox(id, sel.value);
    });
    on($("[data-drop]", el), "click", () => archiveNoteUi(id));
    $$(".shot .kill", el).forEach(k => on(k, "click", ev => {
      ev.stopPropagation();
      removeImage(id, k.closest(".shot").dataset.img);
    }));
  });
  hydrateImages(box);
}

function moveFromInbox(noteId, headId) {
  const head = headRow(headId);
  S.inbox = S.inbox.filter(n => n.note_id !== noteId);
  if (head) { head.note_count = (head.note_count || 0) + 1; head.updated_at = new Date().toISOString(); }
  bumpMru(headId);
  renderInbox(); renderHeads(); paintStats();
  API.enqueue({ action: "moveNote", payload: { note_id: noteId, head_id: headId } });
  toast(`Moved into ${head ? head.title : "the head"}.`, "good");
}

/* ==========================================================================
   Validation

   The same rules the server enforces, checked here so the problem is named
   while you are still looking at the field rather than after a round trip.
   ========================================================================== */
const HAS_LETTER = /[A-Za-zÀ-ɏऀ-ॿ]/;

function titleProblem(value) {
  const title = String(value || "").trim();
  if (!title) return "A head needs a title.";
  if (title.length < 2) return "That title is too short — give it at least 2 characters.";
  if (!HAS_LETTER.test(title)) {
    return `A title needs at least one letter — "${title}" on its own won't mean anything later.`;
  }
  return "";
}

function linkProblem(value) {
  const link = String(value || "").trim();
  if (!link) return "";
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(link)) {
    return "A link must start with http:// or https://";
  }
  return "";
}

/** Marks a field as wrong and returns false, so callers can chain checks. */
function flagField(sel, problem) {
  const el = $(sel);
  if (!el) return !problem;
  if (problem) {
    el.style.borderColor = "var(--red)";
    el.focus();
  } else {
    el.style.borderColor = "";
  }
  return !problem;
}

/* ==========================================================================
   Images in notes

   The sheet holds file ids, not pictures — a cell is about 50,000 characters.
   Uploads are resized here first so a 6MB phone screenshot does not become a
   6MB round trip, and fetched bytes are cached, because every fetch costs a
   full second against Apps Script.
   ========================================================================== */
const MAX_EDGE = 1400;
const imageCache = new Map();        // image_id -> data: URL

/** Shrinks to fit MAX_EDGE and re-encodes, so uploads stay small. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file is not an image this app can read."));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        if (scale === 1 && reader.result.length < 900000) { resolve(reader.result); return; }
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        // PNG keeps screenshots of text crisp; photos go to JPEG for size.
        const asPng = /png/i.test(file.type) && c.width * c.height < 1200000;
        resolve(c.toDataURL(asPng ? "image/png" : "image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function attachImages(noteId, files) {
  const list = Array.from(files).filter(f => /^image\//.test(f.type));
  if (!list.length) return;

  for (const file of list) {
    try {
      const dataUrl = await shrinkImage(file);
      sync("saving", "Uploading image");
      const res = await API.call("addNoteImage", {
        note_id: noteId, data_url: dataUrl, name: file.name
      });
      imageCache.set(res.image_id, dataUrl);          // already have the bytes
      const n = findNote(noteId);
      if (n) { n.images = (res.images || []).join(","); }
      if (S.current) renderNotes();
      renderInbox();
      sync("saved", "Saved");
    } catch (e) {
      toast(e.message, "bad");
      sync("failed", e.message);
    }
  }
}

function imageIdsOf(note) {
  return String(note.images || "").split(",").map(s => s.trim()).filter(Boolean);
}

/** Fills in the <img> tags that renderNotes left as placeholders. */
async function hydrateImages(scope) {
  for (const box of $$(".shot[data-img]", scope)) {
    const id = box.dataset.img;
    if (box.dataset.done) continue;
    box.dataset.done = "1";

    if (imageCache.has(id)) { paintShot(box, imageCache.get(id)); continue; }
    try {
      const res = await API.call("getImage", { image_id: id });
      const url = `data:${res.mime};base64,${res.data}`;
      imageCache.set(id, url);
      paintShot(box, url);
    } catch (e) {
      box.classList.add("broken");
      box.innerHTML = `<span class="ph">gone</span>`;
    }
  }
}

function paintShot(box, url) {
  const kill = box.querySelector(".kill");
  box.innerHTML = `<img src="${url}" alt="">`;
  if (kill) box.appendChild(kill);
  on(box, "click", e => {
    if (e.target.classList.contains("kill")) return;
    $("#lightboxImg").src = url;
    $("#lightbox").classList.add("on");
  });
}

async function removeImage(noteId, imageId) {
  const ok = await confirmAction({
    kind: "Remove image",
    title: "Remove this image?",
    body: "It comes off the note.",
    note: "The file goes to your Google Drive trash, so you can still get it back from there.",
    yes: "Remove it"
  });
  if (!ok) return;

  const n = findNote(noteId);
  if (n) n.images = imageIdsOf(n).filter(i => i !== imageId).join(",");
  if (S.current) renderNotes();
  renderInbox();
  try {
    await API.call("removeNoteImage", { note_id: noteId, image_id: imageId });
    toast("Image removed. It's in your Drive trash.", "good");
  } catch (e) {
    toast(e.message, "bad");
  }
}

/* ==========================================================================
   Sharing

   Read-only and one way. The Shared tab shows people first, then what each of
   them has sent you — a list of names is easier to scan than one long pile of
   everyone's work mixed together.
   ========================================================================== */
async function loadShares(opts) {
  opts = opts || {};
  try {
    const res = await API.call("listShares");
    S.shares = { incoming: res.incoming || [], outgoing: res.outgoing || [] };
    const total = S.shares.incoming.reduce((n, p) => n + p.count, 0);
    $("#cShared").textContent = total;
    if (!opts.quiet) renderShared();
    return true;
  } catch (e) {
    if (!opts.quiet) {
      $("#sharedPanel").innerHTML = emptyState("⚠", "Could not load shares", e.message);
    }
    return false;
  }
}

function renderShared() {
  const box = $("#sharedPanel");
  $("#sharedBack").classList.toggle("hide", !S.sharedPerson);

  /* what I've shared out */
  if (S.sharedPerson === "__outgoing__") {
    $("#sharedTitle").textContent = "What you've shared";
    $("#sharedSub").textContent = "Things you've sent to other people. Revoking stops their access at once.";
    const rows = S.shares.outgoing;
    if (!rows.length) {
      box.innerHTML = emptyState("○", "You haven't shared anything",
        "Open a head and press Share, or use the share button on a note.");
      return;
    }
    box.innerHTML = rows.map(s => `
      <div class="shared-note" data-share="${esc(s.share_id)}">
        <div class="txt">${esc(s.label)}</div>
        <div class="meta">${s.kind === "head" ? "Head" : "Note"} · shared with
          ${esc(s.to_name)} (${esc(s.to_username)}) · ${esc(dateOf(s.created_at))}</div>
        <div style="margin-top:9px"><button class="btn sm danger" data-revoke>Revoke</button></div>
      </div>`).join("");
    $$("[data-revoke]", box).forEach(b => on(b, "click", () => {
      revokeShare(b.closest("[data-share]").dataset.share);
    }));
    return;
  }

  /* one person's shared items */
  if (S.sharedPerson) {
    const p = S.shares.incoming.find(x => x.user_id === S.sharedPerson);
    if (!p) { S.sharedPerson = null; renderShared(); return; }
    $("#sharedTitle").textContent = p.name;
    $("#sharedSub").textContent = `Shared with you by ${p.username}. You can read these, not change them.`;

    let html = "";
    p.heads.forEach(h => {
      html += `
      <button class="trow" data-shared-head="${esc(h.head_id)}">
        <div>
          <div class="title">${esc(h.title)}</div>
          <div class="sub">head · ${h.note_count} note${h.note_count === 1 ? "" : "s"}${
            h.sub_count ? ` · ${h.sub_count} sub-head${h.sub_count === 1 ? "" : "s"}` : ""}</div>
        </div>
        <div>${h.client ? `<span class="chip client">${esc(h.client)}</span>` : `<span class="faint">—</span>`}</div>
        <div class="c-type">${h.type ? `<span class="chip">${esc(h.type)}</span>` : ""}</div>
        <div>${statusChip(h.status)}</div>
        <div class="r num c-notes">${h.note_count}</div>
        <div class="r c-when">${esc(ago(h.updated_at || h.created_at))}</div>
      </button>`;
    });
    p.notes.forEach(n => {
      html += `
      <div class="shared-note">
        <div class="txt">${esc(n.text)}</div>
        <div class="meta">note · ${esc(fullOf(n.created_at))}${
          n.head_title ? " · from " + esc(n.head_title) : ""}</div>
        ${n.details ? `<div class="meta" style="margin-top:8px;white-space:pre-wrap;color:var(--ink-soft)">${esc(n.details)}</div>` : ""}
      </div>`;
    });

    box.innerHTML = html || emptyState("○", "Nothing here", "They have not shared anything yet.");
    $$("[data-shared-head]", box).forEach(el =>
      on(el, "click", () => openHead(el.dataset.sharedHead)));
    return;
  }

  /* the list of people */
  $("#sharedTitle").textContent = "Shared with you";
  $("#sharedSub").textContent = "Work other people have shared with you, read-only.";
  const people = S.shares.incoming;
  if (!people.length) {
    box.innerHTML = emptyState("◈", "Nothing shared with you yet",
      "When someone shares a head or a note, their name appears here.");
    return;
  }
  box.innerHTML = people.map(p => `
    <button class="person" data-person="${esc(p.user_id)}">
      <span class="av">${esc((p.name || p.username).trim().charAt(0).toUpperCase())}</span>
      <span class="who">
        <span class="nm">${esc(p.name)}</span>
        <span class="un">${esc(p.username)}</span>
      </span>
      <span class="n">${p.count} item${p.count === 1 ? "" : "s"}</span>
    </button>`).join("");
  $$("[data-person]", box).forEach(el => on(el, "click", () => {
    S.sharedPerson = el.dataset.person;
    renderShared();
  }));
}

async function revokeShare(shareId) {
  const s = S.shares.outgoing.find(x => x.share_id === shareId);
  const ok = await confirmAction({
    kind: "Revoke access",
    title: s ? `Stop sharing with ${s.to_name}?` : "Revoke this share?",
    body: s ? `They lose access to “${String(s.label).slice(0, 90)}” straight away.` : "",
    note: "You can share it with them again at any time.",
    yes: "Revoke it"
  });
  if (!ok) return;

  S.shares.outgoing = S.shares.outgoing.filter(x => x.share_id !== shareId);
  renderShared();
  try {
    await API.call("unshareItem", { share_id: shareId });
    toast("Share revoked.", "good");
  } catch (e) {
    toast(e.message, "bad");
    loadShares();
  }
}

/* --- the share dialog ----------------------------------------------------- */
let sharing = null;      // { kind, item_id, label }

async function openShare(kind, itemId, label) {
  sharing = { kind, item_id: itemId, label };
  $("#shWhat").textContent = kind === "head" ? "A head and its notes" : "One note";
  clearErr("#shErr");
  openDialog("#shScrim");

  const sel = $("#shWho");
  sel.innerHTML = `<option value="">Loading people…</option>`;
  renderShareList();

  try {
    const res = await API.call("listPeople");
    const people = res.people || [];
    sel.innerHTML = people.length
      ? `<option value="">Choose a person…</option>` +
        people.map(p => `<option value="${esc(p.username)}">${esc(p.name)} (${esc(p.username)})</option>`).join("")
      : `<option value="">Nobody else has an account yet</option>`;
  } catch (e) {
    sel.innerHTML = `<option value="">Could not load people</option>`;
    showErr("#shErr", e.message);
  }
}

/** Who this item is already shared with, so it can be taken back here. */
function renderShareList() {
  const box = $("#shList");
  if (!sharing) { box.classList.add("hide"); return; }
  const rows = S.shares.outgoing.filter(s => s.item_id === sharing.item_id);
  if (!rows.length) { box.classList.add("hide"); box.innerHTML = ""; return; }
  box.classList.remove("hide");
  box.innerHTML = `<div class="eyebrow" style="margin-bottom:8px">Already shared with</div>` +
    rows.map(s => `
      <div class="share-row" data-share="${esc(s.share_id)}">
        <span class="who">${esc(s.to_name)} <span class="lbl">${esc(s.to_username)}</span></span>
        <button class="btn sm danger" data-revoke>Revoke</button>
      </div>`).join("");
  $$("[data-revoke]", box).forEach(b => on(b, "click", async () => {
    await revokeShare(b.closest("[data-share]").dataset.share);
    renderShareList();
  }));
}

async function doShare() {
  const to = $("#shWho").value;
  if (!to) { showErr("#shErr", "Choose who to share with."); return; }
  if (!sharing) return;
  clearErr("#shErr");

  const btn = $("#shGo");
  btn.disabled = true; btn.textContent = "Sharing…";
  try {
    const res = await API.call("shareItem", {
      kind: sharing.kind, item_id: sharing.item_id, to
    });
    toast(res.already ? "Already shared with them." : "Shared.", "good");
    await loadShares({ quiet: true });
    renderShareList();
    $("#shWho").value = "";
  } catch (e) {
    showErr("#shErr", e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Share";
  }
}

/* ==========================================================================
   Quick add and new head
   ========================================================================== */
function openQuickAdd() {
  refreshHeadPickers();
  const now = new Date().toISOString();
  $("#qaClock").textContent = `${dayLabel(now)} · ${clockOf(now)}`;
  if (S.current && S.view === "head") $("#qaHead").value = S.current.head.head_id;
  clearErr("#qaErr");
  openDialog("#qaScrim", "#qaText");
}

function quickSave() {
  const text = $("#qaText").value.trim();
  if (!text) { $("#qaText").focus(); return; }
  const headId = $("#qaHead").value;
  const type = $("#qaType").value;
  addNoteOptimistic(text, headId, type);
  closeDialog("#qaScrim");
  $("#qaText").value = "";
  markEditing("quickadd", false);
  toast(headId ? "Note added." : "Note saved to Inbox.", "good");
}

async function createHeadFromDialog() {
  const title = $("#nhTitle").value.trim();

  const bad = titleProblem(title) || linkProblem($("#nhLink").value);
  flagField("#nhTitle", titleProblem(title));
  flagField("#nhLink", linkProblem($("#nhLink").value));
  if (bad) { showErr("#nhErr", bad); return; }
  clearErr("#nhErr");

  const data = {
    title,
    client: $("#nhClient").value.trim(),
    type: $("#nhType").value,
    status: $("#nhStatus").value,
    link: $("#nhLink").value.trim(),
    parent_id: $("#nhParent").value
  };
  closeDialog("#nhScrim");
  ["#nhTitle", "#nhClient", "#nhLink"].forEach(s => { $(s).value = ""; });

  // The head appears in the list straight away and is saved behind you. The
  // sheet takes a second or two and there is nothing to wait for.
  const now = new Date().toISOString();
  const temp = Object.assign({
    head_id: "tmp-" + Date.now(),
    created_at: now, updated_at: now,
    needs_detail: "No", details: "", archived: "No", note_count: 0,
    parent_id: data.parent_id || ""
  }, data);
  temp._pending = true;

  S.heads.unshift(temp);
  if (temp.client && !S.lists.clients.includes(temp.client)) {
    S.lists.clients.push(temp.client);
    S.lists.clients.sort();
    refreshLists();
  }
  refreshHeadPickers(); renderHeads(); paintStats();
  sync("saving", "Creating head");

  try {
    const res = await API.call("createHead", { data });
    const head = res.head;
    const i = S.heads.indexOf(temp);
    if (i > -1) S.heads[i] = head; else S.heads.unshift(head);
    refreshHeadPickers(); renderHeads(); paintStats(); saveCache();
    sync("saved", "Saved");
    // No jump. The row has been on screen since the click, and throwing the
    // user onto another page seconds later would be the opposite of fast.
    toast(`“${head.title}” created.`, "good", { label: "Open", run: () => openHead(head.head_id) });

    // A sub-head made from its parent's page belongs in that page's list of
    // children, which only the server knows about.
    if (head.parent_id && S.view === "head" && S.current &&
        S.current.head.head_id === head.parent_id) {
      openHead(head.parent_id, { quiet: true });
    }
    return head;
  } catch (e) {
    S.heads = S.heads.filter(h => h !== temp);   // it never existed
    renderHeads(); paintStats();
    // This write is not in the queue, so the Retry on the status pill would be
    // a dead button. Hand the typing back instead: the dialog reopens exactly
    // as it was left, with the reason on it.
    sync("idle", "Not saved");
    $("#nhTitle").value = data.title;
    $("#nhClient").value = data.client;
    $("#nhType").value = data.type;
    $("#nhStatus").value = data.status;
    $("#nhLink").value = data.link;
    $("#nhParent").value = data.parent_id;
    openDialog("#nhScrim", "#nhTitle");
    showErr("#nhErr", e.message);
    return null;
  }
}

/* ==========================================================================
   Export
   ========================================================================== */
async function exportAll() {
  sync("saving", "Building export");
  try {
    const res = await API.call("exportAll");
    const data = res.data;
    download(`documentrism-backup-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
    download(`documentrism-notes-${stamp()}.csv`, notesCsv(data), "text/csv");
    sync("saved", "Export downloaded");
    toast("Two files downloaded: a full JSON backup and a notes CSV.", "good");
  } catch (e) {
    sync("failed", e.message);
    toast(e.message, "bad");
  }
}

function notesCsv(data) {
  const heads = {};
  data.heads.forEach(h => { heads[h.head_id] = h; });
  const cols = ["created_at", "head", "client", "note", "type", "link", "needs_detail", "details", "archived"];
  const lines = [cols.join(",")];
  data.notes.forEach(n => {
    const h = heads[n.head_id] || {};
    lines.push([
      n.created_at, h.title || "Inbox", h.client || "", n.text,
      n.type, n.link, n.needs_detail, n.details, n.archived
    ].map(csvCell).join(","));
  });
  return lines.join("\r\n");
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${d2(d.getMonth() + 1)}${d2(d.getDate())}-${d2(d.getHours())}${d2(d.getMinutes())}`;
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ==========================================================================
   PDF export

   Everything the account owns, laid out as a document: each head starts a
   page, its notes follow it, and its sub-heads are nested inside it with
   their own notes, as deep as they go. The inbox comes last.

   Dates are deliberately absent. This is a record of the work, not a log of
   when it was typed — which is also why notes keep their written order
   rather than being re-sorted by anything the reader cannot see.

   There is no PDF library in here. The browser already carries a typesetter
   and a PDF writer behind Ctrl+P; this builds the document it should print
   and gets out of the way. What comes out has selectable text, real links
   and copyable content — none of which survives drawing a PDF onto a canvas.
   ========================================================================== */
async function exportPdf() {
  sync("saving", "Gathering everything");
  let data;
  try {
    data = (await API.call("exportAll")).data;
  } catch (e) {
    sync("failed", e.message);
    toast(e.message, "bad");
    return;
  }

  // Images live in Drive and come back one at a time. Anything already looked
  // at this session is in hand; the rest are fetched now, because a document
  // that silently drops half its pictures is worse than one that takes longer.
  const wanted = [];
  (data.notes || []).forEach(n => imageIdsOf(n).forEach(id => {
    if (!imageCache.has(id) && !wanted.includes(id)) wanted.push(id);
  }));
  for (let i = 0; i < wanted.length; i++) {
    sync("saving", `Fetching image ${i + 1} of ${wanted.length}`);
    try {
      const res = await API.call("getImage", { image_id: wanted[i] });
      imageCache.set(wanted[i], `data:${res.mime};base64,${res.data}`);
    } catch (e) {
      // Left out of the cache on purpose: the document says the image is
      // missing, and the next export tries for it again.
    }
  }

  const counts = buildPaper(data);
  $("#paperSub").textContent =
    `${counts.heads} head${counts.heads === 1 ? "" : "s"} · ` +
    `${counts.notes} note${counts.notes === 1 ? "" : "s"}` +
    (counts.images ? ` · ${counts.images} image${counts.images === 1 ? "" : "s"}` : "");

  $("#paper").classList.remove("hide");
  document.documentElement.classList.add("export-open");
  const scroll = $(".paper-scroll");
  if (scroll) scroll.scrollTop = 0;

  // The browser names the saved file after the page, so the page is renamed
  // for as long as the document is up.
  paperTitleWas = document.title;
  const who = (data.account && (data.account.name || data.account.username)) || "";
  document.title = who ? `Work record — ${who}` : "Work record";

  sync("saved", "Export ready");
}

let paperTitleWas = "";

function closePaper() {
  $("#paper").classList.add("hide");
  document.documentElement.classList.remove("export-open");
  $("#paperDoc").innerHTML = "";            // some of this is image data
  if (paperTitleWas) { document.title = paperTitleWas; paperTitleWas = ""; }
}

/** Builds the document and returns what went into it. */
function buildPaper(data) {
  const heads = (data.heads || []).filter(h => h.head_id);
  const notes = (data.notes || []).filter(n => n.note_id);

  const kidsOf = groupBy(heads, h => h.parent_id || "");
  const notesOf = groupBy(notes, n => n.head_id || "");
  const noteById = new Map(notes.map(n => [n.note_id, n]));
  const headById = new Map(heads.map(h => [h.head_id, h]));

  // A head whose parent is missing or archived away still has to appear
  // somewhere, so anything we never reach from the top is shown as top-level.
  const seen = new Set();
  const roots = (kidsOf.get("") || []).slice();
  roots.forEach(function mark(h) {
    if (seen.has(h.head_id)) return;
    seen.add(h.head_id);
    (kidsOf.get(h.head_id) || []).forEach(mark);
  });
  heads.forEach(h => { if (!seen.has(h.head_id)) roots.push(h); });

  const who = (data.account && (data.account.name || data.account.username)) || "";
  const inbox = notesOf.get("") || [];
  let imageCount = 0;

  const body = roots.map(h => headSection(h, 1)).join("") +
    (inbox.length
      ? `<section class="pg"><h1 class="h-title">Inbox</h1>
         <p class="h-note">Notes that were never filed under a head.</p>
         ${noteTree(inbox, "")}</section>`
      : "");

  $("#paperDoc").innerHTML = `
    <header class="cover">
      <div class="cover-mark">DOCUMENTRISM</div>
      <h1 class="cover-title">Work record</h1>
      ${who ? `<p class="cover-who">${esc(who)}</p>` : ""}
      <p class="cover-count">${heads.length} head${heads.length === 1 ? "" : "s"} · ${notes.length} note${notes.length === 1 ? "" : "s"}</p>
    </header>
    ${roots.length > 1 ? `<nav class="toc">
      <h2 class="toc-h">Contents</h2>
      <ol>${roots.map(h => `<li>${esc(h.title)}${
        h.client ? ` <span class="toc-c">${esc(h.client)}</span>` : ""}</li>`).join("")}</ol>
    </nav>` : ""}
    ${body || `<section class="pg"><p class="h-note">There is nothing in this account yet.</p></section>`}`;

  return { heads: heads.length, notes: notes.length, images: imageCount };

  /* ---- the pieces ---- */

  function headSection(h, depth) {
    const kids = kidsOf.get(h.head_id) || [];
    const mine = notesOf.get(h.head_id) || [];
    const tag = depth === 1 ? "h1" : depth === 2 ? "h2" : "h3";

    return `<section class="${depth === 1 ? "pg" : "sub"}" ${depth > 1 ? `style="--d:${Math.min(depth - 1, 4)}"` : ""}>
      <${tag} class="h-title">${esc(h.title)}${
        h.archived === "Yes" ? ` <span class="flag">Archived</span>` : ""}${
        h.needs_detail === "Yes" ? ` <span class="flag">Needs detail</span>` : ""}</${tag}>
      ${metaLine([h.client, h.type, h.status])}
      ${h.link ? linkLine(h.link) : ""}
      ${prose(h.details)}
      ${mine.length ? noteTree(mine, h.head_id) : `<p class="h-note">No notes under this head.</p>`}
      ${kids.map(k => headSection(k, depth + 1)).join("")}
    </section>`;
  }

  /** Notes, nested the way they were nested in the app. */
  function noteTree(list, headId) {
    const byParent = groupBy(list, n => {
      const p = n.parent_note_id || "";
      // A note whose parent sits in another head is drawn at this level.
      return p && list.some(x => x.note_id === p) ? p : "";
    });
    return `<div class="notes">${branch("")}</div>`;

    function branch(parent) {
      return (byParent.get(parent) || []).map(n => `
        <div class="note">
          ${prose(n.text) || `<p class="n-text faint">(empty note)</p>`}
          ${metaLine([n.type, n.needs_detail === "Yes" ? "Needs detail" : "",
                      n.archived === "Yes" ? "Archived" : ""])}
          ${n.link ? linkLine(n.link) : ""}
          ${n.details ? `<div class="n-detail">${prose(n.details)}</div>` : ""}
          ${shots(n)}
          ${linkedTo(n)}
          ${byParent.has(n.note_id) ? `<div class="kidnotes">${branch(n.note_id)}</div>` : ""}
        </div>`).join("");
    }
  }

  function shots(n) {
    const ids = imageIdsOf(n);
    if (!ids.length) return "";
    return `<div class="shots">${ids.map(id => {
      const url = imageCache.get(id);
      if (!url) return `<div class="shot-gone">[image unavailable]</div>`;
      imageCount++;
      return `<figure class="shot"><img src="${url}" alt=""></figure>`;
    }).join("")}</div>`;
  }

  /** What this note points at, named so the reader can find it. */
  function linkedTo(n) {
    const ids = String(n.links || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!ids.length) return "";
    const named = ids.map(id => {
      const t = noteById.get(id);
      if (!t) return null;
      const home = t.head_id ? headById.get(t.head_id) : null;
      return `<li>${esc(excerpt(t.text, 90))}${
        home ? ` <span class="in">in ${esc(home.title)}</span>`
             : ` <span class="in">in the inbox</span>`}</li>`;
    }).filter(Boolean);
    if (!named.length) return "";
    return `<div class="linked"><span class="lk">Linked to</span><ul>${named.join("")}</ul></div>`;
  }
}

function metaLine(parts) {
  const bits = parts.filter(Boolean).map(p => `<span>${esc(p)}</span>`);
  return bits.length ? `<p class="meta">${bits.join('<i>·</i>')}</p>` : "";
}

function linkLine(href) {
  return `<p class="link"><a href="${esc(href)}">${esc(href)}</a></p>`;
}

/** Text as paragraphs, with the line breaks the writer put in. */
function prose(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return s.split(/\n{2,}/).map(block =>
    `<p class="n-text">${esc(block).replace(/\n/g, "<br>")}</p>`).join("");
}

function excerpt(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function groupBy(list, keyOf) {
  const m = new Map();
  list.forEach(item => {
    const k = keyOf(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  });
  return m;
}

/* ==========================================================================
   Console — terminal mode
   ========================================================================== */
const CONSOLE_HELP = [
  "note <text>        add a note (to the open head, else the inbox)",
  "head <title>       create a new head and open it",
  "ls [text]          list your heads, optionally filtered",
  "open <n|text>      open head number n from the last list, or by name",
  "inbox              show the inbox",
  "file <n> <head n>  move inbox note n into head n",
  "status <value>     set the open head's status",
  "detail             print the open head's details",
  "mode <name>        signal | terminal | paper",
  "theme <name>       dark | light",
  "export             download a backup",
  "pdf                everything as a printable document",
  "whoami             who is signed in",
  "clear              clear this console",
  "help               this list",
  "exit               sign out"
];

function cprint(text, cls) {
  const out = $("#consoleOut");
  const line = document.createElement("span");
  line.className = "l " + (cls || "");
  line.textContent = text;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

async function runCommand(raw) {
  const input = raw.trim();
  if (!input) return;
  cprint(input, "cmd");

  const sp = input.indexOf(" ");
  const cmd = (sp < 0 ? input : input.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? "" : input.slice(sp + 1).trim();

  switch (cmd) {
    case "help":
      CONSOLE_HELP.forEach(l => cprint(l, "dim"));
      break;

    case "note": {
      if (!rest) return cprint("note what? try: note fixed the gallery", "err");
      const headId = (S.view === "head" && S.current) ? S.current.head.head_id : "";
      addNoteOptimistic(rest, headId, "");
      cprint(headId ? `added to "${S.current.head.title}"` : "saved to inbox", "ok");
      break;
    }

    case "head": {
      if (!rest) return cprint("head what? try: head Aujjessa PDP rebuild", "err");
      $("#nhTitle").value = rest;
      $("#nhClient").value = ""; $("#nhLink").value = "";
      const h = await createHeadFromDialog();
      if (h) cprint(`created "${h.title}"`, "ok");
      break;
    }

    case "ls":
    case "heads": {
      S.filters.q = rest || "";
      renderHeads();
      const rows = S.lastList;
      if (!rows.length) { cprint("no heads match", "dim"); break; }
      rows.forEach((h, i) => cprint(
        `${String(i + 1).padStart(2)}. ${h.title}` +
        `${h.client ? "  [" + h.client + "]" : ""}` +
        `  ${h.status || "-"}  ${h.note_count} note${h.note_count === 1 ? "" : "s"}`));
      break;
    }

    case "open": {
      if (!rest) return cprint("open which? try: open 1", "err");
      let target = null;
      const n = parseInt(rest, 10);
      if (!isNaN(n) && S.lastList[n - 1]) target = S.lastList[n - 1];
      else target = S.heads.find(h => h.title.toLowerCase().includes(rest.toLowerCase()));
      if (!target) return cprint("no head matches " + rest, "err");
      await openHead(target.head_id);
      cprint(`opened "${target.title}"`, "ok");
      break;
    }

    case "inbox": {
      show("inbox");
      if (!S.inbox.length) { cprint("inbox is clear", "dim"); break; }
      S.inbox.forEach((n, i) => cprint(`${String(i + 1).padStart(2)}. ${n.text}`));
      break;
    }

    case "file": {
      const [a, b] = rest.split(/\s+/);
      const note = S.inbox[parseInt(a, 10) - 1];
      const head = S.lastList[parseInt(b, 10) - 1] || S.heads[parseInt(b, 10) - 1];
      if (!note || !head) return cprint("try: file 1 2   (inbox note 1 into head 2 from the last ls)", "err");
      moveFromInbox(note.note_id, head.head_id);
      cprint(`filed into "${head.title}"`, "ok");
      break;
    }

    case "status": {
      if (!S.current) return cprint("open a head first", "err");
      const match = S.lists.statuses.find(s => s.toLowerCase() === rest.toLowerCase());
      if (!match) return cprint("status must be one of: " + S.lists.statuses.join(", "), "err");
      patchHead({ status: match });
      cprint(`status is now ${match}`, "ok");
      break;
    }

    case "detail":
      if (!S.current) return cprint("open a head first", "err");
      cprint(S.current.head.details || "(no details yet)", S.current.head.details ? "" : "dim");
      break;

    case "mode": {
      if (!["signal", "terminal", "paper"].includes(rest)) return cprint("mode: signal | terminal | paper", "err");
      S.prefs.mode = rest; applySkin(); savePrefs();
      cprint("mode set to " + rest, "ok");
      break;
    }

    case "theme": {
      if (!["dark", "light"].includes(rest)) return cprint("theme: dark | light", "err");
      S.prefs.theme = rest; applySkin(); savePrefs();
      cprint("theme set to " + rest, "ok");
      break;
    }

    case "export": exportAll(); cprint("building export…", "dim"); break;
    case "pdf": exportPdf(); cprint("building the document…", "dim"); break;
    case "whoami": cprint(`${S.user.username}  (${S.user.name})`, ""); break;
    case "clear": $("#consoleOut").innerHTML = ""; break;
    case "exit": case "logout": signOut(); break;

    default:
      cprint(`unknown command: ${cmd}  —  type help`, "err");
  }
}

/* ==========================================================================
   Routing

   Every screen has its own address, so a head can be bookmarked, opened in a
   second tab, or sent to someone who has access to it. The slug is there to
   make the link readable; the id on the end is what actually resolves it, so
   renaming a head never breaks a link anyone already has.

       /                     the heads list
       /inbox                /shared
       /h/aujjessa-pdp-rebuild-H-MVKSAXE1-6CED5
       /n/N-MVKT5MPA-2148F
   ========================================================================== */
const ROUTE = {
  slug(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  },

  /** The address for a thing, or for a plain view. */
  pathFor(view, id, title) {
    if (view === "head" && id) {
      const s = ROUTE.slug(title);
      return "/h/" + (s ? s + "-" : "") + id;
    }
    if (view === "note" && id) return "/n/" + id;
    if (view === "inbox") return "/inbox";
    if (view === "shared") return "/shared";
    return "/";
  },

  /** What an address means. Ids are matched by shape, not by position. */
  parse(pathname) {
    const p = String(pathname || "/").replace(/\/+$/, "") || "/";
    if (p === "/" || p === "") return { view: "heads" };
    if (p === "/inbox") return { view: "inbox" };
    if (p === "/shared") return { view: "shared" };

    const head = p.match(/^\/h\/.*?(H-[A-Z0-9]+-[A-Z0-9]+)$/i);
    if (head) return { view: "head", id: head[1].toUpperCase() };

    const note = p.match(/^\/n\/.*?(N-[A-Z0-9]+-[A-Z0-9]+)$/i);
    if (note) return { view: "note", id: note[1].toUpperCase() };

    return { view: "heads", unknown: true };
  },

  /** Writes the address without reloading. Never pushes the same one twice. */
  set(view, id, title, replace) {
    const path = ROUTE.pathFor(view, id, title);
    if (path === location.pathname && !replace) return;
    try {
      history[replace ? "replaceState" : "pushState"]({ view, id }, "", path);
    } catch (e) { /* file:// and the like have no history to write */ }
  },

  /** Acts on whatever the address currently says. */
  apply() {
    const r = ROUTE.parse(location.pathname);
    if (r.view === "head" && r.id) { openHead(r.id, { fromUrl: true }); return; }
    if (r.view === "note" && r.id) { openNote(r.id, { fromUrl: true }); return; }
    show(r.view, { fromUrl: true });
    // An address nobody can act on — an old link, or a typo. The list is the
    // right place to land, but the bar should not keep claiming otherwise.
    if (r.unknown) { ROUTE.set("heads", "", "", true); }
  }
};

/* ==========================================================================
   Views and dialogs
   ========================================================================== */
function show(view, opts) {
  opts = opts || {};
  S.view = view;
  // Coming from the address bar, the address is already right; writing it
  // again would add a second entry for the same place.
  if (!opts.fromUrl && S.user) ROUTE.set(view);
  $$(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + view));

  applySplit();

  $$(".nav-item[data-nav]").forEach(b => b.classList.toggle("on", b.dataset.nav === view));
  document.body.classList.remove("rail-open");
  $("#surface").scrollTop = 0;
  if (view === "inbox") renderInbox();
  if (view === "heads") renderHeads();
  if (view === "shared") { renderShared(); loadShares(); }
  if (view !== "note") document.body.classList.remove("np-wide");
  // leaving a shared item behind means leaving read-only behind with it
  if (view === "heads" || view === "inbox" || view === "shared") {
    S.readonly = false;
    document.body.classList.remove("readonly");
  }
}

/* --------------------------------------------------------------------------
   Confirming before something goes away

   Archiving is recoverable in the sheet, but it does not feel that way in the
   app, and an accidental click on the wrong row is easy. Ask first; the Undo
   that follows is for the mistakes you make on purpose.
   -------------------------------------------------------------------------- */
let confirmResolve = null;

function confirmAction({ kind, title, body, note, yes, danger }) {
  $("#cfKind").textContent = kind || "Confirm";
  $("#cfTitle").textContent = title || "Are you sure?";
  $("#cfBody").textContent = body || "";
  const noteBox = $("#cfNote");
  noteBox.textContent = note || "";
  noteBox.classList.toggle("hide", !note);
  const btn = $("#cfYes");
  btn.textContent = yes || "Yes, do it";
  btn.classList.toggle("danger-pri", danger !== false);

  openDialog("#cfScrim");
  setTimeout(() => $("#cfNo").focus(), 30);

  return new Promise(resolve => { confirmResolve = resolve; });
}

function settleConfirm(answer) {
  closeDialog("#cfScrim");
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(answer);
}

/**
 * In the split layout the heads list stays beside an open head instead of
 * being replaced by it, so you keep your place while reading one. Below
 * 1000px there is no room for two columns and it behaves like classic.
 */
function applySplit() {
  const inner = $(".inner");
  if (!inner) return;
  const on = S.prefs.layout === "split" && S.view === "head" && window.innerWidth >= 900;
  inner.classList.toggle("split-on", on);
  if (on) $("#view-heads").classList.add("on");
  else if (S.view !== "heads") $("#view-heads").classList.remove("on");
}

function openDialog(sel, focusSel) {
  $(sel).classList.add("on");
  if (focusSel) setTimeout(() => $(focusSel).focus(), 30);
}
function closeDialog(sel) {
  $(sel).classList.remove("on");
  const err = $(".err", $(sel));
  if (err) err.classList.remove("on");
}
const anyDialogOpen = () => $$(".scrim.on").length > 0;

/* ==========================================================================
   Preferences
   ========================================================================== */
/**
 * Every appearance control calls this. It paints at once and saves shortly
 * after, so there is no such thing as an unsaved look that a refresh can undo.
 */
let prefsTimer = null;

function touchPrefs() {
  S.prefsDirty = true;
  applySkin();
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePrefs, 700);
}

function savePrefs() {
  clearTimeout(prefsTimer);
  const problem = cssProblem(S.prefs.custom_css);
  if (problem) { showErr("#cssErr", problem); return false; }
  clearErr("#cssErr");

  S.prefsSaving++;
  S.prefsDirty = false;
  const settle = () => { S.prefsSaving = Math.max(0, S.prefsSaving - 1); };

  API.enqueue({
    action: "savePrefs",
    payload: { prefs: Object.assign({}, S.prefs) },
    done: settle,
    fail: () => { settle(); S.prefsDirty = true; }
  });
  return true;
}

/** True while the server's copy must not be allowed to win. */
function prefsBusy() {
  return S.prefsDirty || S.prefsSaving > 0 || $("#stScrim").classList.contains("on");
}

function wireSettings() {
  $$("[data-mode-pick]").forEach(b => on(b, "click", () => {
    S.prefs.mode = b.dataset.modePick;
    touchPrefs();
  }));

  on($("#stTheme"), "click", () => {
    S.prefs.theme = S.prefs.theme === "dark" ? "light" : "dark";
    touchPrefs();
  });

  // Every option paints at once and saves itself a moment later.
  const bind = (sel, key) => on($(sel), "change", e => {
    S.prefs[key] = e.target.value;
    touchPrefs();
  });
  bind("#stLayout", "layout");
  bind("#stStyle", "style");
  bind("#stAccent", "accent");
  bind("#stFont", "font");
  bind("#stSize", "fsize");
  bind("#stDensity", "density");
  on($("#stAnim"), "change", e => {
    S.prefs.anim = e.target.checked ? "on" : "off";
    touchPrefs();
  });

  // Preview as they type, but never store something the server would refuse.
  on($("#cssIn"), "input", () => {
    const css = $("#cssIn").value;
    const problem = cssProblem(css);
    if (problem) { showErr("#cssErr", problem); return; }
    clearErr("#cssErr");
    S.prefs.custom_css = css;
    applyCustomCss(css);
    S.prefsDirty = true;
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(savePrefs, 1200);   // longer: they are still typing
  });

  on($("#cssExample"), "click", () => {
    $("#cssIn").value = CSS_EXAMPLE;
    $("#cssIn").dispatchEvent(new Event("input"));
  });
  on($("#cssClear"), "click", () => {
    $("#cssIn").value = "";
    $("#cssIn").dispatchEvent(new Event("input"));
  });

  on($("#stSave"), "click", () => {
    if (savePrefs()) { closeDialog("#stScrim"); }
  });
}

/* ==========================================================================
   Wiring
   ========================================================================== */
function wire() {
  $$("[data-nav]").forEach(b => on(b, "click", () => show(b.dataset.nav)));
  on($("#railToggle"), "click", () => document.body.classList.toggle("rail-open"));

  /* collapse the sidebar to its icons — a per-device choice, so it is kept
     here rather than on the account */
  const setRail = min => {
    document.body.classList.toggle("rail-min", min);
    local("railMin", min);
  };
  on($("#railCollapse"), "click", () => {
    if (innerWidth <= 900) { document.body.classList.toggle("rail-open"); return; }
    setRail(!document.body.classList.contains("rail-min"));
  });

  on($("#search"), "input", e => onSearchInput(e.target.value));
  on($("#search"), "keydown", e => {
    const open = $("#sugg").classList.contains("on");
    if (e.key === "ArrowDown") { e.preventDefault(); if (open) moveSuggestion(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (open) moveSuggestion(-1); }
    else if (e.key === "Enter") {
      const cur = $(".sugg-item.cur");
      if (cur) { e.preventDefault(); pickSuggestion(cur); }
    } else if (e.key === "Escape") {
      if (open) { e.stopPropagation(); hideSuggestions(); }
      else { e.target.value = ""; onSearchInput(""); }
    }
  });
  on($("#search"), "blur", () => setTimeout(hideSuggestions, 120));
  on($("#search"), "focus", e => { if (e.target.value.trim().length >= 2) onSearchInput(e.target.value); });
  on($("#fClient"), "change", e => { S.filters.client = e.target.value; renderHeads(); });
  on($("#fType"), "change", e => { S.filters.type = e.target.value; renderHeads(); });
  on($("#fStatus"), "change", e => { S.filters.status = e.target.value; renderHeads(); });
  on($("#fFlag"), "change", e => { S.filters.flag = e.target.checked; renderHeads(); });
  on($("#fArch"), "change", e => { S.filters.archived = e.target.checked; reload(); });

  on($("#qaOpen"), "click", openQuickAdd);
  on($("#qaSave"), "click", quickSave);
  on($("#qaText"), "keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); quickSave(); } });

  on($("#btnNewHead"), "click", () => {
    fillParentPicker($("#nhParent"), "", "");
    openDialog("#nhScrim", "#nhTitle");
  });
  on($("#nhSave"), "click", createHeadFromDialog);
  on($("#nhTitle"), "keydown", e => { if (e.key === "Enter") { e.preventDefault(); createHeadFromDialog(); } });

  $$(".scrim").forEach(sc => {
    on(sc, "mousedown", e => {
      if (e.target !== sc) return;
      if (sc.id === "cfScrim") { settleConfirm(false); return; }   // click-away = no
      closeDialog("#" + sc.id);
    });
    $$("[data-close]", sc).forEach(b => on(b, "click", () => closeDialog("#" + sc.id)));
  });

  on($("#cfYes"), "click", () => settleConfirm(true));
  on($("#cfNo"), "click", () => settleConfirm(false));

  on($("#hNoteAdd"), "click", addNoteHere);
  on($("#hNoteText"), "keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNoteHere(); } });

  /* a half-typed note counts as unsaved work too */
  on($("#hNoteText"), "input", e =>
    markEditing("composer", e.target.value.trim().length > 0));
  on($("#qaText"), "input", e =>
    markEditing("quickadd", e.target.value.trim().length > 0));

  /* paste or drop a picture straight into the note you are writing */
  on($("#hNoteText"), "paste", e => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.some(f => /^image\//.test(f.type))) return;
    e.preventDefault();
    queueShots(files);
  });
  ["dragover", "drop"].forEach(ev => on($(".composer"), ev, e => {
    e.preventDefault();
    if (ev === "drop") queueShots(e.dataTransfer?.files || []);
  }));

  /* full-size image viewer */
  on($("#lightbox"), "click", () => $("#lightbox").classList.remove("on"));
  on($("#hTitle"), "change", e => {
    const v = e.target.value.trim();
    const bad = titleProblem(v);
    if (bad) {
      toast(bad, "bad");
      e.target.value = S.current.head.title;      // put the good one back
      markEditing("head-title", false);
      return;
    }
    markEditing("head-title", false);
    patchHead({ title: v });
  });
  on($("#hClient"), "change", e => patchHead({ client: e.target.value }));
  on($("#hType"), "change", e => patchHead({ type: e.target.value }));
  on($("#hStatus"), "change", e => patchHead({ status: e.target.value }));
  on($("#hLink"), "change", e => {
    const v = e.target.value.trim();
    const bad = linkProblem(v);
    flagField("#hLink", bad);
    if (bad) { toast(bad, "bad"); return; }
    markEditing("head-link", false);
    patchHead({ link: v });
  });
  on($("#hFlag"), "change", e => patchHead({ needs_detail: e.target.checked ? "Yes" : "No" }));
  on($("#hParent"), "change", async e => {
    const to = e.target.value;
    try {
      await API.call("updateHead", { head_id: S.current.head.head_id, patch: { parent_id: to } });
      toast(to ? "Moved under " + (headRow(to) || {}).title : "Moved to the top level.", "good");
      await reload();
      openHead(S.current.head.head_id);
    } catch (err) {
      toast(err.message, "bad");
      e.target.value = S.current.head.parent_id || "";
    }
  });
  on($("#addSub"), "click", () => {
    if (!S.current) return;
    // pre-pick the head you came from, which is nearly always what you meant
    fillParentPicker($("#nhParent"), "", S.current.head.head_id);
    openDialog("#nhScrim", "#nhTitle");
  });
  /* the long details box is the easiest place to lose work, so it says so */
  on($("#hDetails"), "input", () => markEditing("head-details", true));
  on($("#hLink"), "input", () => markEditing("head-link", true));
  on($("#hTitle"), "input", () => markEditing("head-title", true));

  /* the note page */
  on($("#nvSave"), "click", saveNotePage);
  on($("#nvText"), "input", () => markEditing("nv-text", true));
  on($("#nvDetails"), "input", () => markEditing("nv-details", true));
  on($("#nvLink"), "input", () => markEditing("nv-link", true));
  on($("#nvType"), "change", saveNotePage);
  on($("#nvFlag"), "change", saveNotePage);
  on($("#nvWide"), "click", () => {
    document.body.classList.toggle("np-wide");
    $("#nvWide").textContent = document.body.classList.contains("np-wide") ? "Narrow" : "Wide";
  });
  on($("#nvExpand"), "click", () => {
    const ta = $("#nvDetails");
    const before = ta.value;
    ta.value = withHeadings(before, $("#nvType").value);
    if (ta.value === before) toast("Those headings are already there.", "");
    markEditing("nv-details", true);
    ta.focus();
  });
  on($("#nvLinkAdd"), "click", openLinkPicker);
  on($("#lnSearch"), "input", e => {
    clearTimeout(linkTimer);
    const q = e.target.value;
    linkTimer = setTimeout(() => searchForLink(q), 350);
  });

  on($("#hExpand"), "click", () => {
    const ta = $("#hDetails");
    const before = ta.value;
    ta.value = withHeadings(before, S.current.head.type);
    if (ta.value === before) toast("Those headings are already in the details.", "");
    markEditing("head-details", true);
    ta.focus();
  });
  on($("#hDetailSave"), "click", () => {
    patchHead({ details: $("#hDetails").value }, false);
    markEditing("head-details", false);
    toast("Details saved.", "good");
  });
  on($("#hArchive"), "click", async () => {
    const h = S.current.head;
    if (h.archived === "Yes") { patchHead({ archived: "No" }); return; }

    const kids = kidCount(h.head_id);
    const ok = await confirmAction({
      kind: "Archive head",
      title: `Archive “${h.title}”?`,
      body: `${h.note_count || 0} note${h.note_count === 1 ? "" : "s"} go with it.` +
            (kids ? ` It also still has ${kids} sub-head${kids === 1 ? "" : "s"}, which will stop this.` : ""),
      note: "Nothing is deleted — the row stays in the sheet. Tick “Include archived” on the Heads list to find it again.",
      yes: "Archive it"
    });
    if (!ok) return;

    const id = h.head_id;
    const snapshot = Object.assign({}, h);
    patchHead({ archived: "Yes" }, false);
    if (!S.filters.archived) S.heads = S.heads.filter(x => x.head_id !== id);
    renderHeads(); paintStats(); show("heads");

    toast("Head archived.", "good", {
      label: "Undo",
      run: () => {
        snapshot.archived = "No";
        if (!S.heads.some(x => x.head_id === id)) S.heads.unshift(snapshot);
        renderHeads(); paintStats();
        API.enqueue({ action: "updateHead", payload: { head_id: id, patch: { archived: "No" } } });
        toast("Put back.", "good");
      }
    });
  });

  on($("#btnRefresh"), "click", () => reload({ loud: true }));

  /* the export document */
  on($("#btnPdf"), "click", exportPdf);
  on($("#paperPrint"), "click", () => window.print());
  on($("#paperClose"), "click", closePaper);

  /* sharing */
  on($("#shareOpen"), "click", () => {
    if (S.current) openShare("head", S.current.head.head_id, S.current.head.title);
  });
  on($("#shGo"), "click", doShare);
  on($("#sharedBack"), "click", () => { S.sharedPerson = null; renderShared(); });
  on($("#sharedOut"), "click", () => {
    S.sharedPerson = S.sharedPerson === "__outgoing__" ? null : "__outgoing__";
    renderShared();
  });
  on($("#btnSettings"), "click", () => openDialog("#stScrim"));
  on($("#btnSignOut"), "click", signOut);
  on($("#syncRetry"), "click", () => API.retry());

  on($("#consoleIn"), "keydown", e => {
    if (e.key !== "Enter") return;
    const v = e.target.value;
    e.target.value = "";
    runCommand(v);
  });

  /* the browser's own Back and Forward */
  on(window, "popstate", () => { if (S.user) ROUTE.apply(); });

  on(document, "keydown", e => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if (e.key === "Escape" && !$("#paper").classList.contains("hide")) {
      closePaper();
      return;
    }
    if (e.key === "Escape" && $("#lightbox").classList.contains("on")) {
      $("#lightbox").classList.remove("on");
      return;
    }
    if (e.key === "Escape" && $("#cfScrim").classList.contains("on")) {
      settleConfirm(false);               // Escape must answer, not just close
      return;
    }
    if (e.key === "Enter" && $("#cfScrim").classList.contains("on")) {
      e.preventDefault();
      settleConfirm(true);
      return;
    }
    if (e.key === "Escape" && anyDialogOpen()) {
      $$(".scrim.on").forEach(sc => closeDialog("#" + sc.id));
      return;
    }
    if ($("#shell").classList.contains("hide")) return;   // gate is up
    if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); openQuickAdd(); return; }
    if (mod && (e.key === "j" || e.key === "J")) { e.preventDefault(); openDialog("#nhScrim", "#nhTitle"); return; }
    if (mod && e.key === ",") { e.preventDefault(); openDialog("#stScrim"); return; }
    if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); $("#railCollapse").click(); return; }
    if (e.key === "/" && !typing && !anyDialogOpen()) { e.preventDefault(); show("heads"); $("#search").focus(); }
  });

  API.onChange((st, ev) => {
    if (ev === "signout") return;
    const label = { saving: st.detail, saved: "Saved", failed: st.detail, idle: "Ready" }[st.status] || "";
    sync(st.status, label);
  });
}

/* ==========================================================================
   Load
   ========================================================================== */
/**
 * opts.loud        show "Reading the sheet" (the Refresh button)
 * opts.background  no spinner, no error toast — a quiet catch-up
 */
async function reload(opts) {
  opts = opts || {};
  const loud = opts.loud;
  if (loud) sync("saving", "Reading the sheet");
  try {
    const data = await API.call("bootstrap");
    S.user = data.user;
    // Never let a refresh overwrite a look the user is in the middle of
    // choosing, or one whose save has not landed yet.
    if (!prefsBusy()) { S.prefs = Object.assign(S.prefs, data.prefs || {}); }
    S.lists = data.lists;
    S.inbox = data.inbox;
    S.heads = data.heads;
    S.needsDetail = (data.stats && data.stats.needs_detail) || 0;

    if (S.filters.archived) {
      // bootstrap returns live heads only; archived ones need an explicit ask
      const all = await API.call("getHeads", { include_archived: true });
      S.heads = all.heads;
    }

    applySkin();
    refreshLists();
    refreshHeadPickers();
    renderHeads();
    renderInbox();
    paintStats();
    saveCache();
    S.lastSync = Date.now();
    loadShares({ quiet: S.view !== "shared" });   // keeps the sidebar count true

    if (loud) sync("saved", "Up to date");
    else if (opts.background) sync("saved", "Up to date");

    if (S.current && S.view === "head") openHead(S.current.head.head_id, { quiet: true });
  } catch (e) {
    if (e.code === "auth") { signOut(); return; }
    // A quiet catch-up that fails leaves the cached screen alone and says so
    // in the status pill. It must not wipe the page or throw a toast.
    if (opts.background) { sync("failed", "Could not refresh"); return; }
    sync("failed", e.message);
    toast(e.message, "bad");
    $("#headsRows").innerHTML = emptyState("⚠", "Could not read the sheet", e.message);
  }
}

/* --------------------------------------------------------------------------
   Keeping up to date without a page reload
   -------------------------------------------------------------------------- */
const STALE_AFTER = 45000;     // coming back to the tab
const POLL_EVERY  = 90000;     // while the tab is in front

/**
 * True while the user is part-way through writing something. Covers both the
 * field they are in right now and anything typed but not yet saved, so a note
 * you opened, edited and left alone for a minute is still protected.
 */
function isEditing() {
  // Explicit tracking only. "The cursor is in a text box" is not enough —
  // the cursor lives in the note composer most of the time, and that would
  // block every refresh forever. Each field that can hold unsaved work marks
  // itself here on input and clears itself when saved, closed or emptied.
  return S.editing.size > 0;
}

/** Refuses to run while writes are in flight, or while anything is being typed. */
function catchUp(force) {
  if (!S.user || document.hidden) return;
  if (API.pending() || API.state.stuck) return;
  if (isEditing()) return;
  if (!force && Date.now() - (S.lastSync || 0) < STALE_AFTER) return;
  reload({ background: true });
}

/** Call when a field starts/stops holding unsaved text. */
function markEditing(key, dirty) {
  if (dirty) S.editing.add(key);
  else S.editing.delete(key);
}

function wireAutoRefresh() {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) catchUp();
  });
  window.addEventListener("focus", () => catchUp());
  setInterval(() => catchUp(true), POLL_EVERY);

  // When the write queue finally empties, pull the authoritative copy back so
  // server-side changes (updated_at, note ids) replace the optimistic ones.
  let settle = null;
  API.onChange(st => {
    if (st.status !== "saved" || API.pending()) return;
    clearTimeout(settle);
    settle = setTimeout(() => catchUp(true), 1500);
  });
}

async function boot() {
  // paint the remembered skin before anything is drawn, so there is no flash
  const skin = local("skin");
  if (skin) { S.prefs = Object.assign(S.prefs, skin); applySkin(); }
  if (local("railMin")) document.body.classList.add("rail-min");
  S.mru = local("mru") || [];

  wireGate();
  wire();
  wireSettings();
  wireAutoRefresh();

  const done = () => {
    $("#boot").classList.add("gone");
    setTimeout(() => $("#boot").remove(), 400);
  };

  // Only ever true if config.js was shipped without a backendUrl — which is a
  // deployment mistake, not something a visitor can fix, so say exactly that.
  if (!API.configured()) {
    showStep("stepLogin");
    $("#liGo").disabled = true;
    showErr("#cfgErr", "This site is not connected to a backend. " +
                       "Whoever deployed it needs to put the Apps Script /exec URL in config.js.");
    done();
    return;
  }
  if (!API.signedIn()) { showStep("stepLogin"); done(); return; }

  $("#bootMsg").textContent = "Reading the sheet";
  try {
    await enterApp({ user: API.user() });
    CONSOLE_HELP.slice(0, 3).forEach(l => cprint(l, "dim"));
    cprint("type help for the full list", "dim");
  } catch (e) {
    showStep("stepLogin");
  }
  done();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
