import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * Prometheus metrics for the Order API, exposed at GET /metrics.
 * A dedicated registry (not prom-client's global one) keeps tests that start
 * several app instances in one process from clashing.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled, by method, route template and status code',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [this.registry],
  });

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly ordersCreatedTotal = new Counter({
    name: 'orders_created_total',
    help: 'Orders created (idempotent replays are not counted)',
    registers: [this.registry],
  });

  readonly outboxPublishedTotal = new Counter({
    name: 'outbox_events_published_total',
    help: 'Outbox events successfully published to RabbitMQ',
    registers: [this.registry],
  });

  readonly outboxPublishFailuresTotal = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Failed attempts to publish an outbox event',
    registers: [this.registry],
  });

  /** Registered by OutboxRelay; refreshes the backlog gauges on each scrape. */
  outboxBacklogCollector?: () => Promise<void>;

  readonly outboxPending = new Gauge({
    name: 'outbox_events_pending',
    help: 'Outbox events not yet published. Should stay near zero.',
    registers: [this.registry],
    collect: async () => {
      await this.outboxBacklogCollector?.();
    },
  });

  readonly outboxOldestPendingAge = new Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Age of the oldest unpublished outbox event. Growth means publishing is stuck.',
    registers: [this.registry],
  });

  constructor() {
    this.registry.setDefaultLabels({ service: 'order-api' });
    collectDefaultMetrics({ register: this.registry });
  }
}
