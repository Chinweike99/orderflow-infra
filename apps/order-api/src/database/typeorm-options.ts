import type { DataSourceOptions } from 'typeorm';
import { OrderItem } from '../orders/entities/order-item.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { Product } from '../products/product.entity.js';
import { User } from '../users/user.entity.js';

export const ENTITIES = [User, Product, Order, OrderItem];

export interface DbSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: boolean;
}

/**
 * Shared by the running app and the migration CLI, so both connect the same way.
 * `synchronize` is always off: the schema changes only through migrations.
 */
export function buildTypeOrmOptions(db: DbSettings): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.database,
    ssl: db.ssl ? { rejectUnauthorized: false } : false,
    entities: ENTITIES,
    synchronize: false,
    migrationsRun: false,
    extra: {
      max: 10, // connection pool size per pod
      connectionTimeoutMillis: 5000,
    },
  };
}
