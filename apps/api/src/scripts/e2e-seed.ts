/**
 * Resets an end-to-end test database and fills it for the Playwright flow
 * (docs/04 Phase 6): the WMT hotels and its first file's packs published as
 * if staff had reviewed them, an FX rate, and one sales user.
 *
 * The pack dates are moved so Ramadan Pack 01 starts 20 days from today, so
 * the test never runs out of future dates. The flow test uses the same rule.
 *
 * It deletes every document in the database, so it refuses to run unless
 * E2E_ALLOW_DB_RESET=true is set, the database is named exactly "marafiq_e2e",
 * and NODE_ENV is not production (resetRefusal).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { connectDb, disconnectDb, syncIndexes } from '../db/connect.js';
import { normalizeName } from '../lib/names.js';
import { hashPassword } from '../modules/auth/password.js';
import { HotelModel } from '../modules/hotels/hotel.model.js';
import { addDays } from '../modules/pricing/engine.js';
import { todayInPakistan } from '../modules/pricing/pricing.service.js';
import {
  HotelRateModel,
  RatePackageModel,
  SourceDocumentModel,
  VisaRateModel,
} from '../modules/rate-sheets/rate-sheet.models.js';
import { SupplierModel } from '../modules/suppliers/supplier.model.js';
import { UserModel } from '../modules/users/user.model.js';
import { WAQAR_SUPPLIER_NAME, runSeed } from './seed.js';

export const E2E_SALES = {
  email: 'e2e-sales@example.com',
  password: 'e2e-sales-password-1',
  name: 'E2E Sales',
};
/** Ramadan Pack 01 starts on the night of this date in the fixture. */
const FIXTURE_FIRST_NIGHT = '2027-02-06';
const FIXTURE_FILE = 'WMT_RAMADAN_27_OCT_2026.pdf';

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

interface FixturePack {
  sourceFile: string;
  packName: string;
  nightFrom: string;
  nightTo: string;
  issueDate: string;
  visa: {
    directPerPerson: number | null;
    indirectByGroupSize: Record<'1' | '2' | '3' | '4', number | null>;
    infant: number | null;
  };
  hotels: {
    city: 'makkah' | 'madinah';
    name: string;
    aliasesPrinted: string[];
    pricingMode: 'derived_per_person' | 'flat_per_room' | 'on_request';
    room: number | null;
    perPerson: {
      quint: number | null;
      quad: number | null;
      triple: number | null;
      double: number | null;
    };
  }[];
}

const minor = (major: number | null) => (major === null ? null : Math.round(major * 100));

/** The only database the E2E seed may wipe. */
export const E2E_DATABASE = 'marafiq_e2e';

/**
 * Why the reset must not run, or null when it may. All three must hold: not
 * production, an explicit E2E_ALLOW_DB_RESET=true, and the exact database name.
 */
export function resetRefusal(
  env: Record<string, string | undefined>,
  databaseName: string | undefined,
): string | null {
  if (env.NODE_ENV === 'production')
    return 'Refusing to run the E2E seed with NODE_ENV=production.';
  if (env.E2E_ALLOW_DB_RESET !== 'true') {
    return 'Refusing to reset the database: set E2E_ALLOW_DB_RESET=true to confirm it may be wiped.';
  }
  if (databaseName !== E2E_DATABASE) {
    return `Refusing to reset a database not named exactly "${E2E_DATABASE}".`;
  }
  return null;
}

export async function resetAndSeed(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<{ shiftDays: number }> {
  const db = mongoose.connection.db;
  const refusal = resetRefusal(env, db?.databaseName);
  if (!db || refusal) throw new Error(refusal ?? 'Not connected to a database.');
  for (const collection of await db.collections()) await collection.deleteMany({});
  await syncIndexes({ drop: true });

  await runSeed({ env: { SEED_FX_RATE: '75.00' } });
  await UserModel.create({
    email: E2E_SALES.email,
    name: E2E_SALES.name,
    role: 'sales',
    passwordHash: await hashPassword(E2E_SALES.password),
    active: true,
  });

  const supplier = await SupplierModel.findOne({ searchName: normalizeName(WAQAR_SUPPLIER_NAME) });
  if (!supplier) throw new Error('Seed did not create the supplier');
  const hotels = await HotelModel.find().lean();
  const hotelFor = (city: string, names: string[]) => {
    const wanted = names.map(normalizeName);
    return hotels.find((h) => h.city === city && h.searchNames.some((n) => wanted.includes(n)));
  };

  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../docs/seed/waqar-sample.json', import.meta.url)),
      'utf8',
    ),
  ) as { extractions: FixturePack[] };
  const shiftDays = daysBetween(FIXTURE_FIRST_NIGHT, addDays(todayInPakistan(now), 20));
  const shift = (date: string) => addDays(date, shiftDays);

  const document = await SourceDocumentModel.create({
    supplierId: supplier._id,
    fileKey: 'e2e/fixture.pdf',
    fileName: FIXTURE_FILE,
    mimeType: 'application/pdf',
    sizeBytes: 1,
    sha256: 'e2e-fixture',
    receivedAt: now,
    extractionStatus: 'published',
  });

  for (const pack of fixture.extractions.filter((p) => p.sourceFile === FIXTURE_FILE)) {
    const created = await RatePackageModel.create({
      supplierId: supplier._id,
      sourceDocumentId: document._id,
      packName: pack.packName,
      nightFrom: shift(pack.nightFrom),
      nightTo: shift(pack.nightTo),
      issueDate: pack.issueDate,
      status: 'published',
      version: 1,
      publishedAt: now,
    });
    await HotelRateModel.insertMany(
      pack.hotels.map((row, index) => ({
        packageId: created._id,
        hotelId: hotelFor(row.city, [row.name, ...row.aliasesPrinted])?._id,
        printed: { city: row.city, name: row.name, aliases: row.aliasesPrinted },
        pricingMode: row.pricingMode,
        roomPriceMinor: minor(row.room),
        perPersonMinor: {
          quint: minor(row.perPerson.quint),
          quad: minor(row.perPerson.quad),
          triple: minor(row.perPerson.triple),
          double: minor(row.perPerson.double),
        },
        sourceRow: index,
      })),
    );
    await VisaRateModel.create({
      packageId: created._id,
      direct: { perPersonMinor: minor(pack.visa.directPerPerson) },
      indirectByGroupSize: {
        '1': minor(pack.visa.indirectByGroupSize['1']),
        '2': minor(pack.visa.indirectByGroupSize['2']),
        '3': minor(pack.visa.indirectByGroupSize['3']),
        '4': minor(pack.visa.indirectByGroupSize['4']),
      },
      infantMinor: minor(pack.visa.infant),
    });
  }
  return { shiftDays };
}

async function main(): Promise<void> {
  // Production and the confirmation flag are checked before connecting at all;
  // resetAndSeed checks everything again, with the real database name, before wiping.
  const early = resetRefusal(process.env, E2E_DATABASE);
  if (early) throw new Error(early);
  // Only the variable passed in; the repository .env is deliberately not read.
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await connectDb(uri);
  try {
    const { shiftDays } = await resetAndSeed();
    console.log(`E2E database ready (pack dates moved by ${shiftDays} days).`);
  } finally {
    await disconnectDb();
  }
}

// pathToFileURL gives the same form as import.meta.url on Windows (file:///C:/...) and POSIX.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('E2E seed failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
