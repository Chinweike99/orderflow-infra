import { validateEnv } from './env.validation.js';

const VALID = {
  DB_HOST: 'localhost',
  DB_USER: 'orderflow',
  DB_PASSWORD: 'secret',
  DB_NAME: 'orderflow',
  JWT_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults and converts types', () => {
    const env = validateEnv({ ...VALID, DB_PORT: '6543', DB_SSL: 'true' });
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      DB_PORT: 6543,
      DB_SSL: true,
      JWT_EXPIRES_IN_SECONDS: 3600,
      CURRENCY: 'USD',
    });
  });

  it('lists every missing or invalid variable', () => {
    expect(() => validateEnv({ JWT_SECRET: 'short' })).toThrow(
      /DB_HOST[\s\S]*DB_USER[\s\S]*JWT_SECRET: JWT_SECRET must be at least 32 characters/,
    );
  });
});
