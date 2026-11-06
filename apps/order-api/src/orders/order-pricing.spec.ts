import { PricingError, priceOrder } from './order-pricing.js';

const KEYBOARD = { id: 'p-keyboard', price: '89.99', active: true };
const MOUSE = { id: 'p-mouse', price: '29.50', active: true };
const RETIRED = { id: 'p-retired', price: '5.00', active: false };

describe('priceOrder', () => {
  it('prices lines from server-side product prices', () => {
    const result = priceOrder(
      [
        { productId: KEYBOARD.id, quantity: 2 },
        { productId: MOUSE.id, quantity: 1 },
      ],
      [KEYBOARD, MOUSE],
    );

    expect(result.totalAmount).toBe('209.48');
    expect(result.lines).toEqual([
      { productId: KEYBOARD.id, quantity: 2, unitPrice: '89.99' },
      { productId: MOUSE.id, quantity: 1, unitPrice: '29.50' },
    ]);
  });

  it('merges duplicate products into one line', () => {
    const result = priceOrder(
      [
        { productId: MOUSE.id, quantity: 1 },
        { productId: MOUSE.id, quantity: 3 },
      ],
      [MOUSE],
    );

    expect(result.lines).toEqual([
      { productId: MOUSE.id, quantity: 4, unitPrice: '29.50' },
    ]);
    expect(result.totalAmount).toBe('118.00');
  });

  it('rejects unknown products and lists them', () => {
    expect.assertions(2);
    try {
      priceOrder([{ productId: 'p-missing', quantity: 1 }], [KEYBOARD]);
    } catch (error) {
      expect(error).toBeInstanceOf(PricingError);
      expect((error as PricingError).productIds).toEqual(['p-missing']);
    }
  });

  it('rejects inactive products', () => {
    expect(() =>
      priceOrder([{ productId: RETIRED.id, quantity: 1 }], [RETIRED]),
    ).toThrow(PricingError);
  });

  it('rejects a merged quantity above the per-product limit', () => {
    expect(() =>
      priceOrder(
        [
          { productId: MOUSE.id, quantity: 60 },
          { productId: MOUSE.id, quantity: 41 },
        ],
        [MOUSE],
      ),
    ).toThrow(/cannot exceed 100/);
  });
});
