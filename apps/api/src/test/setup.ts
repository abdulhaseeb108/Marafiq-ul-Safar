/**
 * Test database. By default an in-memory MongoDB is started for each test
 * file, so tests need no external database. Set MONGODB_TEST_URI to use an
 * already running server instead (each file still gets its own database).
 */
import { randomUUID } from 'node:crypto';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';

let memoryServer: MongoMemoryServer | undefined;

beforeAll(async () => {
  const dbName = `msf_test_${randomUUID().slice(0, 8)}`;
  let uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    uri = memoryServer.getUri();
  }
  await mongoose.connect(uri, { dbName });
}, 120_000);

beforeEach(async () => {
  const collections = await mongoose.connection.db?.collections();
  await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await memoryServer?.stop();
});
