/**
 * Starts one MongoDB for the whole test run. Each test file then uses its own
 * database inside it (see setup.ts), so files cannot see each other's data.
 *
 * - Default: an in-memory single-node replica set, so publish, rollback and
 *   merge run in real transactions exactly as they do on MongoDB Atlas.
 * - MONGODB_TEST_STANDALONE=1: an in-memory standalone server. Transactions
 *   are not available there, so the same code runs its ordered-writes path.
 * - MONGODB_TEST_URI: use a server that is already running.
 */
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let uri = process.env.MONGODB_TEST_URI;
  let stop = async (): Promise<void> => undefined;

  if (!uri) {
    const { MongoMemoryReplSet, MongoMemoryServer } = await import('mongodb-memory-server');
    if (process.env.MONGODB_TEST_STANDALONE === '1') {
      const server = await MongoMemoryServer.create();
      uri = server.getUri();
      stop = async () => void (await server.stop());
    } else {
      const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      uri = replSet.getUri();
      stop = async () => void (await replSet.stop());
    }
  }

  project.provide('mongoUri', uri);
  return stop;
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
