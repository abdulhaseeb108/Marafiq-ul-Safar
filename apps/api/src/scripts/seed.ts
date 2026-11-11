/**
 * Development seed. Safe to run as often as you like: it only adds what is
 * missing and never changes or removes anything that already exists.
 *
 * Hotels come from `docs/seed/waqar-sample.json` (the shape in docs/03
 * section 3). If that file is not there, the rest is still seeded and the
 * result says so. No hotel names are invented (CLAUDE.md hard rule 8).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fxRateString } from '@marafiq/shared';
import { z } from 'zod';
import { SYSTEM_ACTOR } from '../lib/actor.js';
import { normalizeName } from '../lib/names.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { FxRateModel } from '../modules/fx/fx.model.js';
import { createFxRate } from '../modules/fx/fx.service.js';
import { HotelModel } from '../modules/hotels/hotel.model.js';
import { createHotel } from '../modules/hotels/hotels.service.js';
import { SettingsModel } from '../modules/settings/settings.model.js';
import { getSettingsDoc } from '../modules/settings/settings.service.js';
import { SupplierModel } from '../modules/suppliers/supplier.model.js';
import { createSupplier } from '../modules/suppliers/suppliers.service.js';

export const WAQAR_SUPPLIER_NAME = 'Waqar-e-Madina Group (WMT)';
export const DEFAULT_FX_RATE = '75.00';

/** Hotel rows as the extraction schema in docs/03 section 3 prints them. */
const FixtureHotelSchema = z.object({
  city: z.enum(['makkah', 'madinah']),
  name: z.string().trim().min(1),
  aliasesPrinted: z.array(z.string().trim().min(1)).default([]),
  distanceText: z.string().nullish(),
  distanceMeters: z.number().int().min(0).nullish(),
  transportText: z.string().nullish(),
});

const FixtureSchema = z.union([
  z.object({ hotels: z.array(FixtureHotelSchema) }),
  z.array(FixtureHotelSchema),
]);

type FixtureHotel = z.infer<typeof FixtureHotelSchema>;

/** The sheet writes transport as free text; map it to the three stored values. */
function transportFrom(text?: string | null): 'walking' | 'shuttle' | 'unknown' {
  if (!text) return 'unknown';
  if (/shuttle|bus|transport/i.test(text)) return 'shuttle';
  if (/walk/i.test(text)) return 'walking';
  return 'unknown';
}

function readFixture(path: string): FixtureHotel[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
      { cause: error },
    );
  }
  const result = FixtureSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `${path} does not match the rate sheet shape in docs/03 section 3: ${first?.path.join('.')} ${first?.message}`,
    );
  }
  return Array.isArray(result.data) ? result.data : result.data.hotels;
}

export interface SeedOptions {
  /** Defaults to docs/seed/waqar-sample.json in the repository. */
  fixturePath?: string;
  env?: { SEED_FX_RATE?: string };
}

export interface SeedResult {
  supplier: 'created' | 'exists';
  settings: 'created' | 'exists';
  fx: 'created' | 'exists';
  hotels: 'ok' | 'fixture_missing';
  hotelsCreated: number;
  hotelsSkipped: number;
}

const defaultFixturePath = (): string =>
  fileURLToPath(new URL('../../../../docs/seed/waqar-sample.json', import.meta.url));

export async function runSeed(options: SeedOptions = {}): Promise<SeedResult> {
  const fixturePath = options.fixturePath ?? defaultFixturePath();

  // Validate inputs before writing anything, so a bad value changes nothing.
  const rawRate = options.env?.SEED_FX_RATE ?? DEFAULT_FX_RATE;
  const parsedRate = fxRateString.safeParse(rawRate);
  if (!parsedRate.success) {
    throw new Error(`SEED_FX_RATE must be a decimal string such as "75.00", got "${rawRate}"`);
  }
  const fixtureFound = existsSync(fixturePath);
  const fixtureHotels = fixtureFound ? readFixture(fixturePath) : [];

  const result: SeedResult = {
    supplier: 'exists',
    settings: 'exists',
    fx: 'exists',
    hotels: fixtureFound ? 'ok' : 'fixture_missing',
    hotelsCreated: 0,
    hotelsSkipped: 0,
  };

  if (!(await SupplierModel.exists({ searchName: normalizeName(WAQAR_SUPPLIER_NAME) }))) {
    await createSupplier({ name: WAQAR_SUPPLIER_NAME, type: 'hotel_operator' }, SYSTEM_ACTOR);
    result.supplier = 'created';
  }

  if ((await SettingsModel.estimatedDocumentCount()) === 0) {
    await getSettingsDoc();
    result.settings = 'created';
  }

  if ((await FxRateModel.estimatedDocumentCount()) === 0) {
    await createFxRate({ rate: parsedRate.data, confirmLargeChange: false }, SYSTEM_ACTOR);
    result.fx = 'created';
  }

  for (const hotel of fixtureHotels) {
    const names = [hotel.name, ...hotel.aliasesPrinted].map(normalizeName);
    // Any known name, canonical or alias, means we already have this hotel.
    if (await HotelModel.exists({ city: hotel.city, searchNames: { $in: names } })) {
      result.hotelsSkipped += 1;
      continue;
    }
    await createHotel(
      {
        city: hotel.city,
        canonicalName: hotel.name,
        aliases: hotel.aliasesPrinted,
        distanceMeters: hotel.distanceMeters ?? null,
        distanceNote: hotel.distanceText ?? '',
        transport: transportFrom(hotel.transportText ?? hotel.distanceText),
        starRating: null,
      },
      SYSTEM_ACTOR,
    );
    result.hotelsCreated += 1;
  }

  return result;
}

async function main(): Promise<void> {
  const { loadEnv } = await import('../config/env.js');
  const dotenv = await import('dotenv');
  dotenv.default.config({
    path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
    quiet: true,
  });

  const env = loadEnv();
  await connectDb(env.MONGODB_URI);
  try {
    const result = await runSeed({ env: process.env });
    console.log('Seed finished:', result);
    if (result.hotels === 'fixture_missing') {
      console.log(
        'No docs/seed/waqar-sample.json found, so no hotels were added. Add that file (the shape is in docs/03 section 3) and run the seed again.',
      );
    }
  } finally {
    await disconnectDb();
  }
}

// Only run when executed directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
