# OrderFlow

A cloud-native order management system, built to show production-style DevOps on AWS.

Two NestJS services, an **Order API** and an **Order Worker**, communicate through RabbitMQ. They're containerized with Docker, run on Kubernetes (Minikube locally, Amazon EKS in the cloud), store data in PostgreSQL (Amazon RDS), are built and deployed by Jenkins, are exposed to clients through AWS API Gateway, and are monitored with Prometheus and Grafana.

> **Status:** In progress, Sprint 2 (messaging and the Order Worker). See the [project plan](docs/PROJECT_PLAN.md).

---

## Architecture

```
Client
  │
  ▼
AWS API Gateway (HTTP API)
  │  VPC Link
  ▼
Internal Application Load Balancer
  │
  ▼
Order API (EKS) ──────────► RDS PostgreSQL
  │                              ▲
  │ publish (outbox)             │ update status
  ▼                              │
RabbitMQ (EKS) ──► Order Worker (EKS)

GitHub ──webhook──► Jenkins (EC2) ──► Amazon ECR ──► Amazon EKS
Prometheus ──scrapes──► API, Worker, RabbitMQ, cluster ──► Grafana
```

<!-- TODO: replace with the architecture diagram image from docs/diagrams/ -->

### How an order flows

1. A client sends `POST /orders` through API Gateway.
2. The Order API validates the request, calculates the price from the product catalogue, and saves the order (`PENDING`) together with an `order.created` event in a single database transaction ([ADR-0002](docs/adr/0002-transactional-outbox.md)).
3. The outbox relay publishes the event to RabbitMQ.
4. The Order Worker consumes the event, simulates payment and sets the order to `COMPLETED` or `FAILED`. Temporary failures are retried, and repeated failures go to a dead-letter queue ([ADR-0003](docs/adr/0003-rabbitmq-messaging.md)).
5. Duplicate deliveries are detected and skipped, so an order is never processed twice.

## Tech stack

| Area | Technology |
|---|---|
| Application | Node.js, NestJS, TypeScript |
| Data and messaging | PostgreSQL (Amazon RDS), RabbitMQ |
| Containers | Docker, Docker Compose |
| Orchestration | Kubernetes: Minikube or Kind (local), Amazon EKS |
| CI/CD | Jenkins on EC2, GitHub webhooks, Amazon ECR |
| Networking and edge | Amazon VPC, internal ALB, VPC Link, AWS API Gateway |
| Access | AWS IAM |
| Observability | Prometheus, Grafana |

AWS resources are provisioned with the AWS Console and AWS CLI. Every command is saved as a script in [`aws/`](aws/) so the environment can be rebuilt.

## Repository layout

```
orderflow-infra/
├── apps/
│   ├── order-api/        # NestJS API (HTTP, auth, orders, outbox relay)
│   └── order-worker/     # NestJS worker (RabbitMQ consumer, payment simulation)
├── k8s/
│   ├── local/            # Manifests for Minikube/Kind
│   └── eks/              # Manifests for Amazon EKS
├── jenkins/              # CI/CD pipeline configuration
├── aws/                  # AWS CLI scripts and IAM policies
├── monitoring/           # Prometheus and Grafana configuration, dashboards
└── docs/                 # Plan, diagrams, decisions (ADRs), runbooks
```

This is a single repository by design ([ADR-0001](docs/adr/0001-monorepo.md)). In a team setting I'd split it into per-service repositories, a deployment repository and an infrastructure repository. For a single developer, one repository keeps the whole system readable in one place and needs only one pipeline.

## Documentation

- [Project plan and sprints](docs/PROJECT_PLAN.md)
- [Database schema](docs/database-schema.md)
- [Manual testing guide (Postman + RabbitMQ)](docs/testing-guide.md)
- Services: [Order API](apps/order-api/README.md) · [Order Worker](apps/order-worker/README.md)
- Architecture decisions:
  - [ADR-0001: Monorepo](docs/adr/0001-monorepo.md)
  - [ADR-0002: Transactional outbox](docs/adr/0002-transactional-outbox.md)
  - [ADR-0003: RabbitMQ, retries and DLQ](docs/adr/0003-rabbitmq-messaging.md)

## Branching

| Branch | Purpose |
|---|---|
| `dev` | Day-to-day work. All changes are committed here first. |
| `main` | Stable code. Updated only by merging `dev` once the work is tested. |

From Sprint 9 onward, merges to `main` trigger a deployment to EKS.

## Running locally

Requirements: Node.js 24, Docker.

```bash
cp .env.example .env                 # then set real passwords and a JWT_SECRET
docker compose up -d                 # PostgreSQL + RabbitMQ; wait for "healthy"

cd apps/order-api && npm install && npm run build && npm run migration:run
npm run start:dev                    # API on $PORT, Swagger UI at /docs

cd ../order-worker && npm install
npm run start:dev                    # worker; probes and metrics on $WORKER_PORT
```

RabbitMQ management UI: http://localhost:15672. Running the API and worker in containers comes in Sprint 3.

## Deployment

_Coming in Sprints 6–10._

## Monitoring

_Coming in Sprint 11._
