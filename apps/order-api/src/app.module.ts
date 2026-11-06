import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv, type Env } from './config/env.validation.js';
import { buildTypeOrmOptions } from './database/typeorm-options.js';
import { HealthModule } from './health/health.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { ProductsModule } from './products/products.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          name: 'order-api',
          level: config.get('LOG_LEVEL', { infer: true }),
          // Human-readable logs locally; one JSON object per line everywhere else.
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // Reuse an incoming X-Request-Id (e.g. from API Gateway) or create one,
          // and return it so a client error can be matched to a log line.
          genReqId: (req, res) => {
            const header = req.headers['x-request-id'];
            const id =
              (Array.isArray(header) ? header[0] : header) ?? randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/health') ?? false,
          },
        },
      }),
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildTypeOrmOptions({
          host: config.get('DB_HOST', { infer: true }),
          port: config.get('DB_PORT', { infer: true }),
          username: config.get('DB_USER', { infer: true }),
          password: config.get('DB_PASSWORD', { infer: true }),
          database: config.get('DB_NAME', { infer: true }),
          ssl: config.get('DB_SSL', { infer: true }),
        }),
    }),

    HealthModule,
    AuthModule,
    ProductsModule,
    OrdersModule,
  ],
})
export class AppModule {}
