import {
  Controller,
  Get,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from '../metrics/metrics.service.js';
import { OrderConsumer } from '../processing/order-consumer.service.js';
import { OrdersRepository } from '../processing/orders.repository.js';

/**
 * The worker receives no client traffic; its HTTP server exists only for
 * Kubernetes probes and Prometheus.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly consumer: OrderConsumer,
    private readonly metrics: MetricsService,
  ) {}

  /** The process is running. Never checks dependencies. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Can process messages: database reachable and connected to RabbitMQ. */
  @Get('health/ready')
  async ready() {
    const database = await this.orders
      .ping()
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
    const rabbitmq = this.consumer.isConnected() ? 'up' : 'down';
    const result = {
      status: database === 'up' && rabbitmq === 'up' ? 'ok' : 'error',
      database,
      rabbitmq,
    };
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }

  @Get('metrics')
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
