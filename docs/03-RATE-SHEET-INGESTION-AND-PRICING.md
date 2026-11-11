# 03 — Rate Sheet Ingestion and Pricing Engine

## 1. What the first supplier sheets look like (reference)
Supplier: **Waqar-e-Madina Group (WMT)**, Islamabad. Three packs, all effective 27 Oct 2026, all prices in **SAR per night**:

| Pack | Nights (inclusive) |
|---|---|
| Ramadan Pack 01 | 6 Feb 2027 – 26 Feb 2027 |
| Ramadan Pack 02 | 27 Feb 2027 – 10 Mar 2027 |
| Shawal | 11 Mar 2027 – 6 Apr 2027 |

Header block on every pack: visa rate **550 SR** (direct flight, departure from Pakistan, transport by bus for 1–49 pax); **indirect flight via other country: 625 SR (4 pax), 650 SR (3 pax), 675 SR (2 pax), 700 SR (1 pax)**; **infant visa 460 SR**. Note: "Hotel voucher rates are not linked with visa issuance date." Footer: "Rates can be changed at any time without prior notice."

Hotel table columns: hotel name (with aliases like "OLD NAME: …"), distance/shuttle text, then `SHARING QUINT LIMITED | QUAD | TRPL | DUBL | ROOM` (per night; first four are per person, last is per room). Row types:
1. **Normal rows** — five numbers. Per-person values = `ceil(roomPrice / occupancy)` with occupancy 5/4/3/2. Example: Qila Ajiyad (Pack 01) room 200 → 40 / 50 / 67 / 100.
2. **Flat-room rows** — e.g. Fundaq Bilal and Al Kiswah Tower show one value like "200-SR" under all columns marked ROOM BASIS. Treat as `flat_per_room` (price per room per night regardless of occupancy). **Flag for staff confirmation** on first import.
3. **Room-basis rows** — e.g. Akabir Hijrah: only room price is meaningful; per-person columns are labeled ROOM BASIS. Treat as `flat_per_room` using the ROOM value.
4. **ON BOOKING rows** — Voco, Novotel Thakher, M Hotel, M Millenium Dana, Four Points. No price → `on_request`.
Sheets can arrive as a clean PDF and as a scanned copy with a different issue date (17 Oct vs 27 Oct seen). Treat a same-pack, different-date file as a **conflict** for staff to resolve.

Seed examples are in `docs/seed/waqar-sample.json`.

## 2. Pipeline
1. **Upload** (admin/ops): PDF, PNG, JPG, up to 20 MB. Store original in bucket; compute SHA-256; reject exact duplicates (same supplier + hash) with a link to the existing record.
2. **Detect text layer** (pdf text). If the PDF has usable text, pass both text and page images; otherwise page images only.
3. **Extract**: call the Anthropic API with the page images and the schema in §3, one request per file, `temperature` low, `max_tokens` large enough for ~60 rows per page. Parse the JSON, validate with Zod. If JSON fails to validate, retry once with the validation error appended; then mark `needs_review` with message "Extraction failed — enter manually or retry".
4. **Normalize**: map hotel names to `hotels` by exact canonical name, then aliases, then fuzzy match (token similarity ≥ 0.85 suggests, never auto-merges). Unknown names become `new_hotel_candidates` for staff to confirm.
5. **Validate** (§4). Produce `blocking` and `warnings`.
6. **Review screen**: left = original page image (zoom, page switcher); right = editable table (pack header, visa rates, hotel rows). Cells with confidence < 0.9 or failed checks are highlighted. Staff edits set `edited=true`.
7. **Publish** (blocked while blocking errors exist): in one transaction set the pack `published`, mark any overlapping previous pack of the same supplier `superseded`, bump `version`, write audit events. Rolling back republishes the previous version.
8. **Never** overwrite a published pack in place; always create a new version.

## 3. Extraction schema (Zod/JSON; the model must return only JSON)
```json
{
  "supplierName": "string",
  "packName": "string",
  "seasonLabel": "string|null",
  "nightFrom": "YYYY-MM-DD",
  "nightTo": "YYYY-MM-DD",
  "effectiveFrom": "YYYY-MM-DD|null",
  "issueDate": "YYYY-MM-DD|null",
  "currency": "SAR",
  "visa": {
    "directPerPerson": 550,
    "indirectByGroupSize": {"1": 700, "2": 675, "3": 650, "4": 625},
    "infant": 460,
    "notes": "string|null"
  },
  "hotels": [
    {
      "city": "makkah|madinah",
      "name": "string (as printed)",
      "aliasesPrinted": ["string"],
      "distanceText": "string|null",
      "distanceMeters": "number|null",
      "transportText": "string|null",
      "pricingMode": "derived_per_person|flat_per_room|on_request",
      "room": "number|null",
      "perPerson": {"quint": "number|null", "quad": "number|null", "triple": "number|null", "double": "number|null"},
      "flatNote": "string|null",
      "page": 1,
      "row": 1,
      "confidence": 0.0
    }
  ],
  "warnings": ["string"]
}
```
Amounts are whole SAR as printed (store as minor units after validation). Ignore the Urdu terms/conditions paragraph. Never guess a number that is unreadable; use `null` and lower `confidence`.

### Extraction prompt (system)
> You read Umrah supplier rate sheets (Pakistan travel agencies; Urdu and English) and return structured data. Return ONLY JSON matching the schema provided. Do not add commentary. Copy hotel names exactly as printed; put "OLD NAME" variants into `aliasesPrinted`. For each hotel row read the five numbers left to right as quint-sharing, quad, triple, double, room. If a row shows an identical number such as "200-SR" under every column with the label ROOM BASIS, set pricingMode `flat_per_room`, put that number in `room`, and explain in `flatNote`. If a row says "ON BOOKING", set pricingMode `on_request` with no prices. Read dates from the header ("NIGHTS FROM … > …") and the effective and issue dates in the header and footer. If any value is unclear, return null and lower the row's confidence; never invent values. The sheet may be a photo or scan; read carefully.

## 4. Validation rules
**Blocking (cannot publish):**
- Missing `nightFrom`/`nightTo`, or `nightTo < nightFrom`.
- `currency` is not SAR (flag; support only SAR in v1).
- Any hotel row with `derived_per_person` and no `room` value.
- Any negative or zero price (except `on_request`).
- Pack dates overlap another **published** pack of the same supplier without being marked as a replacement.
- Unconfirmed `new_hotel_candidates` remain.
- Visa `directPerPerson` or any group-size visa rate missing.

**Warnings (staff must acknowledge):**
- Derived check: for each normal row, `|perPerson[o] − ceil(room/o)| > 1` for any occupancy `o ∈ {5,4,3,2}` (printed value mismatches the room price).
- Price change > 25% vs the same hotel in the previous published pack of the same season label, or vs the nearest previous pack.
- Hotel count differs from previous pack by more than 3.
- Issue date older than 45 days or missing.
- A flat-room row seen for the first time (confirm meaning).
- Same pack dates already exist with a different issue date (possible conflict/duplicate).
- Confidence < 0.9 on any price cell.

## 5. Money and FX
- Supplier amounts stored in SAR halalas (×100). Settings hold `fxRate` SAR→PKR as a decimal string; convert with integer math: `pkrMinor = round(sarMinor × rateScaled / scale)` where rate is scaled by 10,000. Displayed PKR rounds to whole rupees (half up) per line item; totals sum the rounded line items.
- **Markup** (default 0%): applied to SAR line amounts with `ceil` before FX. With markup 0 the customer sees prices exactly as given by the supplier. Always display supplier name and sheet issue date.
- Do not mix rounding rules; write one `money.ts` with tests (halala/paisa conversion, ceil division, rounding).

## 6. Pricing engine (`apps/api/src/modules/pricing/`)
Pure function: `calculate(inputs, ctx) → Calculation` where `ctx` contains published packages + rates + visa + flight estimates + settings + FX. No database calls inside; the service loads the context and passes it in so tests are deterministic.

**Steps**
1. Build the night list from `arrivalDate`, `nightsMakkah`, `nightsMadinah`, `order`. Each night: `{date, city}`. (Makkah first: nights start at arrival in Makkah, then Madinah; reverse if Madinah first.)
2. For each night and chosen hotel, find the **published** package (supplier of that hotel) whose `[nightFrom, nightTo]` contains the date. If none → add to `missing` as "No published rate for <hotel> on <date>" → "Request a quote".
3. Find the hotel's `hotelRate` in that package:
   - `derived_per_person`: for each room, take the room's occupancy type (`double|triple|quad|quint`), use `perPerson[type] × personsInRoom` per night. If the room is a **whole room** (private use), use `room` price per night.
   - `flat_per_room`: use `room` price per room per night.
   - `on_request`: add to `missing`.
4. Persons: adults count fully; children count as adults when `childAsAdult` is true (default); infants have no hotel charge when `infantHotelCharge = none` (default; flag in assumptions).
5. Group consecutive nights with the same hotel, package and rate into one line item ("Qila Ajiyad, 3 nights × 4 persons × SAR 50"). Show pack name and issue date in the line's note.
6. **Visa:** persons = adults + children. Direct: `directPerPerson × persons`. Indirect: rate chosen by group size (`min(persons,4)` → table lookup; if persons > 4 use the 4-pax rate and add an assumption "5+ travelers priced at the 4-pax rate — confirm"). Infants: `infant × infantCount`. Add assumption "Visa rates are per person and include bus transport for 1–49 pax as printed on the supplier sheet — confirm with supplier."
7. **Flights:** if the departure city has a valid `flightEstimates` row, add a **range** line (low–high per adult) and mark totals as a range; otherwise add to `missing` ("Flight: request a quote").
8. **Extras** (ziyarah, guide, mobility support, transfers) always go to `missing` as "Request a quote".
9. Totals: sum priced items. If any `missing` exists or a flight range exists, `isPartial = true` and the label reads "Estimate for priced items only". Per-person total = group total ÷ persons (ceil, PKR).
10. Attach `assumptions[]`, `exclusions[]` (hotel taxes not stated on sheet, flights if missing, meals, transfers outside bus, ziyarah, personal expenses, anything under "request a quote"), `expiresAt = min(now + expiryHours, earliest nightTo among used packs)`, and a hash.

## 7. Required test cases (use FX 75.00 PKR per SAR, markup 0, for tests)
All use Waqar-e-Madina sample data; see seed file.

| # | Scenario | Expected |
|---|---|---|
| T1 | 4 adults, 1 quad room, arrive 8 Feb 2027, Makkah first: 3 nights Qila Ajiyad, 2 nights Waqar Salmiya (Madinah), direct visa, no flight | Makkah 50×4×3 = SAR 600; Madinah 54×4×2 = SAR 432; visa 550×4 = SAR 2,200. Total **SAR 3,232**; per person **SAR 808**; PKR total **242,400**; partial (flight/extras missing) |
| T2 | 2 adults, 1 double room, Makkah only 4 nights from 25 Feb 2027 (Qila Ajiyad), crosses Pack 01→02 | Nights 25–26 at 100 pp (Pack 01), 27–28 at 175 pp (Pack 02): 2×(100×2 + 175×2) = **SAR 1,100** hotel; two line items with different pack names |
| T3 | Arrival 10 Apr 2027 (after Shawal pack) | Hotel lines go to `missing` with "Request a quote"; no hotel total |
| T4 | 2 adults, double room, 3 nights Qila Ajiyad from 15 Mar 2027 (Shawal) | 48×2×3 = **SAR 288**; derived check passes (room 95: 48 = ceil(47.5)) |
| T5 | Hotel is Voco (on booking) | Line is `missing`; total partial; no number invented |
| T6 | 2 adults + 1 infant, indirect visa, any hotel | Visa 675×2 + 460 = **SAR 1,810**; infant hotel charge 0 with an assumption note |
| T7 | Same inputs as T1 but publish a new pack version, then reload the saved calculation | Saved calculation totals unchanged (snapshot) |
| T8 | Money: 66.666… rounding | Per-person derived check uses `ceil`; PKR conversion rounds half up; totals equal sum of rounded lines |
| T9 | Upload exact duplicate PDF | Rejected as duplicate with link to existing |
| T10 | Same pack dates, different issue date | Flagged as conflict warning; cannot auto-publish |

Also add property tests: total never negative; changing FX changes PKR only; identical inputs + versions give identical hash.

## 8. Flight estimates (v1)
Staff enter flight estimates manually in Settings (origin city, JED/MED, low/high PKR per adult, valid-to date, source note). They are shown as ranges with "estimate, not a fare quote". There is no live fare API in v1 and no ticket issuing; tickets are issued by a partner agency outside the system.
