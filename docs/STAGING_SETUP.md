# Staging set-up: Marafiq Us Safar

The steps that need the owner's accounts, billing, DNS or sign-in, in order. They follow the approved staging decisions (`docs/STAGING_CHECKLIST.md` §1); `docs/DEPLOY.md` explains each setting.

**Secrets:** generate them on your own computer, paste them straight into the provider's secret settings, and keep a copy in a password manager. Never put them in the repository, a chat, an email or a screenshot. Use **different** values from production.

```
openssl rand -hex 48   # JWT_SECRET (run twice: JWT_REFRESH_SECRET must differ)
openssl rand -hex 32   # TOTP_ENC_KEY, ORIGIN_PROXY_SECRET
```

Names used below (change them if you like, but keep them consistent): domain `<your-domain>`, staging site `staging.<your-domain>`.

## 1. MongoDB Atlas (staging database)

1. Create a project **Marafiq Staging**, separate from anything holding real data.
2. Create a cluster. It must be **MongoDB 6.0 or newer** (8.0 preferred). Atlas clusters are replica sets, which the app's transactions need.
3. **Database Access:** create two users:
   - `marafiq_staging_app`, with **readWrite** on database `marafiq_staging` only (for the API)
   - `marafiq_staging_backup`, with **read** on `marafiq_staging` only (for the backup job)
4. **Network Access:** Railway does not give a fixed outbound IP on every plan. If yours has none, allow `0.0.0.0/0`; the long random passwords are then the barrier.
5. Copy the connection strings and add the database name: `mongodb+srv://<user>:<password>@<cluster-host>/marafiq_staging?retryWrites=true&w=majority`.

Do **not** reuse the database in the current development `.env`.

## 2. Cloudflare: domain and R2

1. The domain's DNS must be on Cloudflare (needed for Pages and Resend).
2. **R2:** enable it. Cloudflare asks for a payment method even on the free allowance.
3. Create two **private** buckets: `marafiq-staging-sheets` and `marafiq-staging-backups`. Never turn on public access.
4. **R2 → Manage API tokens:** create two tokens with **Object Read & Write**, each limited to **one** bucket:
   - `staging-api` → `marafiq-staging-sheets`
   - `staging-backup` → `marafiq-staging-backups`
5. Note the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

## 3. Resend (email)

1. **Domains → Add domain:** `<your-domain>`, or a sending subdomain.
2. Add the DNS records Resend shows in Cloudflare DNS, then wait until Resend shows **Verified**.
3. **API Keys:** create a key with **Sending access**, limited to that domain.
4. `MAIL_FROM` = `Marafiq Us Safar (staging) <quotes@<verified domain>>`.

## 4. Sentry

1. Create a **Node.js** project, e.g. `marafiq-api-staging`, and copy its DSN.
2. **Alerts:** notify a monitored inbox on new issues.

## 5. Railway (API, backup job, ClamAV)

Create a Railway account and a project **marafiq-staging**, and connect GitHub so Railway can read `abdulhaseeb108/Marafiq-ul-Safar`. Check that your plan allows cron services and the memory ClamAV needs (2–3 GB).

### 5.1 `clamav` (private)

1. **New → Docker Image:** `clamav/clamav:<tag>`. Pin a version tag from the image's Docker Hub page rather than `latest`.
2. Do **not** generate a domain; it stays private.
3. Name the service `clamav`. Others reach it at `clamav.railway.internal`, port `3310`.

### 5.2 `api`

1. **New → GitHub Repo →** this repository, branch `main`. Name it `api`.
2. **Settings:**

   | Setting | Value |
   |---|---|
   | Custom Build Command | `npm run build -w @marafiq/shared && npm run build -w @marafiq/api` |
   | Custom Start Command | `npm start -w @marafiq/api` |
   | Healthcheck Path | `/api/v1/health` |
   | Replicas | `1` (never more; `docs/DEPLOY.md` §1) |

   Node 22 comes from `.nvmrc`.
3. **Variables:** see the table below.
4. **Networking → Public Networking → Generate Domain.** Only the Pages Function uses this address; note it for step 6.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | The `marafiq_staging_app` connection string |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `TOTP_ENC_KEY` | Generated |
| `PUBLIC_SITE_URL` | `https://staging.<your-domain>` |
| `ORIGIN_PROXY_SECRET` | Generated (the same value goes in Pages) |
| `TRUST_PROXY_HOPS` | `1` for now; set by staging check 4 |
| `R2_ENDPOINT` | The endpoint from step 2 |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The `staging-api` token |
| `R2_BUCKET` | `marafiq-staging-sheets` |
| `RESEND_API_KEY`, `MAIL_FROM` | From step 3 |
| `STAFF_NOTIFY_EMAIL` | A staff test inbox |
| `SENTRY_DSN` | From step 4 |
| `CLAMAV_HOST`, `CLAMAV_PORT` | `clamav.railway.internal`, `3310` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Your admin email and a strong password, for the **first start only** |
| `ANTHROPIC_API_KEY` | Optional (sheets are entered by hand without it) |

Leave `WEB_ORIGIN` and `COOKIE_DOMAIN` unset.

### 5.3 `backup` (cron)

1. **New → GitHub Repo →** this repository, branch `main`. Name it `backup`.
2. **Variables:**

   | Variable | Value |
   |---|---|
   | `RAILWAY_DOCKERFILE_PATH` | `deploy/backup/Dockerfile` |
   | `NODE_ENV` | `production` |
   | `MONGODB_URI` | The `marafiq_staging_backup` (read-only) connection string |
   | `R2_ENDPOINT` | As for the API |
   | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The `staging-backup` token |
   | `BACKUP_BUCKET` | `marafiq-staging-backups` |
   | `BACKUP_RETENTION_DAYS`, `BACKUP_KEEP_MIN` | `30`, `7` |
   | `SENTRY_DSN` | From step 4, for failure alerts |

   Do **not** set `R2_BUCKET` here.
3. **Settings → Cron Schedule:** `0 2 * * *` (02:00 UTC).
4. No domain.

## 6. Cloudflare Pages (web)

1. **Workers & Pages → Create → Pages → Connect to Git →** this repository. Project name e.g. `marafiq-staging`, production branch `main`.
2. **Build settings:**

   | Setting | Value |
   |---|---|
   | Root directory | `apps/web` |
   | Build command | `cd ../.. && npm ci && npm run build -w @marafiq/shared && npm run build -w @marafiq/web` |
   | Output directory | `dist` |

3. **Variables and Secrets:**

   | Name | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `API_ORIGIN` | `https://` + the Railway API domain from 5.2 step 4 |
   | `ORIGIN_PROXY_SECRET` | Secret type, the same value as the API's |

4. **Custom domains:** add `staging.<your-domain>`.

## 7. First sign-in

1. Open `https://staging.<your-domain>/admin`, sign in with the seed admin, and enrol 2FA.
2. In Railway, **delete `SEED_ADMIN_PASSWORD`** from the `api` service; it redeploys.
3. On the Users page, create:
   - a second admin, and enrol 2FA on another device
   - a **sales** test user for the automated checks

## 8. Hand back for the staging checks

Send these addresses (they are not secrets):

- the staging site, `https://staging.<your-domain>`
- the Railway API domain

So the automated checks can sign in without the password ever appearing in chat or the repository, set two **Windows user environment variables** on this computer for the sales test user: `STAGING_SALES_EMAIL` and `STAGING_SALES_PASSWORD`. Then restart VS Code.

Checks that need you in person:

- **Check 4:** an inquiry from a phone on mobile data.
- **Check 8:** admin 2FA with your authenticator.
- **Check 9:** reading the emails that arrive.
- **Check 14:** confirming a Sentry event.
- **Check 13:** uploading the EICAR file as a staff user.
