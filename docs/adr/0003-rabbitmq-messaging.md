# ADR-0003: Use RabbitMQ with bounded retries and a dead-letter queue

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

Orders are processed asynchronously by the Order Worker. Processing can fail temporarily (database unavailable, simulated payment timeout) or permanently (a malformed message). The system must retry temporary failures, stop retrying eventually, and never lose a message silently.

## Options considered

1. **RabbitMQ (self-managed on Kubernetes).** Flexible routing, mature retry and dead-letter features, and the same setup runs locally, on Minikube and on EKS. It has to be operated (persistence, upgrades), which is useful operational practice for this project.
2. **Amazon SQS.** Fully managed and cheap, but it only exists in AWS, so the local and Kubernetes phases would need a different broker or an emulator.
3. **Amazon MQ for RabbitMQ.** Managed RabbitMQ, but it costs more and removes the in-cluster stateful workload the project wants to practise.

## Decision

Use RabbitMQ, running in Kubernetes (Docker Compose locally, a StatefulSet on EKS), with this topology:

| Resource | Type | Purpose |
|---|---|---|
| `orders` | Topic exchange | The Order API's outbox relay publishes `order.created` here |
| `order-processing` | Quorum queue, bound to `order.created`; rejected messages dead-letter to the DLQ | The worker consumes from it |
| `order-processing.retry` | Quorum queue with a 5-second message TTL that dead-letters back to `order-processing`; no consumers | Delayed retry |
| `order-processing.dlq` | Quorum queue | Messages that failed all attempts or can never succeed |

All queues are **quorum queues**, RabbitMQ's recommended durable, replicated queue type. Both services declare the topology on connect (identical code in each app), so either can start first.

Rules:
- Messages are persistent, and publishing uses publisher confirms.
- The worker acknowledges manually, **only after** its database transaction commits.
- On a temporary failure, the worker publishes a copy to the retry queue with the header `x-attempt` incremented, waits for the confirm, then acknowledges the original. After **3** attempts the order is marked `FAILED` and the message is rejected into the DLQ.
- A declined payment is a business outcome, not a failure: the order becomes `FAILED` and the message is acknowledged, with no retry.
- A permanently invalid message goes straight to the DLQ.
- `prefetch` limits how many unacknowledged messages each worker holds.

## Consequences

- RabbitMQ needs persistent storage on Kubernetes (a PersistentVolumeClaim; on EKS, the EBS CSI driver).
- Queue depth and DLQ size become key monitoring signals (Sprint 11).
- Messages in the DLQ need a documented runbook: inspect, fix, replay.
