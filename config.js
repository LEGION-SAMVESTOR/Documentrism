"use strict";
/* ============================================================================
   DOCUMENTRISM — site configuration

   Putting the backend URL here means nobody has to paste it: the app goes
   straight to the sign-in screen. It is the only file you edit when the
   backend moves.

   This is the ONLY place the backend address lives. There is no screen in the
   app for changing it — everyone who opens the site uses the URL below.

   WHAT THIS MEANS — read once
   This file ships to the browser, so the URL in it is public to anyone who
   opens the site. The deployment must be set to "Anyone" for sign-up to work
   at all, so anyone who reaches this page can create an account in your sheet.
   That was already true of the URL itself (the browser has to send it, so it
   shows in the network tab either way) — this just removes the friction.

   If that becomes a problem, the fix is a sign-up key, not hiding this URL.

   To move the backend: deploy a new version in Apps Script, paste the new
   /exec URL below, and push. Vercel redeploys and everyone follows at once.
   ========================================================================== */
window.DOCUMENTRISM_CONFIG = {

  /** The Apps Script web app URL. Must be the /exec one, not /dev. */
  backendUrl: "https://script.google.com/macros/s/AKfycbwPCsP5SqRq_duJO43a4eaodLcU8hb2BDsn9QvAZxMCivBLfr9p71ELcQBKJBDUFRS2Aw/exec"
};
