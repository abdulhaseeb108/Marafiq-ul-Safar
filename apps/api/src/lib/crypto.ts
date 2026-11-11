import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
}

/** AES-256-GCM. Output: base64 `iv.tag.ciphertext`. */
export function encryptSecret(plain: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
}

/** Throws if the key is wrong or the data was altered. */
export function decryptSecret(encrypted: string, key: Buffer): string {
  assertKey(key);
  const [iv, tag, data] = encrypted.split('.').map((part) => Buffer.from(part, 'base64'));
  if (!iv || !tag || !data) throw new Error('Malformed encrypted value');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 32 random bytes, URL-safe. Used for refresh tokens. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Keyed hash for storing tokens: a database leak alone does not reveal them. */
export function hashToken(token: string, key: string): string {
  return createHmac('sha256', key).update(token).digest('hex');
}
