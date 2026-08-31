# ADR-015 — First-party JWT authentication

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

ADR-09 of the approved selection record adopts a self-hostable identity provider — Keycloak or Ory —
to keep identity under the platform's control, supporting email and password sign-in, OAuth and JWT
access tokens. Chapter 11 of the Technical Architecture describes authorisation as layered from
organisation to project to action to tool.

Phase 1 of the roadmap requires authentication, organisations and projects. It does not require
federated identity or third-party OAuth sign-in, and the instruction governing this build is not to
over-engineer authentication.

Standing up Keycloak now would add an infrastructure dependency the milestone does not need. The part
of the design that is expensive to change later is not the token issuer — it is where identity is
trusted and where authorisation is decided.

## Decision

Authentication is implemented first-party, with the substitution seams placed deliberately.

- Passwords are hashed with scrypt from `node:crypto` (N=16384, r=8, p=1, 16-byte salt, 64-byte key)
  and verified with a constant-time comparison. No native module and no third-party hashing
  dependency is introduced.
- Access and refresh tokens are JWTs signed HS256 through `@nestjs/jwt`. JWT_SECRET has no default
  and the API refuses to start without it. Access tokens are short-lived; refresh tokens are stored
  hashed, so a database disclosure does not yield usable tokens.
- Identity enters the application at exactly one point, JwtAuthGuard, which resolves a verified token
  into an AuthenticatedUser. Replacing this guard with one that validates Keycloak or Ory tokens is
  the whole of the substitution.
- Authorisation is decided at exactly one point, AuthorizationService in `backend/src/core/authz/`.
  No controller, service or query composes its own permission logic. The organisation, project, role
  and agent-permission layers of chapter 11 are all evaluated there.

Third-party OAuth sign-in is not implemented.

## Consequences

Phase 1 is met with no additional infrastructure, and the identity-provider decision is preserved
rather than pre-empted. Organisation isolation and role checks are enforced in one auditable place.
The cost is that account recovery, multi-factor authentication and federation must come with the
identity provider; they are not built here.

## Retirement condition

Retired when a Keycloak or Ory deployment exists and JwtAuthGuard validates its tokens.
AuthorizationService is expected to survive that change unchanged.
