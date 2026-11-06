import { fromCents, toCents } from '../common/money.js';

export interface RequestedItem {
  productId: string;
  quantity: number;
}

export interface PricedProduct {
  id: string;
  price: string;
  active: boolean;
}

export interface PricedLine {
  productId: string;
  quantity: number;
  unitPrice: string;
}

export interface PricedOrder {
  lines: PricedLine[];
  totalAmount: string;
}

export class PricingError extends Error {
  constructor(
    message: string,
    readonly productIds: string[],
  ) {
    super(message);
  }
}

/** Upper bound on the quantity of one product in one order (after merging). */
export const MAX_QUANTITY_PER_PRODUCT = 100;

/**
 * Prices an order using server-side product prices. Pure function, no I/O.
 * - Duplicate product IDs in the request are merged.
 * - Unknown or inactive products are rejected.
 */
export function priceOrder(
  requested: RequestedItem[],
  products: PricedProduct[],
): PricedOrder {
  const quantities = new Map<string, number>();
  for (const item of requested) {
    quantities.set(
      item.productId,
      (quantities.get(item.productId) ?? 0) + item.quantity,
    );
  }

  const byId = new Map(products.map((p) => [p.id, p]));
  const unavailable = [...quantities.keys()].filter(
    (id) => !byId.get(id)?.active,
  );
  if (unavailable.length > 0) {
    throw new PricingError(
      'Some products do not exist or are unavailable',
      unavailable,
    );
  }

  const tooMany = [...quantities].filter(
    ([, q]) => q > MAX_QUANTITY_PER_PRODUCT,
  );
  if (tooMany.length > 0) {
    throw new PricingError(
      `Quantity per product cannot exceed ${MAX_QUANTITY_PER_PRODUCT}`,
      tooMany.map(([id]) => id),
    );
  }

  let totalCents = 0;
  const lines = [...quantities].map(([productId, quantity]) => {
    const unitPrice = byId.get(productId)!.price;
    totalCents += toCents(unitPrice) * quantity;
    return { productId, quantity, unitPrice };
  });

  return { lines, totalAmount: fromCents(totalCents) };
}
