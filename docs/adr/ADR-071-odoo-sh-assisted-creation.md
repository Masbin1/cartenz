# ADR-071: Creating an Odoo.sh project is assisted, and Cartenz adopts the repository Odoo.sh creates

Status: Accepted (2026-10-14)

Relates to: ADR-021 (push safety), ADR-028 (execution modes), ADR-041 (GitHub
repository for a created project), ADR-052 §9 (no headless browser), ADR-058
(registered Git credentials), ADR-070 (Odoo Online assisted creation).

## Context

Operators asked for Create-with-AI to start an Odoo.sh project the way it
starts an Odoo Online one (ADR-070). ADR-070 left `odoo_sh` as a planned
hosting value.

Odoo.sh has no public API to create a project. Its form at
`https://www.odoo.sh/project/create` asks for a GitHub repository (new or
existing, under an owner), an Odoo version, a subscription code and a hosting
region. Deploy works only inside the operator's own Odoo.sh session, and that
session's login is GitHub OAuth (`/web/login` → `/oauth/signin` →
`github.com/login/oauth/authorize`).

An embedded browser panel in the portal was considered and rejected:

- github.com answers with `x-frame-options: deny`, so the login cannot load
  inside an iframe. Even after a login, the browser withholds Odoo.sh's cookies
  from a frame embedded in Cartenz's origin.
- Proxying the pages, or driving a headless browser on the server, would put
  the operator's GitHub credentials and subscription code through Cartenz. That
  is refused for the reasons in ADR-052 §9 and ADR-070 §4.

A desktop shell (Electron or Tauri) could host Odoo.sh in a native webview. That
is a separate product decision, and this design does not depend on it.

When "New repository" is chosen, **Odoo.sh creates the GitHub repository
itself.** If Cartenz created the repository first, Odoo.sh's deploy would fail
on the name.

## Decision

1. **The Create-with-AI form offers `hosting: 'odoo_sh'`** with an `odooSh`
   block: `owner`, `repositoryName` and `region`. Region uses Odoo.sh's own
   values (`am ca eu sa me as au`). The Odoo version reuses `odooVersion`. The
   subscription code is never collected: only the operator's own Odoo.sh session
   can use it.
2. **Creation records a plan and provisions nothing.** The project gets one row
   with `projectType: 'odoo_sh'`, `repository_url` null, and
   `environment_config = { hosting: 'odoo_sh', signup: {...} }`. It gets one
   Development environment on branch `development`, plus its specification.
   There is no directory, no scaffold, no GitHub call and no migration.
3. **The project page shows an Odoo.sh setup panel** until the repository is
   connected. It contains the form values with copy buttons and an "Open
   Odoo.sh" button that opens a popup window. It also has a connect button that
   calls `POST /projects/:id/odoo-sh/connect`.
4. **Connecting adopts the repository.** The step:
   - reads it with `GitHubClient.getRepository`;
   - creates `development` from the repository's default branch when it is
     missing, using `ensureBranch`;
   - records a `github` connection through the existing `createConnection`;
   - sets `repository_url` and `default_branch`;
   - audits `project.odoo_sh_connected`.

   The step is idempotent. Once `repository_url` is set, a second call reports
   the same repository.
5. **The token is a registered Git credential** (Settings → Git credentials,
   kind Access token, host github.com; ADR-058). The connection references the
   credential's existing secret, so rotating the credential reaches the project.
   `GITHUB_TOKEN` is only a fallback, and when it is used it is sealed against
   the project.

The Odoo Online path (ADR-070) is unchanged.

## Consequences

- After connecting, the project behaves like any repository-backed `odoo_sh`
  project. Each task clones, commits on `development` and pushes, and Odoo.sh
  builds the branch. `main` stays untargetable (ADR-028).
- The token must be able to see the new repository. A fine-grained token
  restricted to selected repositories cannot see a repository created after the
  token. In that case the panel's message tells the operator to grant it access
  to all of the owner's repositories.
- A repository with no commits cannot be branched. GitHub's own message ("Git
  Repository is empty.") is returned to the panel.
- Nothing is enforced against Odoo.sh. If the operator deploys under another
  name, connecting fails with "not found" rather than adopting the wrong
  repository.

## Verification

- Unit: `odoo-sh-hosting.dto.spec.ts` covers the DTO.
  `github-client.spec.ts` covers `getRepository` and `ensureBranch`: 404 becomes
  null, an existing branch is left alone, a missing one is created at the
  default branch's head, and an empty repository raises an error.
  `odoo-sh-signup.spec.ts` covers the plan reader. `frontend/lib/odoo-sh.test.ts`
  covers the helpers.
- Manual: see the run recorded in `docs/verification-log.md`. Create with
  hosting Odoo.sh, deploy at odoo.sh from the checklist, connect, and confirm
  `development` exists and a task's push triggers an Odoo.sh build.

## Retirement condition

Retire the assisted step if Odoo publishes a supported API to create an Odoo.sh
project. The recorded plan would then feed that call directly.
