import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Business routes live under /v1; health checks stay at /health/* for probes.
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields
      forbidNonWhitelisted: true, // ...and reject requests that send them
      transform: true,
    }),
  );

  // Close HTTP and database connections cleanly on SIGTERM, which Kubernetes
  // sends before stopping a pod during rolling updates and scale-downs.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}

await bootstrap();
