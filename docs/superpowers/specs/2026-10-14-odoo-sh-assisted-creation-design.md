# Odoo.sh assisted project creation — design

Date: 14 October 2026
Status: Draft for review
ADR to accompany the implementation: ADR-071 (follows ADR-070, ADR-041)

## 1. Intent

Operators want "Create with AI" to start an **Odoo.sh** project the same way it
already starts an Odoo Online one (ADR-070): fill the Odoo.sh form fields inside
Cartenz, complete the deploy at odoo.sh, and have Cartenz connect the result so
tasks push to it.

Out of scope, by instruction: any change to the Odoo Online flow, its DTO block,
or its portal panel.

## 2. Constraints (verified 14 October 2026)

1. `odoo.sh/project/create` requires an Odoo.sh session. Login redirects to
   `github.com/login/oauth/authorize`, which sends `x-frame-options: deny`.
   An embedded browser panel in the web portal is therefore not possible; a
   server-side proxy or headless browser would handle the user's GitHub
   credentials and is refused for the reasons in ADR-052 §9 and ADR-070 §4.
2. Odoo.sh has no public API to create a project. The Deploy button needs the
   user's own Odoo.sh session.
3. The form asks for: GitHub repository (new or existing, under an owner),
   Odoo version (14.0–20.0), subscription code (secret), hosting region.
4. When "New repository" is chosen, **Odoo.sh creates the GitHub repository**.
   Cartenz must therefore not create it first, or the Odoo.sh deploy fails on
   a name collision.

## 3. Design

### 3.1 Hosting choice

- `AI_HOSTING_TARGETS` becomes `['on_host', 'odoo_online', 'odoo_sh']`.
- `CreateAiProjectDto` gains `odooSh?: OdooShSignupDto`:
  - `repositoryName` — GitHub repository name rule `^[A-Za-z0-9._-]{1,100}$`.
  - `region` — `IsIn(['am','ca','eu','sa','me','as','au'])` (the values the
    Odoo.sh map uses; `sa` is Middle East, `me` Southern Asia, `as` Southeast Asia).
  - The Odoo version reuses the existing `odooVersion` field, restricted to
    14.0–20.0 when hosting is `odoo_sh`.
- The owner is not a field: it is `GITHUB_OWNER`, because the connect step
  reads the repository with `GITHUB_TOKEN`, which can only see that owner.
- The subscription code is **not collected**. It is a secret Cartenz cannot use.

### 3.2 Creation records a plan, provisions nothing

`createAiProject` branches on `hosting === 'odoo_sh'` before anything else,
into a new private `createOdooShAiProject`, mirroring `createOdooOnlineAiProject`:

- one `projects` row: `projectType: 'odoo_sh'`, `provisioningStatus: 'none'`,
  `repositoryUrl: null`,
  `environmentConfig: { hosting: 'odoo_sh', signup: { owner, repositoryName, odooVersion, region } }`;
- environments: Production on the default branch (kind `production`) and
  Development on `development` (default target);
- the specification, version 1; the same two audit events with `hosting: 'odoo_sh'`.

No directory, no scaffold, no GitHub call. No migration (the plan lives in the
existing `environment_config` JSON).

### 3.3 Portal setup panel

`OdooShSetupPanel` on the project page, shown while an `odoo_sh` project with
`environmentConfig.hosting === 'odoo_sh'` has no `github` connection:

- checklist with copy buttons: "New repository", `owner/repositoryName`,
  Odoo version, region name;
- "Open Odoo.sh" → `window.open('https://www.odoo.sh/project/create')`;
- note: enter the subscription code there; Cartenz never sees it;
- "I have deployed — connect" button → endpoint in 3.4; an error is shown on
  the panel.

The create form gets a third "Where it runs" tile, "Odoo.sh", with the
repository name, version and region inputs.

### 3.4 Connect endpoint

`POST /projects/:id/odoo-sh/connect` (project admin). It:

1. reads `signup` from the project; 400 if the project is not an assisted
   `odoo_sh` project;
2. `GitHubClient.getRepository(name)` — new method, `GET /repos/{owner}/{name}`;
   404 becomes a clear message ("The repository does not exist yet. Finish the
   deploy on Odoo.sh first.");
3. `GitHubRepositoryService.adoptExisting(...)` — new public method: seals
   `GITHUB_TOKEN` and calls the existing `recordConnection` (no `setRemote`, no
   push);
4. sets `projects.repository_url` to the clone URL, so the task guard at
   `tasks.service.ts:158` passes, and the default branch to the repository's
   `default_branch`;
5. audits `project.odoo_sh_connected`.

After this the project behaves like any connected `odoo_sh` project: each task
clones, commits on `development`, and pushes; Odoo.sh builds the branch.

## 4. Error handling

| Case | Behaviour |
|---|---|
| GitHub settings missing | Connect returns 400 naming `GITHUB_TOKEN` / `GITHUB_OWNER` |
| Repository not found | 400 with "finish the deploy on Odoo.sh first" |
| Token cannot see the repository (fine-grained PAT limited to selected repos) | Same 404 path; panel text says the token must cover all repositories of the owner |
| Connect clicked twice | `recordConnection` already replaces the previous `github` connection |
| Task before connect | Refused by the existing guard (no repository URL) |

## 5. Testing

- DTO spec: `odoo_sh` with a valid `odooSh` block is accepted; bad repository
  name, bad region refused. The existing assertion that `odoo_sh` is refused
  (`odoo-online-hosting.dto.spec.ts:52`) is moved to the new spec and inverted;
  no other Odoo Online assertion changes.
- `github-client.spec.ts`: `getRepository` returns the repository and maps 404.
- Manual: create with hosting Odoo.sh → panel shows the checklist → deploy at
  odoo.sh → connect → a task pushes `development` and Odoo.sh builds it.

## 6. Risks to verify during implementation

1. Whether the per-task clone (`workspace-manager.ts`) creates `development`
   when it does not yet exist on the remote. If not, the connect step pushes it
   from the default branch once.
2. Whether `main`-branch refusal (`tasks.service.ts:212-238`) needs the
   Odoo.sh production branch name, which is the repository's default branch.

## 7. Not doing

- Embedded browser, proxy, or headless automation (section 2).
- Collecting or storing the subscription code.
- "Existing repository" option in the Cartenz form; an existing Odoo.sh
  project is already covered by the connect-existing flow.
- Webhook detection of a finished deploy; the explicit connect button is enough.
