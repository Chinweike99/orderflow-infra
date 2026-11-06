import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, type FindOptionsWhere } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { isUniqueViolation } from '../common/postgres-errors.js';
import type { Env } from '../config/env.validation.js';
import { Product } from '../products/product.entity.js';
import { UserRole } from '../users/user.entity.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type { ListOrdersQuery } from './dto/list-orders.query.js';
import { OrderItem } from './entities/order-item.entity.js';
import {
  ORDER_IDEMPOTENCY_CONSTRAINT,
  Order,
} from './entities/order.entity.js';
import { OrderStatus } from './entities/order-status.enum.js';
import { PricingError, priceOrder } from './order-pricing.js';
import { toOrderResponse, type OrderResponse } from './order.response.js';

export interface CreateOrderResult {
  order: OrderResponse;
  /** True when an earlier order with the same Idempotency-Key was returned. */
  replayed: boolean;
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async create(
    user: AuthUser,
    dto: CreateOrderDto,
    idempotencyKey?: string,
  ): Promise<CreateOrderResult> {
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(user.id, idempotencyKey);
      if (existing) return { order: toOrderResponse(existing), replayed: true };
    }

    try {
      const order = await this.dataSource.transaction(async (manager) => {
        const productIds = [...new Set(dto.items.map((i) => i.productId))];
        const products = await manager.findBy(Product, { id: In(productIds) });

        const priced = this.price(dto, products);

        const order = manager.create(Order, {
          userId: user.id,
          status: OrderStatus.PENDING,
          totalAmount: priced.totalAmount,
          currency: this.config.get('CURRENCY', { infer: true }),
          idempotencyKey: idempotencyKey ?? null,
          failureReason: null,
          items: priced.lines.map((line) => manager.create(OrderItem, line)),
        });
        return manager.save(order);
        // Sprint 2: the order.created outbox event is written here, in the same transaction.
      });
      return { order: toOrderResponse(order), replayed: false };
    } catch (error) {
      // Two identical requests raced each other: return the one that won.
      if (
        idempotencyKey &&
        isUniqueViolation(error, ORDER_IDEMPOTENCY_CONSTRAINT)
      ) {
        const existing = await this.findByIdempotencyKey(
          user.id,
          idempotencyKey,
        );
        if (existing)
          return { order: toOrderResponse(existing), replayed: true };
      }
      throw error;
    }
  }

  async findOne(user: AuthUser, id: string): Promise<OrderResponse> {
    const where: FindOptionsWhere<Order> = { id };
    // Customers can only see their own orders. A missing order and someone
    // else's order both return 404, so order IDs can't be probed.
    if (user.role !== UserRole.ADMIN) where.userId = user.id;

    const order = await this.orders.findOne({
      where,
      relations: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return toOrderResponse(order);
  }

  async list(
    user: AuthUser,
    query: ListOrdersQuery,
  ): Promise<{
    data: OrderResponse[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const where: FindOptionsWhere<Order> = {};
    if (user.role !== UserRole.ADMIN) where.userId = user.id;
    if (query.status) where.status = query.status;

    const [orders, total] = await this.orders.findAndCount({
      where,
      relations: { items: true },
      order: { createdAt: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: orders.map(toOrderResponse),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  private price(dto: CreateOrderDto, products: Product[]) {
    try {
      return priceOrder(dto.items, products);
    } catch (error) {
      if (error instanceof PricingError) {
        throw new UnprocessableEntityException({
          message: error.message,
          productIds: error.productIds,
        });
      }
      throw error;
    }
  }

  private findByIdempotencyKey(
    userId: string,
    key: string,
  ): Promise<Order | null> {
    return this.orders.findOne({
      where: { userId, idempotencyKey: key },
      relations: { items: true },
    });
  }
}
