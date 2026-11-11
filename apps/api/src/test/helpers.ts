import type { Role, SupplierType } from '@marafiq/shared';
import type { Express } from 'express';
import { generate, generateSecret } from 'otplib';
import request, { type Response } from 'supertest';
import { createApp } from '../app.js';
import type { AppConfig } from '../config/app-config.js';
import { encryptSecret } from '../lib/crypto.js';
import { hashPassword } from '../modules/auth/password.js';
import { UserModel, type UserDoc } from '../modules/users/user.model.js';

export const TEST_PASSWORD = 'correct-horse-battery-1';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    jwtSecret: 'test-jwt-secret-test-jwt-secret-0001',
    refreshSecret: 'test-refresh-secret-test-refresh-0002',
    totpKey: Buffer.alloc(32, 7),
    secureCookies: true,
    trustProxy: true, // lets tests pick a client IP with X-Forwarded-For
    accessTtlSeconds: 900,
    refreshTtlSeconds: 7 * 24 * 3600,
    mfaTtlSeconds: 300,
    totpIssuer: 'Marafiq us Safar',
    loginLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000 },
    ...overrides,
  };
}

export function makeApp(overrides: Partial<AppConfig> = {}): { app: Express; config: AppConfig } {
  const config = testConfig(overrides);
  return { app: createApp({ config }), config };
}

let counter = 0;

export interface SeededUser {
  user: UserDoc;
  id: string;
  email: string;
  password: string;
  totpSecret?: string;
}

/** Insert a user directly. Admins get an enrolled TOTP secret unless totp is false. */
export async function seedUser(
  options: { role?: Role; email?: string; totp?: boolean; active?: boolean; name?: string } = {},
): Promise<SeededUser> {
  const role = options.role ?? 'sales';
  const email = options.email ?? `${role}${++counter}@example.com`;
  const withTotp = options.totp ?? role === 'admin';
  const totpSecret = withTotp ? generateSecret() : undefined;
  const user = await UserModel.create({
    email,
    name: options.name ?? `Test ${role}`,
    role,
    passwordHash: await hashPassword(TEST_PASSWORD),
    active: options.active ?? true,
    totpSecretEnc: totpSecret ? encryptSecret(totpSecret, testConfig().totpKey) : undefined,
  });
  return { user, id: user.id as string, email, password: TEST_PASSWORD, totpSecret };
}

export function totpCode(secret: string): Promise<string> {
  return generate({ secret });
}

/** Minimal cookie jar. Supertest's agent will not send Secure cookies over http. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(res: Response): this {
    const header = res.headers['set-cookie'] as string[] | string | undefined;
    const lines = Array.isArray(header) ? header : header ? [header] : [];
    for (const line of lines) {
      const [pair = ''] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): this {
    this.cookies.set(name, value);
    return this;
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** Raw Set-Cookie line for one cookie, for asserting flags. */
export function setCookieLine(res: Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  const lines = Array.isArray(header) ? header : header ? [header] : [];
  return lines.find((line) => line.startsWith(`${name}=`));
}

/** Full real sign-in (password, then TOTP when enrolled). Returns the cookie jar. */
export async function signInAs(app: Express, seeded: SeededUser): Promise<CookieJar> {
  const jar = new CookieJar();
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: seeded.email, password: seeded.password });
  jar.absorb(login);
  if (login.body.next === '2fa' && seeded.totpSecret) {
    const second = await request(app)
      .post('/api/v1/auth/2fa')
      .set('Cookie', jar.header())
      .send({ code: await totpCode(seeded.totpSecret) });
    jar.absorb(second);
  }
  if (!jar.get('msf_access')) {
    throw new Error(`sign-in failed for ${seeded.email}: ${JSON.stringify(login.body)}`);
  }
  return jar;
}

export async function signInWithRole(
  app: Express,
  role: Role,
): Promise<{ jar: CookieJar; seeded: SeededUser }> {
  const seeded = await seedUser({ role });
  return { jar: await signInAs(app, seeded), seeded };
}

// --- master data (Phase 2) -------------------------------------------------

export async function seedSupplier(
  overrides: Partial<{ name: string; type: SupplierType; active: boolean }> = {},
): Promise<{ id: string; name: string }> {
  const { SupplierModel } = await import('../modules/suppliers/supplier.model.js');
  const name = overrides.name ?? `Supplier ${++counter}`;
  const doc = await SupplierModel.create({
    name,
    searchName: name.trim().toLowerCase(),
    type: overrides.type ?? 'hotel_operator',
    active: overrides.active ?? true,
  });
  return { id: doc.id as string, name: doc.name };
}

export async function seedHotel(
  overrides: Partial<{
    city: 'makkah' | 'madinah';
    canonicalName: string;
    aliases: string[];
    active: boolean;
  }> = {},
): Promise<{ id: string; canonicalName: string }> {
  const { HotelModel } = await import('../modules/hotels/hotel.model.js');
  const canonicalName = overrides.canonicalName ?? `Hotel ${++counter}`;
  const aliases = overrides.aliases ?? [];
  const doc = await HotelModel.create({
    city: overrides.city ?? 'makkah',
    canonicalName,
    aliases,
    searchNames: [canonicalName, ...aliases].map((name) => name.trim().toLowerCase()),
    distanceNote: '',
    transport: 'unknown',
    active: overrides.active ?? true,
  });
  return { id: doc.id as string, canonicalName: doc.canonicalName };
}

export async function seedFlightEstimate(
  overrides: Partial<{ originCity: string; validTo: string; destination: 'JED' | 'MED' }> = {},
): Promise<{ id: string; originCity: string }> {
  const { FlightEstimateModel } =
    await import('../modules/flight-estimates/flight-estimate.model.js');
  const doc = await FlightEstimateModel.create({
    originCity: overrides.originCity ?? `City ${++counter}`,
    destination: overrides.destination ?? 'JED',
    lowMinor: 15_000_000,
    highMinor: 21_000_000,
    currency: 'PKR',
    validTo: overrides.validTo ?? '2027-12-31',
    source: 'partner quote 2026-11-05',
  });
  return { id: doc.id as string, originCity: doc.originCity };
}
