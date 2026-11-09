/// <reference types="vite/client" />
/**
 * Integration-test infrastructure. Uses the Docker Compose PostgreSQL and
 * RabbitMQ, but an isolated database and RabbitMQ vhost, so development data
 * is never touched. Both are recreated from scratch on every run.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export const TEST_DB = 'orderflow_test_worker';
export const TEST_VHOST = 'orderflow_test_worker';

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

function client(database: string): pg.Client {
  return new pg.Client({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database,
  });
}

export async function recreateDatabase(): Promise<void> {
  const admin = client('postgres');
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
}

/**
 * The Order API owns the schema, so the worker's tests apply the API's
 * migrations. They only use queryRunner.query(), which a pg client can serve.
 */
export async function applyApiMigrations(): Promise<void> {
  type Migration = { up(runner: { query: pg.Client['query'] }): Promise<void> };
  const modules = import.meta.glob(
    '../../order-api/src/database/migrations/*.ts',
    {
      eager: true,
    },
  ) as Record<string, Record<string, new () => Migration>>;

  const ordered = Object.keys(modules).sort(); // filenames start with a timestamp
  const db = testDbClient();
  await db.connect();
  try {
    for (const file of ordered) {
      for (const MigrationClass of Object.values(modules[file])) {
        await new MigrationClass().up({
          query: db.query.bind(db) as pg.Client['query'],
        });
      }
    }
  } finally {
    await db.end();
  }
}

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
  return client(TEST_DB);
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
