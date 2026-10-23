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
  prefs: { mode: "signal", theme: "dark", custom_css: "" },
  lists: { clients: [], types: [], statuses: [] },
  heads: [],
  inbox: [],
  current: null,
  view: "heads",
  // needs_detail spans heads AND every note, including ones not loaded here,
  // so the count comes from the server and is nudged as things change.
  needsDetail: 0,
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
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.innerHTML = `<span class="dot"></span><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
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
function applySkin() {
  document.documentElement.dataset.mode = S.prefs.mode || "signal";
  document.documentElement.dataset.theme = S.prefs.theme || "dark";
  applyCustomCss(S.prefs.custom_css || "");
  const t = $("#stTheme");
  if (t) t.textContent = S.prefs.theme === "dark" ? "Dark" : "Light";
  $$("[data-mode-pick]").forEach(b => b.classList.toggle("on", b.dataset.modePick === S.prefs.mode));
  const cssIn = $("#cssIn");
  if (cssIn && cssIn.value !== (S.prefs.custom_css || "")) cssIn.value = S.prefs.custom_css || "";
  // keep a copy on the device so the next load paints correctly before login
  local("skin", { mode: S.prefs.mode, theme: S.prefs.theme, custom_css: S.prefs.custom_css });
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
async function enterApp(res) {
  if (res && res.user) S.user = res.user;
  if (res && res.prefs) S.prefs = Object.assign(S.prefs, res.prefs);
  applySkin();
  $("#gate").classList.add("hide");
  $("#shell").classList.remove("hide");
  await reload();
  sync("saved", "Ready");
}

function signOut() {
  API.signOut();
  S.user = null; S.heads = []; S.inbox = []; S.current = null;
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
  $("#clientList").innerHTML = L.clients.map(c => `<option value="${esc(c)}"></option>`).join("");
}

function refreshHeadPickers() {
  const ordered = S.heads.slice().sort((a, b) => {
    const ia = S.mru.indexOf(a.head_id), ib = S.mru.indexOf(b.head_id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  let html = `<option value="">Inbox — file it later</option>`;
  ordered.forEach(h => {
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

function emptyState(mark, title, body, action) {
  return `<div class="empty"><div class="mark">${mark}</div><h3>${esc(title)}</h3>
          <p>${esc(body)}</p>${action || ""}</div>`;
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

  box.innerHTML = rows.map(h => `
    <button class="trow${h.archived === "Yes" ? " is-arch" : ""}" data-head="${esc(h.head_id)}">
      <div>
        <div class="title">${esc(h.title)}</div>
        <div class="sub">${h.link ? "↗ link · " : ""}created ${esc(dateOf(h.created_at))}${
          h.needs_detail === "Yes" ? " · needs detail" : ""}${
          h.archived === "Yes" ? " · archived" : ""}</div>
      </div>
      <div>${h.client ? `<span class="chip client">${esc(h.client)}</span>` : `<span class="faint">—</span>`}</div>
      <div class="c-type">${h.type ? `<span class="chip">${esc(h.type)}</span>` : `<span class="faint">—</span>`}</div>
      <div>${statusChip(h.status)}</div>
      <div class="r num c-notes">${h.note_count}</div>
      <div class="r c-when">${esc(ago(h.updated_at || h.created_at))}</div>
    </button>`).join("");

  $$("#headsRows .trow").forEach(el => on(el, "click", () => openHead(el.dataset.head)));
}

/* ==========================================================================
   Head page
   ========================================================================== */
async function openHead(headId) {
  show("head");
  $("#crumbTitle").textContent = "loading…";
  $("#hNotes").innerHTML = `<div class="skeleton"><i></i><i></i><i></i></div>`;
  bumpMru(headId);
  try {
    const res = await API.call("getHead", { head_id: headId });
    S.current = { head: res.head, notes: res.notes };
    paintHead();
  } catch (e) {
    toast(e.message, "bad");
    show("heads");
  }
}

function headRow(id) { return S.heads.find(h => h.head_id === id) || null; }

function paintHead() {
  const h = S.current.head;
  $("#crumbTitle").textContent = h.title;
  $("#hTitle").value = h.title;
  $("#hId").textContent = h.head_id;
  $("#hCreated").textContent = fullOf(h.created_at);
  $("#hUpdated").textContent = fullOf(h.updated_at);
  $("#hLink").value = h.link || "";
  $("#hDetails").value = h.details || "";
  $("#hFlag").checked = h.needs_detail === "Yes";
  $("#hArchive").textContent = h.archived === "Yes" ? "Restore this head" : "Archive this head";

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

function renderNotes() {
  const notes = S.current.notes;
  $("#hNoteCount").textContent = notes.length + (notes.length === 1 ? " entry" : " entries");
  const box = $("#hNotes");

  if (!notes.length) {
    box.innerHTML = emptyState("○", "No notes yet",
      "Write the first line above. Date and time are added for you.");
    return;
  }

  let html = "", lastDay = null;
  notes.slice().reverse().forEach(n => {
    const key = dayKey(n.created_at);
    if (key !== lastDay) {
      lastDay = key;
      html += `<div class="tl-day"><span class="lbl">${esc(dayLabel(n.created_at))}</span><span class="rule"></span></div>`;
    }
    html += noteHtml(n);
  });
  box.innerHTML = html;
  wireNotes(box);
}

function noteHtml(n) {
  const state = n._pending ? " pending" : n._failed ? " failed" : "";
  const chips = [];
  if (n.type) chips.push(`<span class="chip">${esc(n.type)}</span>`);
  if (n.needs_detail === "Yes") chips.push(`<span class="chip flag">Needs detail</span>`);
  if (n.link) chips.push(`<a class="chip" href="${esc(n.link)}" target="_blank" rel="noopener">link ↗</a>`);
  if (n.details) chips.push(`<span class="chip">has details</span>`);
  if (n._pending) chips.push(`<span class="chip">saving…</span>`);
  if (n._failed) chips.push(`<span class="chip" style="color:var(--red)">not saved</span>`);

  return `
  <div class="note${state}" data-note="${esc(n.note_id)}">
    <div class="note-top">
      <div class="note-text">${esc(n.text)}</div>
      <div class="note-time num">${esc(clockOf(n.created_at))}</div>
      <div class="note-acts">
        <button class="icon-btn" data-act="expand" title="Open full details">⤢</button>
        <button class="icon-btn" data-act="archive" title="Archive this note">✕</button>
      </div>
    </div>
    ${chips.length ? `<div class="note-chips">${chips.join("")}</div>` : ""}
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
      if (act === "expand") { el.classList.toggle("open"); b.classList.toggle("on"); }
      if (act === "archive") archiveNoteUi(id);
      if (act === "headings") {
        const ta = $('[data-f="details"]', el);
        ta.value = withHeadings(ta.value, typeSel.value || n.type);
        ta.focus();
      }
      if (act === "save") saveNoteFromUi(el, id);
    }));
  });
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

  flagDelta(n.needs_detail, patch.needs_detail);
  Object.assign(n, patch);
  if (S.current) renderNotes();
  renderInbox();
  paintStats();
  API.enqueue({ action: "updateNote", payload: { note_id: id, patch } });
}

function archiveNoteUi(id) {
  if (S.current) {
    S.current.notes = S.current.notes.filter(n => n.note_id !== id);
    renderNotes();
  }
  S.inbox = S.inbox.filter(n => n.note_id !== id);
  renderInbox();
  paintStats();
  API.enqueue({ action: "archiveNote", payload: { note_id: id } });
  toast("Note archived. The row stays in the sheet.", "good");
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
  if ("needs_detail" in patch) flagDelta(h.needs_detail, patch.needs_detail);
  Object.assign(h, patch);
  const row = headRow(h.head_id);
  if (row) Object.assign(row, patch);
  if (repaint !== false) { paintHead(); renderHeads(); paintStats(); }
  API.enqueue({ action: "updateHead", payload: { head_id: h.head_id, patch } });
}

function addNoteHere() {
  const ta = $("#hNoteText");
  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  const h = S.current.head;
  ta.value = "";
  addNoteOptimistic(text, h.head_id, "");
}

/** Draws the note at once, then sends it. The queue owns the retry. */
function addNoteOptimistic(text, headId, type) {
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
      const saved = res.note;
      if (S.current) {
        const i = S.current.notes.indexOf(temp);
        if (i > -1) { S.current.notes[i] = saved; renderNotes(); }
      }
      const j = S.inbox.indexOf(temp);
      if (j > -1) { S.inbox[j] = saved; renderInbox(); }
    },
    fail: () => { temp._pending = false; temp._failed = true; redraw(); }
  });
  return temp;
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
  });
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
  toast(headId ? "Note added." : "Note saved to Inbox.", "good");
}

async function createHeadFromDialog() {
  const title = $("#nhTitle").value.trim();
  if (!title) { showErr("#nhErr", "A head needs a title."); $("#nhTitle").focus(); return; }
  clearErr("#nhErr");

  const data = {
    title,
    client: $("#nhClient").value.trim(),
    type: $("#nhType").value,
    status: $("#nhStatus").value,
    link: $("#nhLink").value.trim()
  };
  closeDialog("#nhScrim");
  sync("saving", "Creating head");

  try {
    const res = await API.call("createHead", { data });
    const head = res.head;
    S.heads.unshift(head);
    if (head.client && !S.lists.clients.includes(head.client)) {
      S.lists.clients.push(head.client);
      S.lists.clients.sort();
      refreshLists();
    }
    refreshHeadPickers(); renderHeads(); paintStats();
    sync("saved", "Saved");
    ["#nhTitle", "#nhClient", "#nhLink"].forEach(s => { $(s).value = ""; });
    openHead(head.head_id);
    return head;
  } catch (e) {
    sync("failed", e.message);
    toast(e.message, "bad");
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
    case "whoami": cprint(`${S.user.username}  (${S.user.name})`, ""); break;
    case "clear": $("#consoleOut").innerHTML = ""; break;
    case "exit": case "logout": signOut(); break;

    default:
      cprint(`unknown command: ${cmd}  —  type help`, "err");
  }
}

/* ==========================================================================
   Views and dialogs
   ========================================================================== */
function show(view) {
  S.view = view;
  $$(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + view));
  $$(".nav-item[data-nav]").forEach(b => b.classList.toggle("on", b.dataset.nav === view));
  document.body.classList.remove("rail-open");
  $("#surface").scrollTop = 0;
  if (view === "inbox") renderInbox();
  if (view === "heads") renderHeads();
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
function savePrefs() {
  const problem = cssProblem(S.prefs.custom_css);
  if (problem) { showErr("#cssErr", problem); return false; }
  clearErr("#cssErr");
  API.enqueue({ action: "savePrefs", payload: { prefs: S.prefs } });
  return true;
}

function wireSettings() {
  $$("[data-mode-pick]").forEach(b => on(b, "click", () => {
    S.prefs.mode = b.dataset.modePick;
    applySkin();
  }));

  on($("#stTheme"), "click", () => {
    S.prefs.theme = S.prefs.theme === "dark" ? "light" : "dark";
    applySkin();
  });

  // Preview as they type, but never store something the server would refuse.
  on($("#cssIn"), "input", () => {
    const css = $("#cssIn").value;
    const problem = cssProblem(css);
    if (problem) { showErr("#cssErr", problem); return; }
    clearErr("#cssErr");
    S.prefs.custom_css = css;
    applyCustomCss(css);
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
    if (savePrefs()) { toast("Appearance saved to your account.", "good"); closeDialog("#stScrim"); }
  });
}

/* ==========================================================================
   Wiring
   ========================================================================== */
function wire() {
  $$("[data-nav]").forEach(b => on(b, "click", () => show(b.dataset.nav)));
  on($("#railToggle"), "click", () => document.body.classList.toggle("rail-open"));

  on($("#search"), "input", e => { S.filters.q = e.target.value; renderHeads(); });
  on($("#fClient"), "change", e => { S.filters.client = e.target.value; renderHeads(); });
  on($("#fType"), "change", e => { S.filters.type = e.target.value; renderHeads(); });
  on($("#fStatus"), "change", e => { S.filters.status = e.target.value; renderHeads(); });
  on($("#fFlag"), "change", e => { S.filters.flag = e.target.checked; renderHeads(); });
  on($("#fArch"), "change", e => { S.filters.archived = e.target.checked; reload(); });

  on($("#qaOpen"), "click", openQuickAdd);
  on($("#qaSave"), "click", quickSave);
  on($("#qaText"), "keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); quickSave(); } });

  on($("#btnNewHead"), "click", () => openDialog("#nhScrim", "#nhTitle"));
  on($("#nhSave"), "click", createHeadFromDialog);
  on($("#nhTitle"), "keydown", e => { if (e.key === "Enter") { e.preventDefault(); createHeadFromDialog(); } });

  $$(".scrim").forEach(sc => {
    on(sc, "mousedown", e => { if (e.target === sc) closeDialog("#" + sc.id); });
    $$("[data-close]", sc).forEach(b => on(b, "click", () => closeDialog("#" + sc.id)));
  });

  on($("#hNoteAdd"), "click", addNoteHere);
  on($("#hNoteText"), "keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNoteHere(); } });
  on($("#hTitle"), "change", e => {
    const v = e.target.value.trim();
    if (!v) { e.target.value = S.current.head.title; return; }
    patchHead({ title: v });
  });
  on($("#hClient"), "change", e => patchHead({ client: e.target.value }));
  on($("#hType"), "change", e => patchHead({ type: e.target.value }));
  on($("#hStatus"), "change", e => patchHead({ status: e.target.value }));
  on($("#hLink"), "change", e => patchHead({ link: e.target.value.trim() }));
  on($("#hFlag"), "change", e => patchHead({ needs_detail: e.target.checked ? "Yes" : "No" }));
  on($("#hExpand"), "click", () => {
    const ta = $("#hDetails");
    const before = ta.value;
    ta.value = withHeadings(before, S.current.head.type);
    if (ta.value === before) toast("Those headings are already in the details.", "");
    ta.focus();
  });
  on($("#hDetailSave"), "click", () => {
    patchHead({ details: $("#hDetails").value }, false);
    toast("Details saved.", "good");
  });
  on($("#hArchive"), "click", () => {
    const h = S.current.head;
    if (h.archived === "Yes") { patchHead({ archived: "No" }); return; }
    patchHead({ archived: "Yes" }, false);
    if (!S.filters.archived) S.heads = S.heads.filter(x => x.head_id !== h.head_id);
    renderHeads(); paintStats(); show("heads");
    toast("Head archived. Nothing was deleted from the sheet.", "good");
  });

  on($("#btnExport"), "click", exportAll);
  on($("#btnRefresh"), "click", () => reload(true));
  on($("#btnSettings"), "click", () => openDialog("#stScrim"));
  on($("#btnSignOut"), "click", signOut);
  on($("#syncRetry"), "click", () => API.retry());

  on($("#consoleIn"), "keydown", e => {
    if (e.key !== "Enter") return;
    const v = e.target.value;
    e.target.value = "";
    runCommand(v);
  });

  on(document, "keydown", e => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if (e.key === "Escape" && anyDialogOpen()) {
      $$(".scrim.on").forEach(sc => closeDialog("#" + sc.id));
      return;
    }
    if ($("#shell").classList.contains("hide")) return;   // gate is up
    if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); openQuickAdd(); return; }
    if (mod && (e.key === "j" || e.key === "J")) { e.preventDefault(); openDialog("#nhScrim", "#nhTitle"); return; }
    if (mod && e.key === ",") { e.preventDefault(); openDialog("#stScrim"); return; }
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
async function reload(loud) {
  if (loud) sync("saving", "Reading the sheet");
  try {
    const data = await API.call("bootstrap");
    S.user = data.user;
    S.prefs = Object.assign(S.prefs, data.prefs || {});
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
    if (loud) sync("saved", "Up to date");
    if (S.current && S.view === "head") openHead(S.current.head.head_id);
  } catch (e) {
    if (e.code === "auth") { signOut(); return; }
    sync("failed", e.message);
    toast(e.message, "bad");
    $("#headsRows").innerHTML = emptyState("⚠", "Could not read the sheet", e.message);
  }
}

async function boot() {
  // paint the remembered skin before anything is drawn, so there is no flash
  const skin = local("skin");
  if (skin) { S.prefs = Object.assign(S.prefs, skin); applySkin(); }
  S.mru = local("mru") || [];

  wireGate();
  wire();
  wireSettings();

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
