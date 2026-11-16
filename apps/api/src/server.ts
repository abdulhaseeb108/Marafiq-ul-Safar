import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { LogEmail, ResendEmail, type EmailAdapter } from './adapters/email/email.js';
import { AnthropicExtraction } from './adapters/extraction/anthropic.js';
import { LocalDiskStorage } from './adapters/storage/local-disk.js';
import { R2Storage } from './adapters/storage/r2.js';
import type { StorageAdapter } from './adapters/storage/storage.js';
import { createApp } from './app.js';
import { configFromEnv } from './config/app-config.js';
import { loadEnv, type Env } from './config/env.js';
import { connectDb, disconnectDb, syncIndexes } from './db/connect.js';
import {
  startDocumentProcessingWorker,
  type DocumentProcessingWorker,
} from './modules/document-intelligence/document-processing.worker.js';
import { seedFirstAdmin } from './modules/users/users.seed.js';

// One .env at the repo root (same relative path from src/ and dist/).
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
let apiServer: Server | undefined;
let documentWorker: DocumentProcessingWorker | undefined;
let shuttingDown = false;

function chooseStorage(env: Env): StorageAdapter {
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET) {
    return new R2Storage({
      endpoint: R2_ENDPOINT,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      bucket: R2_BUCKET,
    });
  }
  if (env.NODE_ENV === 'production') {
    // Uploaded sheets are the record of what suppliers quoted: do not keep them on a server disk.
    throw new Error(
      'R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required in production',
    );
  }
  return new LocalDiskStorage(`${repoRoot}.local-storage`);
}

function chooseEmail(env: Env): EmailAdapter {
  if (env.RESEND_API_KEY && env.MAIL_FROM)
    return new ResendEmail(env.RESEND_API_KEY, env.MAIL_FROM);
  if (env.NODE_ENV === 'production') {
    // Customers must get their quote links; a log-only adapter would drop them silently.
    throw new Error('RESEND_API_KEY and MAIL_FROM are required in production');
  }
  return new LogEmail();
}

async function main(): Promise<void> {
  const env = loadEnv();
  await connectDb(env.MONGODB_URI);
  for (const problem of await syncIndexes()) {
    console.warn(`Index could not be synced (${problem}). Fix the data, then restart.`);
  }

  const seeded = await seedFirstAdmin(env);
  if (seeded === 'created') {
    console.log(
      'First admin created from SEED_ADMIN_EMAIL. Sign in, set up 2FA, then remove SEED_ADMIN_PASSWORD from .env.',
    );
  }

  const storage = chooseStorage(env);
  const extraction = env.ANTHROPIC_API_KEY
    ? new AnthropicExtraction(env.ANTHROPIC_API_KEY, env.EXTRACTION_MODEL)
    : undefined;
  console.log(
    `Rate sheets: files in ${storage.name}; reading ${extraction ? `with ${extraction.model}` : 'by hand only (no ANTHROPIC_API_KEY)'}.`,
  );

  const email = chooseEmail(env);
  console.log(`Email: ${email.name}.`);

  const host = env.NODE_ENV === 'development' ? '127.0.0.1' : undefined;
  const config = configFromEnv(env);
  const server = createApp({
    config,
    deps: { storage, extraction, inlineJobs: false, email },
  });
  apiServer = host ? server.listen(env.PORT, host) : server.listen(env.PORT);
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      apiServer?.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      apiServer?.off('listening', onListening);
      reject(error);
    };
    apiServer?.once('error', onError);
    apiServer?.once('listening', onListening);
  });

  apiServer.on('error', (error) => {
    console.error('API server error:', error.message);
    process.exitCode = 1;
    void shutdown('server error');
  });
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  documentWorker = startDocumentProcessingWorker({
    storage,
    limits: config.documentParserLimits,
  });
  console.warn(
    'Document intelligence: malware scanner is not configured; files will remain unparsed until scanning is available.',
  );
  console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`API shutting down (${reason}).`);

  const server = apiServer;
  if (server?.listening) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      console.error(
        'API HTTP shutdown failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      process.exitCode = 1;
    }
  }

  const worker = documentWorker;
  documentWorker = undefined;
  if (worker) {
    try {
      await worker.stop();
    } catch (error) {
      console.error(
        'Document processing worker shutdown failed:',
        error instanceof Error ? error.name : 'unknown',
      );
      process.exitCode = 1;
    }
  }

  try {
    await disconnectDb();
  } catch (error) {
    console.error(
      'API database shutdown failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // Message only: connection strings and secrets must not reach the logs.
  console.error('API failed to start:', error instanceof Error ? error.message : 'unknown error');
  void disconnectDb()
    .catch((disconnectError: unknown) => {
      console.error(
        'API database shutdown failed:',
        disconnectError instanceof Error ? disconnectError.message : 'unknown error',
      );
    })
    .finally(() => {
      process.exitCode = 1;
    });
});
