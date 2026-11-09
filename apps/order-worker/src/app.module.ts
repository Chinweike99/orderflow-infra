import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv, type Env } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { MetricsService } from './metrics/metrics.service.js';
import { OrderConsumer } from './processing/order-consumer.service.js';
import { OrderProcessor } from './processing/order-processor.js';
import { OrdersRepository } from './processing/orders.repository.js';
import {
  PAYMENT_GATEWAY,
  SimulatedPaymentGateway,
} from './processing/payment-gateway.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Local development reads .env from the app folder or the repo root.
      // In containers and Kubernetes, real environment variables are used.
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          name: 'order-worker',
          level: config.get('LOG_LEVEL', { infer: true }),
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // Only probes and Prometheus call the worker over HTTP; don't log them.
          autoLogging: false,
        },
      }),
    }),
    DatabaseModule,
  ],
  controllers: [HealthController],
  providers: [
    MetricsService,
    OrdersRepository,
    OrderProcessor,
    OrderConsumer,
    { provide: PAYMENT_GATEWAY, useClass: SimulatedPaymentGateway },
  ],
})
export class AppModule {}
