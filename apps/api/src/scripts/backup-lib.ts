/**
 * Shared parts of the backup and restore scripts (docs/DEPLOY.md "Backups").
 *
 * Backups are `mongodump --archive --gzip` files. In production they go to
 * their own private R2 bucket (BACKUP_BUCKET), never the rate-sheet bucket:
 * a backup holds every lead and quote. In development they go to the
 * `.local-backups` folder.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

const blank = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optional = z.preprocess(blank, z.string().optional());

/** Only what the backup job needs, so it can run without the API's secrets. */
const BackupEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    MONGODB_URI: z.preprocess(blank, z.string({ error: 'is required' }).min(1)),
    R2_ENDPOINT: optional,
    R2_ACCESS_KEY_ID: optional,
    R2_SECRET_ACCESS_KEY: optional,
    R2_BUCKET: optional,
    /** Private bucket for backups only. Required in production. */
    BACKUP_BUCKET: optional,
    /** Backups older than this are deleted, but the newest BACKUP_KEEP_MIN always stay. */
    BACKUP_RETENTION_DAYS: z.preprocess(blank, z.coerce.number().int().min(1).default(30)),
    BACKUP_KEEP_MIN: z.preprocess(blank, z.coerce.number().int().min(1).default(7)),
    MONGODUMP_PATH: z.preprocess(blank, z.string().default('mongodump')),
    MONGORESTORE_PATH: z.preprocess(blank, z.string().default('mongorestore')),
    SENTRY_DSN: optional,
  })
  .superRefine((env, context) => {
    const r2 = env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY;
    if (env.NODE_ENV === 'production' && !(r2 && env.BACKUP_BUCKET)) {
      context.addIssue({
        code: 'custom',
        message: 'BACKUP_BUCKET and the R2_* credentials are required in production',
        path: ['BACKUP_BUCKET'],
      });
    }
    if (env.BACKUP_BUCKET && env.BACKUP_BUCKET === env.R2_BUCKET) {
      context.addIssue({
        code: 'custom',
        message: 'must be a separate bucket from R2_BUCKET (backups hold customer data)',
        path: ['BACKUP_BUCKET'],
      });
    }
  });
export type BackupEnv = z.infer<typeof BackupEnvSchema>;

export function loadBackupEnv(source: Record<string, string | undefined> = process.env): BackupEnv {
  const result = BackupEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment (check .env):\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in backup-lib.test.ts)

export const BACKUP_PREFIX = 'mongodb/';

/** e.g. mongodb/marafiq-2026-11-17T02-15-00Z.archive.gz (sorts by time). */
export function backupKey(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  return `${BACKUP_PREFIX}marafiq-${stamp}.archive.gz`;
}

/** The database named in a connection string, or undefined when it names none. */
export function databaseFromUri(uri: string): string | undefined {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  const name = match?.[1] ? decodeURIComponent(match[1]) : '';
  return name === '' ? undefined : name;
}

/** The host list of a connection string, without user, database or options. */
export function hostsFromUri(uri: string): string | undefined {
  return /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1]?.toLowerCase();
}

/**
 * The connection string without its database path, for mongorestore. With
 * --archive, a database in the URI acts as a filter on the archive's own
 * namespaces, so restoring under another name would silently restore nothing.
 * The target database is chosen with --nsInclude / --nsTo instead.
 *
 * The database path is also the default authentication database of a plain
 * mongodb:// URI with credentials, so it is kept as authSource there. A
 * mongodb+srv:// host (Atlas) supplies authSource through DNS; it is left alone.
 */
export function serverUri(uri: string): string {
  const match = /^(mongodb(?:\+srv)?:\/\/)([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(uri);
  if (!match) throw new Error('Not a MongoDB connection string');
  const [, scheme = '', authority = '', path = '', query = ''] = match;
  const params = new URLSearchParams(query);
  const database = decodeURIComponent(path);
  if (
    database !== '' &&
    scheme === 'mongodb://' &&
    authority.includes('@') &&
    !params.has('authSource')
  ) {
    params.set('authSource', database);
  }
  const rest = params.toString();
  return `${scheme}${authority}/${rest ? `?${rest}` : ''}`;
}

/** The connection string with any password replaced, for messages. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

export interface StoredBackup {
  key: string;
  modified: Date;
  bytes: number;
}

/**
 * Which backups to delete: older than the retention period, but never one of
 * the newest `keepMin` (so a broken schedule cannot empty the bucket).
 */
export function backupsToDelete(
  backups: StoredBackup[],
  now: Date,
  retentionDays: number,
  keepMin: number,
): string[] {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return [...backups]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(keepMin)
    .filter((backup) => backup.modified.getTime() < cutoff)
    .map((backup) => backup.key);
}

/** "mongodump version: 100.9.4" -> [100, 9, 4]. */
export function parseToolVersion(output: string): [number, number, number] | null {
  const match = /version:\s*r?(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Database Tools 100.3+ read the connection string from a config file, which
 * keeps the password out of the process list. Older tools need --uri.
 */
export function supportsConfigFile(version: [number, number, number] | null): boolean {
  if (!version) return false;
  const [major, minor] = version;
  return major > 100 || (major === 100 && minor >= 3);
}

// ---------------------------------------------------------------------------
// Running mongodump / mongorestore

function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Runs a MongoDB tool against `uri`. Its own output can echo the connection
 * string, so on failure only the last lines are returned, with any password
 * masked.
 */
export async function runMongoTool(
  tool: string,
  uri: string,
  args: string[],
  workDir: string,
): Promise<string> {
  const versionOutput = await run(tool, ['--version']).catch(() => {
    throw new Error(`${tool} was not found. Install MongoDB Database Tools (docs/DEPLOY.md).`);
  });
  const version = parseToolVersion(versionOutput.output);
  let connection: string[];
  if (supportsConfigFile(version)) {
    const configPath = join(workDir, 'mongo-tool.yaml');
    // A JSON string is a valid YAML double-quoted string.
    await writeFile(configPath, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
    connection = [`--config=${configPath}`];
  } else {
    connection = [`--uri=${uri}`];
  }
  const { code, output } = await run(tool, [...connection, ...args]);
  const safe = output.split(uri).join(redactUri(uri));
  if (code !== 0) {
    const tail = safe.trim().split('\n').slice(-5).join('\n');
    throw new Error(`${tool} exited with code ${code}:\n${tail}`);
  }
  return safe;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Where backups are kept

export interface BackupMeta {
  sha256: string;
  database: string;
}

export interface BackupStore {
  readonly name: string;
  put(key: string, file: string, meta: BackupMeta): Promise<void>;
  list(): Promise<StoredBackup[]>;
  download(key: string, file: string): Promise<BackupMeta | null>;
  remove(key: string): Promise<void>;
}

export class LocalBackupStore implements BackupStore {
  readonly name: string;
  constructor(private readonly dir: string) {
    this.name = `local folder ${dir}`;
  }

  private path(key: string): string {
    return join(this.dir, key.replace(/\//g, '__'));
  }

  async put(key: string, file: string, meta: BackupMeta): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await pipeline(createReadStream(file), createWriteStream(this.path(key)));
    await writeFile(`${this.path(key)}.json`, JSON.stringify(meta));
  }

  async list(): Promise<StoredBackup[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const prefix = BACKUP_PREFIX.replace(/\//g, '__');
    const backups: StoredBackup[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || name.endsWith('.json')) continue;
      const info = await stat(join(this.dir, name));
      backups.push({ key: name.replace(/__/g, '/'), modified: info.mtime, bytes: info.size });
    }
    return backups;
  }

  async download(key: string, file: string): Promise<BackupMeta | null> {
    await pipeline(createReadStream(this.path(key)), createWriteStream(file));
    try {
      return JSON.parse(await readFile(`${this.path(key)}.json`, 'utf8')) as BackupMeta;
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
    await rm(`${this.path(key)}.json`, { force: true });
  }
}

export class R2BackupStore implements BackupStore {
  readonly name: string;
  private readonly client: S3Client;

  constructor(
    options: { endpoint: string; accessKeyId: string; secretAccessKey: string },
    private readonly bucket: string,
  ) {
    this.name = `R2 bucket ${bucket}`;
    this.client = new S3Client({
      region: 'auto',
      endpoint: options.endpoint,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async put(key: string, file: string, meta: BackupMeta): Promise<void> {
    const { size } = await stat(file);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: 'application/gzip',
        Metadata: { sha256: meta.sha256, database: meta.database },
      }),
    );
  }

  async list(): Promise<StoredBackup[]> {
    const backups: StoredBackup[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: BACKUP_PREFIX,
          ContinuationToken: token,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key && item.LastModified) {
          backups.push({ key: item.Key, modified: item.LastModified, bytes: item.Size ?? 0 });
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return backups;
  }

  async download(key: string, file: string): Promise<BackupMeta | null> {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    await pipeline(object.Body as Readable, createWriteStream(file));
    const sha256 = head.Metadata?.sha256;
    const database = head.Metadata?.database;
    return sha256 && database ? { sha256, database } : null;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function chooseBackupStore(env: BackupEnv, repoRoot: string): BackupStore {
  if (env.BACKUP_BUCKET && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    return new R2BackupStore(
      {
        endpoint: env.R2_ENDPOINT,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      env.BACKUP_BUCKET,
    );
  }
  // loadBackupEnv() has already refused this in production.
  return new LocalBackupStore(join(repoRoot, '.local-backups'));
}
