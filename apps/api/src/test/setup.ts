/**
 * Per test file: connect to the shared test MongoDB (started in
 * global-setup.ts) using a database of this file's own, empty it before each
 * test, and drop it at the end.
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { resetTransactionSupport } from '../lib/transaction.js';

beforeAll(async () => {
  // Same setting as connectDb(): calls inside inTransaction() join it.
  mongoose.set('transactionAsyncLocalStorage', true);
  resetTransactionSupport();
  await mongoose.connect(inject('mongoUri'), { dbName: `msf_test_${randomUUID().slice(0, 8)}` });
  // Build indexes up front so index builds never overlap a transaction.
  await Promise.all(
    mongoose.modelNames().map((name) =>
      mongoose
        .model(name)
        .init()
        .catch((error: unknown) => {
          // MongoDB-compatible stand-ins (used via MONGODB_TEST_URI) lack some
          // index types, e.g. TTL. Real MongoDB never raises this message.
          if (!(error instanceof Error && error.message.includes('not implemented yet')))
            throw error;
        }),
    ),
  );
}, 120_000);

beforeEach(async () => {
  const collections = await mongoose.connection.db?.collections();
  await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
