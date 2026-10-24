# Documentrism — Setup

You do this once. After that, anyone you give the web address to can make their
own account and start logging work.

There are two halves:

- **The backend** — a Google Sheet plus a script. This holds the data. Only you
  own it.
- **The front end** — the pages, hosted free on Vercel at your own web address.

Take them in order.

---

# Part A — The backend (about 15 minutes)

## A1. Make the sheet

1. Open <https://sheets.new>.
2. Click the name at the top left (**Untitled spreadsheet**).
3. Type **Documentrism** and press Enter.

You do not need to make any tabs by hand. The script does that in step A4.

## A2. Add the script

1. In the sheet, click **Extensions** → **Apps Script**. A new tab opens.
2. Click **Untitled project** at the top left, type **Documentrism**, press Enter.
3. On the left you see **Code.gs**. Click it.
4. Click inside the big code box, press `Ctrl + A`, then `Delete`.
5. Open `apps-script.gs` from your `documentrism` folder, select all of it,
   copy, and paste it into the empty box.
6. Click the **Save** icon.

That is the only file. The rest of the app lives on Vercel.

## A3. Run the setup once

1. In the dropdown at the top, choose **setupSheet**.
2. Click **Run**.

Google asks for permission. This is normal — it is your own script, touching
your own sheet.

3. **Review permissions** → choose your account.
4. You see **Google hasn't verified this app**. Click **Advanced** at the
   bottom left, then **Go to Documentrism (unsafe)**. That wording only means
   you wrote this script yourself and Google has not reviewed it.
5. Click **Allow**.

Wait for **Execution completed**.

## A4. Check the sheet

Go back to the sheet and refresh the page. You should see these tabs:

**Heads**, **Notes**, **Lists**, **Report**

The **Users**, **Sessions** and **Prefs** tabs are hidden on purpose — they hold
account data. To see them: **Documentrism** → **Show hidden tabs**. Hide them
again when you are done.

## A5. Deploy the backend

1. Back in the script editor, click **Deploy** → **New deployment**.
2. Next to **Select type**, click the gear → **Web app**.
3. Fill it in:

| Field | Choose |
| --- | --- |
| Description | `Documentrism backend v1` |
| Execute as | **Me** (your email) |
| Who has access | **Anyone** |

**"Who has access" must be "Anyone".** Other people cannot sign up otherwise —
their browser has to be able to reach this script.

This does *not* mean anyone can read your sheet. The script is the only way in,
and it hands back nothing without a valid signed-in session. What it does mean
is that anyone who gets the address can *create an account*. See **Safety** at
the bottom.

4. Click **Deploy**.
5. **Copy the Web app URL.** It is long and ends in `/exec`. Keep it somewhere
   safe — you need it in Part C, and so does everyone who joins.
6. Click **Done**.

---

# Part B — The front end on Vercel (about 5 minutes)

## B1. Put the files on GitHub

1. Make a new **private** repository on GitHub, called `documentrism`.
2. Upload everything from your `documentrism` folder **except** the `.md`
   files (they are ignored anyway).

If you prefer not to use GitHub, skip to B3.

## B2. Deploy from GitHub

1. Go to <https://vercel.com> and sign in.
2. **Add New** → **Project** → import your `documentrism` repository.
3. Framework preset: **Other**. Leave the build settings empty — this is a
   plain static site with no build step.
4. Click **Deploy**.

## B3. Or deploy without GitHub

1. Install the tool once: `npm i -g vercel`
2. In the `documentrism` folder, run `vercel` and answer the questions.
3. When it is working, run `vercel --prod`.

## B4. Set the address

In Vercel, open the project → **Settings** → **Domains**, and set the name to
**documentrism**. Your app is then at:

```
https://documentrism.vercel.app
```

(That name was free when this was written. If Vercel says it is taken, pick
another and use that everywhere below.)

---

# Part C — First sign-in

1. Open your Vercel address.
2. You land straight on the sign-in screen — the backend URL is already in
   `config.js`, so nobody has to paste anything.
3. Click **Create an account** and fill in:
   - **Username** — 3 to 24 characters, letters and numbers
   - **Your name**
   - **Password** — at least 8 characters
   - **Date of birth** — the real one. This is what gets you back in if you
     forget your password.
4. Click **Create account**. You are in.

## Letting other people join

Send them the web address, `https://documentrism.vercel.app`. That is all.
They make their own account and see only their own work. They never touch your
sheet.

### Changing the backend later

The URL lives in one place: **`config.js`**. Deploy a new version in Apps
Script, paste the new `/exec` URL into that file, and push. Vercel redeploys
and everyone follows at once.

There is no screen in the app for changing it. Everyone who opens the site
uses the URL in that file, and that is the only way to change it.

> The URL in `config.js` is visible to anyone who opens the site. That was
> already true before — the browser has to send it, so it shows in the network
> tab either way. What it means in practice is that **anyone who finds the web
> address can create an account in your sheet.** See *Safety* below.

---

# Part D — Using it

**The fastest way to log work:** press `Ctrl + K` anywhere, type what you did,
press `Enter`. If you did not pick a Head, it goes to the **Inbox** to file
later. Only the text is ever required.

| Key | Does |
| --- | --- |
| `Ctrl + K` | Quick note |
| `Ctrl + J` | New head |
| `Ctrl + ,` | Appearance |
| `/` | Jump to search |
| | Search covers head titles **and note text** |
| `Enter` | Save the note you are typing |
| `Shift + Enter` | New line inside a note |
| `Esc` | Close the box |

## The Expand button

Every Head and Note has a **Details** area. **Expand** drops in starting
headings for that type, so you never face an empty page:

| Type | Headings |
| --- | --- |
| Section | Files used · Settings · Known issues |
| Template | When to use · How to use · Owner |
| Update | Before → After · Why · How to undo |
| Research | Question · Answer in 3 bullets · Sources · Decision |
| Bug | Problem · Cause · Fix |
| Other | nothing |

It never deletes what you have written, and it will not add a heading twice.

## The saving light

| It says | It means |
| --- | --- |
| **Ready** / **Saved** | Nothing waiting |
| **Saving** | On its way to the sheet |
| **Save failed** + **Retry** | It did not arrive |

Your note shows up instantly, before the sheet has it. If you see **Retry**,
nothing is lost — it is still held in the app. Click **Retry**. The browser
warns you if you try to close the tab with work still waiting.

---

# Part E — Appearance

Click **Appearance** in the bottom left, or press `Ctrl + ,`.

**Sharing.** Open a head and press **Share this head**, or press the ◈ button
on a single note. Pick a person and they get a read-only copy in their
**Shared** tab. Sharing a head also shares every note under it, including ones
you add later. They cannot edit or archive it, and they see nothing else of
yours. **What I've shared** lists everything you have sent out, with a Revoke
button that cuts access immediately.

Their **Shared** tab shows the people who have shared with them; clicking a
name opens that person's items.

**Three modes:**

- **Signal** — the default. Dense and calm, for scanning a lot of work.
- **Terminal** — a console. Green on black, square edges, and a command line.
- **Paper** — quiet and serif, for reading and writing long details.

Each works in light or dark. On top of the mode you can set:

| Option | Choices |
| --- | --- |
| Surface style | Plain · Glass · Neo · Flat · Brutal · Cartoon |
| Accent colour | Mode default · Emerald · Amber · Violet · Magenta · Crimson |
| Typeface | Mono · Sans · Serif |
| Text size | Small · Medium · Large |
| Density | Comfortable · Compact (more rows on screen) |
| Animations | On · Off |

**Surface style** is the LEDGER set: *Glass* is frosted and translucent, *Neo*
is soft extruded plastic, *Flat* has hairlines and no depth, *Brutal* is heavy
ink borders with hard offset shadows, and *Cartoon* is LEDGER's toon look —
cream paper with dots, chunky outlines and comic lettering.

All of it is saved to your account, so it follows you to another computer.

## Pictures in notes

Paste an image straight into the note box, or drag one onto it, then write your
line and press Enter — the picture attaches once the note is saved. Click a
thumbnail to see it full size, or the ✕ on it to remove it.

Pictures are shrunk to 1400px before upload, so a big phone screenshot does not
take forever. They go to a **private folder in your Google Drive** called
*Documentrism Images*, and they are read back through the app, not by a public
link — so a picture on a shared note follows the same rule as the note itself.
Removing one puts it in your Drive trash rather than destroying it.

Limits: 8 pictures per note, 4MB each after shrinking.

## What the app will not accept

- A head **title** must have at least one letter and be 2 characters or more.
  "2026" on its own is refused — in a month it would tell you nothing.
- A **client** must be chosen from the dropdown. To add a new one, put it in
  the **clients** column on the **Lists** tab; it appears next time the app
  loads.
- A **link** must start with `http://` or `https://`, or be empty.
- **Type** and **status** must come from the Lists tab too.

Each rule is checked in the browser *and* again on the server, so nothing
invalid reaches the sheet even if someone bypasses the screen.

## The command line (Terminal mode)

Type `help` to see everything. The useful ones:

```
note fixed the gallery       add a note to the open head, or the inbox
head Aujjessa PDP rebuild    make a new head and open it
ls                           list your heads, numbered
open 2                       open head 2 from that list
inbox                        show the inbox
file 1 2                     move inbox note 1 into head 2
status Paused                set the open head's status
mode paper                   switch mode
export                       download a backup
```

## Custom CSS

The box at the bottom of Appearance takes **CSS only**. It is checked twice —
in the browser and again on the server — and refused if it contains HTML,
`@import`, `javascript:`, `expression()`, `behavior:`, or a `url()` that is not
an `https:` address or a `data:image`.

Every mode is built from variables on `:root`, so one line repaints everything:

```css
:root { --accent: #ff8a3d; }
```

Your choice is saved to your account, so it follows you to another computer.

---

# Safety — please read this

**Never share the spreadsheet with anyone.** Everybody's work lives in it. The
"you only see your own notes" rule is enforced by the script, not by Google —
anyone you give the spreadsheet to sees *everyone's* rows, and can unhide the
Users tab. Hiding a tab is tidiness, not protection.

To share work with someone who has an account, use the **Share** button. For
anyone else, send the Report as a PDF, or **File → Download** from the sheet.

There is no Export button in the app any more. The sheet itself is the backup:
**File → Download → Microsoft Excel** covers everybody's work in one file. In
Terminal mode, the `export` command still downloads your own data as JSON
and CSV.

**Passwords are stored hashed**, with a different random salt each. They cannot
be read back out of the sheet, by you or anyone else. If someone forgets theirs,
you cannot look it up — issue a reset code instead.

**Date of birth is a weak way back in.** A birthday is often guessable, so
anyone who knows a username and a birthday could take over that account. The
better way:

> **Documentrism** → **Issue a password reset code** in the sheet's menu.
> Type the username, and it gives you an 8-character code. Hand it over in
> person or on a channel you trust. They put it on the **Forgot password**
> screen. It works once.

**Anyone who opens the web address can create an account**, because the backend
URL ships in `config.js` and sign-up is open. For a small team you trust with
the address, that is fine. If strangers start signing up, you have two moves:

1. **Rotate the backend.** Script editor → **Deploy** → **Manage deployments**
   → **Archive** the old one, deploy a new one, put the new `/exec` URL in
   `config.js` and push. The old address stops working.
2. **Ask for a sign-up key** — a short shared secret the server checks before
   it creates an account. This is the real fix, and it is not built yet.

Either way, existing accounts and all the work stay where they are.

**Accounts are locked for 15 minutes after 8 wrong passwords**, so guessing is
slow.

---

# If something goes wrong

**"That URL did not return data"**
The deployment is not set to **Anyone**, or you pasted the `/dev` URL instead of
`/exec`. Redeploy and copy the `/exec` one.

**"Cannot reach the backend"**
No connection, or the deployment was archived.

**"The tab ... is missing"**
In the sheet: **Documentrism** → **Set up / repair tabs**. It restores anything
missing without touching data that is already there.

**The Documentrism menu is not in the sheet**
Refresh the sheet page. If it still does not show, run `onOpen` once from the
script editor.

**Which version of the backend is live?**
Open the `/exec` URL in a browser. It answers with the version and what it can
do, for example:

```
{"ok":true,"app":"documentrism","version":"2.3.0",
 "can":["accounts","sharing","images","validation","search"]}
```

If something in the app says "Unknown action", the backend is older than the
website and needs re-pasting and redeploying.

**I changed the script and nothing changed**
Apps Script serves the deployed version, not the saved one.
**Deploy** → **Manage deployments** → pencil icon → **Version: New version** →
**Deploy**. The URL stays the same.

**I changed the website and nothing changed**
Vercel redeploys when you push to GitHub. Hard-refresh with `Ctrl + Shift + R`.

**Someone is locked out**
**Documentrism** → **Issue a password reset code**.

**The Report tab is out of date**
**Documentrism** → **Rebuild Report tab**.
