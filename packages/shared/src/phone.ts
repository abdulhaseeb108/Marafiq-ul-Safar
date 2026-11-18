/**
 * Pakistani mobile numbers (docs/01 section 5: WhatsApp preferred, Pakistani
 * format validated). Accepts the ways people type them and returns one form.
 */

/** "0300 1234567", "+92 300 1234567", "92-300-1234567", "3001234567" -> "+923001234567". */
export function normalizePkMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  const bare = digits.replace(/^\+/, '');
  let national: string;
  if (bare.startsWith('0092')) national = bare.slice(4);
  else if (bare.startsWith('92')) national = bare.slice(2);
  else if (bare.startsWith('0')) national = bare.slice(1);
  else national = bare;
  // Mobile numbers: 3XX followed by 7 digits.
  if (!/^3\d{9}$/.test(national)) return null;
  return `+92${national}`;
}

/** "+923001234567" -> "0300 1234567", the way it is written in Pakistan. */
export function formatPkMobile(normalized: string): string {
  const national = normalized.replace(/^\+92/, '0');
  return `${national.slice(0, 4)} ${national.slice(4)}`;
}
