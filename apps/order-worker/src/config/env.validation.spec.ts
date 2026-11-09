import { validateEnv } from './env.validation.js';

const VALID = {
  DB_HOST: 'localhost',
  DB_USER: 'orderflow',
  DB_PASSWORD: 'secret',
  DB_NAME: 'orderflow',
  RABBITMQ_URL: 'amqp://user:pass@localhost:5672',
};

describe('validateEnv (worker)', () => {
  it('applies defaults and ignores the API PORT', () => {
    expect(validateEnv({ ...VALID, PORT: '5000' })).toMatchObject({
      WORKER_PORT: 3001,
      WORKER_PREFETCH: 10,
      WORKER_MAX_ATTEMPTS: 3,
      PAYMENT_DECLINE_RATE: 0.1,
      PAYMENT_ERROR_RATE: 0.1,
    });
  });

  it('rejects failure rates that add up to more than 1', () => {
    expect(() =>
      validateEnv({
        ...VALID,
        PAYMENT_DECLINE_RATE: '0.6',
        PAYMENT_ERROR_RATE: '0.5',
      }),
    ).toThrow(/must not exceed 1/);
  });

  it('rejects a non-AMQP RabbitMQ URL', () => {
    expect(() =>
      validateEnv({ ...VALID, RABBITMQ_URL: 'http://localhost' }),
    ).toThrow(/RABBITMQ_URL/);
  });
});
