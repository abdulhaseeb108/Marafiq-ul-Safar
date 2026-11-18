import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HotelIndex, nameSimilarity } from '../modules/rate-sheets/matching.js';
import { sniffMimeType } from '../modules/rate-sheets/documents.service.js';
import { seedHotel } from '../test/helpers.js';
import { ExtractionFormatError, parseModelJson } from './extraction/extraction.js';
import { LocalDiskStorage } from './storage/local-disk.js';
import { MemoryStorage, rateSheetKey, type StorageAdapter } from './storage/storage.js';

const SUPPLIER = '64b7f0c2a1b2c3d4e5f60718';
const HASH = 'a'.repeat(64);

describe('storage', () => {
  it('builds keys from ids and the hash only', () => {
    expect(rateSheetKey(SUPPLIER, HASH, 'application/pdf')).toBe(
      `rate-sheets/${SUPPLIER}/${HASH}.pdf`,
    );
    expect(rateSheetKey(SUPPLIER, HASH, 'image/jpeg')).toMatch(/\.jpg$/);
    expect(() => rateSheetKey('../etc', HASH, 'application/pdf')).toThrow();
    expect(() => rateSheetKey(SUPPLIER, '../../passwd', 'application/pdf')).toThrow();
  });

  it.each([
    ['memory', (): StorageAdapter => new MemoryStorage()],
    [
      'local disk',
      (): StorageAdapter => new LocalDiskStorage(mkdtempSync(join(tmpdir(), 'msf-store-'))),
    ],
  ])('%s: stores and returns the same bytes', async (_name, make) => {
    const storage = make();
    const key = rateSheetKey(SUPPLIER, HASH, 'application/pdf');
    const data = Buffer.from([0, 1, 2, 255, 254]);
    await storage.put(key, data, 'application/pdf');
    expect(await storage.get(key)).toEqual(data);
    await expect(storage.get('rate-sheets/missing.pdf')).rejects.toThrow();
  });

  it('local disk refuses a key that climbs out of its folder', async () => {
    const storage = new LocalDiskStorage(mkdtempSync(join(tmpdir(), 'msf-store-')));
    await expect(storage.put('../outside.pdf', Buffer.from('x'))).rejects.toThrow(/escapes/);
    await expect(storage.get('../../etc/hosts')).rejects.toThrow(/escapes/);
  });
});

describe('file type detection', () => {
  it('goes by the first bytes', () => {
    expect(sniffMimeType(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe1]))).toBe('image/jpeg');
    expect(sniffMimeType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('reading the model answer', () => {
  it('takes the JSON object out of a fenced or chatty answer', () => {
    expect(parseModelJson('{"packs":[]}')).toEqual({ packs: [] });
    expect(parseModelJson('```json\n{"packs":[]}\n```')).toEqual({ packs: [] });
    expect(parseModelJson('Here you go: {"packs":[{"a":1}]} Hope that helps.')).toEqual({
      packs: [{ a: 1 }],
    });
  });

  it('raises a format error when there is no usable JSON', () => {
    expect(() => parseModelJson('I could not read the file.')).toThrow(ExtractionFormatError);
    expect(() => parseModelJson('{"packs": [')).toThrow(ExtractionFormatError);
  });
});

describe('hotel name matching', () => {
  it('scores spelling slips high and different hotels low', () => {
    expect(nameSimilarity('QILA AJYAD', 'Qila Ajiyad')).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity('Novotel  Thakher', 'novotel thakher')).toBe(1);
    expect(nameSimilarity('Waqar Rotana', 'Waqar International')).toBeLessThan(0.85);
    expect(nameSimilarity('Nuzul Waqar', 'Nida Taiba')).toBeLessThan(0.5);
    expect(nameSimilarity('', 'Voco')).toBe(0);
  });

  it('matches exactly by name or alias within the city, and only suggests otherwise', async () => {
    const rose = await seedHotel({
      city: 'madinah',
      canonicalName: 'Rose Platinum',
      aliases: ['Retaj Rawdah'],
    });
    const index = await HotelIndex.load();

    expect(index.match('madinah', 'ROSE PLATINUM')).toEqual({
      hotelId: rose.id,
      suggestedHotelId: null,
    });
    expect(index.match('madinah', 'retaj  rawdah').hotelId).toBe(rose.id);
    // A new name printed beside a known old name still finds the hotel.
    expect(index.match('madinah', 'Brand New Name', ['RETAJ RAWDAH']).hotelId).toBe(rose.id);
    // Same name, other city: not this hotel.
    expect(index.match('makkah', 'Rose Platinum')).toEqual({
      hotelId: null,
      suggestedHotelId: null,
    });
    // Close, but never applied automatically.
    expect(index.match('madinah', 'Rose Platinun')).toEqual({
      hotelId: null,
      suggestedHotelId: rose.id,
    });
  });
});
