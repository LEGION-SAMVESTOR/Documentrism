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
one Google Sheet — Users · Sessions · Prefs · Shares · Heads · Notes · Lists · Report
```

The backend URL lives in **`config.js`** and nowhere else. It ships to the
browser, so people land straight on sign-in, and there is no in-app way to
point this site at a different backend. Ship `config.js` without a
`backendUrl` and the sign-in screen says so plainly instead of failing oddly.

This means anyone who opens the site can sign up. The URL was never really
secret — the browser sends it on every call — so the honest control is a
sign-up key, which is **not built**. Until then, the address is the gate.

| File | What it is |
| --- | --- |
| `apps-script.gs` | The entire backend. Pasted into Apps Script by hand. |
| `config.js` | The backend URL. The only file to edit when the backend moves. |
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

## Sharing

One way and read-only. Sharing a head shares that head and every note under
it, now and later; sharing a note shares only that note.

`getHead` lets a head through if the caller owns it **or** has a live share for
it, and marks the response `readonly`. That flag only drives the interface —
every write still goes through `requireOwnHead_` / `requireOwnNote_`, which
match owned rows and nothing else, so a recipient cannot write even if they
drive the API directly.

The **Shared** tab lists people first, then what each has sent, because a list
of names scans better than everyone's work in one pile. A second view shows
what you have shared out, with revoke. Revoking sets `revoked` to `Yes`; the
row stays.

`listPeople` returns every active account's username and display name so the
share box can offer them. That is a directory visible to everyone signed in —
names only, no birthdays, no hashes.

Shared content is never written to the local cache, which is keyed per account
and meant for your own work.

## Search

Two halves, deliberately split by where the data is.

- **Heads** filter instantly in the browser, from the list already in memory —
  title, client, type and status.
- **Note text** is never all in the browser, so it costs a round trip.
  `searchNotes` scans the caller's own live notes across text, details and the
  parent head's title, and runs 400ms after you stop typing rather than per
  keystroke. Results appear under the heads, with the matched words marked.

Every word in the query must appear somewhere, in any order, so "cart drawer"
finds "the drawer on the cart page". Capped at 60 results, and the header says
when there were more.

Answers are sequence-numbered: a slow reply for an older query is dropped
rather than overwriting what you are looking at now.

## Knowing what is deployed

`ping` (and a plain GET of the `/exec` URL) returns the version and a
capability list:

```json
{"ok":true,"app":"documentrism","version":"2.3.0",
 "can":["accounts","sharing","images","validation","search"]}
```

Open the backend URL in a browser to see which build is live. Before this, two
very different backends both reported `2.0.0`, and there was no way to tell
from outside which one you were talking to.

## Validation

Checked in `app.js` and again in `apps-script.gs`, because the browser copy is
a courtesy and the server copy is the one that protects the sheet.

- **Title** — at least one letter and 2+ characters. A bare number is refused;
  a head called "2026" tells you nothing a week later.
- **Client** — must be a value on the Lists tab. The field is a `<select>`, and
  the server rejects anything not in the list, so free text cannot get in. New
  clients are added on the Lists tab, or via the `addClient` action.
- **Link** — empty or `http(s)://…`. This is also what keeps `javascript:` out
  of an attribute that ends up in an `href`.
- **Type / status** — must be on the Lists tab.

## Images

A cell holds about 50,000 characters, so pictures cannot live in the sheet. The
`images` column on Notes holds comma-separated Drive file ids instead.

- Uploads are resized to 1400px on the longest edge and re-encoded in the
  browser first (PNG for small screenshots, JPEG otherwise), so a 6MB photo is
  not a 6MB round trip. 8 per note, 4MB each after resizing.
- Files go to a private *Documentrism Images* folder in the owner's Drive and
  are explicitly set to no sharing.
- `getImage` returns the bytes base64-encoded, and only after checking the
  caller owns the note or has it (or its head) shared with them. Nothing is
  reachable by guessing a URL, and a shared note's pictures follow the same
  rule as its text.
- Fetched bytes are cached in memory for the session, because each fetch is a
  full Apps Script round trip.

**This needs a new Drive permission**, so authorization is requested again the
first time `setupSheet` runs after this change.

## Design modes

Three modes, chosen per person and stored on their account, so the choice
follows them to another computer.

| Mode | What it is |
| --- | --- |
| `signal` | Default. LEDGER's palette and type on an application shell. |
| `terminal` | A console: phosphor on black, square corners, a command line. |
| `paper` | Light, serif, generous — for reading and writing long details. |

Crossed with a **surface style** on `<html data-style>`, ported from LEDGER's
own axis: `plain`, `glass` (frosted and translucent), `neo` (soft extruded
plastic), `flat` (hairlines, no depth), `brutal` (heavy ink, hard offset
shadows) and `toon` (LEDGER's cartoon — cream paper with dots, chunky outlines,
Fredoka and Luckiest Guy). A mode sets palette and type; a style sets how a
surface is made, and every style rule targets the one shared set of surfaces so
it is written once.

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

- Search of **shared** notes: you only ever search your own.
- No "needs detail" screen or timeline view; the flag is set and counted.
- Clients, types and statuses in `Lists` are shared by everyone. Notes and heads
  are not.
- No installable CLI. The console is in the browser.
- Sharing is read-only and one way. There is no shared editing, and no
  notification when something is shared with you — it appears in the tab.
- The Export button is gone at your request. The terminal `export` command
  still works, and the sheet itself remains the real backup (File → Download).

---

## Relationship to `worklog`

`Desktop/worklog` is the earlier single-user build: one Apps Script web app
bound to one sheet, deployed "Only myself", no accounts. It still works and is
simpler. Documentrism supersedes it for anything with more than one person.
