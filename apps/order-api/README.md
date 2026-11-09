# Order API

NestJS service that handles authentication, products and orders. Every new order is saved together with an `order.created` event (transactional outbox, [ADR-0002](../../docs/adr/0002-transactional-outbox.md)); a background relay publishes the events to RabbitMQ for the [Order Worker](../order-worker/README.md).

## Endpoints

Business routes are under `/v1`. Health checks, metrics and docs are at the root: they're for Kubernetes, Prometheus and developers, and API Gateway only routes `/v1/*`.

Interactive documentation (Swagger UI): **`/docs`** · OpenAPI JSON: `/docs-json`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health/live` | Public | Process is running (liveness probe). Never checks dependencies |
| GET | `/health/ready` | Public | Database reachable (readiness probe). Deliberately ignores RabbitMQ, see below |
| GET | `/metrics` | Public | Prometheus metrics |
| POST | `/v1/auth/register` | Public | Create a customer account |
| POST | `/v1/auth/login` | Public | Returns a Bearer access token (JWT) |
| GET | `/v1/auth/me` | Token | Current user |
| GET | `/v1/products` | Public | Active products and prices |
| POST | `/v1/orders` | Token | Create an order. Optional `Idempotency-Key` header |
| GET | `/v1/orders` | Token | List orders (`limit`, `offset`, `status`). Customers see their own; admins see all |
| GET | `/v1/orders/:id` | Token | One order. Another customer's order returns 404 |

### Example

```bash
curl -X POST localhost:3000/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7b1c2f0e-checkout-1" \
  -d '{"items":[{"productId":"<uuid>","quantity":2}]}'
```

Prices are always taken from the `products` table; clients send only product IDs and quantities. Repeating a request with the same `Idempotency-Key` returns the original order with the header `Idempotent-Replayed: true`.

A new order is returned as `PENDING`. The worker moves it to `PROCESSING` and then `COMPLETED` or `FAILED` (with `failureReason`), usually within a few seconds; poll `GET /v1/orders/:id` to follow it.

## Transactional outbox

1. `POST /v1/orders` saves the order, its items and an `outbox_events` row in **one** transaction.
2. The relay (every replica runs one) claims unpublished rows with `SELECT … FOR UPDATE SKIP LOCKED`, publishes them to the `orders` exchange and waits for RabbitMQ's confirm, then sets `published_at`.
3. If RabbitMQ is down, orders are still accepted. Events wait in the table (`outbox_events_pending` metric) and are published automatically when RabbitMQ is back.

Delivery is at-least-once: an event can be published twice after a crash. The worker deduplicates by message ID.

## Configuration

All settings come from environment variables, validated at startup. See [`.env.example`](.env.example). For local runs the API reads `.env` from this folder or from the repository root.

## Scripts

```bash
npm install
npm run build             # compile to dist/

npm run migration:run     # apply database migrations (needs a build first)
npm run migration:show    # list applied/pending migrations
npm run migration:revert  # undo the last migration

npm run start:dev         # run with reload (development)
npm run start:prod        # run the compiled app: node dist/main.js

ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='at-least-12-chars' npm run create-admin

npm test                  # unit tests (Vitest)
npm run test:e2e          # integration tests: needs `docker compose up -d`.
                          # Uses its own database and RabbitMQ vhost (orderflow_test_api).
npm run lint
```

## Operational notes (for the infrastructure)

- **Port:** `PORT`, default `3000`.
- **Migrations** run from the compiled output: `node ./node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js`. Run them as a separate step (Compose one-off, Kubernetes Job or pipeline stage), never as part of app startup.
- **Logs** are JSON, one line per entry, on stdout (`NODE_ENV=production`). With `NODE_ENV=development` they're pretty-printed. `Authorization` headers are redacted.
- **Request IDs:** an incoming `X-Request-Id` header is reused, otherwise one is generated. It's returned in the response and included in every log line.
- **Shutdown:** handles `SIGTERM` gracefully (stops the relay, closes HTTP, database and RabbitMQ connections).
- **Readiness vs RabbitMQ:** readiness depends only on the database. While RabbitMQ is down the API keeps accepting orders into the outbox, so it must stay in the load balancer.
- **Metrics to watch:** `outbox_events_pending` and `outbox_oldest_pending_age_seconds` (should stay near 0), `outbox_publish_failures_total`, `http_requests_total`, `http_request_duration_seconds`.
- **Database TLS:** set `DB_SSL=true` for Amazon RDS.
