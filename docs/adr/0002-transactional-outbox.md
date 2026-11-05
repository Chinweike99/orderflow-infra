# ADR-0002: Publish order events through a transactional outbox

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

When a customer creates an order, the Order API must do two things: save the order in PostgreSQL and send a message to RabbitMQ so the worker processes it. These are two different systems, and no single transaction covers both (the "dual-write" problem):

- Save, then publish: if the publish fails or the pod crashes in between, the order stays `PENDING` forever.
- Publish, then save: if the save fails, the worker processes an order that doesn't exist.

## Options considered

1. **Publish directly after saving, and hope it succeeds.** Simple, but it loses orders under exactly the failure conditions this project is meant to test.
2. **Transactional outbox.** Save the order and an event row in `outbox_events` in one database transaction. A relay reads unpublished rows, publishes them and marks them published.
3. **Change data capture (for example, Debezium reading the PostgreSQL log).** Robust, but it adds a heavy extra component that's out of scope.

## Decision

Use a transactional outbox with a polling relay inside the Order API.

## Consequences

- No order can exist without its event, and no event without its order.
- Delivery is **at least once**: the relay can publish an event twice after a crash. The worker must be idempotent (`processed_messages` table, see `docs/database-schema.md`).
- There's a short delay (the polling interval) between creating an order and publishing its event.
- With several API replicas, the relay must avoid double work. It locks rows with `SELECT … FOR UPDATE SKIP LOCKED`.
- Unpublished outbox rows become a useful metric: a growing count means RabbitMQ publishing is broken.
