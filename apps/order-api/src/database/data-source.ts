/**
 * DataSource used by the TypeORM CLI to run migrations, e.g.
 *   npm run migration:run
 *
 * Migrations run as a separate step (locally, as a Kubernetes Job, or as a
 * pipeline stage), never on application startup. See docs/database-schema.md.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from './typeorm-options.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export default new DataSource({
  ...buildTypeOrmOptions({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    username: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    ssl: process.env.DB_SSL === 'true',
  }),
  migrations: [join(import.meta.dirname, 'migrations', '*.js')],
  migrationsTableName: 'typeorm_migrations',
});
