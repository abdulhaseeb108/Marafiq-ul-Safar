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
| 30 | `docs/seed/` (sample PDFs, `waqar-sample.json`) was not supplied | Folder is empty; T8 uses the numbers printed in doc 03 | Phase 3 |
