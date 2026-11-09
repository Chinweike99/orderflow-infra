import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as amqp from 'amqp-connection-manager';
import type {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Env } from '../config/env.validation.js';
import {
  assertTopology,
  ORDER_PROCESSING_QUEUE,
  ORDER_RETRY_QUEUE,
} from '../messaging/topology.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OrderProcessor, type Decision } from './order-processor.js';

const ATTEMPT_HEADER = 'x-attempt';

/**
 * Consumes order-processing and carries out the processor's decision:
 * ack, retry (via the delayed retry queue) or dead-letter (nack → DLQ).
 *
 * Messages are acknowledged manually and only after the database work has
 * committed, so a crash at any point leads to redelivery, never to loss.
 */
@Injectable()
export class OrderConsumer
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private consumeChannel?: ConfirmChannel;
  private consumerTag?: string;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly processor: OrderProcessor,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(OrderConsumer.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    const prefetch = this.config.get('WORKER_PREFETCH', { infer: true });

    this.connection = amqp.connect(
      [this.config.get('RABBITMQ_URL', { infer: true })],
      {
        heartbeatIntervalInSeconds: 15,
        reconnectTimeInSeconds: 5,
      },
    );
    this.connection.on('connect', () =>
      this.logger.info('Connected to RabbitMQ'),
    );
    this.connection.on('disconnect', ({ err }) =>
      this.logger.warn(
        `Disconnected from RabbitMQ: ${err?.message ?? 'unknown reason'}`,
      ),
    );
    this.connection.on('connectFailed', ({ err }) =>
      this.logger.warn(`Could not connect to RabbitMQ: ${err?.message}`),
    );

    // The setup function runs on every (re)connect, so consuming resumes
    // automatically after a RabbitMQ restart.
    this.channel = this.connection.createChannel({
      confirm: true,
      publishTimeout: 5000,
      setup: async (channel: ConfirmChannel) => {
        await assertTopology(channel);
        if (this.stopping) return;
        await channel.prefetch(prefetch);
        const { consumerTag } = await channel.consume(
          ORDER_PROCESSING_QUEUE,
          (msg) => this.track(this.onMessage(channel, msg)),
          { noAck: false },
        );
        this.consumeChannel = channel;
        this.consumerTag = consumerTag;
        this.logger.info(
          `Consuming ${ORDER_PROCESSING_QUEUE} (prefetch ${prefetch})`,
        );
      },
    });
  }

  isConnected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  /** SIGTERM: stop taking new messages and let in-flight ones finish. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.consumeChannel && this.consumerTag) {
      await this.consumeChannel.cancel(this.consumerTag).catch(() => undefined);
    }
    const timeoutMs = this.config.get('WORKER_SHUTDOWN_TIMEOUT_MS', {
      infer: true,
    });
    if (this.inFlight.size > 0) {
      this.logger.info(
        `Waiting for ${this.inFlight.size} in-flight message(s)`,
      );
    }
    await Promise.race([
      Promise.allSettled(this.inFlight),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async onApplicationShutdown(): Promise<void> {
    // Anything still unacknowledged is redelivered by RabbitMQ to another worker.
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async onMessage(
    channel: ConfirmChannel,
    msg: ConsumeMessage | null,
  ): Promise<void> {
    if (!msg) {
      this.logger.warn('Consumer was cancelled by RabbitMQ');
      return;
    }

    const stopTimer = this.metrics.processingDuration.startTimer();
    const messageId = msg.properties.messageId as string | undefined;
    const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1) || 1;
    let body: unknown;
    try {
      body = JSON.parse(msg.content.toString('utf8'));
    } catch {
      body = undefined;
    }

    const decision = await this.processor.handle({ messageId, attempt, body });
    const context = { messageId, attempt, orderId: orderIdOf(body) };

    try {
      await this.execute(channel, msg, decision);
    } catch (error) {
      // Usually the channel closed (RabbitMQ restarted). The message was not
      // acknowledged, so RabbitMQ will deliver it again; idempotency makes that safe.
      this.logger.warn(
        { ...context, err: error instanceof Error ? error.message : error },
        'Could not acknowledge message; it will be redelivered',
      );
      return;
    }

    switch (decision.action) {
      case 'ack':
        stopTimer({ outcome: decision.outcome });
        this.metrics.ordersProcessedTotal.inc({ outcome: decision.outcome });
        this.logger.info(
          { ...context, outcome: decision.outcome },
          'Order message processed',
        );
        break;
      case 'retry':
        this.metrics.messagesRetriedTotal.inc();
        this.logger.warn(
          {
            ...context,
            nextAttempt: decision.nextAttempt,
            error: decision.error,
          },
          'Temporary failure; message scheduled for retry',
        );
        break;
      case 'dead-letter':
        this.metrics.messagesDeadLetteredTotal.inc({ reason: decision.reason });
        this.logger.error(
          { ...context, reason: decision.reason, detail: decision.detail },
          'Message sent to the dead-letter queue',
        );
        break;
    }
  }

  private async execute(
    channel: ConfirmChannel,
    msg: ConsumeMessage,
    decision: Decision,
  ): Promise<void> {
    switch (decision.action) {
      case 'ack':
        channel.ack(msg);
        return;
      case 'retry':
        // Publish a copy to the retry queue and wait for RabbitMQ to confirm it
        // BEFORE acknowledging the original, so the message cannot be lost.
        await this.channel!.sendToQueue(ORDER_RETRY_QUEUE, msg.content, {
          ...msg.properties,
          persistent: true,
          headers: {
            ...msg.properties.headers,
            [ATTEMPT_HEADER]: decision.nextAttempt,
          },
        });
        channel.ack(msg);
        return;
      case 'dead-letter':
        // The queue's dead-letter settings route rejected messages to the DLQ.
        channel.nack(msg, false, false);
        return;
    }
  }
}

function orderIdOf(body: unknown): string | undefined {
  const id = (body as { data?: { orderId?: unknown } } | undefined)?.data
    ?.orderId;
  return typeof id === 'string' ? id : undefined;
}
