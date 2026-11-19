# Staging checklist: Marafiq Us Safar

What must exist before the first **staging** deployment, and the checks to run on it. `docs/DEPLOY.md` has the step-by-step guide; this list says what is still missing and where each value goes. **No values belong in this file or anywhere in the repository.**

**As of 18 Nov 2026:** nothing below has been created yet. No host, staging database, bucket, email domain or Sentry project is set up, and the repository has no deployment environments, secrets or variables. Staging has therefore **not** been deployed.

## 1. Decisions (approved 19 Nov 2026)

| Decision | Choice |
|---|---|
| API host (APR-01) | Railway: services `api`, `backup` (cron), `clamav` (private) |
| Web | Cloudflare Pages, a separate staging project |
| Database | A dedicated MongoDB Atlas staging database |
| Files | Separate private R2 buckets and tokens for sheets and for backups |
| Backups (APR-12) | Railway cron `0 2 * * *` (02:00 UTC), 30-day retention, newest 7 always kept |
| Email, errors, scanning | Resend, Sentry, private ClamAV |

Step-by-step set-up: `docs/STAGING_SETUP.md`.

## 2. Accounts and resources to create (staging only)

- [ ] **Cloudflare:** the domain's DNS, a Pages project for `apps/web`, and two private R2 buckets for staging (sheets, backups) with one API token per bucket
- [ ] **API host:** one service, Node 22, exactly **one** instance
- [ ] **MongoDB Atlas:** a staging database (6.0 or newer, replica set) with its own user. **Not** the database in the current development `.env`: that one is shared and must not be wiped or restored over
- [ ] **Resend:** the sending domain verified (DNS records in Cloudflare) and an API key with sending access only
- [ ] **Sentry:** a Node.js project for the API, with an alert to a monitored inbox
- [ ] **ClamAV:** the `clamav/clamav` image as a private service (only needed if document intelligence will be used on staging)
- [ ] **MongoDB Database Tools 100.3+** wherever backups and restores run (official download: mongodb.com → Tools → Database Tools)

## 3. Values and where they are configured

Generate secrets with `openssl rand -hex 48` (JWT) or `openssl rand -hex 32` (others). Use **different** values on staging and production.

### API host (service variables or secrets)

| Name | Staging value comes from | Required |
|---|---|---|
| `NODE_ENV` | `production` (staging runs the production code path) | Yes |
| `MONGODB_URI` | Atlas staging connection string, **with the database name** | Yes |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Generated, different from each other | Yes |
| `TOTP_ENC_KEY` | Generated (64 hex characters); keep a copy in a password manager | Yes |
| `PUBLIC_SITE_URL` | The staging https address | Yes |
| `ORIGIN_PROXY_SECRET` | Generated; the same value in Pages | Strongly recommended |
| `TRUST_PROXY_HOPS` | Start at `1` (likely `2` on Railway); confirm with check 4 below | Yes |
| `WEB_ORIGIN` | Blank (same-origin set-up) | No |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2, the **sheets** token and bucket | Yes |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend; `MAIL_FROM` on the verified domain | Yes |
| `STAFF_NOTIFY_EMAIL` | A staff test inbox | No |
| `SENTRY_DSN`, `SENTRY_RELEASE` | Sentry project; release = deployed commit | Strongly recommended |
| `CLAMAV_HOST`, `CLAMAV_PORT` | Private address of the clamd service, `3310` | For document intelligence |
| `ANTHROPIC_API_KEY`, `EXTRACTION_MODEL` | Anthropic, with a spending cap | No (manual entry without it) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | First start only; delete the password afterwards | First start |

### Cloudflare Pages project (Settings → Variables and Secrets)

| Name | Value |
|---|---|
| `API_ORIGIN` | The API host's https address |
| `ORIGIN_PROXY_SECRET` (secret) | Same as the API's |
| `NODE_VERSION` | `22` |

Build settings: root `apps/web`; build `cd ../.. && npm ci && npm run build -w @marafiq/shared && npm run build -w @marafiq/web`; output `dist`.

### Backup job (separate from the API)

`NODE_ENV`, `MONGODB_URI` (a read-only user is enough), `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (the **backup** token), `BACKUP_BUCKET` (must differ from `R2_BUCKET`; leave `R2_BUCKET` unset), optional `BACKUP_RETENTION_DAYS`, `BACKUP_KEEP_MIN`, `MONGODUMP_PATH`, `MONGORESTORE_PATH`, `SENTRY_DSN`.

## 4. Checks on staging (in order; record date and result)

| # | Check | How | Result |
|---|---|---|---|
| 1 | Node 22 and one instance | Host settings; log line `API listening … (production)` | |
| 2 | Start-up guards | Log shows no "failed to start"; R2 and Resend named in the start-up lines | |
| 3 | Database | `/api/v1/health` 200; log has no `index problem` | |
| 4 | Real visitor IP (`TRUST_PROXY_HOPS`) | DEPLOY.md §9 step 4 from a phone on mobile data | |
| 5 | Origin lock | API host's own address: `/api/v1/public/config` → 403, `/api/v1/health` → 200 | |
| 6 | Headers and CSP | DevTools: CSP present; **no** violations on home, calculator, request-quote, a quote link and staff pages | |
| 7 | CORS | A request from another origin gets no `Access-Control-Allow-Origin` | |
| 8 | Staff sign-in | Admin with 2FA enrolment; sales without; wrong password ×5 → "Too many attempts", **still locked after an API restart** | |
| 9 | Public inquiry | English and Urdu, 360 px phone; acknowledgement email arrives | |
| 10 | Quotes | Create, send, open the link, accept; quote email arrives in both languages | |
| 11 | Rate limits | 6th inquiry in an hour → 429. Also: two or three phones on the **same mobile network** browse the calculator at once and are never limited | |
| 12 | Files (R2) | Upload a rate sheet; it opens in the review frame; the bucket is not publicly readable | |
| 13 | Malware scanning | DEPLOY.md §6.3 step 6: EICAR → `infected`; a normal file → `processed` | |
| 14 | Sentry | A forced test error appears, with no personal data | |
| 15 | Backup and restore | DEPLOY.md §10 by hand, then §11 into a **scratch** database; compare counts; open a restored quote link | |

The public rate limits are constants in `apps/api/src/lib/public-limits.ts` (60/min, 5 inquiries/hour, 20 unknown quote links per 15 min). If check 11 shows shared-IP users being limited, changing them needs a code change and a redeploy.
