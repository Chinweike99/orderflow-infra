import type { Channel } from 'amqplib';

/**
 * RabbitMQ topology (ADR-0003).
 *
 * IMPORTANT: an identical copy lives in apps/order-api/src/messaging/topology.ts.
 * Both services declare the topology on connect, so whichever starts first
 * creates it. RabbitMQ rejects a declaration whose arguments differ from the
 * existing queue (PRECONDITION_FAILED), so the two files must stay identical.
 *
 *   orders (topic exchange)
 *     └─ order.created ─► order-processing ──(nack / rejected)──► order-processing.dlq
 *                              ▲      │
 *                              │      └─(worker publishes for retry)─► order-processing.retry
 *                              └────────(after RETRY_DELAY_MS TTL)─────────┘
 */
export const ORDERS_EXCHANGE = 'orders';
export const ORDER_CREATED = 'order.created';

export const ORDER_PROCESSING_QUEUE = 'order-processing';
export const ORDER_RETRY_QUEUE = 'order-processing.retry';
export const ORDER_DEAD_LETTER_QUEUE = 'order-processing.dlq';

export const RETRY_DELAY_MS = 5000;

export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(ORDERS_EXCHANGE, 'topic', { durable: true });

  // Quorum queues are replicated and are RabbitMQ's recommended durable queue type.
  await channel.assertQueue(ORDER_DEAD_LETTER_QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });

  await channel.assertQueue(ORDER_PROCESSING_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      // Messages the worker rejects (nack, requeue=false) go to the DLQ.
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': ORDER_DEAD_LETTER_QUEUE,
    },
  });

  await channel.assertQueue(ORDER_RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      // Nothing consumes this queue: messages wait for the TTL, then expire
      // back into the main queue for another attempt.
      'x-message-ttl': RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': ORDER_PROCESSING_QUEUE,
    },
  });

  await channel.bindQueue(
    ORDER_PROCESSING_QUEUE,
    ORDERS_EXCHANGE,
    ORDER_CREATED,
  );
}
