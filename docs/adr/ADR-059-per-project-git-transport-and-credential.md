# ADR-059: A project chooses its git transport and credential

- Status: Accepted
- Date: 23 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-021 (push safety and SSH remotes), ADR-041 (a created project's GitHub
repository) and ADR-058 (deployment-wide git credentials).

Written after the fact: the decision shipped in commit `967ac45`, and this record is
reconstructed from that commit and `backend/src/agent/git/project-git-access.ts`.

## Context

A project's transport was whatever its repository URL happened to say, and its
credential was whichever connection happened to be created first. On `task_221242` a
project whose remote was HTTPS, but whose only stored credentials were SSH keys, pushed
with no credential at all and failed with
`fatal: could not read Username for 'https://github.com'`. The error named nothing the
operator had done.

## Decision

1. `projects` gains `git_transport` (`auto` | `ssh` | `https`), `git_credential_id`
   (a reference to `git_credentials`) and `git_username` (migration `0023`).
2. Setting the transport rewrites the project's own repository URL between the
   `ssh://` and `https://` forms in the same statement. A non-default port is left as
   it is rather than being changed silently.
3. A credential of the wrong kind for the chosen transport is refused when it is saved,
   not shown as a warning. A warning on a settings page is read once; otherwise the
   operator finds out at the next failed push.
4. The credential a clone, fetch or push uses is resolved in three tiers:
   1. the project's own choice;
   2. the project's oldest connection that is a Git remote and carries a secret;
   3. the ADR-058 deployment default for the remote's host.
5. The resolved username reaches the HTTPS clone and push URL, and a project can
   override the per-host username convention.
6. `GET` and `PATCH /projects/:projectId/git-access` back a "Git access" panel on the
   project settings page. The panel shows the stored and the effective transport and
   where the credential comes from, so it can answer "will this push present a key or
   a token?".

## Consequences

- A transport and credential mismatch is caught when it is saved, not on a push.
- Tier 2 only counts connections that are Git remotes. Otherwise a project holding an
  Odoo Online API key would present that key to GitHub.

## Verification

- `backend/src/modules/projects/repository-url.spec.ts`: transport conversion.
- `backend/src/agent/task-repository-credential.spec.ts`: each resolution tier wins
  in turn, and the URL is rewritten.
