# Documentrism

Log your work in seconds, add the detail later. A **Head** is one piece of work;
**Notes** are the lines you add to it as you go, each stamped with the time. A
note with no Head lands in the **Inbox** to be filed later.

The rule the whole app is built around: **a quick note takes under 30 seconds,
and only the text is required.**

Multi-user. Everyone signs up themselves, and each person sees only their own
work. Static front end on Vercel, Google Sheet behind it.

**Setting it up? Read [SETUP.md](SETUP.md).** This file is the technical side.

---

## Shape

```
browser (documentrism.vercel.app)
   │   POST {action, token, …}      no custom headers, so no CORS preflight
   ▼
Apps Script web app  (deployed "Anyone", runs as the sheet's owner)
   │
   ▼
one Google Sheet — Users · Sessions · Prefs · Heads · Notes · Lists · Report
```

The backend URL is **not** baked into the front end. Each person pastes their
deployment URL on first run and it lives in that device's `localStorage`. That
is what lets the site be public while the data stays private to one sheet.

| File | What it is |
| --- | --- |
| `apps-script.gs` | The entire backend. Pasted into Apps Script by hand. |
| `index.html` | Gate screens, app shell, dialogs. |
| `styles.css` | Design system and all three modes. |
| `api.js` | The only thing that talks to the backend. Transport, session, write queue. |
| `app.js` | Screens, rendering, console, appearance. |
| `vercel.json` | Static config and security headers. |
| `.vercelignore` | Keeps `apps-script.gs` and the docs off the public site. |

No build step, no framework, no dependencies.

---

## Accounts

Sign up takes username, name, password and date of birth. Login accepts the
username **or** the display name.

- Passwords: per-user 16-byte random salt, SHA-256 iterated 1,200 times. The
  plain password is never written anywhere.
- Comparisons use a constant-time check, so timing reveals nothing.
- A login attempt hashes even when there is no such user, so a wrong username
  and a wrong password take the same time and cannot be told apart.
- 8 wrong passwords locks the account for 15 minutes.
- Sessions are 32 random bytes in the `Sessions` tab, valid 30 days, swept on
  each new login.

### Getting back in

Two ways, checked in this order:

1. **A reset code** — the owner runs *Issue a password reset code* from the
   sheet menu, which writes a one-time 8-character code into that user's row.
2. **Date of birth** — as asked for in the brief.

Date of birth is the weaker of the two and is documented as such in SETUP.md,
because a birthday is often guessable. The reset code exists so there is a
better option available.

---

## Per-user isolation

Every row in `Heads` and `Notes` carries an `owner_id`. Every data action
resolves the caller from their session token and:

- reads only rows whose `owner_id` matches,
- stamps new rows with that `owner_id`,
- refuses to touch a head or note belonging to anyone else — with the **same**
  "does not exist" message used for a genuinely missing row, so the API never
  confirms that someone else's ID is real.

Filing a note into a head checks ownership of the head too, so a note cannot be
pushed into someone else's work.

> **This is application-level isolation, not Google-level.** Everyone's rows sit
> in one spreadsheet. Anyone given access to that spreadsheet sees all of it,
> and can unhide the `Users` tab. Hiding and protecting tabs is housekeeping.
> **The spreadsheet is never shared** — that is the actual control, and it is
> stated at the top of `apps-script.gs` and in SETUP.md.

---

## Rules the backend holds to

- **Columns are found by header name, never by position.** Add, reorder or
  widen columns freely; renaming a header is what breaks things, and the error
  says which one.
- **No row is ever deleted.** Archiving sets `archived` to `Yes`. (Expired
  sessions are the one exception — they are rubbish, not records.)
- **IDs are generated once and never rewritten.**
- **Every read hits the sheet.** No server-side cache, so edits typed straight
  into the sheet show up.
- **Writes are serialised** through `LockService`.

---

## Saving

A note is drawn on screen immediately and sent afterwards — a sheet write takes
one to two seconds, too long to block typing.

`api.js` holds a serial queue:

- jobs run one at a time, oldest first;
- a failure **stops the queue and keeps every job in it** — nothing is dropped,
  and the note stays on screen marked "not saved" until **Retry** works;
- `beforeunload` warns if the tab is closed with work still queued.

Optimistic rows carry a `tmp-…` id and are swapped for the real row on success.

---

## Design modes

Three modes, chosen per person and stored on their account, so the choice
follows them to another computer.

| Mode | What it is |
| --- | --- |
| `signal` | Default. LEDGER's palette and type on an application shell. |
| `terminal` | A console: phosphor on black, square corners, a command line. |
| `paper` | Light, serif, generous — for reading and writing long details. |

A mode is a **token swap** on `<html data-mode>`, not a separate stylesheet.
Every component is written once and follows whichever mode is on; only a handful
of shape changes that tokens cannot express are mode-specific. Each mode has a
light and a dark variant.

The remembered mode is painted from `localStorage` before the first frame, so
there is no flash of the wrong skin on load.

### The console

Terminal mode adds a real command line: `note`, `head`, `ls`, `open`, `inbox`,
`file`, `status`, `detail`, `mode`, `theme`, `export`, `whoami`, `clear`,
`help`, `exit`. `ls` numbers its output and `open 2` takes that number, so the
two work together.

### Custom CSS

Stored per account and injected into one `<style>` element **as text**, never as
markup. Validated identically in `app.js` and `apps-script.gs` — the server copy
is the one that matters, since whatever is stored there is served back to a
browser later.

Refused: any `<` or `>`, `@import`, `javascript:`, `expression()`,
`-moz-binding`, `behavior:`, and any `url()` that is not `https:` or
`data:image`. Capped at 20,000 characters.

Because every mode is built from `:root` variables, one line repaints the app:

```css
:root { --accent: #ff8a3d; }
```

---

## The Report tab

Written by the script, not by formulas. A formula cannot reliably group notes
under their head, and a broken one would show wrong work with no error.
`rebuildReport()` runs a few seconds after any write (debounced ~25s), after a
manual sheet edit, and on demand from the sheet menu.

It contains **every** user's work, grouped by person. It is for the sheet's
owner. Sharing work is what each person's **Export** is for.

---

## Not built

- Search covers head titles, clients, types and statuses — not note text, which
  would need a server-side query since notes are not all loaded in the browser.
- No "needs detail" screen or timeline view; the flag is set and counted.
- Clients, types and statuses in `Lists` are shared by everyone. Notes and heads
  are not.
- No installable CLI. The console is in the browser.

---

## Relationship to `worklog`

`Desktop/worklog` is the earlier single-user build: one Apps Script web app
bound to one sheet, deployed "Only myself", no accounts. It still works and is
simpler. Documentrism supersedes it for anything with more than one person.
