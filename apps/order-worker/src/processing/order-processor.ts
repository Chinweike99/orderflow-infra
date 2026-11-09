import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import type {
  DeadLetterReason,
  ProcessingOutcome,
} from '../metrics/metrics.service.js';
import { OrdersRepository } from './orders.repository.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway.js';

export interface IncomingMessage {
  messageId: string | undefined;
  /** 1 for the first delivery; incremented each time the message is retried. */
  attempt: number;
  body: unknown;
}

/** What the consumer should do with the message. */
export type Decision =
  | { action: 'ack'; outcome: ProcessingOutcome }
  | { action: 'retry'; nextAttempt: number; error: string }
  | { action: 'dead-letter'; reason: DeadLetterReason; detail: string };

interface OrderCreatedEvent {
  messageId: string;
  orderId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Processes one order.created message and returns a decision. Contains no
 * RabbitMQ code, so every path can be unit-tested.
 *
 * Safety rules:
 * - Already-processed messages are acknowledged and skipped (idempotency).
 * - The final status and the processed-message record are written in one
 *   transaction, so a crash can never leave one without the other.
 * - Temporary failures are retried up to WORKER_MAX_ATTEMPTS, then the order
 *   is marked FAILED and the message goes to the dead-letter queue.
 * - Messages that can never succeed (malformed, unknown order) go straight
 *   to the dead-letter queue.
 */
@Injectable()
export class OrderProcessor {
  private readonly logger = new Logger(OrderProcessor.name);
  private readonly maxAttempts: number;

  constructor(
    private readonly orders: OrdersRepository,
    @Inject(PAYMENT_GATEWAY) private readonly payments: PaymentGateway,
    config: ConfigService<Env, true>,
  ) {
    this.maxAttempts = config.get('WORKER_MAX_ATTEMPTS', { infer: true });
  }

  async handle(message: IncomingMessage): Promise<Decision> {
    const event = parseOrderCreated(message);
    if (typeof event === 'string') {
      return {
        action: 'dead-letter',
        reason: 'invalid_message',
        detail: event,
      };
    }

    try {
      if (await this.orders.isProcessed(event.messageId)) {
        return { action: 'ack', outcome: 'duplicate' };
      }

      const order = await this.orders.findOrder(event.orderId);
      if (!order) {
        return {
          action: 'dead-letter',
          reason: 'order_not_found',
          detail: `Order ${event.orderId} does not exist`,
        };
      }
      if (order.status === 'COMPLETED' || order.status === 'FAILED') {
        // Already finished, e.g. by an earlier copy of this event.
        return { action: 'ack', outcome: 'duplicate' };
      }

      await this.orders.markProcessing(order.id);

      const result = await this.payments.charge({
        orderId: order.id,
        amount: order.totalAmount,
        currency: order.currency,
        idempotencyKey: order.id,
      });

      const [status, reason] = result.approved
        ? (['COMPLETED', null] as const)
        : (['FAILED', `Payment declined: ${result.reason}`] as const);

      const recorded = await this.orders.complete(
        event.messageId,
        order.id,
        status,
        reason,
      );
      if (!recorded) return { action: 'ack', outcome: 'duplicate' };
      return {
        action: 'ack',
        outcome: status === 'COMPLETED' ? 'completed' : 'failed',
      };
    } catch (error) {
      return this.onTemporaryFailure(event, message.attempt, error);
    }
  }

  private async onTemporaryFailure(
    event: OrderCreatedEvent,
    attempt: number,
    error: unknown,
  ): Promise<Decision> {
    const detail = error instanceof Error ? error.message : String(error);

    if (attempt < this.maxAttempts) {
      return { action: 'retry', nextAttempt: attempt + 1, error: detail };
    }

    // Out of attempts: record the failure so the customer sees a final status.
    // If even this fails (e.g. the database is down), the order stays
    // PROCESSING and the message in the DLQ is the record of what happened.
    try {
      await this.orders.complete(
        event.messageId,
        event.orderId,
        'FAILED',
        `Processing failed after ${attempt} attempts: ${detail}`.slice(0, 1000),
      );
    } catch (markError) {
      this.logger.error(
        `Could not mark order ${event.orderId} as FAILED: ${
          markError instanceof Error ? markError.message : String(markError)
        }`,
      );
    }
    return {
      action: 'dead-letter',
      reason: 'max_attempts',
      detail: `Gave up after ${attempt} attempts: ${detail}`,
    };
  }
}

/** Returns the parsed event, or a string describing why the message is invalid. */
export function parseOrderCreated(
  message: IncomingMessage,
): OrderCreatedEvent | string {
  if (!message.messageId || !UUID.test(message.messageId)) {
    return 'Missing or invalid messageId (must be the outbox event UUID)';
  }
  const body = message.body as
    { eventType?: unknown; data?: { orderId?: unknown } } | null | undefined;
  if (!body || typeof body !== 'object') return 'Body is not a JSON object';
  if (body.eventType !== 'order.created') {
    return `Unexpected eventType: ${JSON.stringify(body.eventType)}`;
  }
  const orderId = body.data?.orderId;
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    return 'data.orderId is missing or not a UUID';
  }
  return { messageId: message.messageId, orderId };
}
