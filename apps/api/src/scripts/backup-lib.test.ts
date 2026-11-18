import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupKey,
  backupsToDelete,
  databaseFromUri,
  hostsFromUri,
  loadBackupEnv,
  LocalBackupStore,
  parseToolVersion,
  redactUri,
  sha256File,
  supportsConfigFile,
} from './backup-lib.js';

const DAY = 24 * 60 * 60 * 1000;

describe('backup naming and connection strings', () => {
  it('names backups by UTC time so they sort in order', () => {
    expect(backupKey(new Date('2026-11-17T02:15:00.123Z'))).toBe(
      'mongodb/marafiq-2026-11-17T02-15-00Z.archive.gz',
    );
  });

  it('reads the database name, hosts and a safe form of the URI', () => {
    expect(
      databaseFromUri('mongodb+srv://u:p@cluster0.x.mongodb.net/marafiq?retryWrites=true'),
    ).toBe('marafiq');
    expect(databaseFromUri('mongodb://h1:27017,h2:27017/live?replicaSet=rs0')).toBe('live');
    expect(
      databaseFromUri('mongodb+srv://u:p@cluster0.x.mongodb.net/?retryWrites=true'),
    ).toBeUndefined();
    expect(databaseFromUri('mongodb://localhost')).toBeUndefined();
    expect(hostsFromUri('mongodb+srv://a:b@Cluster0.x.mongodb.net/one')).toBe(
      'cluster0.x.mongodb.net',
    );
    expect(hostsFromUri('mongodb+srv://c:d@cluster0.x.mongodb.net/two')).toBe(
      'cluster0.x.mongodb.net',
    );
    expect(redactUri('mongodb+srv://user:s3cret@host/db')).toBe('mongodb+srv://user:***@host/db');
    expect(redactUri('mongodb://host/db')).toBe('mongodb://host/db');
  });
});

describe('retention', () => {
  const now = new Date('2026-11-30T00:00:00Z');
  const daily = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      key: `mongodb/b${i}`,
      modified: new Date(now.getTime() - i * DAY),
      bytes: 10,
    }));

  it('deletes backups older than the retention period', () => {
    expect(backupsToDelete(daily(40), now, 30, 7)).toEqual(
      Array.from({ length: 9 }, (_, i) => `mongodb/b${i + 31}`),
    );
  });

  it('always keeps the newest few, even when they are all old', () => {
    const old = daily(10).map((b) => ({
      ...b,
      modified: new Date(b.modified.getTime() - 90 * DAY),
    }));
    const deleted = backupsToDelete(old, now, 30, 7);
    expect(deleted).toEqual(['mongodb/b7', 'mongodb/b8', 'mongodb/b9']);
  });
});

describe('MongoDB tool versions', () => {
  it('uses a config file (password out of the process list) on Database Tools 100.3+', () => {
    expect(parseToolVersion('mongodump version: 100.9.4\ngit version: abc')).toEqual([100, 9, 4]);
    expect(parseToolVersion('mongodump version: r4.3.2')).toEqual([4, 3, 2]);
    expect(parseToolVersion('nonsense')).toBeNull();
    expect(supportsConfigFile([100, 9, 4])).toBe(true);
    expect(supportsConfigFile([100, 3, 0])).toBe(true);
    expect(supportsConfigFile([100, 2, 9])).toBe(false);
    expect(supportsConfigFile([4, 3, 2])).toBe(false);
    expect(supportsConfigFile(null)).toBe(false);
  });
});

describe('backup environment', () => {
  const base = { MONGODB_URI: 'mongodb://localhost/marafiq' };
  const r2 = {
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
  };

  it('works locally without a bucket', () => {
    const env = loadBackupEnv(base);
    expect(env.BACKUP_RETENTION_DAYS).toBe(30);
    expect(env.BACKUP_KEEP_MIN).toBe(7);
  });

  it('requires a backup bucket in production, separate from the rate-sheet bucket', () => {
    const production = { ...base, NODE_ENV: 'production' };
    expect(() => loadBackupEnv(production)).toThrow(/BACKUP_BUCKET/);
    expect(() =>
      loadBackupEnv({ ...production, ...r2, R2_BUCKET: 'sheets', BACKUP_BUCKET: 'sheets' }),
    ).toThrow(/separate bucket/);
    expect(
      loadBackupEnv({ ...production, ...r2, R2_BUCKET: 'sheets', BACKUP_BUCKET: 'backups' })
        .BACKUP_BUCKET,
    ).toBe('backups');
  });
});

describe('local backup store', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('stores, lists, downloads with its checksum, and removes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'msf-store-test-'));
    const store = new LocalBackupStore(join(dir, 'store'));
    const source = join(dir, 'in.gz');
    await writeFile(source, 'archive bytes');
    const sha256 = await sha256File(source);
    await store.put('mongodb/marafiq-1.archive.gz', source, { sha256, database: 'marafiq' });

    const listed = await store.list();
    expect(listed.map((b) => b.key)).toEqual(['mongodb/marafiq-1.archive.gz']);
    expect(listed[0]?.bytes).toBe(13);

    const out = join(dir, 'out.gz');
    expect(await store.download('mongodb/marafiq-1.archive.gz', out)).toEqual({
      sha256,
      database: 'marafiq',
    });
    expect(await readFile(out, 'utf8')).toBe('archive bytes');

    await store.remove('mongodb/marafiq-1.archive.gz');
    expect(await store.list()).toEqual([]);
  });
});
