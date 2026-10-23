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
2. The first screen asks for the **Apps Script web app URL**. Paste the one you
   copied in A5 and click **Connect**.
3. Click **Create an account** and fill in:
   - **Username** — 3 to 24 characters, letters and numbers
   - **Your name**
   - **Password** — at least 8 characters
   - **Date of birth** — the real one. This is what gets you back in if you
     forget your password.
4. Click **Create account**. You are in.

## Letting other people join

Send them two things:

1. the web address, `https://documentrism.vercel.app`
2. the Apps Script URL ending in `/exec`

They paste the second one on the first screen, make their own account, and see
only their own work. They never touch your sheet.

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

**Three modes:**

- **Signal** — the default. Dense and calm, for scanning a lot of work.
- **Terminal** — a console. Green on black, square edges, and a command line.
- **Paper** — quiet and serif, for reading and writing long details.

Each works in light or dark.

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

To share work, use **Export** in the app, or send the Report as a PDF.

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

**Anyone with the Apps Script URL can create an account.** Treat it like a
door key, not a public link. If it gets out: in the script editor, **Deploy** →
**Manage deployments** → **Archive** the old deployment and make a new one. The
old URL stops working and everyone pastes the new one.

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
