import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

export type ProcessingOutcome = 'completed' | 'failed' | 'duplicate';
export type DeadLetterReason =
  'invalid_message' | 'order_not_found' | 'max_attempts';

/**
 * Prometheus metrics for the Order Worker, exposed at GET /metrics.
 * Queue depth is not measured here: RabbitMQ exposes it itself (Sprint 11).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly ordersProcessedTotal = new Counter({
    name: 'orders_processed_total',
    help: 'Messages fully handled, by outcome (completed, failed, duplicate)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'order_processing_duration_seconds',
    help: 'Time from receiving a message to acknowledging it',
    labelNames: ['outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly paymentRequestsTotal = new Counter({
    name: 'payment_requests_total',
    help: 'Calls to the (simulated) payment provider, by result (approved, declined, error, idempotent_replay)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly messagesRetriedTotal = new Counter({
    name: 'messages_retried_total',
    help: 'Messages sent to the retry queue after a temporary failure',
    registers: [this.registry],
  });

  readonly messagesDeadLetteredTotal = new Counter({
    name: 'messages_dead_lettered_total',
    help: 'Messages sent to the dead-letter queue, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  constructor() {
    this.registry.setDefaultLabels({ service: 'order-worker' });
    collectDefaultMetrics({ register: this.registry });
  }
}
