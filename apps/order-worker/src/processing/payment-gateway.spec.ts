import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { MetricsService } from '../metrics/metrics.service.js';
import {
  PaymentProviderError,
  SimulatedPaymentGateway,
} from './payment-gateway.js';

function gateway(overrides: Partial<Env>) {
  const env: Partial<Env> = {
    PAYMENT_MIN_LATENCY_MS: 0,
    PAYMENT_MAX_LATENCY_MS: 0,
    PAYMENT_ERROR_RATE: 0,
    PAYMENT_DECLINE_RATE: 0,
    ...overrides,
  };
  const config = {
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>;
  const metrics = new MetricsService();
  return { gateway: new SimulatedPaymentGateway(config, metrics), metrics };
}

const request = (key: string) => ({
  orderId: key,
  amount: '10.00',
  currency: 'USD',
  idempotencyKey: key,
});

async function counts(metrics: MetricsService) {
  const { values } = await metrics.paymentRequestsTotal.get();
  return Object.fromEntries(values.map((v) => [v.labels.result, v.value]));
}

describe('SimulatedPaymentGateway', () => {
  it('approves when no failures are configured', async () => {
    const { gateway: g } = gateway({});
    await expect(g.charge(request('a'))).resolves.toEqual({ approved: true });
  });

  it('declines at a decline rate of 1', async () => {
    const { gateway: g } = gateway({ PAYMENT_DECLINE_RATE: 1 });
    await expect(g.charge(request('a'))).resolves.toEqual({
      approved: false,
      reason: 'Card declined',
    });
  });

  it('returns the first result for a repeated idempotency key, without charging again', async () => {
    const { gateway: g, metrics } = gateway({});
    const [first, second] = await Promise.all([
      g.charge(request('k')),
      g.charge(request('k')),
    ]);

    expect(second).toBe(first);
    expect(await counts(metrics)).toEqual({
      approved: 1,
      idempotent_replay: 1,
    });
  });

  it('does not remember errors, so a retry really calls the provider again', async () => {
    const { gateway: g, metrics } = gateway({ PAYMENT_ERROR_RATE: 1 });
    await expect(g.charge(request('k'))).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
    await expect(g.charge(request('k'))).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
    expect(await counts(metrics)).toEqual({ error: 2 });
  });
});
