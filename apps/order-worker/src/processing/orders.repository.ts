import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { PG_POOL } from '../database/database.module.js';

export const CONSUMER_NAME = 'order-worker';

export type OrderStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface OrderRecord {
  id: string;
  status: OrderStatus;
  totalAmount: string;
  currency: string;
}

/** All SQL the worker runs. */
@Injectable()
export class OrdersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async isProcessed(messageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM processed_messages WHERE message_id = $1 AND consumer = $2`,
      [messageId, CONSUMER_NAME],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findOrder(orderId: string): Promise<OrderRecord | null> {
    const result = await this.pool.query<{
      id: string;
      status: OrderStatus;
      total_amount: string;
      currency: string;
    }>(`SELECT id, status, total_amount, currency FROM orders WHERE id = $1`, [
      orderId,
    ]);
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          status: row.status,
          totalAmount: row.total_amount,
          currency: row.currency.trim(),
        }
      : null;
  }

  /** PENDING → PROCESSING. A no-op on a retry, when the order is already PROCESSING. */
  async markProcessing(orderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE orders SET status = 'PROCESSING', updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [orderId],
    );
  }

  /**
   * Records the message as processed and sets the final order status, in one
   * transaction. Returns false (and changes nothing) if this message was
   * already recorded: another delivery of it won the race.
   */
  async complete(
    messageId: string,
    orderId: string,
    status: 'COMPLETED' | 'FAILED',
    failureReason: string | null,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO processed_messages (message_id, consumer) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [messageId, CONSUMER_NAME],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE orders SET status = $2, failure_reason = $3, updated_at = now()
          WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')`,
        [orderId, status, failureReason],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
