import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import {
  OrderProcessor,
  parseOrderCreated,
  type IncomingMessage,
} from './order-processor.js';
import type { OrderRecord, OrdersRepository } from './orders.repository.js';
import {
  PaymentProviderError,
  type PaymentGateway,
} from './payment-gateway.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: MESSAGE_ID,
    attempt: 1,
    body: { eventType: 'order.created', data: { orderId: ORDER_ID } },
    ...overrides,
  };
}

const pendingOrder: OrderRecord = {
  id: ORDER_ID,
  status: 'PENDING',
  totalAmount: '148.99',
  currency: 'USD',
};

describe('OrderProcessor', () => {
  let repo: {
    isProcessed: ReturnType<typeof vi.fn>;
    findOrder: ReturnType<typeof vi.fn>;
    markProcessing: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  };
  let payments: { charge: ReturnType<typeof vi.fn> };
  let processor: OrderProcessor;

  beforeEach(() => {
    repo = {
      isProcessed: vi.fn().mockResolvedValue(false),
      findOrder: vi.fn().mockResolvedValue(pendingOrder),
      markProcessing: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(true),
    };
    payments = { charge: vi.fn().mockResolvedValue({ approved: true }) };
    const config = { get: () => 3 } as unknown as ConfigService<Env, true>; // WORKER_MAX_ATTEMPTS
    processor = new OrderProcessor(
      repo as unknown as OrdersRepository,
      payments as unknown as PaymentGateway,
      config,
    );
  });

  it('completes an order when payment is approved', async () => {
    await expect(processor.handle(message())).resolves.toEqual({
      action: 'ack',
      outcome: 'completed',
    });
    expect(repo.markProcessing).toHaveBeenCalledWith(ORDER_ID);
    expect(payments.charge).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      amount: '148.99',
      currency: 'USD',
      idempotencyKey: ORDER_ID,
    });
    expect(repo.complete).toHaveBeenCalledWith(
      MESSAGE_ID,
      ORDER_ID,
      'COMPLETED',
      null,
    );
  });

  it('fails an order (without retrying) when payment is declined', async () => {
    payments.charge.mockResolvedValue({
      approved: false,
      reason: 'Card declined',
    });
    await expect(processor.handle(message())).resolves.toEqual({
      action: 'ack',
      outcome: 'failed',
    });
    expect(repo.complete).toHaveBeenCalledWith(
      MESSAGE_ID,
      ORDER_ID,
      'FAILED',
      'Payment declined: Card declined',
    );
  });

  describe('idempotency', () => {
    it('skips a message that was already processed, without charging again', async () => {
      repo.isProcessed.mockResolvedValue(true);
      await expect(processor.handle(message())).resolves.toEqual({
        action: 'ack',
        outcome: 'duplicate',
      });
      expect(payments.charge).not.toHaveBeenCalled();
      expect(repo.complete).not.toHaveBeenCalled();
    });

    it.each(['COMPLETED', 'FAILED'] as const)(
      'skips an order that is already %s',
      async (status) => {
        repo.findOrder.mockResolvedValue({ ...pendingOrder, status });
        await expect(processor.handle(message())).resolves.toEqual({
          action: 'ack',
          outcome: 'duplicate',
        });
        expect(payments.charge).not.toHaveBeenCalled();
      },
    );

    it('reports a duplicate when a concurrent delivery recorded the message first', async () => {
      repo.complete.mockResolvedValue(false);
      await expect(processor.handle(message())).resolves.toEqual({
        action: 'ack',
        outcome: 'duplicate',
      });
    });

    it('continues an order left in PROCESSING by an earlier attempt', async () => {
      repo.findOrder.mockResolvedValue({
        ...pendingOrder,
        status: 'PROCESSING',
      });
      await expect(
        processor.handle(message({ attempt: 2 })),
      ).resolves.toMatchObject({
        outcome: 'completed',
      });
    });
  });

  describe('temporary failures', () => {
    it('schedules a retry on a payment provider error', async () => {
      payments.charge.mockRejectedValue(new PaymentProviderError('timeout'));
      await expect(processor.handle(message({ attempt: 1 }))).resolves.toEqual({
        action: 'retry',
        nextAttempt: 2,
        error: 'timeout',
      });
      expect(repo.complete).not.toHaveBeenCalled();
    });

    it('schedules a retry when the database is unavailable', async () => {
      repo.isProcessed.mockRejectedValue(new Error('connect ECONNREFUSED'));
      await expect(
        processor.handle(message({ attempt: 2 })),
      ).resolves.toMatchObject({
        action: 'retry',
        nextAttempt: 3,
      });
    });

    it('marks the order FAILED and dead-letters it on the last attempt', async () => {
      payments.charge.mockRejectedValue(new PaymentProviderError('timeout'));
      await expect(processor.handle(message({ attempt: 3 }))).resolves.toEqual({
        action: 'dead-letter',
        reason: 'max_attempts',
        detail: 'Gave up after 3 attempts: timeout',
      });
      expect(repo.complete).toHaveBeenCalledWith(
        MESSAGE_ID,
        ORDER_ID,
        'FAILED',
        'Processing failed after 3 attempts: timeout',
      );
    });

    it('still dead-letters if the order cannot be marked FAILED', async () => {
      repo.isProcessed.mockRejectedValue(new Error('database down'));
      repo.complete.mockRejectedValue(new Error('database down'));
      await expect(
        processor.handle(message({ attempt: 3 })),
      ).resolves.toMatchObject({
        action: 'dead-letter',
        reason: 'max_attempts',
      });
    });
  });

  describe('permanent failures go straight to the dead-letter queue', () => {
    it('order does not exist', async () => {
      repo.findOrder.mockResolvedValue(null);
      await expect(processor.handle(message())).resolves.toMatchObject({
        action: 'dead-letter',
        reason: 'order_not_found',
      });
      expect(payments.charge).not.toHaveBeenCalled();
    });

    it('malformed message', async () => {
      await expect(
        processor.handle(message({ body: undefined })),
      ).resolves.toMatchObject({
        action: 'dead-letter',
        reason: 'invalid_message',
      });
      expect(repo.isProcessed).not.toHaveBeenCalled();
    });
  });
});

describe('parseOrderCreated', () => {
  it('accepts a valid event', () => {
    expect(parseOrderCreated(message())).toEqual({
      messageId: MESSAGE_ID,
      orderId: ORDER_ID,
    });
  });

  it.each([
    ['missing messageId', message({ messageId: undefined }), /messageId/],
    ['non-UUID messageId', message({ messageId: 'abc' }), /messageId/],
    ['body not an object', message({ body: 'hello' }), /JSON object/],
    [
      'wrong event type',
      message({
        body: { eventType: 'order.shipped', data: { orderId: ORDER_ID } },
      }),
      /Unexpected eventType/,
    ],
    [
      'missing orderId',
      message({ body: { eventType: 'order.created', data: {} } }),
      /orderId/,
    ],
  ])('rejects %s', (_name, input, error) => {
    expect(parseOrderCreated(input)).toMatch(error);
  });
});
