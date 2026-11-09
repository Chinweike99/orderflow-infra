import { z } from 'zod';

const rate = z.coerce.number().min(0).max(1);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * Every environment variable the Order Worker reads, validated at startup.
 *
 * The worker uses WORKER_PORT rather than PORT so it can share the repository
 * .env file with the Order API during local development.
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    WORKER_PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),

    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().positive().default(5432),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_NAME: z.string().min(1),
    DB_SSL: bool.default(false),

    RABBITMQ_URL: z
      .string()
      .regex(
        /^amqps?:\/\//,
        'RABBITMQ_URL must start with amqp:// or amqps://',
      ),
    /** Messages processed in parallel by one worker. */
    WORKER_PREFETCH: z.coerce.number().int().min(1).max(500).default(10),
    /** Total attempts per message before it is dead-lettered. */
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    /** How long to wait for in-flight messages on SIGTERM. */
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(20000),

    // Simulated payment provider
    PAYMENT_DECLINE_RATE: rate.default(0.1),
    PAYMENT_ERROR_RATE: rate.default(0.1),
    PAYMENT_MIN_LATENCY_MS: z.coerce.number().int().min(0).default(200),
    PAYMENT_MAX_LATENCY_MS: z.coerce.number().int().min(0).default(1000),
  })
  .refine((e) => e.PAYMENT_DECLINE_RATE + e.PAYMENT_ERROR_RATE <= 1, {
    message: 'PAYMENT_DECLINE_RATE + PAYMENT_ERROR_RATE must not exceed 1',
  })
  .refine((e) => e.PAYMENT_MIN_LATENCY_MS <= e.PAYMENT_MAX_LATENCY_MS, {
    message: 'PAYMENT_MIN_LATENCY_MS must not exceed PAYMENT_MAX_LATENCY_MS',
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(config)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
