import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { httpMetricsMiddleware } from './metrics/http-metrics.middleware.js';
import { MetricsService } from './metrics/metrics.service.js';

/**
 * HTTP configuration shared by main.ts and the integration tests, so tests
 * exercise exactly what runs in production.
 */
export function configureApp(app: INestApplication): void {
  app.use(httpMetricsMiddleware(app.get(MetricsService)));

  // Business routes live under /v1. Health checks and metrics stay at the
  // root: they are for Kubernetes and Prometheus, not for API clients.
  app.setGlobalPrefix('v1', {
    exclude: ['health/live', 'health/ready', 'metrics'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields
      forbidNonWhitelisted: true, // ...and reject requests that send them
      transform: true,
    }),
  );

  // Interactive API documentation at /docs (OpenAPI JSON at /docs-json).
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('OrderFlow Order API')
      .setDescription(
        'Authentication, products and orders. Orders are processed asynchronously ' +
          'by the Order Worker; poll GET /v1/orders/{id} to follow the status.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}
