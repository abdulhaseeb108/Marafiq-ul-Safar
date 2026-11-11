# Phase 1 decisions made by the builder

Paste these rows into the table in `05-OPEN-DECISIONS.md` (your copy has edits I have not seen, so I did not overwrite it), then delete this file.

| # | Question | Default used in the build | Needed before |
|---|---|---|---|
| 31 | Where refresh tokens live (doc 02 has no collection for them) | New `sessions` collection holding only a keyed hash of each refresh token; expired rows are removed by a TTL index | – |
| 32 | Token lifetimes | Access 15 minutes, refresh 7 days (sliding), "password OK, code pending" step 5 minutes | Launch |
| 33 | What counts toward "5 attempts per 15 minutes" | Failed attempts only, counted per IP and per email; wrong 2FA codes count too (per IP and per user). A correct sign-in clears the email counter | Launch |
| 34 | Rate-limit storage | In memory, per API process. Counters reset when the API restarts. Move to a shared store if the API ever runs as more than one instance | Scaling |
| 35 | New env variable `TOTP_ENC_KEY` | Required. 64 hex characters; encrypts 2FA secrets (AES-256-GCM). Changing it forces everyone to set up 2FA again | Phase 1 run |
| 36 | 2FA for non-admin roles | Optional. Required only for `admin` | Launch |
| 37 | Lost authenticator phone | Another admin presses "Reset two-factor". If the only admin loses theirs, it needs a manual database fix, so create a second admin early | Launch |
| 38 | Password rule | 12 to 128 characters, no composition rules | Launch |
| 39 | Can staff change their own password? | Not yet: an admin sets a new one. Self-service change/reset needs email (Phase 6) | Launch |
| 40 | Admin changes to their own account | An admin cannot deactivate or demote themselves, which also guarantees one active admin always remains | – |
| 41 | Effect of deactivation, password change, 2FA reset | All of that user's sessions end immediately | – |
| 42 | Failed-login audit for an unknown email | Recorded without the typed email (people paste passwords into that box) | – |
| 43 | Cookies in development | `Secure` flag is off only when `NODE_ENV=development` so http://localhost works in every browser; on in test and production. `SameSite=Strict` everywhere | – |
| 44 | Client IP behind a proxy | One proxy hop is trusted in production only. Confirm this matches the host (Railway/VPS + Cloudflare) in Phase 7 | Phase 7 |
| 45 | CORS | Not enabled: the web app reaches the API on the same origin (Vite proxy in dev). The allow-list comes in Phase 7 | Phase 7 |
| 46 | TOTP code reuse inside its 30-second window | Allowed (standard behaviour). Can be tightened in Phase 7 | Phase 7 |
