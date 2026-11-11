import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { configFromEnv } from './config/app-config.js';
import { loadEnv } from './config/env.js';
import { connectDb } from './db/connect.js';
import { seedFirstAdmin } from './modules/users/users.seed.js';

// One .env at the repo root (same relative path from src/ and dist/).
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

async function main(): Promise<void> {
  const env = loadEnv();
  await connectDb(env.MONGODB_URI);

  const seeded = await seedFirstAdmin(env);
  if (seeded === 'created') {
    console.log(
      'First admin created from SEED_ADMIN_EMAIL. Sign in, set up 2FA, then remove SEED_ADMIN_PASSWORD from .env.',
    );
  }

  createApp({ config: configFromEnv(env) }).listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
}

main().catch((error: unknown) => {
  // Message only: connection strings and secrets must not reach the logs.
  console.error('API failed to start:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
