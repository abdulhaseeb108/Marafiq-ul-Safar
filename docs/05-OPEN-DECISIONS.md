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
