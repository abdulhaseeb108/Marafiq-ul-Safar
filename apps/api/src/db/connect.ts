import mongoose from 'mongoose';

export async function connectDb(uri: string): Promise<void> {
  mongoose.set('strictQuery', true);
  // Calls made inside lib/transaction.ts inTransaction() join it by themselves.
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
}

/**
 * Make the database's indexes match the schemas. Run at startup. The
 * collections are small (hundreds of rows), so this takes moments.
 *
 * - `drop: true` (development and tests): create missing indexes and drop any
 *   that a schema no longer declares.
 * - `drop: false` (production): create missing indexes only. An index that a
 *   schema no longer declares is reported, never dropped by a restart; remove
 *   it on purpose with `npm run db:indexes -w @marafiq/api` (docs/DEPLOY.md).
 *
 * A failure is reported and startup continues: the API still works, because
 * the services check uniqueness themselves; the index is the second line of
 * defence. Returns the problems so the caller can log them.
 */
export async function syncIndexes(options: { drop: boolean }): Promise<string[]> {
  const problems: string[] = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    try {
      if (options.drop) {
        await model.syncIndexes();
        continue;
      }
      await model.createIndexes();
      const { toDrop } = await model.diffIndexes();
      for (const index of toDrop) {
        problems.push(`${name}: index "${index}" is no longer declared and was kept`);
      }
    } catch (error) {
      // Name and code only: a duplicate-key message quotes the duplicated value.
      const code = (error as { code?: unknown } | null)?.code;
      const kind = error instanceof Error ? error.name : 'unknown error';
      problems.push(`${name}: ${kind}${typeof code === 'number' ? ` (code ${code})` : ''}`);
    }
  }
  return problems;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
