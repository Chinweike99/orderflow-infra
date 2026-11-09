import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { MetricsService } from '../metrics/metrics.service.js';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface ChargeRequest {
  orderId: string;
  amount: string;
  currency: string;
  /** A real provider uses this to make retried charges safe. */
  idempotencyKey: string;
}

export type ChargeResult =
  { approved: true } | { approved: false; reason: string };

/** A temporary provider problem (timeout, 5xx). The charge should be retried. */
export class PaymentProviderError extends Error {}

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/** How many idempotency keys the simulated provider remembers. */
const IDEMPOTENCY_CACHE_SIZE = 10_000;

/**
 * Stands in for a real payment provider. Latency and failure rates are set
 * through environment variables, so failure scenarios can be demonstrated.
 *
 * Like real providers (e.g. Stripe), it honours the idempotency key: a second
 * charge with the same key returns the first result instead of charging again.
 * This is what protects the customer when RabbitMQ delivers the same message
 * to two workers at the same moment. (A real provider keeps keys for ~24h;
 * this simulation keeps them in memory, per worker process.)
 */
@Injectable()
export class SimulatedPaymentGateway implements PaymentGateway {
  private readonly results = new Map<string, Promise<ChargeResult>>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const previous = this.results.get(request.idempotencyKey);
    if (previous) {
      this.metrics.paymentRequestsTotal.inc({ result: 'idempotent_replay' });
      return previous;
    }

    const attempt = this.attemptCharge();
    this.results.set(request.idempotencyKey, attempt);
    // Errors are not remembered: the caller is expected to retry them.
    attempt.catch(() => this.results.delete(request.idempotencyKey));
    if (this.results.size > IDEMPOTENCY_CACHE_SIZE) {
      this.results.delete(this.results.keys().next().value!);
    }
    return attempt;
  }

  private async attemptCharge(): Promise<ChargeResult> {
    const min = this.config.get('PAYMENT_MIN_LATENCY_MS', { infer: true });
    const max = this.config.get('PAYMENT_MAX_LATENCY_MS', { infer: true });
    await new Promise((resolve) =>
      setTimeout(resolve, min + Math.random() * (max - min)),
    );

    const errorRate = this.config.get('PAYMENT_ERROR_RATE', { infer: true });
    const declineRate = this.config.get('PAYMENT_DECLINE_RATE', {
      infer: true,
    });
    const roll = Math.random();

    if (roll < errorRate) {
      this.metrics.paymentRequestsTotal.inc({ result: 'error' });
      throw new PaymentProviderError('Payment provider timed out');
    }
    if (roll < errorRate + declineRate) {
      this.metrics.paymentRequestsTotal.inc({ result: 'declined' });
      return { approved: false, reason: 'Card declined' };
    }
    this.metrics.paymentRequestsTotal.inc({ result: 'approved' });
    return { approved: true };
  }
}
