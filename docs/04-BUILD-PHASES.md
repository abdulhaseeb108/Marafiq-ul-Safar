# 04 — Build Phases (paste one prompt at a time into Claude Code)

Use Claude Fable 5.2 for Phases 0, 3, 4 and 7 (foundations, ingestion, pricing, security). Sonnet 5.5 is fine for the rest. After each phase: run `npm test`, run the app, check the acceptance list by hand, commit, then start the next phase in a fresh session (CLAUDE.md is re-read automatically).

Every prompt starts with the same line:
> Read CLAUDE.md and the docs named below. Follow the Working method. Write tests first for pricing, status and permissions. When done, report changes, assumptions, and what I should test by hand.

---

## Phase 0 — Scaffold and shared package
**Prompt:** Read `docs/01` §1–2 and `docs/02` §1–2, §5. Create the npm-workspaces monorepo (`apps/web`, `apps/api`, `packages/shared`) with TypeScript strict, ESLint, Prettier, Vitest, `.env.example`, `.gitignore`, a GitHub Actions CI that runs lint + test + build, and the scripts listed in CLAUDE.md. In `packages/shared` implement and test: `money.ts` (integer SAR/PKR helpers, ceil division, scaled-rate conversion, half-up rounding), `status.ts` (enums + transition tables + customer wording map in en/ur), and Zod schemas for every collection in doc 02. Add an Express health endpoint and a Vite hello page that renders in English and Urdu (RTL).
**Accept:** CI green; `money` tests cover T8 in doc 03; health endpoint returns 200; Urdu page shows RTL.

## Phase 1 — Auth, users, audit
**Prompt:** Read `docs/02` §1 (users, auditEvents), §3. Implement staff auth (argon2, JWT access + refresh in httpOnly cookies, login rate limiting, TOTP 2FA required for `admin`), user CRUD (admin only), role middleware, and an audit-event service used by all admin writes. Seed one admin from env on first run. Add Supertest tests for every role against every protected route created so far.
**Accept:** wrong role gets 403; no token gets 401; audit event written on user create/update; 2FA flow works.

## Phase 2 — Masters: suppliers, hotels, settings, FX, flight estimates
**Prompt:** Read `docs/02` §1, §4 (Hotels, Settings, Flight estimates) and `docs/01` §6 items 4–5. Implement models, services, admin routes and minimal admin UI (React) for suppliers, hotels (with aliases and merge), settings (markup, expiry hours, infant charge, child-as-adult), FX rates with history, and flight estimates. Seed the Waqar-e-Madina supplier and an initial FX rate placeholder from env.
**Accept:** CRUD works with validation; FX history keeps old rows; all writes audited.

## Phase 3 — Rate sheet ingestion and publishing
**Prompt:** Read `docs/03` fully and `docs/02` (sourceDocuments, ratePackages, hotelRates, visaRates). Implement upload to the bucket adapter (with a local-disk adapter for dev), SHA-256 duplicate check, the extraction adapter that calls the Anthropic SDK with page images and the schema/prompt in doc 03 §3 (mock the adapter in tests using fixtures from `docs/seed/waqar-sample.json`), normalization with alias matching, all validation rules in §4, the review screen (image left, editable table right, highlighted problems), publish/reject/rollback in a transaction, and supersede logic. Never expose raw model output to the public.
**Accept:** T9 and T10 pass; publishing blocked while blocking errors exist; editing a cell marks `edited`; rollback restores previous version; a manual end-to-end run with one real sheet works.

## Phase 4 — Pricing engine and public calculate API
**Prompt:** Read `docs/03` §5–7 and `docs/01` §4. Implement the pure `calculate()` function and the service that loads context from the DB. Add `POST /public/calculate`, `GET /public/hotels`, `GET /public/config`. Implement T1–T8 as unit tests with the seed data and exact expected numbers from doc 03 §7. Add property tests. Ensure saved calculations are immutable snapshots.
**Accept:** T1 = SAR 3,232 / PKR 242,400; T2 = SAR 1,100 hotel; T3, T5 produce `missing`; changing published rates does not change saved snapshots.

## Phase 5 — Public site and calculator UI
**Prompt:** Read `docs/01` §3, §4, §8, §9. Build the public pages, header language switch (EN/اردو), PKR/SAR switch, the calculator form and result screen exactly as specified (missing items shown as "Request a quote"; partial totals labeled). Use Tailwind, mobile first at 360px, WCAG 2.2 AA basics (labels, focus, contrast), and an Urdu font stack. Policies pages use placeholder text marked `[LEGAL REVIEW NEEDED]`. Add Playwright test: calculator → result on mobile viewport in both languages.
**Accept:** Lighthouse performance ≥ 85 on home and calculator; keyboard navigation works; RTL layout has no overflow.

## Phase 6 — Inquiries, leads, quotes
**Prompt:** Read `docs/01` §5–7 and `docs/02` (leads, quotes, messages, travelers). Implement the inquiry endpoint (reference numbers, dedupe, consent storage, snapshot recalculation on the server), email via the Resend adapter (log-only adapter in dev), admin lead pipeline, quote builder with versions, send-link, the public quote page `/q/:token` (accept, ask question, expired/replaced states), and token security (store hash only; 32-byte random). Add the customer wording map so "booked" never appears.
**Accept:** Full flow works end to end in Playwright; old link shows "replaced" after new version; another quote's token cannot be guessed or enumerated; every customer-facing status string comes from the wording map.

## Phase 7 — Hardening, deploy, backups
**Prompt:** Read `docs/01` §9–10 and CLAUDE.md hard rules. Add helmet, CORS allow-list, request size limits, rate limits, input sanitization, secure cookie flags, dependency audit in CI, Sentry, structured logs without personal data, a nightly `mongodump` job script that uploads to the bucket, and a restore script with instructions. Write `docs/DEPLOY.md` for Cloudflare Pages (web) and a small VPS or Railway (api) with MongoDB Atlas and R2, including the exact environment variables and a launch checklist. Run a permission test sweep across all routes.
**Accept:** `npm audit` has no high issues; backup + restore verified on a staging DB; launch checklist reviewed with me.

## Later (do not build yet)
Orders and fulfillment tracker, payments through a hosted gateway, supplier portal, customer accounts, live APIs. Only after the open questions in `docs/05-OPEN-DECISIONS.md` marked "before payments" are answered.
