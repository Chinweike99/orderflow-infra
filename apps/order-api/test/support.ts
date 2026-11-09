/**
 * Integration-test infrastructure. Uses the Docker Compose PostgreSQL and
 * RabbitMQ, but an isolated database and RabbitMQ vhost, so development data
 * is never touched. Both are recreated from scratch on every run.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export const TEST_DB = 'orderflow_test_api';
export const TEST_VHOST = 'orderflow_test_api';

export function loadEnv(): void {
  for (const file of ['.env', '../../.env']) {
    const path = resolve(process.cwd(), file);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .env.example)`);
  return value;
}

export async function recreateDatabase(): Promise<void> {
  const admin = new pg.Client({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
}

/** Recreates the vhost through the RabbitMQ management API and returns an AMQP URL for it. */
export async function recreateVhost(): Promise<string> {
  const amqpUrl = new URL(required('RABBITMQ_URL'));
  const management =
    process.env.RABBITMQ_MANAGEMENT_URL ?? `http://${amqpUrl.hostname}:15672`;
  const user = decodeURIComponent(amqpUrl.username);
  const auth = `Basic ${Buffer.from(`${user}:${decodeURIComponent(amqpUrl.password)}`).toString('base64')}`;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${management}/api${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  await api('DELETE', `/vhosts/${TEST_VHOST}`);
  const created = await api('PUT', `/vhosts/${TEST_VHOST}`);
  if (!created.ok)
    throw new Error(`Could not create vhost: HTTP ${created.status}`);
  await api('PUT', `/permissions/${TEST_VHOST}/${encodeURIComponent(user)}`, {
    configure: '.*',
    write: '.*',
    read: '.*',
  });

  amqpUrl.pathname = `/${TEST_VHOST}`;
  return amqpUrl.toString();
}

export function testDbClient(): pg.Client {
  return new pg.Client({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: TEST_DB,
  });
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  { timeoutMs = 10_000, intervalMs = 100, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
