import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { Env } from '../config/env.validation.js';

export const PG_POOL = Symbol('PG_POOL');

/**
 * The worker only runs a handful of SQL statements, so it uses a plain `pg`
 * connection pool instead of an ORM. The schema is owned by the Order API's
 * migrations (docs/database-schema.md).
 */
@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new pg.Pool({
          host: config.get('DB_HOST', { infer: true }),
          port: config.get('DB_PORT', { infer: true }),
          user: config.get('DB_USER', { infer: true }),
          password: config.get('DB_PASSWORD', { infer: true }),
          database: config.get('DB_NAME', { infer: true }),
          ssl: config.get('DB_SSL', { infer: true })
            ? { rejectUnauthorized: false }
            : false,
          max: 10,
          connectionTimeoutMillis: 5000,
          application_name: 'order-worker',
        }),
    },
    PoolCloser,
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
