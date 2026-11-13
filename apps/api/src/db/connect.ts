import mongoose from 'mongoose';

export async function connectDb(uri: string): Promise<void> {
  mongoose.set('strictQuery', true);
  // Calls made inside lib/transaction.ts inTransaction() join it by themselves.
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
}

/**
 * Make the database's indexes match the schemas: create missing ones and drop
 * any that a schema no longer declares. Run at startup. The collections are
 * small (hundreds of rows), so this takes moments.
 *
 * A failure is reported and startup continues: the API still works, because
 * the services check uniqueness themselves; the index is the second line of
 * defence. Returns the problems so the caller can log them.
 */
export async function syncIndexes(): Promise<string[]> {
  const problems: string[] = [];
  for (const name of mongoose.modelNames()) {
    try {
      await mongoose.model(name).syncIndexes();
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return problems;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
