// @vitest-environment node
/**
 * The web app runs under a CSP without 'unsafe-eval'. Loaded in the same
 * order as main.tsx (zod-csp first, then the shared schemas), validation must
 * never construct a Function, and must give the same answers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

describe('Zod under the site CSP', () => {
  it('main.tsx imports zod-csp before anything else', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    const firstImport = /^import .*$/m.exec(main)?.[0];
    expect(firstImport).toBe("import './zod-csp';");
  });

  it('validates the shared schemas without new Function', async () => {
    vi.resetModules();
    const spy = vi.spyOn(globalThis, 'Function');
    await import('./zod-csp');
    const { CalculateInputSchema, InquiryBodySchema } = await import('@marafiq/shared');
    const input = {
      arrivalDate: '2027-01-10',
      nightsMakkah: 5,
      nightsMadinah: 4,
      order: 'makkah_first',
      travelers: { adults: 2 },
      rooms: [{ occupancy: 'double', persons: 2 }],
      hotels: { makkah: 'cheapest', madinah: 'cheapest' },
      visa: 'direct',
      flight: 'self',
    };
    expect(CalculateInputSchema.safeParse(input).success).toBe(true);
    expect(CalculateInputSchema.safeParse({ ...input, rooms: [] }).success).toBe(false);
    expect(InquiryBodySchema.safeParse({ source: 'umrah' }).success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
