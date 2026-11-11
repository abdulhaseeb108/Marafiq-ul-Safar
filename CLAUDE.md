# CLAUDE.md — Marafiq us Safar

Read this file at the start of every session. Then read the doc named in the current phase prompt.

## What we are building
A bilingual (English + Urdu, RTL) Umrah planning and assisted-quote website for Pakistan-origin travelers, operated by a Pakistan SMC private limited company. Staff upload supplier rate sheets (PDF/image from WhatsApp); the system extracts them with the Claude API, staff review and publish, and the public calculator prices trips from the published rates. Customers request a confirmed quote; staff build and send a dated quote. **No online payments in this version.**

Full detail: `docs/01-PRODUCT-SPEC.md`, `docs/02-DATA-MODEL-AND-API.md`, `docs/03-RATE-SHEET-INGESTION-AND-PRICING.md`, `docs/04-BUILD-PHASES.md`.

## Stack (do not substitute without asking)
- Monorepo (npm workspaces): `apps/web` (React + Vite + TypeScript + Tailwind + react-i18next), `apps/api` (Node 20 + Express + TypeScript), `packages/shared` (Zod schemas, enums, money helpers).
- MongoDB with Mongoose. Validation: Zod on every request body and on every Claude extraction result.
- Auth: staff = email + password (argon2), short-lived JWT in httpOnly cookie + refresh cookie, TOTP 2FA for admin role. Customers = no account; they open quotes by private token link.
- Files: S3-compatible bucket (Cloudflare R2) via `@aws-sdk/client-s3`. Email: Resend. Errors: Sentry.
- AI extraction: Anthropic SDK, model id from env `EXTRACTION_MODEL` (default `claude-sonnet-5-5`).
- Tests: Vitest + Supertest; Playwright for 3 end-to-end flows. Lint: ESLint + Prettier.

## Hard rules
1. **Money is integer minor units** (SAR halalas, PKR paisa). Never use floating point for money. All arithmetic goes through `packages/shared/src/money.ts`. Rounding rule for per-person rates: `ceil`.
2. **Status words.** Never show the word "booked" or "confirmed" to a customer unless the order status is `confirmed`. Allowed statuses are defined once in `packages/shared/src/status.ts` with a transition table. Every transition writes an audit event.
3. **Every price shown carries**: supplier, pack dates, issue date of the sheet, currency, "rates can change without notice", and the quote/estimate expiry.
4. **Snapshots.** A saved calculation stores inputs, rate-package ids, FX rate, markup, line items, totals and timestamp. Publishing new rates never changes old calculations or quotes.
5. **Never publish unreviewed extraction.** Extracted rates are `draft` until a staff user clicks Publish. Publish is blocked while any blocking validation error exists.
6. **Do not collect** passport numbers, CNIC, or card data. No personal data in logs. No secrets in the repo; use `.env` (see `.env.example`).
7. **Role checks on every route.** Roles: `admin`, `sales`, `ops`, `finance`. Customer quote links use 32+ byte random tokens, expire, and expose only that quote.
8. **Do not invent data.** If a price, hotel or date is missing, the UI shows "Request a quote". Never estimate live fares from static data.
9. **Do not make claims** that a hotel is halal-certified, that a visa is guaranteed, or that anything is "best price".
10. Small print on supplier sheets (Urdu terms about visa refunds and overstay) is **not parsed**; the original file is stored and linked for staff.

## Conventions
- TypeScript strict. No `any` without a comment. Functions small and tested.
- Folder per domain in `apps/api/src/modules/<name>/` (routes, controller, service, model, tests).
- Provider adapters in `apps/api/src/adapters/` (storage, email, extraction, fx) behind interfaces so vendors can change.
- Conventional commits. One branch per phase task. Tests must pass before you say a task is done.
- UI text lives in `apps/web/src/locales/{en,ur}.json`. Urdu layout uses `dir="rtl"`; test every page in both.
- Accessibility target: WCAG 2.2 AA. Mobile first (test at 360px width).

## Commands (create these scripts in Phase 0)
`npm run dev` · `npm run build` · `npm test` · `npm run lint` · `npm run seed` · `npm run e2e`

## Working method
For each task: restate the goal in two lines, list files you will touch, write tests first for pricing/status/permissions, implement, run tests, then report: what changed, assumptions made, what to test by hand. If a requirement is ambiguous, pick the safest option in `docs/05-OPEN-DECISIONS.md`, note it, and continue; do not stop to ask unless data loss or security is involved.
