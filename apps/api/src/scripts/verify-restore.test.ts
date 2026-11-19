import { describe, expect, it } from 'vitest';
import { compareShapes, type DatabaseShape } from './verify-restore.js';

const shape = (overrides: Partial<DatabaseShape> = {}): DatabaseShape => ({
  counts: { leads: 3, quotes: 2 },
  indexes: { leads: ['{"name":"_id_"}', '{"name":"reference_1"}'], quotes: ['{"name":"_id_"}'] },
  ...overrides,
});

describe('compareShapes (restore verification)', () => {
  it('reports nothing when the restore matches', () => {
    expect(compareShapes(shape(), shape())).toEqual([]);
  });

  it('reports missing collections, count differences and missing or extra indexes', () => {
    const target = shape({
      counts: { leads: 2, extra: 1 },
      indexes: { leads: ['{"name":"_id_"}', '{"name":"other_1"}'], extra: [] },
    });
    expect(compareShapes(shape(), target)).toEqual([
      'extra: only in the restored database',
      'leads: 3 documents in source, 2 restored',
      'leads: index missing {"name":"reference_1"}',
      'leads: extra index {"name":"other_1"}',
      'quotes: missing in the restored database',
    ]);
  });
});
