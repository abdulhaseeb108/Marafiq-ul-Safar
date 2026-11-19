# Nightly database backup job (docs/DEPLOY.md section 10; Railway cron service).
#
# Railway: a service from this repository with the service variable
#   RAILWAY_DOCKERFILE_PATH=deploy/backup/Dockerfile
# and Settings -> Cron Schedule "0 2 * * *" (02:00 UTC). The container runs
# one backup and exits, as Railway cron requires.
#
# CI builds this image and rehearses backup -> restore with it on every pull
# request (.github/workflows/ci.yml, job backup-rehearsal).

# --- build: install, compile shared + api, keep runtime dependencies only ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
# The tests' in-memory MongoDB is not needed in the image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY . .
RUN npm ci \
  && npm run build -w @marafiq/shared \
  && npm run build -w @marafiq/api \
  && npm prune --omit=dev

# --- runtime: Node 22 + MongoDB Database Tools (mongodump, mongorestore) ---
FROM node:22-bookworm-slim
# MongoDB Database Tools 100.3+ is required (docs/DEPLOY.md); the official
# Debian 12 package from MongoDB's download server.
ARG MONGODB_TOOLS_VERSION=100.10.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /tmp/mongodb-database-tools.deb \
    "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-${MONGODB_TOOLS_VERSION}.deb" \
  && apt-get install -y --no-install-recommends /tmp/mongodb-database-tools.deb \
  && rm /tmp/mongodb-database-tools.deb \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && mongodump --version

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
# Whole package folders: their own node_modules exist only when npm could not hoist.
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api

USER node
CMD ["node", "apps/api/dist/scripts/backup.js"]
