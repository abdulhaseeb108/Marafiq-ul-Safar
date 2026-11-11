import argon2 from 'argon2';

/** argon2id with the library's current defaults. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash: treat as a failed login, not a crash
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spend the same time as a real check when the email is unknown, so response
 * time does not reveal which emails have accounts.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('placeholder-for-unknown-accounts');
  await verifyPassword(await dummyHash, password);
}
