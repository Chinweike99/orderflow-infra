# Order Worker

NestJS service that processes orders asynchronously. It consumes `order.created` events from RabbitMQ, charges the (simulated) payment provider and sets each order to `COMPLETED` or `FAILED`.

It receives no client traffic. Its small HTTP server exists only for Kubernetes probes and Prometheus.

## How a message is processed

```
order-processing ──► worker
                       │
                       ├─ already processed?           → ack, skip (duplicate)
                       ├─ malformed / order missing?   → reject → order-processing.dlq
                       ├─ order PENDING → PROCESSING
                       ├─ charge payment (idempotency key = order ID)
                       │    ├─ approved  → COMPLETED ┐ one transaction with the
                       │    ├─ declined  → FAILED    ┘ processed_messages record → ack
                       │    └─ provider error / database down:
                       │         attempt < 3 → copy to order-processing.retry (5 s delay) → ack
                       │         attempt = 3 → order FAILED, reject → order-processing.dlq
```

Guarantees ([ADR-0003](../../docs/adr/0003-rabbitmq-messaging.md)):

- **No message loss.** Messages are acknowledged only after the database transaction commits. A crash at any point means RabbitMQ redelivers the message.
- **No double processing.** The final status and a `processed_messages` row are written in one transaction, so a redelivered message is recognised and skipped. If two copies are processed at the same moment, both send the same payment idempotency key, so the provider charges once.
- **Bounded retries.** Temporary failures are retried after a 5-second delay, up to `WORKER_MAX_ATTEMPTS` (default 3) attempts in total. Declined payments are final and never retried.

## Endpoints

| Path | Description |
|---|---|
| `GET /health/live` | Process is running (liveness probe) |
| `GET /health/ready` | Database reachable **and** connected to RabbitMQ (readiness probe); 503 otherwise |
| `GET /metrics` | Prometheus metrics |

## Configuration

Environment variables, validated at startup. See [`.env.example`](.env.example). Locally, the worker reads `.env` from this folder or from the repository root, sharing the database and RabbitMQ settings with the Order API.

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_PORT` | `3001` | HTTP port for probes and metrics (not `PORT`, so it can share the API's `.env`) |
| `WORKER_PREFETCH` | `10` | Messages processed in parallel per worker |
| `WORKER_MAX_ATTEMPTS` | `3` | Attempts before a message is dead-lettered |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `20000` | How long to wait for in-flight messages on SIGTERM |
| `PAYMENT_DECLINE_RATE` | `0.1` | Share of payments the simulated provider declines |
| `PAYMENT_ERROR_RATE` | `0.1` | Share that fail temporarily (these are retried) |
| `PAYMENT_MIN_LATENCY_MS` / `PAYMENT_MAX_LATENCY_MS` | `200` / `1000` | Simulated provider response time |

Useful for failure drills: `PAYMENT_ERROR_RATE=1` makes every payment fail temporarily, so every order goes through all retries and ends in the DLQ.

## Scripts

```bash
npm install
npm run build
npm run start:dev         # run with reload (development)
npm run start:prod        # node dist/main.js

npm test                  # unit tests
npm run test:e2e          # integration tests: needs `docker compose up -d`.
                          # Uses its own database and RabbitMQ vhost (orderflow_test_worker).
npm run lint
```

The worker has no migrations of its own: the Order API owns the database schema. Run the API's migrations first.

## Operational notes (for the infrastructure)

- **Scaling:** run several replicas; RabbitMQ spreads messages between them. Throughput per replica ≈ `WORKER_PREFETCH` ÷ payment latency.
- **Shutdown:** on `SIGTERM` the worker stops consuming, waits up to `WORKER_SHUTDOWN_TIMEOUT_MS` for in-flight messages, then disconnects. Anything unfinished is redelivered to another replica. Set the Kubernetes `terminationGracePeriodSeconds` above this timeout.
- **Readiness:** depends on both the database and RabbitMQ, because the worker can't do anything without either.
- **Metrics to watch:** `orders_processed_total{outcome}`, `messages_retried_total`, `messages_dead_lettered_total{reason}` (should stay at 0), `order_processing_duration_seconds`, `payment_requests_total{result}`. Queue depth comes from RabbitMQ's own metrics.
- **Logs:** JSON on stdout, one line per processed message, with `messageId`, `orderId` and `attempt`.
