import { describe, expect, it } from 'vitest';
// Registers every model, as the server does.
import '../app.js';
import { HotelModel } from '../modules/hotels/hotel.model.js';
import { syncIndexes } from './connect.js';

const indexNames = async () => (await HotelModel.collection.indexes()).map((index) => index.name);

describe('syncIndexes', () => {
  it('in production mode keeps an index no schema declares, and reports it', async () => {
    await HotelModel.collection.createIndex({ legacyField: 1 }, { name: 'legacyField_1' });
    const problems = await syncIndexes({ drop: false });
    expect(await indexNames()).toContain('legacyField_1');
    expect(problems).toContain('Hotel: index "legacyField_1" is no longer declared and was kept');
  });

  it('in development mode drops it', async () => {
    await HotelModel.collection.createIndex({ legacyField: 1 }, { name: 'legacyField_1' });
    expect(await syncIndexes({ drop: true })).toEqual([]);
    expect(await indexNames()).not.toContain('legacyField_1');
  });

  it('creates missing declared indexes in both modes', async () => {
    await HotelModel.collection.dropIndexes();
    const declared = (await HotelModel.diffIndexes()).toCreate.length;
    expect(declared).toBeGreaterThan(0);
    await syncIndexes({ drop: false });
    expect((await HotelModel.diffIndexes()).toCreate).toEqual([]);
  });
});
