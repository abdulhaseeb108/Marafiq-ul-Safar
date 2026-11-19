# DEPLOY.md: Marafiq Us Safar

How to put the site live, keep it backed up, and restore it. Written in Phase 7 (docs/04).

**Status of this guide:** the code paths it relies on are tested (unit and API tests, plus a local backup and restore against MongoDB 8.0). The hosting steps have **not** been run on a real Cloudflare, Railway or Atlas account yet. Treat the first staging deployment as the test of this guide, and correct it where the real screens differ.

## 1. Shape of the deployment

```
Browser ──https──▶ Cloudflare Pages  (your-domain.com)
                     ├─ static site: apps/web/dist, headers from apps/web/public/_headers
                     └─ /api/*  ──▶ Pages Function apps/web/functions/api/[[path]].ts
                                      │  adds X-Forwarded-For (real visitor IP)
                                      │  adds X-Origin-Secret
                                      ▼
                              API host (Railway service or small VPS), Node 22
                                      ├─▶ MongoDB Atlas (replica set, 6.0+)
                                      ├─▶ Cloudflare R2: rate-sheet bucket (private)
                                      ├─▶ Resend (email)
                                      ├─▶ Anthropic API (rate-sheet reading)
                                      ├─▶ ClamAV clamd (private network; document scanning)
                                      └─▶ Sentry (errors)

Backup job (nightly) ──▶ mongodump ──▶ Cloudflare R2: backup bucket (private, separate)
```

Why the proxy: the browser only ever talks to `your-domain.com`. Staff cookies, the PDF preview frame on the rate-sheet review page, and the content security policy all stay same-origin, exactly as in development (docs/05 decision 45). CORS is not needed and `WEB_ORIGIN` stays blank.

Why the origin secret: the API host also has its own public address. Without the secret, anyone could call it directly and put a fake IP in `X-Forwarded-For` to dodge the rate limits. With `ORIGIN_PROXY_SECRET` set, the API refuses every request that did not come through the Pages Function (the health check stays open).

**Run exactly one API process.** The public rate-limit counters live in memory (`lib/public-limits.ts`), so a second process would double them. Sign-in lock-outs are kept in MongoDB and survive restarts (`modules/auth/login-limiter.ts`). Do not scale the API service to more than one instance or replica.

## 2. Accounts you need

| Service | Used for | Notes |
|---|---|---|
| Domain registrar | The site address | DNS moved to Cloudflare |
| Cloudflare | DNS, Pages (web), R2 (files and backups) | Free plan is enough to start |
| Railway, or a small VPS | The API | Must run one long-lived Node 22 process |
| MongoDB Atlas | Database | Separate clusters or databases for staging and production |
| Resend | Email | Sending domain must be verified |
| Anthropic | Rate-sheet reading | Set a monthly spending cap on the account |
| Sentry | Error reports | One Node project for the API |

Keep every credential in the host's secret settings. Nothing goes in the repository.

## 3. Database (MongoDB Atlas)

1. Create a cluster for **production** and another cluster or database for **staging**. Atlas clusters are replica sets, which the quote and rate-publishing transactions need. Confirm the version is **6.0 or newer** on the cluster page.
2. Create one database user per environment with read and write access to its own database only.
3. Put the database name in the connection string, e.g. `mongodb+srv://user:pass@cluster.mongodb.net/marafiq?retryWrites=true&w=majority`. Without a name, data lands in a database called `test`.
4. Network access: allow the API host's outbound IP. If the host has no fixed IP, Atlas needs `0.0.0.0/0`; then the long random password is the only barrier, so make it long.
5. Never point a development `.env` at the production database.

## 4. File storage (Cloudflare R2)

1. Create two **private** buckets, e.g. `marafiq-sheets` (supplier originals) and `marafiq-backups` (database backups). Never turn on public access for either.
2. Create an R2 API token with **Object Read & Write** limited to `marafiq-sheets` for the API.
3. Create a second token limited to `marafiq-backups` for the backup job. The API never needs the backups, and the backup job never needs the sheets.
4. Note the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

## 5. Email (Resend)

1. Add your domain in Resend and create the DNS records it shows (in Cloudflare DNS). Wait until Resend shows the domain as verified.
2. Create an API key with sending access only.
3. `MAIL_FROM` must use the verified domain, e.g. `Marafiq Us Safar <quotes@your-domain.com>`.

## 6. The API service

### 6.1 Build and start

| Setting | Value |
|---|---|
| Node | 22 (see `.nvmrc`; `engines` requires 22.12+) |
| Install | `npm ci` |
| Build | `npm run build` |
| Start | `npm start -w @marafiq/api` (runs `node apps/api/dist/server.js`) |
| Health check path | `/api/v1/health` |
| Instances | **1** |

On Railway: create a service from the GitHub repository with the settings above, and give it a public domain (only the Pages Function will use it). On a VPS: run the same commands under a process manager such as systemd, behind a reverse proxy that terminates HTTPS.

On the first start against an empty database, the API creates the first admin from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. Sign in, set up 2FA, then **delete `SEED_ADMIN_PASSWORD`** from the host's variables and restart.

To load the starting supplier, hotels and FX rate, run `npm run seed` once with the production variables (it only adds what is missing).

### 6.2 API environment variables

| Variable | Production value | Required |
|---|---|---|
| `NODE_ENV` | `production` | Yes |
| `PORT` | Usually set by the host; otherwise `4000` | Host |
| `MONGODB_URI` | Atlas connection string with the database name (section 3) | Yes |
| `JWT_SECRET` | `openssl rand -hex 48` | Yes |
| `JWT_REFRESH_SECRET` | `openssl rand -hex 48`, different from the above | Yes |
| `TOTP_ENC_KEY` | `openssl rand -hex 32`. Losing or changing it forces every user to set up 2FA again. Store a copy in a password manager. | Yes |
| `COOKIE_DOMAIN` | Blank. Cookies are then tied to the exact site host, which is tighter. | No |
| `PUBLIC_SITE_URL` | `https://your-domain.com` (used in quote links) | Yes |
| `WEB_ORIGIN` | Blank in this set-up (same origin). Only for a split deployment: comma-separated https origins. Cannot be combined with `ORIGIN_PROXY_SECRET` (the API refuses to start). | No |
| `TRUST_PROXY_HOPS` | Start at `1`; confirm with section 9, step 4. A host that puts its own proxy in front of the API (Railway does) usually needs `2`: Cloudflare's proxy plus the host's. | Yes (default 1) |
| `ORIGIN_PROXY_SECRET` | `openssl rand -hex 32`; the same value goes in Pages. Not with `WEB_ORIGIN`: browsers calling the API directly cannot send it. | Strongly recommended |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | Yes |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The sheets token | Yes |
| `R2_BUCKET` | `marafiq-sheets` | Yes |
| `RESEND_API_KEY` | From Resend | Yes |
| `MAIL_FROM` | `Marafiq Us Safar <quotes@your-domain.com>` | Yes |
| `STAFF_NOTIFY_EMAIL` | Staff inbox for new inquiries and accepted quotes | No |
| `ANTHROPIC_API_KEY` | From Anthropic. Blank = sheets entered by hand. | No |
| `EXTRACTION_MODEL` | `claude-sonnet-5-5` | No |
| `CLAMAV_HOST`, `CLAMAV_PORT` | The clamd service's private address and port (`3310`); section 6.3. Blank = no scanner, documents stay unparsed. | Before document intelligence is used |
| `SENTRY_DSN` | From the Sentry project | Strongly recommended |
| `SENTRY_RELEASE` | The deployed commit id, if the host provides one | No |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | First start only; then delete the password | First start |
| `DOCUMENT_*` | Leave unset (safe defaults) | No |

The API refuses to start in production without R2, Resend and an https `PUBLIC_SITE_URL`, and refuses an http `WEB_ORIGIN`. These are checked before the database is contacted. The start-up error names the variable and the reason, never the value.

### 6.3 Malware scanning (ClamAV)

Document intelligence parses supplier files (PDF, images, spreadsheets) only after a malware scanner has called them clean. Without a scanner, files are stored but never parsed; nothing unscanned is ever opened by the parsers. Uploads are staff-only (`admin`, `ops`); there is no public upload.

1. Run ClamAV's daemon beside the API, on the host's **private** network only (never a public port): the official image `clamav/clamav` (Docker Hub) as a second service. It downloads virus definitions on start and keeps them updated (freshclam).
2. Give it 2–3 GB of memory; clamd loads the whole signature database.
3. Set `CLAMAV_HOST` (the service's private hostname) and `CLAMAV_PORT` (`3310`) on the API.
4. clamd's `StreamMaxLength` must be at least `DOCUMENT_MAX_FILE_BYTES` (20 MB by default; ClamAV's own default is 25 MB). A larger file gets "size limit exceeded" and stays unparsed.
5. Restart the API. The log says `files are scanned by ClamAV at <host>:3310`, or `is not answering` if clamd is unreachable (files then wait, unparsed).
6. Check: upload the EICAR test file (eicar.org) through the staff portal as a document-intelligence source. Its processing status must become `infected`, and it must never be parsed. A normal sheet must reach `processed` (or `partial` / `unmapped`), never `scan_unavailable`.

Rate-sheet uploads (the AI reading path) are not scanned yet; they go to Anthropic, are stored in R2 and are previewed by staff in the browser.

## 7. The web app (Cloudflare Pages)

1. Create a Pages project connected to the GitHub repository.
2. Build settings:

   | Setting | Value |
   |---|---|
   | Root directory | `apps/web` |
   | Build command | `cd ../.. && npm ci && npm run build -w @marafiq/shared && npm run build -w @marafiq/web` |
   | Build output directory | `dist` |
   | Environment variable | `NODE_VERSION` = `22` |

   Pages finds the proxy in `apps/web/functions/` and the headers in `dist/_headers` (copied from `apps/web/public/_headers`).
3. Variables and secrets for the Pages project (production and preview separately):

   | Name | Value |
   |---|---|
   | `API_ORIGIN` | The API host's https address, e.g. `https://marafiq-api.up.railway.app` |
   | `ORIGIN_PROXY_SECRET` (secret) | Same value as the API's `ORIGIN_PROXY_SECRET` |

4. Add the custom domain `your-domain.com` (and `www` if wanted) to the Pages project.

## 8. Error reports (Sentry)

Create a Node.js project and copy its DSN into `SENTRY_DSN`. The API sends only errors it did not expect, plus crashes, and scrubs every event first: no request data, no user, no breadcrumbs and no error messages (`lib/monitoring.ts`). The error class, stack trace, route pattern and request id remain. Turn on an alert for new issues to the staff inbox.

Every API response carries an `X-Request-Id` header, and every log line has the same id, so a customer's report can be matched to one log line and one Sentry event.

## 9. First deployment: checks in order

Do all of this on **staging** first, then repeat on production.

1. **Health:** `https://your-domain.com/api/v1/health` returns `{"status":"ok",...}`.
2. **Origin lock:** the API host's own address returns 403 for `/api/v1/public/config`, and 200 for `/api/v1/health`.
3. **Headers:** in the browser developer tools, the home page response shows `Content-Security-Policy`, and the console shows **no** CSP violations on the home, calculator, request-quote, quote and staff pages (including the rate-sheet review page with a PDF open).
4. **Real visitor IP (`TRUST_PROXY_HOPS`):**
   1. From a phone on mobile data, submit a test inquiry.
   2. Signed in as admin, open `https://your-domain.com/api/v1/admin/audit` and find the newest `lead.create` event.
   3. Its IP must be the phone's public IP (compare with any "what is my IP" site on the phone).
   4. If it shows a Cloudflare or host address, raise `TRUST_PROXY_HOPS` by one, restart and repeat. If it would accept an address you add yourself with an `X-Forwarded-For` header, lower it.
5. **Rate limits:** six inquiries from one connection within an hour; the sixth gets "Too many attempts".
6. **Email:** inquiry acknowledgement and quote email arrive in English and Urdu, from your domain, not in spam.
7. **Files:** upload a rate sheet; it opens in the review page's frame; the R2 bucket is not publicly readable.
8. **Sentry:** a test error appears in Sentry with no personal data in it.
9. **Backup and restore:** run section 10 once by hand, then section 11 into a scratch database, and compare the counts.

## 10. Backups

`npm run backup -w @marafiq/api` (or, on a built copy, `node apps/api/dist/scripts/backup.js`):

1. runs `mongodump --archive --gzip` on the database in `MONGODB_URI`;
2. uploads it to `BACKUP_BUCKET` as `mongodb/marafiq-<UTC time>.archive.gz`, with its SHA-256;
3. deletes backups older than `BACKUP_RETENTION_DAYS` (default 30), always keeping the newest `BACKUP_KEEP_MIN` (default 7);
4. exits with code 1 on any failure, and reports it to Sentry if `SENTRY_DSN` is set.

It needs **MongoDB Database Tools 100.3 or newer** (`mongodump`, `mongorestore`) on the machine that runs it. With 100.3+, the connection string is passed in a private temporary file, not on the command line.

### Backup job variables

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | The production connection string (a read-only database user is enough for backups) |
| `R2_ENDPOINT` | As for the API |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The **backup** token |
| `BACKUP_BUCKET` | `marafiq-backups` (must differ from `R2_BUCKET`; leave `R2_BUCKET` unset here) |
| `BACKUP_RETENTION_DAYS`, `BACKUP_KEEP_MIN` | Optional |
| `MONGODUMP_PATH`, `MONGORESTORE_PATH` | Only if the tools are not on `PATH` |
| `SENTRY_DSN` | Optional, for failure alerts |

### Scheduling (choose one; decision APR-12)

- **VPS cron**, nightly at 02:15 Pakistan time (21:15 UTC):
  ```
  15 21 * * * cd /srv/marafiq && /usr/bin/node apps/api/dist/scripts/backup.js >> /var/log/marafiq-backup.log 2>&1
  ```
- **Railway cron service:** a second service from the same repository, with the backup variables above, start command `node apps/api/dist/scripts/backup.js`, and a cron schedule of `15 21 * * *`. Its image must include MongoDB Database Tools; the default build image does not. **Not yet tried.**
- **Atlas Cloud Backup** (paid cluster tiers) can replace or complement this. Even then, keep one copy outside Atlas and test a restore.

A backup that has never been restored is not a backup. Do section 11 into a scratch database at least once a month.

## 11. Restore

```
npm run restore -w @marafiq/api -- --list
npm run restore -w @marafiq/api -- --from latest --target-uri "mongodb+srv://.../marafiq_restore_check" --yes
```

- The target is always named on the command line. It is never taken from `MONGODB_URI`.
- Without `--yes` it only prints what it would do.
- The archive's SHA-256 is checked before anything is touched; a mismatch stops the restore.
- If the target database name differs from the backed-up one, collections are renamed on the way in.
- Collections present in the backup are **dropped and replaced** in the target.
- At the end it prints the document count of every collection. Compare with the source.

**Disaster recovery into the live database:** stop the API first, then add `--allow-live-database`. Afterwards start the API, sign in, and open a recent quote link to confirm.

Rate-sheet files live in R2, not in the database. A restored database refers to them by key; they are not part of the backup. Do not delete objects from the sheets bucket.

## 12. Database indexes

On start-up in production the API **creates** missing indexes but never **drops** one. An index that no schema declares any more is reported in the logs as `index problem`. To remove it on purpose:

```
npm run db:indexes -w @marafiq/api          # lists changes
npm run db:indexes -w @marafiq/api -- --yes # applies them (take a backup first)
```

## 13. Logs

In production the API writes one JSON object per line to standard output and standard error: `time`, `level`, `msg`, and fields such as `requestId`, `method`, `route`, `status`, `ms`. The route is the pattern (`/api/v1/public/quotes/:token`), never the real address, so quote tokens never reach the logs. No names, phones, emails, IPs or request bodies are logged. Successful health checks are not logged.

## 14. Updating and rolling back

- **Update:** merge to `main`; Pages and the API host rebuild. Watch Sentry and the logs for 15 minutes.
- **Roll back the web app:** in Pages, promote the previous deployment.
- **Roll back the API:** redeploy the previous commit on the host.
- Database changes in this project are additive (new collections, fields and indexes). If a release ever needs a data change, take a backup immediately before it.

## 15. If a secret leaks

| Secret | What to do |
|---|---|
| `JWT_SECRET` or `JWT_REFRESH_SECRET` | Replace and restart: every staff member signs in again |
| `TOTP_ENC_KEY` | Replace only if it leaked: every user must set up 2FA again |
| `ORIGIN_PROXY_SECRET` | Replace in both the API and Pages at the same time |
| Database password | Rotate in Atlas; update `MONGODB_URI` in the API and the backup job |
| R2, Resend, Anthropic, Sentry keys | Revoke in the provider, create a new one, update the host |

## 16. Lost admin 2FA device

If another admin exists, they reset the user from the Users page. **Create a second admin with 2FA before launch** so this is always possible. If the only admin is locked out, a database change is needed; there is no in-app recovery yet.

## 17. Launch checklist

Review this list with the client before launch (docs/04 Phase 7 acceptance). Tick each item with a date.

**Code and tests**
- [ ] Phases 3 to 7 merged to `main`; CI green, including the audit, `e2e` and `e2e-flow` jobs
- [ ] `npm audit` reports no high or critical issues
- [ ] Permission sweep (`apps/api/src/test/permissions.test.ts`) passes

**Infrastructure**
- [ ] Section 9 checks 1 to 9 pass on staging, then on production
- [ ] Exactly one API instance
- [ ] Production and staging use separate databases, buckets and keys
- [ ] `SEED_ADMIN_PASSWORD` removed after first sign-in
- [ ] Two admin accounts, both with 2FA
- [ ] Nightly backup scheduled; one restore tested into a scratch database and counts compared
- [ ] Sentry alert goes to a monitored inbox

**Content and legal (docs/01, docs/05)**
- [ ] No `[CLIENT TO PROVIDE]`, `[CLIENT TO CONFIRM]`, `[LICENCE …]`, `[ISSUING AUTHORITY]` or `[LEGAL REVIEW NEEDED]` text left in either language
- [ ] Company name, licence details and contact details confirmed by the client
- [ ] Privacy policy, terms, quote terms and consent wording reviewed; consent version raised if the wording changed
- [ ] Urdu text and Urdu emails reviewed by a native speaker
- [ ] Supplier pricing assumptions confirmed in writing

**Sign-off**
- [ ] Owner
- [ ] Client
