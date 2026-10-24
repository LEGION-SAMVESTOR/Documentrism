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
| `icon.svg` | Favicon and app icon — a head with its notes stacked under it. |
| `manifest.webmanifest` | Lets the site install as an app. |
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

## Not losing what you are typing

Background catch-ups re-render, and re-rendering destroys a half-written note.
Two things stop that:

- `S.editing` holds a key for every field with unsaved text. Each field adds
  itself on input and clears itself on save, close or empty. `catchUp` refuses
  to run while that set has anything in it. It is explicit tracking, not "the
  cursor is in a text box" — the cursor lives in the note composer most of the
  time, and that would block refreshes forever.
- `renderNotes` lifts open editors out before rebuilding and puts them back
  after, including the focused field and the caret. So even a refresh that does
  land mid-sentence is invisible.

The same rule guards appearance (`prefsBusy`) and the head's title, link and
details fields.

## Saving

A note is drawn on screen immediately and sent afterwards — a sheet write takes
one to two seconds, too long to block typing.

A callback that throws **after** a write has landed can no longer mark the
queue stuck. It is a rendering bug, and treating it as a failed save used to
wedge every later write behind a Retry that could not help.

`api.js` holds a serial queue:

- jobs run one at a time, oldest first;
- a failure **stops the queue and keeps every job in it** — nothing is dropped,
  and the note stays on screen marked "not saved" until **Retry** works;
- `beforeunload` warns if the tab is closed with work still queued.

Optimistic rows carry a `tmp-…` id and are swapped for the real row on success.

---

## Sub-heads

A head may sit under another, up to `MAX_DEPTH` (4) levels. `parent_id` on
Heads holds it.

**Sub-heads do not appear in the Heads tab.** They are part of one piece of
work, and listing them alongside top-level heads doubles the list for no gain.
They live on their parent's page; the parent's row carries a count.

A sub-head takes its parent's **client, type and status** rather than carrying
its own — it is the same work — and it **must have a link**, since its job is
to point at where that part of the work actually lives. Both rules are applied
on create and when an existing head is filed under another.

Two things are checked on the way in rather than hoped for: a head can never
become its own ancestor (the chain is walked upward from the proposed parent),
and the depth cap is enforced. The picker applies the same rule in the browser
by banning the head and everything below it.

Archiving a head that still has live sub-heads is refused — they would be
stranded out of sight — with a message saying to move or archive them first.

In the list, children follow their parent and carry a depth attribute that
draws the rail and indent; a head whose parent is filtered out is shown at the
top level rather than disappearing with it.

## Notes: a page, a tree, and links

**A page.** Notes get long, and a two-row textarea inside a list is the wrong
place to read one. The ↗ on any note opens `view-note`: the line at the top,
the write-up in a box sized to the window (`min(58vh, 560px)`, or `min(72vh,
780px)` in Wide, which hides the side panel), images at full size, and
everything about the note down the side.

**A tree.** `parent_note_id` nests notes within one head. Drag a note onto
another to file it underneath; drop it on the timeline background to bring it
back out. A note cannot be dropped onto its own descendant — checked in the
browser before the drop is allowed, and again on the server. Moving a note to a
different head clears its parent rather than stranding it.

**Links.** `links` holds lateral references between any two of your notes, in
any head. They are **symmetric**: linking A to B links B to A, because a
one-way reference you cannot see from the other end is one you will never find
again. Capped at 20 per note.

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

A recipient can read **everything** on a shared head: its details, every note,
and each note's full details. Read-only hides the controls that would change
something (composer, save, archive, share, image delete) and turns the detail
fields into plain reading surfaces — still selectable, so the text can be
copied. The expand button stays, because hiding it was the difference between
"shared" and "shared but unreadable".

## Confirming destructive actions

Archiving, removing an image and revoking a share all ask first, through one
`confirmAction()` that returns a promise. Each says what will actually happen
and what is recoverable — archiving names the note and points out the row
survives in the sheet; removing an image says the file goes to Drive's trash.
Escape and clicking away both answer "no" rather than leaving the promise
hanging. The Undo toast still follows, for the mistakes made on purpose.

## Search

Two halves, deliberately split by where the data is.

- **Heads** filter instantly in the browser, from the list already in memory —
  title, client, type and status.
- **Note text** is never all in the browser, so it costs a round trip.
  `searchNotes` scans the caller's own live notes across text, details and the
  parent head's title, and runs 400ms after you stop typing rather than per
  keystroke. Results appear under the heads, with the matched words marked.

A **dropdown** under the search box shows the best of both as you type: heads
immediately from memory, then notes slotted in underneath when they arrive, so
the list never waits on the network. Arrow keys move through it, Enter opens,
Escape closes it and a second Escape clears the box. The full result panel
stays below for the complete list.

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

## Layout and theme are separate

They used to be one thing, which meant picking a palette also moved the page
around, and no combination was anyone's actual choice. Now:

- **Theme** (`data-mode`) sets colour and type. It never moves anything.
- **Layout** (`data-layout`) sets structure. It never sets a colour.

Ten **arrangements**, not ten paddings. Spacing alone made them look like one
design at different zoom levels; each of these moves the actual regions of the
page. **Every layout uses the full width** — none narrows the work area.

| Layout | What moves |
| --- | --- |
| `classic` | Rail left, command bar, table. The default. |
| `topbar` | No side rail at all; navigation runs across the top. |
| `split` | The list stays beside the open head, so you keep your place. |
| `cards` | Heads become a grid of tiles. |
| `board` | Heads are grouped into a column per status. |
| `console` | The command line is the main instrument. |
| `dense` | 4px rows; the most a screen will hold. |
| `zen` | Icon rail, and the command bar is removed entirely. |
| `mirror` | The rail moves to the right. |
| `focus` | No rail, no bar — a floating strip over full-width work. |

Two of them cannot be done in CSS alone and have app support:

- **board** groups rows into one list per status before rendering, in the
  order the Lists tab gives them, with anything unrecognised in a final
  column. Changing to or from it redraws the list.
- **split** keeps `#view-heads` on screen beside `#view-head` and trims the
  list to title and status, since it is an index at that width. Below 900px
  there is no room for two columns and it behaves like classic.

**Layout outranks theme on purpose.** Every layout selector is written
`html[data-layout="…"]`, which beats a bare `[data-mode="…"]` on specificity.
Without that, a theme that draws a panel (Cartoon's ink outline) fought a
layout that removes panels (Magazine), and whichever came later in the file
won — exactly the coupling this split was meant to end.

## Themes

Three modes, chosen per person and stored on their account, so the choice
follows them to another computer.

| Mode | What it is |
| --- | --- |
| `signal` | Default. LEDGER's palette and type on an application shell. |
| `terminal` | A console: phosphor on black, square corners, a command line. |
| `paper` | Light, serif, generous — for reading and writing long details. |
| `ember` | Red on black. Two coals breathing underneath. |
| `nocturne` | A night sky: drifting stars, cold light, deep indigo. |
| `runic` | Obsidian and old gold, an arcane shimmer turning behind it. |
| `royal` | Deep violet and gold, formal, with a slow sheen. |
| `blackbox` | Amber CRT: scanlines, a sweeping line, command line on. |
| `sleek` | Near-monochrome, one pale light, almost subliminal. |

A mode changes the **arrangement** of the page, not only its colour. The
biggest lever: **Paper and Royal move navigation to a 66px top bar** instead of
a left rail, drop panel backgrounds entirely, and collapse the head page to a
single column — they read as a document, not a dashboard. Terminal and
Blackbox go the other way: full width, 8px rows, row subtitles hidden, a small
uppercase heading. Sleek takes a 46px heading, Nocturne centres its masthead,
Ember shouts in uppercase with an accent rule under the table head.

The quieter levers are `--inner-max`, `--row-pad` and `--pad`:

| Mode | Column | Rows | Feel |
| --- | --- | --- | --- |
| terminal, blackbox | full width | 8px | dense, nothing wasted |
| signal | 1180px | 13px | the default |
| ember, nocturne | 1240px | 15px | a touch taller |
| runic | 1000px | 16px | narrow and formal |
| paper, royal | 860px | 17px | a reading measure, no side panel |
| sleek | 1320px | 18px | wide and airy |

Paper and Royal also drop the head page's side panel into a single column and
strip the chrome off the hero and filters, because a reading mode should not
look like a dashboard.

The six dark modes each have a moving backdrop, drawn in a single fixed
`.bgfx` layer behind everything. Only `transform` and `opacity` animate,
nothing sits in the scroll path, and the layer is inert unless the mode asks
for it — so the cost is one compositor layer and no scroll work. Both
**Animations: off** and `prefers-reduced-motion` stop the motion while leaving
the backdrop in place, rather than removing it.

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
