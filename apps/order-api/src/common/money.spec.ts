import { fromCents, toCents } from './money.js';

describe('money', () => {
  it.each([
    ['19.99', 1999],
    ['0.10', 10],
    ['0.1', 10],
    ['12', 1200],
    ['0', 0],
    ['-5.25', -525],
  ])('toCents(%s) = %i', (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it.each(['abc', '1.999', '', '1,000.00'])(
    'rejects invalid amount "%s"',
    (input) => {
      expect(() => toCents(input)).toThrow();
    },
  );

  it.each([
    [1999, '19.99'],
    [10, '0.10'],
    [1200, '12.00'],
    [0, '0.00'],
    [-525, '-5.25'],
  ])('fromCents(%i) = %s', (input, expected) => {
    expect(fromCents(input)).toBe(expected);
  });

  it('avoids floating-point errors (0.1 + 0.2)', () => {
    expect(fromCents(toCents('0.10') + toCents('0.20'))).toBe('0.30');
  });

  it('rejects non-integer cents', () => {
    expect(() => fromCents(1.5)).toThrow();
  });
});
