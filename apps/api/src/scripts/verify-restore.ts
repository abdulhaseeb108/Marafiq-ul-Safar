/**
 * Compares a restored database with its source (docs/DEPLOY.md section 11).
 * Read-only on both: it lists collections, counts documents and reads index
 * definitions, and changes nothing.
 *
 *   npm run verify-restore -w @marafiq/api -- --source-uri "<uri>" --target-uri "<uri>"
 *
 * Exits with code 1 when a collection, a document count or an index differs.
 * Connection strings are never printed.
 */
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';

export interface DatabaseShape {
  /** Collection name -> document count. */
  counts: Record<string, number>;
  /** Collection name -> sorted index descriptions (keys and options that matter). */
  indexes: Record<string, string[]>;
}

/** The parts of an index that change behaviour; build metadata such as `v` is ignored. */
function describeIndex(index: Record<string, unknown>): string {
  const { key, unique, sparse, expireAfterSeconds, partialFilterExpression, name } = index;
  return JSON.stringify({ name, key, unique, sparse, expireAfterSeconds, partialFilterExpression });
}

export async function readShape(uri: string): Promise<DatabaseShape> {
  const connection = await mongoose
    .createConnection(uri, { serverSelectionTimeoutMS: 15_000, autoIndex: false })
    .asPromise();
  try {
    const db = connection.db;
    if (!db) throw new Error('Could not open the database');
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((name) => !name.startsWith('system.'))
      .sort();
    const shape: DatabaseShape = { counts: {}, indexes: {} };
    for (const name of names) {
      shape.counts[name] = await db.collection(name).countDocuments();
      shape.indexes[name] = (await db.collection(name).indexes())
        .map((index) => describeIndex(index as Record<string, unknown>))
        .sort();
    }
    return shape;
  } finally {
    await connection.close();
  }
}

/** Every difference between the two shapes, as readable lines; empty when they match. */
export function compareShapes(source: DatabaseShape, target: DatabaseShape): string[] {
  const problems: string[] = [];
  const names = [...new Set([...Object.keys(source.counts), ...Object.keys(target.counts)])].sort();
  for (const name of names) {
    if (!(name in target.counts)) {
      problems.push(`${name}: missing in the restored database`);
      continue;
    }
    if (!(name in source.counts)) {
      problems.push(`${name}: only in the restored database`);
      continue;
    }
    if (source.counts[name] !== target.counts[name]) {
      problems.push(
        `${name}: ${source.counts[name]} documents in source, ${target.counts[name]} restored`,
      );
    }
    const want = source.indexes[name] ?? [];
    const have = target.indexes[name] ?? [];
    for (const index of want)
      if (!have.includes(index)) problems.push(`${name}: index missing ${index}`);
    for (const index of have)
      if (!want.includes(index)) problems.push(`${name}: extra index ${index}`);
  }
  return problems;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const sourceUri = flag('--source-uri');
  const targetUri = flag('--target-uri');
  if (!sourceUri || !targetUri) throw new Error('Give --source-uri <uri> and --target-uri <uri>.');
  const [source, target] = [await readShape(sourceUri), await readShape(targetUri)];
  for (const [name, count] of Object.entries(target.counts)) {
    console.log(`  ${name}: ${count} documents, ${target.indexes[name]?.length ?? 0} indexes`);
  }
  const problems = compareShapes(source, target);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`DIFFERENT ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Restore matches the source: ${Object.keys(target.counts).length} collections.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Message only: driver errors can name hosts; connection strings are never printed here.
    console.error('Verify failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
