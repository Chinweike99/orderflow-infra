/// <reference types="vite/client" />
/**
 * Integration tests: Order API + PostgreSQL + RabbitMQ (transactional outbox).
 * Requires the Docker Compose stack: docker compose up -d
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import amqplib from 'amqplib';
import type pg from 'pg';
import request from 'supertest';
import { DataSource, type MigrationInterface } from 'typeorm';
import { ORDER_PROCESSING_QUEUE } from '../src/messaging/topology.js';
import { RabbitMqService } from '../src/messaging/rabbitmq.service.js';
import {
  loadEnv,
  recreateDatabase,
  recreateVhost,
  TEST_DB,
  testDbClient,
  waitFor,
} from './support.js';

let app: INestApplication;
let db: pg.Client;
let amqpConnection: amqplib.ChannelModel;
let channel: amqplib.Channel;
let token: string;
let productId: string;

const http = () => request(app.getHttpServer());

async function runMigrations(): Promise<void> {
  const modules = import.meta.glob<
    Record<string, new () => MigrationInterface>
  >('../src/database/migrations/*.ts', { eager: true });
  const migrations = Object.values(modules).flatMap((m) => Object.values(m));
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: TEST_DB,
    migrations,
    migrationsTableName: 'typeorm_migrations',
  });
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}

function createOrder(headers: Record<string, string> = {}) {
  return http()
    .post('/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .set(headers)
    .send({ items: [{ productId, quantity: 2 }] });
}

async function outboxRowsFor(orderId: string) {
  const result = await db.query(
    `SELECT id, event_type, payload, publish_attempts, last_error, published_at
       FROM outbox_events WHERE aggregate_id = $1`,
    [orderId],
  );
  return result.rows;
}

beforeAll(async () => {
  loadEnv();
  await recreateDatabase();
  const amqpUrl = await recreateVhost();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    DB_NAME: TEST_DB,
    RABBITMQ_URL: amqpUrl,
    OUTBOX_POLL_INTERVAL_MS: '200',
    JWT_SECRET: process.env.JWT_SECRET ?? 'x'.repeat(48),
  });
  await runMigrations();

  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/app.setup.js');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();

  db = testDbClient();
  await db.connect();
  amqpConnection = await amqplib.connect(amqpUrl);
  channel = await amqpConnection.createChannel();
  channel.on('error', (err) => console.error('test channel error', err));

  // The topology is declared asynchronously after the API connects.
  await waitFor(async () => app.get(RabbitMqService).isConnected(), {
    what: 'RabbitMQ connection',
  });
  await waitFor(
    async () => {
      // A failed checkQueue closes its channel, so use a throwaway one.
      const probe = await amqpConnection.createChannel();
      probe.on('error', () => undefined); // a 404 closes the channel with an error event
      try {
        await probe.checkQueue(ORDER_PROCESSING_QUEUE);
        await probe.close();
        return true;
      } catch {
        return false;
      }
    },
    { what: 'topology to be declared' },
  );

  await http()
    .post('/v1/auth/register')
    .send({ email: 'outbox@orderflow.test', password: 'Password123!' })
    .expect(201);
  const login = await http()
    .post('/v1/auth/login')
    .send({ email: 'outbox@orderflow.test', password: 'Password123!' })
    .expect(200);
  token = login.body.accessToken;
  productId = (await http().get('/v1/products').expect(200)).body[0].id;
}, 60_000);

afterAll(async () => {
  await channel?.close().catch(() => undefined);
  await amqpConnection?.close().catch(() => undefined);
  await db?.end();
  await app?.close();
});

beforeEach(async () => {
  await channel.purgeQueue(ORDER_PROCESSING_QUEUE);
});

describe('transactional outbox', () => {
  it('saves an order.created event in the same transaction as the order', async () => {
    const res = await createOrder().expect(201);
    const [event] = await outboxRowsFor(res.body.id);

    expect(event.event_type).toBe('order.created');
    expect(event.payload).toEqual({
      orderId: res.body.id,
      userId: res.body.userId,
      totalAmount: res.body.totalAmount,
      currency: 'USD',
    });
  });

  it('publishes the event to order-processing and marks it published', async () => {
    const res = await createOrder().expect(201);
    const [{ id: eventId }] = await outboxRowsFor(res.body.id);

    // Skip any message left over from an earlier test.
    const message = await waitFor(
      async () => {
        const msg = await channel.get(ORDER_PROCESSING_QUEUE, { noAck: true });
        return msg && msg.properties.messageId === eventId ? msg : undefined;
      },
      { what: 'message on order-processing' },
    );
    expect(message.properties.messageId).toBe(eventId);
    expect(message.properties.type).toBe('order.created');
    expect(message.properties.deliveryMode).toBe(2); // persistent
    expect(JSON.parse(message.content.toString())).toMatchObject({
      eventId,
      eventType: 'order.created',
      aggregateId: res.body.id,
      data: { orderId: res.body.id },
    });

    const [event] = await waitFor(
      async () => {
        const rows = await outboxRowsFor(res.body.id);
        return rows[0]?.published_at ? rows : undefined;
      },
      { what: 'published_at to be set' },
    );
    expect(event.publish_attempts).toBe(1);
  });

  it('does not create a second event for an idempotent replay', async () => {
    const first = await createOrder({
      'Idempotency-Key': 'outbox-replay-1',
    }).expect(201);
    const second = await createOrder({
      'Idempotency-Key': 'outbox-replay-1',
    }).expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(await outboxRowsFor(first.body.id)).toHaveLength(1);
  });

  it('writes no event when the order is rejected', async () => {
    const before = await db.query(
      'SELECT count(*)::int AS n FROM outbox_events',
    );
    await http()
      .post('/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { productId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
        ],
      })
      .expect(422);
    const after = await db.query(
      'SELECT count(*)::int AS n FROM outbox_events',
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('keeps an event whose publish failed and publishes it on a later poll', async () => {
    const rabbit = app.get(RabbitMqService);
    const publish = vi
      .spyOn(rabbit, 'publish')
      .mockRejectedValueOnce(new Error('simulated broker outage'));

    const res = await createOrder().expect(201);

    const [failed] = await waitFor(
      async () => {
        const rows = await outboxRowsFor(res.body.id);
        return rows[0]?.last_error ? rows : undefined;
      },
      { what: 'the failed attempt to be recorded' },
    );
    expect(failed.last_error).toBe('simulated broker outage');
    expect(failed.published_at).toBeNull();

    const [published] = await waitFor(
      async () => {
        const rows = await outboxRowsFor(res.body.id);
        return rows[0]?.published_at ? rows : undefined;
      },
      { what: 'the retry to publish' },
    );
    expect(published.publish_attempts).toBe(2);
    expect(published.last_error).toBeNull();
    publish.mockRestore();
  });

  it('reports outbox and order metrics', async () => {
    const res = await http().get('/metrics').expect(200);
    expect(res.text).toMatch(/orders_created_total\{service="order-api"\} \d+/);
    expect(res.text).toMatch(
      /outbox_events_published_total\{service="order-api"\} \d+/,
    );
    expect(res.text).toMatch(/outbox_events_pending\{service="order-api"\} 0/);
    expect(res.text).toContain('route="/v1/orders"');
  });
});

describe('health', () => {
  it('readiness depends only on the database, not RabbitMQ', async () => {
    // By design: while RabbitMQ is down the API keeps accepting orders and the
    // outbox holds the events, so the pod must stay in the load balancer.
    const res = await http().get('/health/ready').expect(200);
    expect(Object.keys(res.body.details)).toEqual(['database']);
  });
});
