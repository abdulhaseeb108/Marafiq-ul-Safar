/**
 * Index maintenance, run by hand (docs/DEPLOY.md "Database indexes").
 *
 *   npm run db:indexes -w @marafiq/api          lists what would change
 *   npm run db:indexes -w @marafiq/api -- --yes creates missing indexes and
 *                                               drops ones no schema declares
 *
 * In production the API only ever creates indexes on startup. Dropping one is
 * a deliberate step: take a backup first.
 */
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
// Importing the app registers every model, so all collections are covered.
import '../app.js';
import { loadEnv } from '../config/env.js';
import { connectDb, disconnectDb, syncIndexes } from '../db/connect.js';

dotenv.config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });

async function main(): Promise<void> {
  const apply = process.argv.includes('--yes');
  const env = loadEnv();
  await connectDb(env.MONGODB_URI);
  let changes = 0;
  for (const name of mongoose.modelNames()) {
    const { toCreate, toDrop } = await mongoose.model(name).diffIndexes();
    for (const index of toCreate) {
      changes += 1;
      console.log(`${name}: create ${JSON.stringify(index)}`);
    }
    for (const index of toDrop) {
      changes += 1;
      console.log(`${name}: drop "${index}"`);
    }
  }
  if (changes === 0) {
    console.log('Indexes already match the schemas.');
  } else if (!apply) {
    console.log(`${changes} change(s). Take a backup, then run again with --yes to apply.`);
  } else {
    const problems = await syncIndexes({ drop: true });
    for (const problem of problems) console.error(`Not applied: ${problem}`);
    console.log(problems.length === 0 ? 'Indexes updated.' : 'Some indexes were not updated.');
    if (problems.length > 0) process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('Index check failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
