import mongoose from 'mongoose';

let supported: boolean | undefined;

/** Transactions need a replica set (MongoDB Atlas is one) or a sharded cluster. */
async function detectSupport(): Promise<boolean> {
  const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
  return Boolean(hello?.setName) || hello?.msg === 'isdbgrid';
}

/**
 * Run `work` as one all-or-nothing unit.
 *
 * With `transactionAsyncLocalStorage` on (see connectDb), every Mongoose call
 * made inside `work` joins the transaction by itself. Do not run those calls
 * in parallel (no Promise.all inside): a session handles one at a time.
 *
 * On a standalone MongoDB, which cannot do transactions, `work` runs as plain
 * sequential writes. Callers therefore order their writes so that stopping
 * half-way leaves nothing wrong on show: at worst a pack is missing, never
 * mispriced. Production (Atlas) always gets the real transaction.
 */
export async function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  supported ??= await detectSupport();
  if (!supported) return work();

  let result: T | undefined;
  await mongoose.connection.transaction(async () => {
    result = await work();
  });
  return result as T;
}

/** For tests and reconnects: forget what the last connection supported. */
export function resetTransactionSupport(): void {
  supported = undefined;
}
