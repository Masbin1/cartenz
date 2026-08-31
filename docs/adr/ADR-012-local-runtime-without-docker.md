# ADR-012 — Local runtime without Docker

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

Chapter 16 of the Technical Architecture specifies Docker Compose for development and Kubernetes for
production. The development host used for this milestone is a WSL2 Ubuntu 22.04 instance with no
Docker Engine, no container runtime and no administrative privilege, so the Compose stack cannot be
started there. The host does provide Node.js 20, Python 3.10, a running PostgreSQL 14 cluster on
127.0.0.1:5432, a C toolchain and outbound network access.

Authoring a Compose file that has never been executed and presenting it as the working development
path would misrepresent the state of the build.

## Decision

Two development paths are supported, and the distinction is stated wherever either is documented.

1. Compose path — the standard developer path. `infrastructure/compose/docker-compose.yml` defines
   the full documented stack: PostgreSQL, Redis, the NestJS API, the worker, the Next.js front end
   and the Nginx reverse proxy. It is the path used by developers with Docker and the basis for the
   Kubernetes manifests. It is authored but NOT verified on this host.
2. Unprivileged local path — this host only. `infrastructure/scripts/` provisions the same service
   topology without Docker or root: `install-redis-local.sh` builds Redis 7.2.5 from source into
   `~/.local`, and `dev-up.sh` starts Redis, applies migrations and starts the API, the worker and
   the front end. This path IS verified, and the verification is recorded in
   `docs/verification-log.md`.

Both paths read the same `.env` contract and start the same processes with the same arguments. No
application code branches on which path is in use.

## Consequences

The application is demonstrably runnable and testable on the available host, and the Compose
definition remains the documented target. The cost is a second runtime path to keep in step with the
first; the shared `.env` contract and the absence of code-level branching keep the divergence to the
provisioning scripts alone.

## Retirement condition

Retired when Docker is available on the development hosts and the Compose path has been executed and
recorded in `docs/verification-log.md`. The unprivileged scripts may then be removed.
