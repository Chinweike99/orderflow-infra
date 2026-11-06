import type { Order } from './entities/order.entity.js';
import type { OrderStatus } from './entities/order-status.enum.js';

export interface OrderResponse {
  id: string;
  userId: string;
  status: OrderStatus;
  totalAmount: string;
  currency: string;
  failureReason: string | null;
  items: { productId: string; quantity: number; unitPrice: string }[];
  createdAt: Date;
  updatedAt: Date;
}

export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id,
    userId: order.userId,
    status: order.status,
    totalAmount: order.totalAmount,
    currency: order.currency.trim(),
    failureReason: order.failureReason,
    items: (order.items ?? []).map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
