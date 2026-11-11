# 02 — Data Model and API

All ids are Mongo ObjectIds. All timestamps UTC. Money fields end in `Minor` and are integers (SAR halalas / PKR paisa). Every collection has `createdAt`, `updatedAt`. Define matching Zod schemas in `packages/shared`.

## 1. Collections

**users** — `email` (unique), `name`, `passwordHash`, `role` (`admin|sales|ops|finance`), `totpSecretEnc?`, `active`, `lastLoginAt`.

**suppliers** — `name`, `type` (`hotel_operator|transport|flight_partner|other`), `contactName`, `phone`, `email`, `notes`, `active`.

**hotels** — `city` (`makkah|madinah`), `canonicalName`, `aliases[]`, `distanceMeters?`, `distanceNote` (e.g. "Shahra Ajiad", "Masjid Bilal side"), `transport` (`walking|shuttle|unknown`), `starRating?` (only if supplier states it), `active`.

**sourceDocuments** — `supplierId`, `fileKey`, `fileName`, `mimeType`, `sha256` (unique per supplier), `receivedAt`, `issueDate?`, `uploadedBy`, `extractionStatus`, `extractionModel`, `extractionRaw` (JSON), `notes`.

**ratePackages** — `supplierId`, `sourceDocumentId`, `packName` ("Ramadan Pack 01"), `seasonLabel`, `nightFrom` (date), `nightTo` (date, inclusive), `effectiveFrom`, `issueDate`, `currency` (`SAR`), `status` (`draft|needs_review|published|superseded|rejected`), `version`, `supersedesId?`, `publishedAt?`, `publishedBy?`, `validation` (`{blocking:[], warnings:[]}`).

**hotelRates** — `packageId`, `hotelId`, `pricingMode` (`derived_per_person|flat_per_room|on_request`), `roomPriceMinor?` (per night), `perPersonMinor` (`{quint, quad, triple, double}`, optional), `flatNote?`, `sourcePage`, `sourceRow`, `confidence` (0–1), `edited` (bool, staff changed it).

**visaRates** — `packageId`, `direct`: `{perPersonMinor}`, `indirectByGroupSize`: `{1,2,3,4: perPersonMinor}`, `infantMinor`, `appliesNote` (e.g. "Transport by bus for 1–49 pax" — shown to staff only until confirmed).

**fxRates** — `base` (`SAR`), `quote` (`PKR`), `rate` (decimal string, e.g. "74.50"), `effectiveAt`, `setBy`.

**settings** (single doc) — `markupPercent` (default 0), `estimateExpiryHours` (72), `responseTimeText`, `infantHotelCharge` (default `none`), `childAsAdult` (default true).

**flightEstimates** — `originCity`, `destination` (`JED|MED`), `season?`, `lowMinor`, `highMinor`, `currency` (`PKR`), `validTo`, `note`, `source` (free text, e.g. "partner quote 2026-11-05").

**calculations** — `inputs`, `rateVersionSnapshot` (`[{packageId, version, supplierId, issueDate}]`), `fx` (`{rate, effectiveAt}`), `markupPercent`, `lineItems[]`, `missing[]`, `assumptions[]`, `exclusions[]`, `totals` (`{perPersonMinorPKR, groupMinorPKR, groupMinorSAR, isPartial}`), `expiresAt`, `hash` (of inputs + versions), `engineVersion`.

**travelers** — `name`, `phone`, `email?`, `language`.

**leads** — `reference` (unique), `travelerId`, `calculationId?`, `source`, `status`, `assignedTo?`, `notes[]`, `consent` (`{textVersion, acceptedAt, ip?}`), `dedupeKey`.

**quotes** — `leadId`, `version`, `status` (`draft|sent|accepted|declined|expired|replaced`), `lineItems[]`, `exclusions[]`, `terms`, `fx`, `totals`, `publicTokenHash` (store hash; send raw token only in link), `expiresAt`, `sentAt?`, `acceptedAt?`, `replacedById?`.

**messages** — `leadId`, `direction`, `body`, `channel` (`email|whatsapp_manual|site`), `by`.

**auditEvents** — `actorId?`, `actorRole`, `action`, `entityType`, `entityId`, `before?`, `after?`, `ip?`, `at`.

**Indexes:** `leads.reference` unique; `leads.dedupeKey`; `quotes.publicTokenHash` unique; `sourceDocuments {supplierId, sha256}` unique; `ratePackages {supplierId, nightFrom, nightTo, status}`; `hotelRates {packageId, hotelId}` unique; `auditEvents {entityType, entityId, at}`.

## 2. Status enums (in `packages/shared/src/status.ts`)
- Rate package: `draft → needs_review → published → superseded`; `draft|needs_review → rejected`.
- Lead: `new → contacted → quote_in_progress → quote_sent → accepted | declined | lost`; any → `lost`.
- Quote: `draft → sent → accepted | declined | expired | replaced`.
- Customer wording map (`en`/`ur`): sent = "Quote sent", accepted = "Request accepted — we will confirm with suppliers", never "booked".

## 3. Permission matrix
| Action | admin | sales | ops | finance | public |
|---|---|---|---|---|---|
| Upload/review/publish rates | ✓ | – | ✓ | – | – |
| Edit settings, FX, markup | ✓ | – | – | – | – |
| View/manage leads | ✓ | ✓ | read | read | – |
| Build/send quotes | ✓ | ✓ | – | read | – |
| Manage users, view audit | ✓ | – | – | – | – |
| Run calculator, submit inquiry | – | – | – | – | ✓ |
| View quote by token | – | – | – | – | ✓ (own) |

## 4. API (REST, JSON, `/api/v1`)
Public:
- `GET /public/config` → languages, FX rate, markup flag, city list for departure.
- `GET /public/hotels?city=` → published hotels with distance/transport text and "from" price info.
- `POST /public/calculate` → body: calculator inputs; returns calculation (not saved).
- `POST /public/inquiries` → body: traveler, consent, inputs (server recalculates and stores snapshot); returns `{reference}`.
- `GET /public/quotes/:token` · `POST /public/quotes/:token/accept` · `POST /public/quotes/:token/message`.

Auth: `POST /auth/login` · `/auth/2fa` · `/auth/refresh` · `/auth/logout`.

Admin (role-checked):
- Rate sheets: `POST /admin/source-documents` (multipart) · `GET /admin/source-documents` · `POST /admin/source-documents/:id/extract` · `GET /admin/rate-packages/:id` (with rates and validation) · `PATCH /admin/hotel-rates/:id` · `POST /admin/rate-packages/:id/validate` · `POST /admin/rate-packages/:id/publish` · `POST /admin/rate-packages/:id/reject` · `POST /admin/rate-packages/:id/rollback`.
- Hotels: `GET/POST/PATCH /admin/hotels` · `POST /admin/hotels/:id/merge`.
- Settings: `GET/PUT /admin/settings` · `POST /admin/fx` · `GET /admin/fx`.
- Flight estimates: CRUD `/admin/flight-estimates`.
- Leads: `GET /admin/leads` · `GET/PATCH /admin/leads/:id` · `POST /admin/leads/:id/notes`.
- Quotes: `POST /admin/leads/:id/quotes` · `PUT /admin/quotes/:id` · `POST /admin/quotes/:id/send` · `POST /admin/quotes/:id/new-version`.
- Users: CRUD `/admin/users` · `GET /admin/audit`.

All admin writes emit an audit event. All inputs validated by Zod; errors return `{error:{code,message,fields?}}`. Public routes are rate limited (e.g. 60/min per IP; inquiries 5/hour per IP).

## 5. Environment variables (`.env.example`)
`NODE_ENV, PORT, MONGODB_URI, JWT_SECRET, JWT_REFRESH_SECRET, COOKIE_DOMAIN, WEB_ORIGIN, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, RESEND_API_KEY, MAIL_FROM, ANTHROPIC_API_KEY, EXTRACTION_MODEL=claude-sonnet-5-5, SENTRY_DSN, PUBLIC_SITE_URL`.
