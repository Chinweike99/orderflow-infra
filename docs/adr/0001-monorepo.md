# ADR-0001: Use a single repository (monorepo)

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

OrderFlow has two application services (Order API, Order Worker) plus Docker, Kubernetes, Jenkins, AWS and monitoring configuration. It's built and run by one person, and it's meant to be read as a portfolio project.

## Options considered

1. **One repository per service, plus separate deploy and infra repositories.** This is common in larger organizations: it gives clear team ownership, independent release cycles, tighter access control over production infrastructure, and suits GitOps tools such as ArgoCD. However, it needs cross-repo pipelines and versioning, and a reader has to visit several repositories to understand one system.
2. **A single repository with clear top-level folders** (`apps/`, `k8s/`, `jenkins/`, `aws/`, `monitoring/`, `docs/`). One place to read, one pipeline, and an application change and its deployment change can land in the same commit. Its weakness is that pipelines must detect which service changed, so they don't rebuild everything.

## Decision

Use a single repository, `orderflow-infra`.

## Consequences

- The Jenkins pipeline must build only the services whose folders changed.
- Dockerfiles live next to the service they build (`apps/<service>/Dockerfile`).
- The two services share one PostgreSQL database with documented table ownership (see `docs/database-schema.md`). In a larger system each service would usually own its own database.
- If this were a team project, the natural split would be: `order-api`, `order-worker`, an `orderflow-deploy` repository for Kubernetes manifests, and a `platform-infra` repository for AWS resources.
