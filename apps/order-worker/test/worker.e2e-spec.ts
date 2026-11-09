/**
 * Integration tests: Order Worker + PostgreSQL + RabbitMQ.
 * Requires the Docker Compose stack: docker compose up -d
 *
 * The payment provider is replaced by a scripted fake so each test decides
 * what the "provider" does. Everything else is real.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import amqplib from 'amqplib';
import type pg from 'pg';
import {
  ORDER_CREATED,
  ORDER_DEAD_LETTER_QUEUE,
  ORDER_PROCESSING_QUEUE,
  ORDERS_EXCHANGE,
} from '../src/messaging/topology.js';
import { MetricsService } from '../src/metrics/metrics.service.js';
import { OrderConsumer } from '../src/processing/order-consumer.service.js';
import {
  PAYMENT_GATEWAY,
  PaymentProviderError,
  type ChargeRequest,
  type ChargeResult,
  type PaymentGateway,
} from '../src/processing/payment-gateway.js';
import {
  applyApiMigrations,
  loadEnv,
  recreateDatabase,
  recreateVhost,
  TEST_DB,
  testDbClient,
  waitFor,
} from './support.js';

type Step = 'approve' | 'decline' | 'error';

/** A payment provider whose answers are scripted per order. */
class ScriptedPayments implements PaymentGateway {
  readonly script = new Map<string, Step[]>();
  readonly charges: ChargeRequest[] = [];

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(request);
    const step = this.script.get(request.orderId)?.shift() ?? 'approve';
    if (step === 'error')
      throw new PaymentProviderError('scripted provider outage');
    if (step === 'decline')
      return { approved: false, reason: 'Insufficient funds' };
    return { approved: true };
  }

  chargesFor(orderId: string): number {
    return this.charges.filter((c) => c.orderId === orderId).length;
  }
}

let app: INestApplication;
let db: pg.Client;
let amqpConnection: amqplib.ChannelModel;
let channel: amqplib.Channel;
let userId: string;
let product: { id: string; price: string };
const payments = new ScriptedPayments();

async function createPendingOrder(): Promise<string> {
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (user_id, status, total_amount, currency)
     VALUES ($1, 'PENDING', $2, 'USD') RETURNING id`,
    [userId, product.price],
  );
  const orderId = order.rows[0].id;
  await db.query(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, 1, $3)`,
    [orderId, product.id, product.price],
  );
  return orderId;
}

/** Publishes an event shaped exactly like the Order API's outbox relay output. */
function publishOrderCreated(
  orderId: string,
  messageId: string = randomUUID(),
): string {
  const body = {
    eventId: messageId,
    eventType: ORDER_CREATED,
    aggregateType: 'order',
    aggregateId: orderId,
    occurredAt: new Date().toISOString(),
    data: { orderId, userId, totalAmount: product.price, currency: 'USD' },
  };
  channel.publish(
    ORDERS_EXCHANGE,
    ORDER_CREATED,
    Buffer.from(JSON.stringify(body)),
    {
      messageId,
      type: ORDER_CREATED,
      persistent: true,
      contentType: 'application/json',
    },
  );
  return messageId;
}

async function orderRow(orderId: string) {
  const result = await db.query<{
    status: string;
    failure_reason: string | null;
  }>(`SELECT status, failure_reason FROM orders WHERE id = $1`, [orderId]);
  return result.rows[0];
}

function waitForStatus(orderId: string, status: string, timeoutMs = 10_000) {
  return waitFor(
    async () => {
      const row = await orderRow(orderId);
      return row?.status === status ? row : undefined;
    },
    { timeoutMs, what: `order ${orderId} to become ${status}` },
  );
}

async function processedCount(messageId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM processed_messages WHERE message_id = $1`,
    [messageId],
  );
  return result.rows[0].n;
}

async function counterValue(
  counter:
    | 'ordersProcessedTotal'
    | 'messagesRetriedTotal'
    | 'messagesDeadLetteredTotal',
  label?: Record<string, string>,
): Promise<number> {
  const { values } = await app.get(MetricsService)[counter].get();
  return values
    .filter((v) =>
      Object.entries(label ?? {}).every(
        ([k, val]) => (v.labels as Record<string, unknown>)[k] === val,
      ),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

function findInDeadLetterQueue(messageId: string, timeoutMs = 10_000) {
  return waitFor(
    async () => {
      const msg = await channel.get(ORDER_DEAD_LETTER_QUEUE, { noAck: true });
      return msg && msg.properties.messageId === messageId ? msg : undefined;
    },
    { timeoutMs, what: `message ${messageId} in the DLQ` },
  );
}

beforeAll(async () => {
  loadEnv();
  await recreateDatabase();
  await applyApiMigrations();
  const amqpUrl = await recreateVhost();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    DB_NAME: TEST_DB,
    RABBITMQ_URL: amqpUrl,
    WORKER_MAX_ATTEMPTS: '3',
  });

  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(payments)
    .compile();
  app = moduleRef.createNestApplication({ logger: ['error'] });
  await app.init(); // starts the consumer

  db = testDbClient();
  await db.connect();
  amqpConnection = await amqplib.connect(amqpUrl);
  channel = await amqpConnection.createChannel();
  channel.on('error', (err) => console.error('test channel error', err));

  await waitFor(async () => app.get(OrderConsumer).isConnected(), {
    what: 'worker to connect to RabbitMQ',
  });
  await waitFor(
    async () => {
      const probe = await amqpConnection.createChannel();
      probe.on('error', () => undefined);
      try {
        const queue = await probe.checkQueue(ORDER_PROCESSING_QUEUE);
        await probe.close();
        return queue.consumerCount > 0;
      } catch {
        return false;
      }
    },
    { what: 'worker to start consuming' },
  );

  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('worker-test@orderflow.test', 'x') RETURNING id`,
  );
  userId = user.rows[0].id;
  product = (
    await db.query<{ id: string; price: string }>(
      `SELECT id, price FROM products LIMIT 1`,
    )
  ).rows[0];
}, 60_000);

afterAll(async () => {
  await channel?.close().catch(() => undefined);
  await amqpConnection?.close().catch(() => undefined);
  await db?.end();
  await app?.close();
});

beforeEach(async () => {
  await channel.purgeQueue(ORDER_DEAD_LETTER_QUEUE);
});

describe('happy path', () => {
  it('completes an order when payment is approved', async () => {
    const orderId = await createPendingOrder();
    const messageId = publishOrderCreated(orderId);

    const row = await waitForStatus(orderId, 'COMPLETED');
    expect(row.failure_reason).toBeNull();
    expect(await processedCount(messageId)).toBe(1);
    expect(payments.charges.find((c) => c.orderId === orderId)).toMatchObject({
      amount: product.price,
      currency: 'USD',
      idempotencyKey: orderId,
    });
  });

  it('fails an order when payment is declined, without retrying', async () => {
    const orderId = await createPendingOrder();
    payments.script.set(orderId, ['decline']);
    publishOrderCreated(orderId);

    const row = await waitForStatus(orderId, 'FAILED');
    expect(row.failure_reason).toBe('Payment declined: Insufficient funds');
    expect(payments.chargesFor(orderId)).toBe(1);
  });
});

describe('at-least-once delivery', () => {
  it('processes a message delivered twice exactly once', async () => {
    const duplicatesBefore = await counterValue('ordersProcessedTotal', {
      outcome: 'duplicate',
    });
    const orderId = await createPendingOrder();
    const messageId = randomUUID();

    // The relay can publish the same event twice (e.g. it crashed before
    // recording that it had published). Simulate that.
    publishOrderCreated(orderId, messageId);
    publishOrderCreated(orderId, messageId);

    await waitForStatus(orderId, 'COMPLETED');
    await waitFor(
      async () =>
        (await counterValue('ordersProcessedTotal', { outcome: 'duplicate' })) >
        duplicatesBefore,
      { what: 'the second delivery to be recognised as a duplicate' },
    );
    expect(await processedCount(messageId)).toBe(1);
    // If both copies reached the provider, they carried the same idempotency
    // key, so a real provider charges only once.
    expect(
      new Set(
        payments.charges
          .filter((c) => c.orderId === orderId)
          .map((c) => c.idempotencyKey),
      ),
    ).toEqual(new Set([orderId]));
  });
});

describe('retries and the dead-letter queue', () => {
  it('retries a temporary failure after a delay, then completes', async () => {
    const retriesBefore = await counterValue('messagesRetriedTotal');
    const orderId = await createPendingOrder();
    payments.script.set(orderId, ['error', 'approve']);
    publishOrderCreated(orderId);

    // While waiting in the retry queue the order shows as PROCESSING.
    await waitForStatus(orderId, 'PROCESSING');
    await waitForStatus(orderId, 'COMPLETED', 15_000);

    expect(payments.chargesFor(orderId)).toBe(2);
    expect(await counterValue('messagesRetriedTotal')).toBe(retriesBefore + 1);
  });

  it('gives up after 3 attempts: order FAILED and message in the DLQ', async () => {
    const orderId = await createPendingOrder();
    payments.script.set(orderId, ['error', 'error', 'error']);
    const messageId = publishOrderCreated(orderId);

    const row = await waitForStatus(orderId, 'FAILED', 20_000);
    expect(row.failure_reason).toBe(
      'Processing failed after 3 attempts: scripted provider outage',
    );
    expect(payments.chargesFor(orderId)).toBe(3);

    const dead = await findInDeadLetterQueue(messageId);
    expect(dead.properties.headers?.['x-attempt']).toBe(3);
    expect(dead.properties.headers?.['x-death']).toBeDefined(); // added by RabbitMQ
  }, 30_000);

  it('dead-letters a malformed message immediately', async () => {
    const messageId = randomUUID();
    channel.publish(
      ORDERS_EXCHANGE,
      ORDER_CREATED,
      Buffer.from('this is not JSON'),
      {
        messageId,
      },
    );

    const dead = await findInDeadLetterQueue(messageId);
    expect(dead.content.toString()).toBe('this is not JSON');
    expect(
      await counterValue('messagesDeadLetteredTotal', {
        reason: 'invalid_message',
      }),
    ).toBeGreaterThan(0);
  });

  it('dead-letters an event for an order that does not exist, without charging', async () => {
    const missingOrderId = randomUUID();
    const messageId = publishOrderCreated(missingOrderId);

    await findInDeadLetterQueue(messageId);
    expect(payments.chargesFor(missingOrderId)).toBe(0);
  });
});
