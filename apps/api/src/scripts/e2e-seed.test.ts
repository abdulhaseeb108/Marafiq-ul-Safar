import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { SupplierModel } from '../modules/suppliers/supplier.model.js';
import { E2E_DATABASE, resetAndSeed, resetRefusal } from './e2e-seed.js';

describe('E2E seed guard', () => {
  const allowed = { NODE_ENV: 'development', E2E_ALLOW_DB_RESET: 'true' };

  it('allows only an explicit flag, the exact database name and a non-production run', () => {
    expect(resetRefusal(allowed, E2E_DATABASE)).toBeNull();
    expect(resetRefusal({ ...allowed, NODE_ENV: 'test' }, 'marafiq_e2e')).toBeNull();
  });

  it('refuses without E2E_ALLOW_DB_RESET=true', () => {
    for (const flag of [undefined, '', '1', 'yes', 'TRUE', ' true']) {
      expect(resetRefusal({ ...allowed, E2E_ALLOW_DB_RESET: flag }, E2E_DATABASE)).toMatch(
        /E2E_ALLOW_DB_RESET=true/,
      );
    }
  });

  it('refuses any other database name, including look-alikes', () => {
    for (const name of [
      undefined,
      'marafiq',
      'marafiq_local',
      'marafiq_e2e_old',
      'prod_marafiq_e2e',
      'MARAFIQ_E2E',
      'e2e',
    ]) {
      expect(resetRefusal(allowed, name)).toMatch(/not named exactly "marafiq_e2e"/);
    }
  });

  it('refuses production even with the flag and the right name', () => {
    expect(resetRefusal({ ...allowed, NODE_ENV: 'production' }, E2E_DATABASE)).toMatch(
      /NODE_ENV=production/,
    );
  });

  it('checks before deleting anything: another database keeps its data', async () => {
    expect(mongoose.connection.db?.databaseName).not.toBe(E2E_DATABASE);
    await SupplierModel.create({ name: 'Keep me', searchName: 'keep me', type: 'other' });
    await expect(resetAndSeed(new Date(), allowed)).rejects.toThrow(/not named exactly/);
    expect(await SupplierModel.countDocuments({ name: 'Keep me' })).toBe(1);
  });
});
