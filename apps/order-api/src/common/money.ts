/**
 * Money is handled in integer cents to avoid floating-point errors.
 * PostgreSQL NUMERIC(12,2) values arrive as strings such as "19.99".
 */
const DECIMAL_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export function toCents(amount: string): number {
  if (!DECIMAL_PATTERN.test(amount)) {
    throw new Error(`Invalid money amount: "${amount}"`);
  }
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = amount.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

export function fromCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`Cents must be an integer, got ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}
