import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Env } from '../config/env.validation.js';
import { RabbitMqService } from '../messaging/rabbitmq.service.js';
import { ORDERS_EXCHANGE } from '../messaging/topology.js';
import { MetricsService } from '../metrics/metrics.service.js';

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** The message body consumers receive. */
export interface EventEnvelope {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * Publishes outbox events to RabbitMQ (ADR-0002).
 *
 * Every API replica runs a relay. Rows are claimed with
 * SELECT ... FOR UPDATE SKIP LOCKED, so replicas never publish the same batch
 * at the same time. An event is marked published only after RabbitMQ
 * confirms it. A crash between the confirm and the UPDATE means the event is
 * published again later: delivery is at-least-once and the worker deduplicates.
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private stopped = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rabbit: RabbitMqService,
    private readonly metrics: MetricsService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });

    // Refresh the backlog gauges whenever Prometheus scrapes.
    this.metrics.outboxBacklogCollector = () => this.refreshBacklogMetrics();
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.warn('Outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.schedule(0);
  }

  /** Called after an order is committed, to publish without waiting for the next poll. */
  kick(): void {
    if (!this.enabled || this.stopped || this.current) return;
    this.schedule(0);
  }

  /** Publishes one batch. Returns the number of events published. Public for tests. */
  async publishBatch(): Promise<number> {
    if (!this.rabbit.isConnected()) return 0;

    return this.dataSource.transaction(async (manager) => {
      const rows: OutboxRow[] = await manager.query(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, created_at
           FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT $1
            FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );

      const published: string[] = [];
      for (const row of rows) {
        try {
          await this.rabbit.publish(
            ORDERS_EXCHANGE,
            row.event_type,
            this.toEnvelope(row),
            {
              messageId: row.id,
              type: row.event_type,
            },
          );
          published.push(row.id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.metrics.outboxPublishFailuresTotal.inc();
          this.logger.warn(
            `Failed to publish outbox event ${row.id}: ${message}`,
          );
          await manager.query(
            `UPDATE outbox_events
                SET publish_attempts = publish_attempts + 1, last_error = $2
              WHERE id = $1`,
            [row.id, message.slice(0, 1000)],
          );
          break; // RabbitMQ is probably unavailable; retry the rest on the next poll
        }
      }

      if (published.length > 0) {
        await manager.query(
          `UPDATE outbox_events
              SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL
            WHERE id = ANY($1::uuid[])`,
          [published],
        );
        this.metrics.outboxPublishedTotal.inc(published.length);
      }
      return published.length;
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.current = this.tick().finally(() => {
        this.current = undefined;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let published = 0;
    try {
      published = await this.publishBatch();
    } catch (error) {
      // Typically the database is unreachable. Keep polling; readiness checks report it.
      this.logger.warn(
        `Outbox relay iteration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (this.stopped) return;
    // A full batch means there is probably more waiting: go again immediately.
    this.schedule(published === this.batchSize ? 0 : this.pollIntervalMs);
  }

  private toEnvelope(row: OutboxRow): EventEnvelope {
    return {
      eventId: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: new Date(row.created_at).toISOString(),
      data: row.payload,
    };
  }

  private async refreshBacklogMetrics(): Promise<void> {
    try {
      const [row] = await this.dataSource.query<
        { pending: string; oldest: string | null }[]
      >(
        `SELECT count(*) AS pending,
                extract(epoch FROM now() - min(created_at)) AS oldest
           FROM outbox_events
          WHERE published_at IS NULL`,
      );
      this.metrics.outboxPending.set(Number(row.pending));
      this.metrics.outboxOldestPendingAge.set(
        row.oldest === null ? 0 : Number(row.oldest),
      );
    } catch {
      // Database unavailable: leave the last known values.
    }
  }
}
