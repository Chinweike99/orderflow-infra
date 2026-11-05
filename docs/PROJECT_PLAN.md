# OrderFlow: Project Plan

OrderFlow is a cloud-native order management system built to show production-style DevOps on AWS. It has two NestJS services, an Order API and an Order Worker, that communicate through RabbitMQ. They run on Kubernetes (EKS), use RDS PostgreSQL, are built and deployed by Jenkins, are exposed through AWS API Gateway, and are monitored with Prometheus and Grafana.

This document records what has been agreed and breaks the work into sprints.

---

## 1. Agreements

### 1.1 Purpose

- This is a **portfolio project**, not a tutorial. The tools are already known individually; the goal is to make them work together the way a production system would.
- The main growth focus is **AWS**: VPC, IAM, EC2, ECR, RDS, EKS and API Gateway.
- Showing the work (documentation, diagrams, evidence of failure drills) is as important as building it.

### 1.2 Who does what

| Area | Owner | How |
|---|---|---|
| Application code (Order API, Order Worker, tests, metrics endpoints) | Claude | Writes the code directly |
| All infrastructure (Dockerfiles, Compose, Kubernetes manifests, Jenkins, AWS, monitoring) | You | Built by you. Claude explains, gives steps, reviews and helps debug, but doesn't write the finished files unless asked |
| Documentation | Shared | Claude drafts the app docs; you write the infra docs and runbooks |

### 1.3 Scope

**In scope:** NestJS and TypeScript, PostgreSQL, RabbitMQ, Docker and Docker Compose, Kubernetes (Minikube or Kind, then EKS), Jenkins, GitHub, AWS (EC2, ECR, EKS, RDS, API Gateway, VPC, IAM), Prometheus and Grafana.

**Out of scope:**
- **Lambda** was considered and deliberately left out. The stack stays as originally planned.
- **Terraform** will be learned separately after OrderFlow. AWS is provisioned through the Console and AWS CLI.

### 1.4 Repository

- **Monorepo** named `orderflow-infra`; the name stays.
- In a team setting this would usually be split into service repos, a deploy repo and an infra repo. For a single developer and a portfolio, one repo keeps the whole system in one place and needs only one pipeline. This reasoning goes in the README.
- Repository structure doesn't affect which AWS services can be used. API Gateway, EKS and the rest only see what's deployed, not how the repo is organized.

```
orderflow-infra/
├── apps/
│   ├── order-api/          # NestJS API, plus its Dockerfile          (Claude: code, You: Dockerfile)
│   └── order-worker/       # NestJS worker, plus its Dockerfile       (Claude: code, You: Dockerfile)
├── k8s/
│   ├── local/              # Minikube/Kind manifests                  (You)
│   └── eks/                # EKS manifests                            (You)
├── jenkins/                # Pipeline config (or Jenkinsfile at root) (You)
├── aws/                    # AWS CLI scripts + IAM policy JSON        (You)
├── monitoring/             # Prometheus/Grafana config, dashboards    (You)
├── docs/                   # Diagrams, decisions (ADRs), runbooks     (Shared)
├── docker-compose.yml      # Local environment                        (You)
└── README.md
```

### 1.5 Architecture

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
  │ publish                      │ update status
  ▼                              │
RabbitMQ (EKS) ──► Order Worker (EKS)

GitHub ──webhook──► Jenkins (EC2) ──► ECR ──► EKS
Prometheus ──scrapes──► API, Worker, RabbitMQ, cluster ──► Grafana
```

### 1.6 Engineering notes (within the agreed scope)

These don't add new services. They're what the existing plan needs to work reliably.

| Topic | What it means | When |
|---|---|---|
| Transactional outbox | The API writes the order and an `outbox` event in one database transaction, and a relay publishes it to RabbitMQ. This prevents orders stuck in `PENDING` when a publish fails. | Sprint 2 |
| Dead-letter queue (DLQ) and retry limit | Messages that keep failing go to a DLQ instead of retrying forever | Sprint 2 |
| Idempotency | The worker records processed message IDs, so redelivery never processes an order twice | Sprint 2 |
| Database migrations | Migrations run as a separate step (a Kubernetes Job or pipeline stage), not on app startup, to avoid races between replicas | Sprints 5 and 9 |
| AWS Load Balancer Controller plus IRSA | Needed for Kubernetes to create the internal ALB | Sprint 8 |
| EBS CSI driver | Needed for persistent volumes (RabbitMQ) on EKS | Sprint 8 |
| Jenkins placement | Jenkins runs locally for CI first, then moves to EC2 when AWS is ready, and gains the ECR push and EKS deploy stages | Sprints 6, 7 and 9 |
| Cost discipline | Teardown and rebuild routine from the first AWS sprint, with billing alerts before anything else | Sprint 7 onward |
| Phase 9 completion criteria | Missing from the original roadmap; defined in Sprint 12 below | Sprint 12 |

---

## 2. Sprints

Sprints are measured by outcome, not by calendar. Rough guide: 1–2 weeks each. A sprint is done when its **Definition of done** is met and its **Evidence** is captured.

### Overview

| # | Sprint | Original phase | Main owner |
|---|---|---|---|
| 0 | Foundation | Phase 0 | Shared |
| 1 | Order API core | Phase 1 | Claude (you: local dependencies) |
| 2 | Messaging and Worker | Phase 1 | Claude |
| 3 | Containerization | Phase 2 | You |
| 4 | Local Kubernetes: deploy | Phase 3 | You |
| 5 | Local Kubernetes: resilience | Phase 3 | You |
| 6 | Jenkins CI | Phase 4 | You |
| 7 | AWS foundation | Phase 5 | You |
| 8 | AWS services and EKS cluster | Phases 5 and 6 | You |
| 9 | OrderFlow on EKS plus continuous delivery | Phases 6 and 4 | You |
| 10 | API Gateway | Phase 7 | You |
| 11 | Monitoring | Phase 8 | You (Claude: app metrics) |
| 12 | Security and resilience | Phase 9 | You |
| 13 | Portfolio polish | — | Shared |

---

### Sprint 0: Foundation

**Goal:** Set the scope and repository so building can start.

| Claude | You |
|---|---|
| Create the folder skeleton and README draft | Review and adjust the README |
| Propose the database schema (users, orders, order items, outbox, processed messages) and ER diagram | Draw the architecture diagram (draw.io, Excalidraw or similar) |
| Draft an ADR (Architecture Decision Record) template and the first ADRs (monorepo, outbox, RabbitMQ) | Set branching and commit conventions (suggested: short-lived feature branches and Conventional Commits) |
| — | Install local tools: Node, Docker, kubectl, Minikube or Kind, AWS CLI |

**Definition of done:** The repository has its structure, README, architecture diagram, ER diagram and first ADRs. All local tools are installed.

**Evidence:** Diagrams committed to `docs/`.
 
---

### Sprint 1: Order API core

**Goal:** A working API that stores orders in PostgreSQL.

| Claude | You |
|---|---|
| Scaffold the Order API (NestJS, TypeScript) | Write a **minimal** `docker-compose.yml` that runs only PostgreSQL and RabbitMQ for local development (your first infra task) |
| Database entities and migrations | Test the endpoints with Postman and keep the collection in `docs/` |
| Authentication and authorization (JWT, user roles) | — |
| Create, retrieve and list orders, with validation | — |
| Structured JSON logging, `/health` endpoints (liveness and readiness) | — |
| Unit tests | — |

**Definition of done:** You can register or log in, create an order and retrieve it. Tests pass.

---

### Sprint 2: Messaging and Worker

**Goal:** Orders are processed asynchronously, safely.

| Claude | You |
|---|---|
| Outbox table and relay publishing to RabbitMQ | Test failure cases by hand: stop RabbitMQ, kill the worker mid-job, restart them |
| Scaffold the Order Worker; consume, simulate payment, update status | Review the queue, exchange and DLQ layout in the RabbitMQ management UI |
| Retry with a limit, plus a DLQ | — |
| Idempotent processing (processed message IDs) | — |
| `/metrics` endpoints on both services (Prometheus format) | — |
| Integration tests, API documentation (Swagger) | — |

**Definition of done:** Orders move `PENDING → PROCESSING → COMPLETED/FAILED`. Redelivery never processes an order twice. Poison messages end up in the DLQ.

**Evidence:** Short notes or screenshots of the failure tests.

---

### Sprint 3: Containerization (Phase 2)

**Goal:** The whole system runs with Docker Compose.

**You:**
- Multi-stage Dockerfiles for both services (small images, non-root user)
- Full `docker-compose.yml`: API, Worker, PostgreSQL, RabbitMQ
- Networks, named volumes, health checks, restart policies, `.env` handling
- Image tagging scheme (for example, the git commit SHA)
- Image size optimization; record before and after sizes

**Claude:** Answers questions, reviews the Dockerfiles, makes app changes if containers expose problems (for example, configuration from environment variables).

**Definition of done:** `docker compose up` brings up a working system. Data survives `docker compose down` and `up`. Services wait for their dependencies to be healthy.

**Evidence:** Image sizes, a screenshot of `docker compose ps` showing healthy services.

---

### Sprint 4: Local Kubernetes, deploy (Phase 3)

**Goal:** OrderFlow runs on Minikube or Kind.

**You:**
- Namespace, Deployments, Services (ClusterIP), ConfigMaps, Secrets
- PostgreSQL and RabbitMQ with PersistentVolumeClaims (local testing only)
- Ingress for the API
- Run migrations as a Kubernetes **Job** before the API starts
- Resource requests and limits

**Definition of done:** You can create an order through the Ingress, and the worker processes it inside the cluster. Service DNS works between pods.

---

### Sprint 5: Local Kubernetes, resilience (Phase 3)

**Goal:** Prove that Kubernetes keeps the system healthy.

**You:**
- Liveness, readiness and startup probes
- Horizontal Pod Autoscaler (HPA) for the API (load test with a tool like `k6` or `hey`)
- Rolling update and rollback (deploy a broken image on purpose)
- Pod-failure drills: delete pods, kill the worker mid-processing
- Write the first runbook: `docs/runbooks/local-k8s-troubleshooting.md`

**Definition of done:** Scaling, rolling updates, rollback and recovery all work and are documented.

**Evidence:** Screenshots or terminal output of HPA scaling, a rollback and a pod recovery.

---

### Sprint 6: Jenkins CI (Phase 4, part 1)

**Goal:** Every push is tested and built automatically.

**You:**
- Run Jenkins **locally** in a container
- GitHub integration and credentials (for local Jenkins, a tunnel such as ngrok for the webhook, or polling)
- Declarative `Jenkinsfile`: checkout → install → test → build both images → tag with the git SHA
- Only rebuild a service when its folder changed (a monorepo concern)
- Handle failures: the pipeline fails clearly on failed tests

**Definition of done:** A push to GitHub triggers the pipeline. Tests run and images are built and tagged.

**Note:** Pushing to ECR and deploying are added in Sprints 7 and 9, once AWS exists.

---

### Sprint 7: AWS foundation (Phase 5, part 1)

**Goal:** A secure, cost-controlled AWS base.

**You:**
1. **First:** check your credits and their expiry, then set up billing alerts and a budget
2. Choose the region; record why
3. IAM: an admin user with MFA (no root usage), plus roles for later (Jenkins EC2, EKS)
4. VPC: public and private subnets across 2 Availability Zones, route tables, Internet Gateway, NAT Gateway
5. Security groups (least privilege)
6. Save every CLI command as a script in `aws/`
7. Write the **teardown and rebuild** routine; this is critical for cost control

**Definition of done:** The VPC exists and is documented. Billing alerts work. You can tear the network down and rebuild it from your scripts.

**Evidence:** AWS network diagram in `docs/`, scripts in `aws/`.

---

### Sprint 8: AWS services and EKS cluster (Phases 5 and 6)

**Goal:** Everything OrderFlow needs to run in AWS exists.

**You:**
- **ECR** repositories for both services
- **Jenkins on EC2**: migrate from local Jenkins, give it an IAM role (no access keys), add the **push to ECR** stage
- **RDS PostgreSQL** in private subnets, reachable only from the cluster's security group
- **EKS cluster** with managed node groups in private subnets
- Connect `kubectl` to EKS
- Install the **AWS Load Balancer Controller** (with IRSA) and the **EBS CSI driver**

**Definition of done:** Jenkins on EC2 pushes images to ECR. EKS is running and `kubectl` works. The controllers are healthy. RDS can be reached from inside the cluster (test from a temporary pod).

---

### Sprint 9: OrderFlow on EKS plus continuous delivery (Phases 6 and 4)

**Goal:** The app runs on EKS and Jenkins deploys it.

**You:**
- Adapt the manifests into `k8s/eks/`: ECR images, RDS connection, RabbitMQ as a StatefulSet on EBS
- Migrations Job against RDS
- Probes, requests and limits, HPA on EKS
- Jenkins **deploy stage**: update the image tag, apply, wait for the rollout, verify, and roll back automatically on failure
- Recovery tests on EKS (delete pods, drain a node)

**Definition of done:** A push to `main` ends with the new version running on EKS with no manual steps. A failed deploy rolls back.

**Evidence:** Jenkins pipeline screenshot showing every stage green; notes on a forced rollback.

---

### Sprint 10: API Gateway (Phase 7)

**Goal:** Clients reach OrderFlow only through API Gateway.

**Target flow:** `Client → API Gateway → VPC Link → Internal ALB → Order API`

**You:**
- Expose the API through an **internal** ALB (Ingress plus the Load Balancer Controller)
- Create an **API Gateway HTTP API** and a **VPC Link** to the private subnets
- Routes and integration to the ALB listener
- Throttling, error handling, access logging
- Authentication decision (see Open decisions below), then implement it
- Prove the ALB isn't reachable from the internet

**Definition of done:** The public endpoint works. The ALB is private. Throttling and auth behave as designed.

**Evidence:** Requests that succeed through the gateway, and a failed direct request to the ALB.

---

### Sprint 11: Monitoring (Phase 8)

**Goal:** You can see the system's health and detect failures.

| You | Claude |
|---|---|
| Deploy Prometheus and Grafana on EKS (Helm, kube-prometheus-stack) | Add any missing app metrics: request count, status codes, latency histograms, worker processed or failed counts |
| Scrape targets: API, Worker, RabbitMQ (queue depth), nodes and pods | — |
| Dashboards: API (traffic, errors, latency), Worker (throughput, failures, DLQ), RabbitMQ, cluster | — |
| Alerts: high error rate, growing queue depth, pod restarts, high CPU or memory | — |
| Trigger failures and watch them on the dashboards | — |

**Definition of done:** Dashboards show meaningful data and alerts fire on simulated failures.

**Evidence:** Dashboard screenshots taken *during* a failure, and exported dashboard JSON in `monitoring/`.

---

### Sprint 12: Security and resilience (Phase 9)

**Goal:** A production-ready posture, proven by tests.

**You:**
- Review IAM against least privilege
- Secrets: move application secrets out of plain manifests
- Pod security contexts (non-root, read-only filesystem where possible)
- Scan images for vulnerabilities (for example, Trivy in the pipeline)
- Network restrictions (security groups, Kubernetes NetworkPolicies)
- Failure drills: kill pods, kill the worker mid-message, cut database connectivity, exhaust resources, ship a failed deployment
- RDS backup and restore test (actually restore a snapshot)
- Cost review

**Definition of done** (defined here because the original roadmap had none):
- No IAM policy is broader than it needs to be, and no secrets are committed or in plain manifests.
- Containers run as non-root, and image scans show no critical vulnerabilities, or they're documented.
- Every failure drill has a written result: what happened, what the metrics showed, how it recovered.
- An RDS restore has been performed and timed.
- Runbooks exist for the most likely incidents.

**Evidence:** `docs/security.md`, `docs/failure-drills.md`, `docs/runbooks/`.

---

### Sprint 13: Portfolio polish

**Goal:** Someone who never runs the project can understand and trust it in 5 minutes.

| You | Claude |
|---|---|
| Final README: overview, architecture diagram, how to run locally, how it's deployed | Review the README for clarity |
| Short demo video (create an order through API Gateway, show processing, dashboards, a failure drill) | Tidy app code and docs |
| Monthly cost breakdown and how you kept it down | — |
| "What I'd do next" section (for example, Terraform, ArgoCD, splitting the repos) | — |
| Final teardown of AWS resources | — |

**Definition of done:** The repo tells the full story without a running environment.

---

## 3. Open decisions

Decide these when the relevant sprint starts, and record each as an ADR in `docs/adr/`.

| Decision | Options | Decide by |
|---|---|---|
| Local Kubernetes tool | Minikube or Kind | Sprint 4 |
| Where authentication is enforced | App only (gateway handles throttling and routing), or a gateway JWT authorizer validating the app's tokens plus app-level authorization | Sprint 10 |
| Secrets handling on EKS | Kubernetes Secrets (encrypted at rest), or an external store | Sprint 12 |
| Jenkins agents | Run builds on the controller, or separate agents | Sprint 8 |

---

## 4. Standing rules

1. **Cost:** from Sprint 7 onward, tear down or scale down AWS resources whenever you're not working. Check the billing dashboard weekly.
2. **Reproducibility:** every AWS resource is created by a script saved in `aws/`, even when the console was used to explore first.
3. **Document as you go:** each sprint ends with its evidence committed. Don't leave documentation until Sprint 13.
4. **Small app:** keep the application deliberately simple. The infrastructure is the focus.
