/**
 * Nightly database backup (docs/01 section 9, docs/DEPLOY.md "Backups").
 *
 *   npm run backup -w @marafiq/api
 *
 * 1. mongodump the database in MONGODB_URI to a gzip archive.
 * 2. Upload it with its SHA-256 to the backup store.
 * 3. Delete backups past BACKUP_RETENTION_DAYS, keeping the newest BACKUP_KEEP_MIN.
 *
 * Exits with code 1 on any failure, so the scheduler marks the run failed; if
 * SENTRY_DSN is set the failure is reported there too.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { configureLogger, log } from '../lib/logger.js';
import { closeMonitoring, initMonitoring, reportError } from '../lib/monitoring.js';
import {
  backupKey,
  backupsToDelete,
  chooseBackupStore,
  databaseFromUri,
  loadBackupEnv,
  runMongoTool,
  sha256File,
} from './backup-lib.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
dotenv.config({ path: join(repoRoot, '.env'), quiet: true });

async function main(): Promise<void> {
  const env = loadBackupEnv();
  configureLogger({ json: env.NODE_ENV === 'production', silent: false });
  initMonitoring({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });

  const fromUri = databaseFromUri(env.MONGODB_URI);
  // Mongoose uses "test" when the connection string names no database.
  const database = fromUri ?? 'test';
  const store = chooseBackupStore(env, repoRoot);
  const now = new Date();
  const key = backupKey(now);
  const workDir = await mkdtemp(join(tmpdir(), 'msf-backup-'));
  try {
    const archive = join(workDir, 'backup.archive.gz');
    await runMongoTool(
      env.MONGODUMP_PATH,
      env.MONGODB_URI,
      [`--archive=${archive}`, '--gzip', ...(fromUri ? [] : [`--db=${database}`])],
      workDir,
    );
    const { size } = await stat(archive);
    if (size === 0) throw new Error('mongodump produced an empty archive');
    const sha256 = await sha256File(archive);
    await store.put(key, archive, { sha256, database });
    log.info('backup uploaded', { key, bytes: size, database, store: store.name });

    const stale = backupsToDelete(
      await store.list(),
      now,
      env.BACKUP_RETENTION_DAYS,
      env.BACKUP_KEEP_MIN,
    );
    for (const old of stale) await store.remove(old);
    if (stale.length > 0) log.info('old backups deleted', { count: stale.length });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main()
  .catch((error: unknown) => {
    log.error('backup failed', { reason: error instanceof Error ? error.message : 'unknown' });
    reportError(error, { area: 'backup' });
    process.exitCode = 1;
  })
  .finally(() => void closeMonitoring());
