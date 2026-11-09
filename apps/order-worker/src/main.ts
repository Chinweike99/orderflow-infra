import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // On SIGTERM: stop consuming, finish in-flight messages, then close
  // RabbitMQ and database connections (see OrderConsumer).
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  await app.listen(config.get('WORKER_PORT', { infer: true }), '0.0.0.0');
}

await bootstrap();
