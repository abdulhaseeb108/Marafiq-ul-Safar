/**
 * Restore a backup (docs/DEPLOY.md "Restore").
 *
 *   npm run restore -w @marafiq/api -- --list
 *   npm run restore -w @marafiq/api -- --from latest --target-uri "<uri>" --yes
 *   npm run restore -w @marafiq/api -- --from <key> --target-uri "<uri>" --yes
 *
 * The target is always named on the command line, never taken from
 * MONGODB_URI, so a restore cannot land on the live database by accident.
 * Restoring into the same database as MONGODB_URI also needs
 * --allow-live-database (only for disaster recovery, with the API stopped).
 *
 * Collections in the target that are in the backup are dropped and replaced
 * (mongorestore --drop). The archive's SHA-256 is checked first. After the
 * restore the document count of every collection is printed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  chooseBackupStore,
  databaseFromUri,
  hostsFromUri,
  loadBackupEnv,
  redactUri,
  serverUri,
  runMongoTool,
  sha256File,
} from './backup-lib.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
dotenv.config({ path: join(repoRoot, '.env'), quiet: true });

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes(name);

async function main(): Promise<void> {
  const env = loadBackupEnv();
  const store = chooseBackupStore(env, repoRoot);
  const backups = (await store.list()).sort((a, b) => b.modified.getTime() - a.modified.getTime());

  if (has('--list')) {
    console.log(`Backups in ${store.name} (newest first):`);
    for (const b of backups) {
      console.log(`  ${b.key}  ${b.modified.toISOString()}  ${(b.bytes / 1024).toFixed(0)} KB`);
    }
    if (backups.length === 0) console.log('  (none)');
    return;
  }

  const from = flag('--from');
  const targetUri = flag('--target-uri');
  if (!from || !targetUri) {
    throw new Error('Give --from <key|latest> and --target-uri <uri>. Use --list to see backups.');
  }
  const key = from === 'latest' ? backups[0]?.key : from;
  if (!key || !backups.some((b) => b.key === key)) {
    throw new Error(`No backup "${from}" in ${store.name}. Use --list to see backups.`);
  }

  const targetDb = databaseFromUri(targetUri);
  if (!targetDb) throw new Error('--target-uri must name a database, e.g. .../marafiq_restore');
  const liveDb = databaseFromUri(env.MONGODB_URI) ?? 'test';
  const sameHost = hostsFromUri(targetUri) === hostsFromUri(env.MONGODB_URI);
  if (sameHost && targetDb === liveDb && !has('--allow-live-database')) {
    throw new Error(
      `The target is the live database (${liveDb}). Restore into another database name, ` +
        'or add --allow-live-database for disaster recovery with the API stopped.',
    );
  }

  console.log(`Restore ${key}`);
  console.log(`   into ${redactUri(targetUri)}`);
  console.log('   Collections in the backup are dropped and replaced in the target.');
  if (!has('--yes')) {
    console.log('Nothing done. Add --yes to run it.');
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'msf-restore-'));
  try {
    const archive = join(workDir, 'backup.archive.gz');
    const meta = await store.download(key, archive);
    if (!meta) throw new Error('The backup has no checksum record; refusing to restore it.');
    if ((await sha256File(archive)) !== meta.sha256) {
      throw new Error('The downloaded backup does not match its checksum; refusing to restore.');
    }
    // Select the backed-up database explicitly and rename it to the target.
    // The tool gets the server only: a database in its URI would filter the
    // archive by that name and restore nothing (see serverUri).
    const rename =
      meta.database === targetDb ? [] : [`--nsFrom=${meta.database}.*`, `--nsTo=${targetDb}.*`];
    await runMongoTool(
      env.MONGORESTORE_PATH,
      serverUri(targetUri),
      [`--archive=${archive}`, '--gzip', '--drop', `--nsInclude=${meta.database}.*`, ...rename],
      workDir,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  // Counts per collection, to compare with the source (docs/DEPLOY.md).
  const connection = await mongoose.createConnection(targetUri).asPromise();
  try {
    const db = connection.db;
    if (!db) throw new Error('Could not open the target database');
    const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
    let total = 0;
    const lines: string[] = [];
    for (const name of names) {
      const count = await db.collection(name).countDocuments();
      total += count;
      lines.push(`  ${name}: ${count}`);
    }
    // A restore that leaves the target empty must never look like a success.
    if (names.length === 0 || total === 0) {
      throw new Error(`Nothing was restored into ${targetDb}; check the backup and the target.`);
    }
    console.log('Restored. Documents per collection:');
    for (const line of lines) console.log(line);
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error('Restore failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
