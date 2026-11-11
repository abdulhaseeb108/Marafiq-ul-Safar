/**
 * Hotel and supplier names arrive from rate sheets typed by different people:
 * "Qila Ajiyad", "qila  ajiyad", "QILA AJIYAD". Compare them in a normalized
 * form, but always store and display exactly what was entered.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalized names with duplicates removed, order preserved. */
export function normalizedSet(names: readonly string[]): string[] {
  return [...new Set(names.map(normalizeName).filter((name) => name !== ''))];
}
