# 01 — Product Spec (MVP: Umrah calculator + assisted quote)

## 1. Scope
**In:** bilingual public site; Umrah calculator driven by published supplier rates; inquiry → reference number; admin portal (rate sheet upload/review/publish, FX and markup settings, leads, quote builder, users); customer quote page by private link; email notifications; audit log.
**Out (do not build):** online payments, customer accounts/passwords, live hotel or flight search, ticket issuing, visa processing, supplier portal, mobile app, WhatsApp API automation, Hajj.

## 2. Users
- **Traveler** (anonymous): uses calculator, submits inquiry, opens quote link.
- **Sales:** manages leads, builds and sends quotes.
- **Ops:** uploads and reviews rate sheets, publishes rates.
- **Finance:** views quotes and totals (read-only in MVP).
- **Admin:** everything plus users, settings (FX, markup), audit log.

## 3. Public site pages
Home · Umrah (calculator + explanation) · Flights (inquiry) · Hotels (inquiry + published hotel list with distance) · Visa consultation (checklist + inquiry; "decisions rest with the issuing authority") · Transport (inquiry) · FAQ · Policies (privacy, terms, quote terms) · Contact · Quote view (`/q/:token`). Language switch EN/اردو in header. Currency switch PKR / SAR (default PKR, SAR shown beside).

## 4. Umrah calculator
**Inputs**
| Field | Notes |
|---|---|
| Departure city | Dropdown of cities that have a flight estimate row, plus "Other city" (flight → Request a quote). Free-text allowed for "Other". |
| Arrival date in Saudi Arabia | Date picker; optional flexibility ±days (informational only). |
| Nights in Makkah, nights in Madinah, and stay order | Order = Makkah first or Madinah first. Dates per night are derived from this. |
| Travelers | Adults, children (2–11), infants (<2). |
| Rooms | One entry per room: occupancy type (double, triple, quad, quint-sharing) or "whole room"; number of travelers in it. |
| Hotel | Pick a specific hotel per city from published hotels (shows distance/shuttle text and price per night), or "Show me the cheapest / nearest option". |
| Visa type | Direct flight from Pakistan, or indirect flight via other country. |
| Flight | Include estimate (if city has one) or "I will arrange flights". |
| Extras | Ziyarah, guide, mobility support, transfers: **always "Request a quote"** in MVP (no rate sheets yet). |

**Pricing logic:** see `03-RATE-SHEET-INGESTION-AND-PRICING.md` §6. Priced night by night from published rate packages.

**Output screen**
- Line items: hotels per night group, visa, flight estimate (range) if available, extras (quote needed).
- Per-person and group total, in PKR with SAR beside each amount.
- Assumptions list, exclusions list, "rates can change without notice", supplier name and sheet issue date, estimate expiry (default 72 hours or the earliest pack end, whichever is sooner).
- Missing pieces clearly marked "Request a quote" and excluded from totals; the total is labeled "Estimate for priced items only" when anything is missing.
- Button **Request a confirmed quote** → inquiry form prefilled with the calculation.
- Calculations are saved on submit (snapshot) with a rule/version id and timestamp.

## 5. Inquiry and lead flow
1. Form: name, phone (WhatsApp preferred, Pakistani format validated), email optional, preferred language, notes, consent checkbox (with consent text version stored), calculation snapshot attached.
2. Server creates lead with reference `MSF-YYYY-NNNNNN` (sequence), suppresses duplicates (same phone + same calculation hash within 24 hours returns the existing reference), sends an acknowledgement email if email given, and shows the reference on screen with "We will reply within [configurable] hours".
3. Staff see lead in admin pipeline: `new → contacted → quote_in_progress → quote_sent → accepted / declined / lost`.
4. Staff build a quote (see §7), send it; customer opens `/q/:token`.
5. Customer can press **Accept quote** (records acceptance, notifies staff) or **Ask a question** (message to staff). Acceptance means "request accepted", not "booked". Payment and confirmation happen offline in this version; staff update status to `confirmed` only when every component is confirmed with suppliers (orders module is out of MVP; status stays on the quote/lead).

## 6. Admin portal screens
1. **Login** (+ 2FA for admin).
2. **Dashboard:** new leads, quotes expiring in 48h, rate packs expiring in 14 days, last published rate version.
3. **Rate sheets:** upload; list with status (`uploaded → extracting → needs_review → published / rejected / superseded`); review screen (image left, editable table right, validation messages); publish; roll back to a previous published version.
4. **Hotels master:** list, aliases, distance, notes (edit; merge duplicates).
5. **Settings:** SAR→PKR rate (with effective date, history), markup percent (default 0), estimate expiry hours, response-time text, flight estimate table (city → low/high PKR per adult, validity).
6. **Leads:** table with filters, assignment, notes, status.
7. **Quote builder:** from a lead; line items (add/edit/remove), supplier per line, currency, exclusions, terms text, expiry date; totals recalc; version history; "Send" emails the private link; copy-link button (for WhatsApp).
8. **Users and audit log** (admin).

## 7. Quote rules
- Quote has `version`, `expiresAt`, `lineItems[]` (description, supplier, quantity, unit amount, currency, notes), `exclusions[]`, `terms`, totals in PKR and SAR with the FX rate stored.
- Editing a sent quote creates a new version; the old link shows "This quote was replaced" with a link to the new one.
- Expired quotes display "Expired — request a new quote".
- Quote page shows plain status words: Draft (staff only), Sent, Accepted (request), Expired, Replaced. Never "Booked".

## 8. Content and tone
Plain, respectful English and Urdu. Muslim-travel attributes (prayer room, halal food, qibla, family privacy) appear only when a source and verification date are stored; otherwise show nothing. No "halal certified", "best price", or "guaranteed" claims.

## 9. Non-functional
- Mobile first, fast on 4G: Lighthouse performance ≥ 85 on home and calculator at 360px.
- WCAG 2.2 AA design target; Urdu font (Noto Nastaliq Urdu or Jameel-like fallback stack) with comfortable line height.
- Rate limiting on public endpoints; honeypot + simple captcha-free spam check on inquiry.
- Backups: nightly `mongodump` to bucket; restore tested.
- Observability: Sentry; structured logs without personal data.

## 10. Acceptance (MVP done when)
1. Uploading `docs/seed/` sample sheets produces a draft with zero blocking errors after review, and publishing makes the calculator return correct totals (see test cases in doc 03 §7).
2. A traveler can complete calculator → inquiry → reference number on a 360px phone in English and Urdu.
3. Staff can send a quote and the traveler can open, read, and accept it via link.
4. A new rate upload does not change any saved calculation or sent quote.
5. Role and token permission tests pass; no endpoint leaks another lead or quote.
6. Restore from backup works.
