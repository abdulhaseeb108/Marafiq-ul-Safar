# 05 — Open Decisions and Safe Defaults

The AI builder uses the **default** until you change it. Edit this file when you decide; the builder reads it.

| # | Question | Safe default used in the build | Needed before |
|---|---|---|---|
| 1 | Exact registered SMC name, address, NTN, contact details | Placeholder `[COMPANY NAME]` in footer and terms | Public launch |
| 2 | Travel agency license / Umrah operator permission, or partner who holds it | Site says "quote and planning service; services fulfilled by licensed partners" | Public launch and any payment |
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
| 44 | Client IP behind a proxy | One proxy hop is trusted in production only. Confirm this matches the host (Railway/VPS + Cloudflare) in Phase 7 | Phase 7 |
| 45 | CORS | Not enabled: the web app reaches the API on the same origin (Vite proxy in dev). The allow-list comes in Phase 7 | Phase 7 |
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
| 103 | Rate limits on public routes | Not yet; Phase 7 adds them (doc 02 §4: 60/min per IP) | Phase 7 |

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
| 117 | Quote view `/q/:token` | Not built; Phase 6 adds it with the quote tokens | Phase 6 |

## Open items carried over

- **Duplicate rate-sheet upload** (reported after Phase 3): still seen on the owner's machine after the fix package. Parked at the owner's request (still parked after Phase 5). To check later: the browser Network tab response for the second upload (409 or 201?), the API startup log ("Index could not be synced"), and whether the integrated `documents.service.ts` matches the delivered one.
- **Urdu text** is an AI draft; a native speaker must approve `apps/web/src/locales/ur.json` before launch (decision 15).
