# 05 — Open Decisions and Safe Defaults

The AI builder uses the **default** until you change it. Edit this file when you decide; the builder reads it.

| # | Question | Safe default used in the build | Needed before |
|---|---|---|---|
| 1 | Exact registered SMC name, address, NTN, contact details | Footer shows the display name **Marafiq Us Safar** (owner, 13 Nov 2026). Registered legal entity name, address and NTN not supplied, so none is shown, and the site does not call the business registered, an SMC or a private limited company. Terms still placeholder | Public launch |
| 2 | Travel agency license / Umrah operator permission, or partner who holds it | Licence status **active** (owner, 13 Nov 2026). Footer: "quote and planning service" and "Licence status: active" with placeholders `[LICENCE CATEGORY]`, `[LICENCE NUMBER]`, `[ISSUING AUTHORITY]`. The earlier "services fulfilled by licensed partners" is removed until the operating model is confirmed; placeholder `[SERVICE FULFILMENT WORDING: CLIENT TO CONFIRM]` | Public launch and any payment |
| 3 | Merchant of record when payments start | No payments in v1 | Payments |
| 4 | Are visa rates per person, and does 550 SR include the bus transport printed beside it? | Assume per person, includes bus for 1–49 pax; shown as "confirm with supplier" | First real quote |
| 5 | Group size for indirect visa when travelers > 4 | Use the 4-pax rate with a visible assumption | First real quote |
| 6 | Infant hotel charge | None (0), shown as an assumption | First real quote |
| 7 | Child (2–11) hotel and visa price | Same as adult | First real quote |
| 8 | Meaning of flat "200-SR / 300-SR / 110-SR" rows (Fundaq Bilal, Al Kiswah Tower) | `flat_per_room` per night, flagged for confirmation | First import |
| 9 | Whole-room (private) price when fewer people than beds | Use ROOM price per night | First real quote |
| 10 | Markup | 0% (supplier price as given) | Change anytime in Settings |
| 11 | SAR→PKR rate source and update frequency | Manual entry in Settings with effective date | Launch |
| 12 | Quote response time promised | Configurable text, default "within 1 business day" | Launch |
| 13 | Departure cities with flight estimates | Dropdown from entered estimates; others "Request a quote" | Launch |
| 14 | Frontend SEO | Plain React + Vite with pre-rendered marketing pages; move to Next.js only if SEO needs it | Phase 5 |
| 15 | Urdu copy review | AI draft marked `[URDU REVIEW]` until a native speaker approves | Public launch |
| 16 | Privacy policy, terms, quote terms | Placeholders marked `[LEGAL REVIEW NEEDED]` | Public launch |
| 17 | Payment gateway (Safepay, PayFast, XPay, bank) | Not selected | Payments |
| 18 | Whether supplier wholesale rates may be shown publicly | Shown as given (your decision); toggle `showSupplierRates` in Settings to show "From PKR X" instead | Public launch |

## Phase 0 decisions made by the builder (review and edit)

| # | Question | Default used in the build | Needed before |
|---|---|---|---|
| 19 | Node version. CLAUDE.md says Node 20, but Node 20 is end-of-life (April 2026) and patched Vitest / i18next / jsdom releases need Node 22 | **Node 22** in `.nvmrc`, `engines` and CI. If you agree, change "Node 20" to "Node 22" in CLAUDE.md | Phase 1 |
| 20 | Is there a `confirmed` status? CLAUDE.md rule 2 and doc 01 §5 mention it; the enums in doc 02 §2 do not | Not added. No status maps to "confirmed" or "booked", so neither word can reach a customer | Phase 6 |
| 21 | Lead "any → lost": does it include `accepted` and `declined`? | Yes, every status except `lost` itself can move to `lost` | Phase 6 |
| 22 | Rollback of a rate pack vs. "superseded" having no outgoing transition | `superseded` is terminal; rollback will create a new version (doc 03 §2.8), not revive the old document | Phase 3 |
| 23 | Rounding of derived per-person rates and per-person totals | Ceil to a whole SAR / whole rupee (room 200 ÷ 3 = 67, as printed on the sheet) | Phase 4 |
| 24 | Markup rounding ("ceil before FX") | Ceil to the halala (0.01 SAR). Irrelevant while markup is 0% | First non-zero markup |
| 25 | PKR line rounding | One half-up rounding from the exact SAR × rate product to whole rupees; totals are the sum of rounded lines | Phase 4 |
| 26 | Night / pack / issue dates | Stored as `YYYY-MM-DD` strings (no time zone) so a night never shifts a day; timestamps are UTC dates | Phase 2 |
| 27 | Draft rate data with missing values | Pack dates and visa amounts are nullable in the schema so a draft can be saved; publish rules (doc 03 §4) block them in Phase 3 | Phase 3 |
| 28 | Shapes not specified in doc 02: `calculations.inputs` / `lineItems`, `messages.direction`, `leads.notes[]`, `validation` items, `auditEvents.actorRole` for non-staff | Calculation inputs and line items are loose objects until Phase 4; direction = `inbound|outbound`; notes = `{body, by, at}`; validation items = `{code, message, path?}`; actorRole also allows `public` and `system` | Phase 4 / 6 |
| 29 | Customer wording for statuses not listed in doc 02 (declined, expired, replaced) and all Urdu wording | English taken from doc 01 §7; Urdu is an AI draft `[URDU REVIEW]` | Public launch |
| 30, 60 | `docs/seed/` (sample PDFs, `waqar-sample.json`) was not supplied; what happens when `docs/seed/waqar-sample.json` is present or missing? | Folder is empty; T8 uses the numbers printed in doc 03. The seed reads `docs/seed/waqar-sample.json` if present and creates the hotels it lists. If the file is missing, the seed still creates the supplier, settings and FX rate, and says no hotels were added. **No hotel names or cities are invented** (CLAUDE.md rule 8) | Phase 3 |

## Phase 1 decisions made by the builder (review and edit)

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
| 44 | Client IP behind a proxy | Production trusts `TRUST_PROXY_HOPS` proxies (default 1). The Pages Function sets `X-Forwarded-For` to Cloudflare's `CF-Connecting-IP`, and `ORIGIN_PROXY_SECRET` makes the API refuse requests that skip it. The hop count must be confirmed on staging (docs/DEPLOY.md §9 step 4) | Phase 7 (done; confirm on staging) |
| 45 | CORS | The site and API stay on one origin: Cloudflare Pages serves the web app and forwards `/api/*` to the API host through a Pages Function. An allow-list (`WEB_ORIGIN`) exists for a split deployment and is blank by default | Phase 7 (done) |
| 46 | TOTP code reuse inside its 30-second window | Allowed (standard behaviour). Can be tightened in Phase 7 | Phase 7 |

## Phase 2 decisions made by the builder (review and edit)

| # | Question | Default used in the build | Needed before |
|---|---|---|---|
| 47 | Who may edit flight estimates? Doc 01 §6.5 puts them under Settings (admin only); the Phase 2 brief says admin and ops | **admin and ops**, per the brief. Settings and FX stay admin-only | Launch |
| 48 | Who may read hotels? | Every staff role (sales and finance need them for quotes). Only admin and ops may change them | – |
| 49 | Scope of "aliases must be unique across hotels" | Unique **within a city**, not globally, so a chain with the same name in Makkah and Madinah is still possible. Rate-sheet rows carry a city, so a name still resolves to one hotel | Phase 3 |
| 50 | How two names are judged the same | Unicode-normalized, lower-cased, repeated spaces collapsed. Punctuation is **not** ignored, so "Retaj-Rawdah" and "Retaj Rawdah" are different names. Tighten this in Phase 3 if real sheets need it | Phase 3 |
| 51 | What merge does | The duplicate's name and aliases move to the target; the duplicate is kept, deactivated, and marked `mergedIntoId`. Nothing is deleted. Old names resolve to the surviving hotel | – |
| 52 | Repointing other records on merge | Only hotel names move today, because nothing else references a hotel yet. **Phase 3 must repoint `hotelRates.hotelId` in the same operation** (there is a comment in `mergeHotels` marking the spot) | Phase 3 |
| 53 | Merge is two writes, not a transaction | Deliberate, so it works on a standalone MongoDB. The duplicate releases its names first; a failure between the steps leaves both records intact and the merge can be re-run | – |
| 54 | Merge limits | Only within the same city, never into itself, and never involving a hotel that was already merged away | – |
| 55 | Deleting master data | No delete route anywhere. Suppliers and hotels deactivate; a flight estimate is retired by setting `validTo` in the past, which keeps the history of what was quoted | – |
| 56 | FX "more than 30% away" | Exactly 30% is allowed; more than 30% needs `confirmLargeChange`. Compared against the row with the newest effective date, future-dated rows included | Launch |
| 57 | Future-dated FX rates | Allowed. `getCurrentFx()` ignores a row until its effective date, so you can enter tomorrow's rate today | – |
| 58 | What `/public/config` returns | languages, current FX rate and date, `markupApplied` (a flag, never the percentage), `showSupplierRates`, `responseTimeText`, and departure cities with a non-expired estimate. `responseTimeText` is not in doc 02's list but the inquiry form in doc 01 §5 needs it | – |
| 59 | New env variable `SEED_FX_RATE` | Optional, default `75.00`. Only used by `npm run seed` when no rate exists | Phase 2 run |
| 61 | Transport on seeded hotels | Read from the sheet's free text: "shuttle"/"bus"/"transport" to `shuttle`, "walk" to `walking`, otherwise `unknown`. Staff can correct it | First import |
| 62 | Money entry in the admin portal | Flight estimates are typed in whole rupees and converted to paisa by the shared money helpers. Nothing stores a float | – |
| 63 | Settings document | A single document with a fixed key, created with the defaults the first time it is read | – |

## Phase 3 decisions made by the builder (review and edit)

| # | Question | Default used in the build | Needed before |
|---|---|---|---|
| 64 | One file, several packs. Doc 03 §3 describes one pack per file, but the real WMT PDF has three (one per page) | The model returns `{ "packs": [...] }` and each becomes its own rate pack, reviewed and published separately | – |
| 65 | Room-basis rows such as Akabir Hijrah | `flat_per_room` from the ROOM column, as doc 03 §1 says. The printed quad/triple/double figures are stored for reference and not used for pricing | Phase 4 |
| 66 | Two hotels printed on one line at one rate (Qasr Al Sharq Tower / Hiba Hijrah-6 in Ramadan packs) | The extraction prompt asks for one row per hotel with the same prices. Confirm with the supplier that both are sold at that rate | First real quote |
| 67 | How the file is sent to the model | A PDF goes as one document (the API reads each page as text and image); a photo goes as an image. One request per file, one retry if the answer does not fit the schema. No `temperature` is sent: the current SDK does not accept it | – |
| 68 | Reading takes about a minute | `POST …/extract` answers 202 at once and reads in the background; the screen refreshes until it finishes. If the API restarts mid-read, the sheet can be read again after 10 minutes | – |
| 69 | Extraction failures | Any failure shows "Extraction failed — enter manually or retry". The reason is kept out of the message and the logs (it can name hosts or keys); the raw model answer is stored on the document and never returned by any route | – |
| 70 | File type check | Decided by the file's first bytes, not its name or the browser's claim. PDF, PNG, JPEG only, 20 MB (this is the rate-sheet upload; the Phase 4A document-intelligence intake also takes XLSX and CSV, see doc 06) | – |
| 71 | Where files are stored | Cloudflare R2 when all four `R2_*` variables are set; otherwise the `.local-storage` folder. **The API refuses to start in production without R2.** The storage key is built from the supplier id and the file hash, never the file name | Deploy |
| 72 | No `ANTHROPIC_API_KEY` | The API still runs; "Read the sheet" answers 503 and staff use "Enter by hand" | – |
| 73 | Unknown hotel names | The row stays unconfirmed (blocking) until staff choose "same hotel" (the printed name is added as an alias) or "new hotel". A close match (similarity ≥ 0.85) is offered but never applied automatically | – |
| 74 | The same hotel read twice in one pack | The second row is left unconfirmed for staff to remove | – |
| 75 | Acknowledging warnings | One tick covers all warnings on the pack at publish time; the count is written to the audit event. Any edit clears the tick | Launch |
| 76 | "Marked as a replacement" | Staff pick the published pack this one replaces. Publishing then supersedes it and sets version = old version + 1. A pack can replace one pack only | – |
| 77 | Which pack prices are compared against (the 25% and hotel-count warnings) | The pack being replaced, if marked; otherwise the latest published pack of the same season ending before this one starts; otherwise the latest published pack that does | – |
| 78 | Rollback | The earlier pack comes back as a **new** published version (a copy); the current one is superseded. Nothing is overwritten. Refused if the earlier pack's nights now belong to another published pack | – |
| 79 | Reading a sheet again | Allowed until one of its packs is published. Earlier unpublished packs from that file are rejected, not deleted | – |
| 80 | Deleting a row | Allowed only in an unpublished pack (the model read a row that is not there). Audited. Published rows are never deleted | – |
| 81 | Infant visa rate missing | A warning, not a blocker: doc 03 §4 lists only the direct and group-size rates as blocking | Phase 4 |
| 82 | Transactions | Publish, rollback and hotel merge run in a MongoDB transaction where the database supports one (Atlas does). On a standalone MongoDB the same writes run in a safe order: at worst a pack is missing, never mispriced | Deploy |
| 83 | Merging hotels that have rates | Rate rows move to the surviving hotel, published packs included. Refused when both hotels are priced in the same pack | – |
| 84 | Merged-away hotels | Their name list holds one placeholder (`MERGED:<id>`) instead of being empty, so the unique name index needs no partial filter and behaves the same on every MongoDB | – |
| 85 | Index upkeep | At startup the API makes indexes match the schemas (creating and dropping as needed). A failure is logged and startup continues | – |
| 86 | Validation messages | In English in both languages: they quote sheet values and hotel names. Headings, buttons and statuses are translated | Launch |
| 87 | Viewing the original | PDFs open in the browser's own viewer inside the review screen (zoom and page switching come with it); photos toggle between fit and full size | – |

## Phase 4 decisions made by the builder (review and edit)

| # | Question | Default used in the build | Needed before |
|---|---|---|---|
| 88 | A sharing room with fewer people than beds (3 people in a quad) | Priced per bed taken (3 × quad rate), with a note that the other beds may go to other travelers | First real quote |
| 89 | Whole room | Uses the ROOM price per night (decision 9); at most 5 people in one room | First real quote |
| 90 | Two suppliers both publish a rate for the same hotel and night | The pack with the newest issue date wins, then the most recently published. Never mixed within one night | Second supplier |
| 91 | Which pack the visa rate comes from | The pack used for the first priced hotel night; otherwise a published pack covering the arrival date (same rule as 90). None → "Request a quote" | First real quote |
| 92 | Flight estimate destination | Makkah first → JED, Madinah first → MED. No fallback to the other airport. The estimate is per adult; children and infants on flights are "Request a quote". "I will arrange flights" is listed as an exclusion, not as missing | Launch |
| 93 | Totals when a flight range exists | `groupMinorSAR` / `groupMinorPKR` are hotel + visa only; with a flight they gain a `range` (low–high, group and per person). Per person = total ÷ (adults + children), rounded up to a whole SAR / rupee | Phase 5 |
| 94 | "Earliest pack end" for expiry | The end of the pack's last night in Saudi time (23:59:59 UTC+3) | Phase 6 |
| 95 | "Cheapest" / "nearest" hotel choice | Only hotels with a published price for every night qualify. Cheapest: lowest hotel total, ties by distance then name. Nearest: shortest stated distance (unknown distance last), ties by price. Wording: "lowest-priced on our published rates", never "best price" | Phase 5 |
| 96 | Input limits | Arrival date today or later (Pakistan time); up to 49 travelers (the visa sheet's 1–49 pax); up to 30 nights per city; up to 20 rooms; adults + children must all have a place in a room; infants share a bed | Phase 5 |
| 97 | Missing items, assumptions and exclusions | Each is `{code, message, params}`. `message` is English; the web app will translate by `code` in Phase 5 | Phase 5 |
| 98 | If Settings turn off "children priced as adults" | Children still pay for the bed they take in the room; their visa becomes "Request a quote" (no child visa rate exists) | First real quote |
| 99 | No FX rate set | `POST /public/calculate` answers 503 `prices_unavailable` ("please request a quote"); nothing is guessed | Launch |
| 100 | `GET /public/hotels` | Active hotels with a row in a published pack that has not ended. "From" prices: the lowest per-person sharing price and the lowest per-room price over those packs, with supplier, pack and issue date. When `showSupplierRates` is off, the SAR figure is hidden and only PKR is shown | Phase 5 |
| 101 | Saving calculations | Saved results are immutable: every update path is refused by the model. No public route saves yet; inquiries will save the server-side recalculation in Phase 6 | Phase 6 |
| 102 | Calculation hash | SHA-256 over engine version, inputs, rate versions used, FX rate, markup, child/infant settings and the flight estimate used. Not the time, so the same inputs and versions give the same hash | Phase 6 |
| 103 | Rate limits on public routes | Per client IP, in memory (one API process): 60 requests/min on all `/public` routes; 5 accepted inquiries/hour; 20 not-found quote links per 15 min. Over the limit = HTTP 429 with `Retry-After` | Phase 7 (done) |

## Phase 5 decisions made by the builder (review and edit)

| # | Question | Default used in the build | Needed before |
|---|---|---|---|
| 104 | "Request a quote" before the inquiry form exists (Phase 6) | Every "Request a quote" button opens Contact. From the calculator, Contact also shows a plain-text trip summary (English, for staff) that the customer can copy into WhatsApp or email. It is kept only in the browser tab (sessionStorage); nothing is sent or stored on the server | Phase 6 |
| 105 | Business phone, WhatsApp, email, address, office hours | Not supplied, so Contact shows a visible "[CLIENT TO PROVIDE]" marker for each. Fill them in `apps/web/src/public/site.ts` | Launch |
| 106 | Visa document checklist | A short, general list marked "[CLIENT TO CONFIRM]" on the page. The page says visa decisions rest with the issuing authority and that we cannot guarantee a visa, and asks customers not to send passport, CNIC or card numbers through the site | Launch |
| 107 | Privacy, terms, quote terms | Placeholder text marked "[LEGAL REVIEW NEEDED]" | Launch |
| 108 | PKR / SAR switch | Only changes which currency comes first; the other is always beside it. Flight estimates stay PKR only (they are entered in PKR). The choice is remembered in the browser | Phase 6 |
| 109 | Urdu font | Noto Nastaliq Urdu, self-hosted from the `@fontsource` package (no Google Fonts request). Downloaded only when a page is shown in Urdu | Launch |
| 110 | English and numbers inside Urdu sentences | Wrapped in Unicode isolates so "1 SAR = PKR 75.00", amounts and supplier names keep their order in right-to-left text | Urdu review |
| 111 | Digits in Urdu | Western digits (0–9) for amounts and dates, as on the supplier sheets and in Pakistani price lists | Urdu review |
| 112 | Calculator starting values | 5 nights Makkah, 4 nights Madinah, Makkah first, 2 adults, one double room, "lowest-priced option" for both hotels, direct-flight visa, flight estimate on. No arrival date until the customer picks one | Launch |
| 113 | Hotel names in Urdu pages | Shown as printed on the supplier sheet (English letters); not transliterated | Urdu review |
| 114 | Customer button wording | "Request a quote" (owner's decision for v1; doc 01 §4 still says "Request a confirmed quote"). Customer text never uses "booked", "confirmed", "best price", "guaranteed" or "halal certified"; a unit test checks this | — |
| 115 | Staff screens and page speed | The admin area loads only when someone opens /admin, so customers never download it. Measured with Lighthouse (mobile, 360 px, simulated 4G) on the built site: home 99, calculator 99; accessibility 100 on both | Launch |
| 116 | Browser tests | Playwright runs against the built site with the API mocked (T1 example). It covers calculator → result at 360 px in English and Urdu, no sideways scrolling on every public page in Urdu, and keyboard use (skip link, menu, form errors). CI installs Chromium and runs them | — |
| 117 | Quote view `/q/:token` | Built in Phase 6 (decisions 124-128) | — |
| 118 | Lead statuses | `new → contacted → quote_in_progress → quote_sent → accepted / declined / lost` (any → lost). No `confirmed` or `booked` status (owner's v1 decision; doc 01 §5.5 still mentions `confirmed`). Building a quote moves a new lead forward step by step, each step audited | — |
| 119 | Duplicate inquiries | Same normalized phone + same trip (calculation hash) within 24 hours returns the existing reference and creates nothing. Without a trip, "same trip" means the same source page. Two identical requests in the same instant can still both be stored (no lock) | Launch |
| 120 | Phone numbers | Pakistani mobiles only (3XX + 7 digits) in any common format; stored as +923001234567, shown as 0300 1234567. One traveler record per phone; a new inquiry updates its name, language and email. Each lead also keeps the name, email and language given with its own inquiry, and everything about that lead (quote emails, the quote page, staff screens) uses those: a later inquiry from the same phone never redirects an earlier quote, and a lead without an email gets no email (staff share the link) | Launch |
| 121 | Consent | Checkbox with versioned text (`CONSENT_TEXT_VERSION = 2026-11-v1`); the lead stores version, time and IP. Change the version whenever the wording changes. The wording needs legal review with the privacy policy | Launch |
| 122 | Inquiry when the trip cannot be priced (no FX rate) | The inquiry is still accepted; the trip inputs are stored on the lead and staff price it in the quote. A past arrival date is still rejected | Launch |
| 123 | Reference numbers | `MSF-YYYY-NNNNNN`, a counter per year in Pakistan time | — |
| 124 | Quote versions | A draft is edited in place. "Make a new version" copies a sent quote into a new draft; the old link keeps working until the new version is **sent**, then shows "This quote was replaced" with a button to the newest version (same link, `?v=latest`). One open draft per lead. A sent quote cannot be edited | — |
| 125 | Link to the new version | The old link can open the newest version because only the customer holds it. No raw token is stored for any version | — |
| 126 | Quote links | 32 random bytes (43 characters). Only the sha256 is stored; the raw link is shown to staff once when sent. "New link" replaces it (the old link stops working). Unknown or malformed links all get the same 404. Public answers contain no internal ids, no phone or email; `Cache-Control: no-store`; the page asks search engines not to index it | — |
| 127 | Expiry | Staff pick the last valid day; it ends 23:59 Pakistan time. Default: 3 days after today. A sent quote becomes "expired" the first time anyone looks after that (audited as the system) | Launch |
| 128 | Accepting | Records "Request accepted — we will confirm with suppliers" and moves the lead to accepted. Accepting twice is harmless. An expired, replaced or declined quote cannot be accepted. Sending a new version after the customer accepted the previous one is blocked | — |
| 129 | Quote totals | Each line is quantity × unit in its own currency. SAR lines → whole rupees per line; PKR lines → SAR rounded half up to the halala. Totals are line sums. FX is taken when the draft is saved and fixed when sent | — |
| 130 | Quote prefill | From the calculation: hotel and visa lines in SAR with supplier and sheet, and its exclusions. Flights and "Request a quote" items are listed for staff as "Still to price" | — |
| 131 | Default quote terms | Four plain sentences (currencies, rates can change, accepting is a request, visa decisions rest with the authority). Staff can edit per quote. Needs legal review | Launch |
| 132 | Emails | Resend in production (required: `RESEND_API_KEY`, `MAIL_FROM`; the API will not start without them, and `MAIL_FROM` is required whenever a key is set). Quote links use `PUBLIC_SITE_URL`, which production requires as a real `https://` address (no credentials, query or fragment; not localhost); blank in development = http://localhost:5175; log-only in development (kind and subject only, never addresses). Customer acknowledgement and quote link in their language; staff notices (new inquiry, accepted, question) only if `STAFF_NOTIFY_EMAIL` is set, with the reference and an admin link but no customer details. A failed email never fails the request | Launch |
| 133 | Who sees what | Leads: admin and sales manage; ops and finance read. Quotes: admin and sales build and send; finance reads; ops sees no quotes (not even on the lead page). Assignments only to active admin or sales users | — |
| 134 | Declining | Staff set the lead to declined; the sent quote becomes declined too. The customer page has no "decline" button (spec lists Accept and Ask a question only) | Phase 7 |
| 135 | Browser flow test | `npm run e2e:flow` (its own Playwright config, so it runs the same in Windows shells) starts its own API on a database it **wipes** (only one named exactly `marafiq_e2e`, and only with `E2E_ALLOW_DB_RESET=true` set by whoever runs it; the seed reads only the variables it is given, never `.env`, and refuses `NODE_ENV=production`), seeds the WMT sheet with dates moved to start 20 days from today, and runs the whole flow. CI runs it with a MongoDB service | — |
| 136 | Quotes at the same moment (Phase 6 review) | A lead has at most one draft, one sent and one accepted quote. Two staff creating a quote or a new version at once: one succeeds, the other gets 409 `draft_exists` with the winning draft's id. A draft cannot be sent while the customer holds another sent quote for the lead that it does not replace (409 `other_quote_sent`). A lead accepted through one quote cannot be accepted through another (409 `quote_other_accepted`). Kept by re-checking inside the transaction (each change first writes the lead, so two changes conflict and one is retried) and, as the last line, by the unique index `one_live_quote_per_status` on quotes `{leadId, status}` for those three statuses, which also holds on a single server without transactions. It needs MongoDB 6.0 or newer (`$in` in a partial index) | Launch |
| 137 | Renewing a link at the same moment as an acceptance | Whichever is stored first wins. Accepted first: the renewal is refused (409 `quote_not_sent`) and the customer's link keeps working. Renewed first: the old link gets the usual 404 and accepts nothing; the new link can be accepted | — |
| 138 | A write refused by a unique index that no service expected | Answered as 409 `conflict` ("changed by someone else at the same time"), never 500, and never with the database's message (it names the duplicated value) | — |
| 139 | Security headers (Phase 7) | API: helmet with no content security policy (it returns JSON and supplier files), `X-Frame-Options: SAMEORIGIN` so staff can preview PDFs in a same-site frame, `Cross-Origin-Resource-Policy: same-site`. Web: strict same-origin policy in `apps/web/public/_headers` (no third-party scripts, styles, fonts or connections) | Phase 7 |
| 140 | Spam check on inquiries (Phase 7) | Honeypot field `website` (off-screen, out of tab order, hidden from screen readers) or more than two links in the notes: the API answers 201 with a decoy reference and stores and sends nothing | Phase 7 |
| 141 | Logs (Phase 7) | One line per request: request id, method, route **pattern** (never the URL, which can hold a quote token), status, duration. JSON in production. No names, phones, emails, IPs, bodies or raw driver messages. Successful health checks are not logged | Phase 7 |
| 142 | Sentry (Phase 7) | API only, on when `SENTRY_DSN` is set. No automatic request capture; every event loses its request, user, breadcrumbs and messages before sending. The web app does not report to Sentry yet | Phase 7 |
| 143 | Indexes in production (Phase 7) | Start-up creates missing indexes but never drops one; undeclared indexes are logged. `npm run db:indexes -w @marafiq/api -- --yes` drops them on purpose | Phase 7 |
| 144 | Backups (Phase 7) | `mongodump --archive --gzip` to a separate private R2 bucket with a SHA-256, 30-day retention keeping at least the newest 7. Restore always names its target, checks the checksum, and refuses the live database without `--allow-live-database`. Schedule still to choose (docs/DEPLOY.md §10) | Phase 7 |
| 145 | Origin lock or CORS, not both (Phase 7) | `ORIGIN_PROXY_SECRET` and `WEB_ORIGIN` together are refused at startup: in a split deployment browsers call the API directly and cannot send the proxy secret, so every request would get 403 | Phase 7 |
| 146 | Zod in the browser (Phase 7) | The web app sets Zod's `jitless` mode before any schema is created (`apps/web/src/zod-csp.ts`, first import in `main.tsx`), so validation never uses `new Function` and the site's CSP needs no `'unsafe-eval'`. Same results, no generated code. The API keeps Zod's default | Phase 7 |
| 147 | Malware scanning (Phase 7, SEC gap) | ClamAV daemon over TCP (`INSTREAM`), `CLAMAV_HOST`/`CLAMAV_PORT`, no extra package. Document intelligence parses a file only after an explicit clean verdict; unreachable, timed-out, oversized or unexpected answers all count as not clean. Without `CLAMAV_HOST` files are kept but never parsed. Rate-sheet uploads (AI reading path) are not scanned yet. There is no public upload | Phase 7 |
| 148 | Duplicate inquiries sent at the same moment (SEC-06) | A claim row per de-duplication key (hashed phone + trip, 24 h, unique `_id`, TTL) taken inside the inquiry's transaction. The second of two identical inquiries gets the first one's reference with `duplicate: true` and sends no emails. A claim with no lead behind it is removed and the inquiry stored | Phase 7 |
| 149 | Sign-in lock-outs (SEC-07) | Kept in MongoDB (`loginAttempts`, keys stored as SHA-256, TTL), same limits as before (5 per 15 min per IP, email and 2FA user). A restart or deploy no longer resets them. Public rate limits stay in memory (one API process) | Phase 7 |
| 150 | Rate-sheet readings interrupted by a restart (SEC-10) | Checked at start-up and every minute: a reading still `extracting` after 10 minutes is marked failed exactly like a failed reading ("Extraction failed — enter manually or retry", audit `sourceDocument.extract_failed`, failure `interrupted`). Document-intelligence jobs already recover through their leases | Phase 7 |
| 151 | Error reports from the browser | Not added. Server errors already reach Sentry. A browser SDK would add a third-party connection to the strict CSP and could capture customer form data from the page; revisit after launch if staff report errors the API does not see | Phase 7 |

## Open items carried over

- **Duplicate rate-sheet upload** (reported after Phase 3): still seen on the owner's machine after the fix package. Parked at the owner's request (still parked after Phase 5). To check later: the browser Network tab response for the second upload (409 or 201?), the API startup log ("Index could not be synced"), and whether the integrated `documents.service.ts` matches the delivered one.
- **Rate limits** on public routes (inquiries 5/hour per IP, 60/min overall): done in Phase 7 (decision 103).
- **Urdu text** is an AI draft; a native speaker must approve `apps/web/src/locales/ur.json` and the Urdu emails in `apps/api/src/modules/leads/emails.ts` before launch (decision 15).
