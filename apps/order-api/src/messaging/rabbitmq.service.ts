import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import type {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import type { Env } from '../config/env.validation.js';
import { assertTopology } from './topology.js';

const PUBLISH_TIMEOUT_MS = 5000;

export interface PublishOptions {
  messageId: string;
  type: string;
  headers?: Record<string, unknown>;
}

/**
 * RabbitMQ connection for publishing.
 *
 * - Connects in the background and reconnects automatically, so the API
 *   starts and keeps accepting orders while RabbitMQ is down (the outbox
 *   holds the events until it is back).
 * - Uses a confirm channel: publish() resolves only after RabbitMQ has
 *   accepted the message, so the outbox never marks an event as published
 *   that RabbitMQ didn't actually receive.
 */
@Injectable()
export class RabbitMqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;

  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit(): void {
    const url = this.config.get('RABBITMQ_URL', { infer: true });
    this.connection = amqp.connect([url], {
      heartbeatIntervalInSeconds: 15,
      reconnectTimeInSeconds: 5,
    });
    this.connection.on('connect', () =>
      this.logger.log('Connected to RabbitMQ'),
    );
    this.connection.on('disconnect', ({ err }) =>
      this.logger.warn(
        `Disconnected from RabbitMQ: ${err?.message ?? 'unknown reason'}`,
      ),
    );
    this.connection.on('connectFailed', ({ err }) =>
      this.logger.warn(`Could not connect to RabbitMQ: ${err?.message}`),
    );

    this.channel = this.connection.createChannel({
      confirm: true,
      publishTimeout: PUBLISH_TIMEOUT_MS,
      setup: (channel: ConfirmChannel) => assertTopology(channel),
    });
  }

  isConnected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  async publish(
    exchange: string,
    routingKey: string,
    body: unknown,
    options: PublishOptions,
  ): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ channel not initialised');
    await this.channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(body)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: options.messageId,
        type: options.type,
        timestamp: Math.floor(Date.now() / 1000),
        appId: 'order-api',
        headers: options.headers,
        timeout: PUBLISH_TIMEOUT_MS,
      },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
