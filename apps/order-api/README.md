# Order API

NestJS service that handles authentication, products and orders. From Sprint 2 it also publishes order events to RabbitMQ through a transactional outbox.

## Endpoints

Business routes are under `/v1`. Health checks are at the root, for Kubernetes probes.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health/live` | Public | Process is running (liveness probe). Never checks dependencies |
| GET | `/health/ready` | Public | Database reachable (readiness probe) |
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
npm run lint
```

## Operational notes (for the infrastructure)

- **Port:** `PORT`, default `3000`.
- **Migrations** run from the compiled output: `node ./node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js`. Run them as a separate step (Compose one-off, Kubernetes Job or pipeline stage), never as part of app startup.
- **Logs** are JSON, one line per entry, on stdout (`NODE_ENV=production`). With `NODE_ENV=development` they're pretty-printed. `Authorization` headers are redacted.
- **Request IDs:** an incoming `X-Request-Id` header is reused, otherwise one is generated. It's returned in the response and included in every log line.
- **Shutdown:** handles `SIGTERM` gracefully (closes HTTP and database connections).
- **Database TLS:** set `DB_SSL=true` for Amazon RDS.
