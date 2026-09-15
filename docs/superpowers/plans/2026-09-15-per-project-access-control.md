# Per-project access control — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member sees every project in the organisation but can only open the ones they were granted, with an owner panel that grants access and a queue for requests.

**Architecture:** Two tables — `project_members` (a grant carrying nothing but "may open this") and `project_access_requests` (an ask, decided by an owner or admin). The decision itself is a pure function, `decideProjectAccess`, so it can be tested without a database; `AuthorizationService.requireProjectAccess` calls it after organisation membership resolves, which puts enforcement at the single point all 28 call sites already pass through. A locked project stays in the list and refuses with 403.

**Tech Stack:** NestJS, Drizzle ORM (PostgreSQL), Jest (unit only, no database in tests), Next.js App Router + Tailwind for the portal.

**Spec:** `docs/superpowers/specs/2026-09-15-project-access-control-design.md` · **ADR:** `docs/adr/ADR-043-per-project-access-control.md`

## Global Constraints

- **British/South African spelling in all prose, comments and user-facing copy:** "organisation", "authorisation", "licence" (noun). Existing code uses `organization` in *identifiers* (`organizationMembers`, `organizationId`) — keep identifiers as they are, use British spelling in comments and UI text.
- **Tests never touch a database.** Every `.spec.ts` in this repo is a pure unit test. Anything needing a live stack is asserted by `infrastructure/scripts/smoke-test*.sh`, not by Jest. Do not add a test container, a mock `db`, or an in-memory Postgres.
- **Comments explain why, not what.** Match the surrounding density: this codebase writes a short paragraph above anything non-obvious and nothing above the obvious. Never write `// set the status` above `status = x`.
- **Migrations are files, never `drizzle-kit push`.** Write the `.sql` by hand into `backend/drizzle/`, numbered in sequence. `src/core/database/migrate.ts` applies them; the API never applies them on boot.
- **Enumerations live in `backend/src/core/enums.ts`** and nowhere else.
- **Audit event names live in `backend/src/core/audit/audit-events.ts`** as a closed set.
- **Run from `backend/`:** `npm test`, `npm run lint`, `npm run typecheck`. Run from `frontend/`: `npx tsc --noEmit`. `npm run build` is known to fail in this environment for unrelated reasons (see `RUNNING.md`) — do not treat that as your regression.
- **Commit messages** follow the repo's style: `feat(access): …` / `test(access): …`, a body explaining why, and the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Line endings:** git reports `LF will be replaced by CRLF` on this host. Expected, ignore it.

---

### Task 1: The access decision, as a pure function

The whole feature's rule, extracted so it can be tested without a database and so that the service has one thing to call. Everything after this task depends on it.

**Files:**
- Create: `backend/src/core/authz/project-access.ts`
- Create: `backend/src/core/authz/project-access.spec.ts`

**Interfaces:**
- Consumes: `OrganizationRole`, `ROLE_RANK` from `backend/src/core/enums.ts`
- Produces:
  - `type ProjectAccessReason = 'role' | 'creator' | 'grant' | 'none'`
  - `interface ProjectAccessInput { role: OrganizationRole; userId: string; createdByUserId: string | null; hasGrant: boolean }`
  - `function decideProjectAccess(input: ProjectAccessInput): { allowed: boolean; reason: ProjectAccessReason }`
  - `const PROJECT_ACCESS_BYPASS_ROLE: OrganizationRole` (value `'admin'`)

- [ ] **Step 1: Write the failing test**

Create `backend/src/core/authz/project-access.spec.ts`:

```typescript
import { decideProjectAccess } from './project-access';

/**
 * The rule that decides whether a member may open a project (ADR-043).
 *
 * Extracted from the authorisation service so it can be asserted without a
 * database. Each test is one branch of the order the service applies them in,
 * and the order matters: a change that lets an ungranted developer through
 * fails here.
 */
describe('deciding project access', () => {
  const base = { userId: 'user-1', createdByUserId: null, hasGrant: false };

  it('lets an owner in without a grant', () => {
    expect(decideProjectAccess({ ...base, role: 'owner' })).toEqual({
      allowed: true,
      reason: 'role',
    });
  });

  it('lets an admin in without a grant', () => {
    expect(decideProjectAccess({ ...base, role: 'admin' })).toEqual({
      allowed: true,
      reason: 'role',
    });
  });

  it('lets the person who created the project in without a grant', () => {
    // Being locked out of your own project is a bug, not a policy.
    expect(
      decideProjectAccess({ ...base, role: 'developer', createdByUserId: 'user-1' }),
    ).toEqual({ allowed: true, reason: 'creator' });
  });

  it('lets a granted developer in', () => {
    expect(decideProjectAccess({ ...base, role: 'developer', hasGrant: true })).toEqual({
      allowed: true,
      reason: 'grant',
    });
  });

  it('lets a granted viewer in', () => {
    // A grant says "may open", not "may change": depth stays with the org role.
    expect(decideProjectAccess({ ...base, role: 'viewer', hasGrant: true })).toEqual({
      allowed: true,
      reason: 'grant',
    });
  });

  it('refuses an ungranted developer', () => {
    expect(decideProjectAccess({ ...base, role: 'developer' })).toEqual({
      allowed: false,
      reason: 'none',
    });
  });

  it('refuses an ungranted viewer', () => {
    expect(decideProjectAccess({ ...base, role: 'viewer' })).toEqual({
      allowed: false,
      reason: 'none',
    });
  });

  it('does not treat a null creator as matching a caller', () => {
    // createdByUserId is nullable (the creator's account may have been deleted).
    // A null must never equal a caller who also has no id in some future shape.
    expect(
      decideProjectAccess({ ...base, role: 'viewer', createdByUserId: null }),
    ).toEqual({ allowed: false, reason: 'none' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npx jest src/core/authz/project-access.spec.ts
```

Expected: FAIL — `Cannot find module './project-access'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/core/authz/project-access.ts`:

```typescript
import { ROLE_RANK, type OrganizationRole } from '../enums';

/**
 * Why a caller was let into a project, or why they were not (ADR-043).
 *
 * Carried back rather than discarded because the portal renders the difference:
 * an admin who is in by rank has no grant to revoke, and showing them a filled
 * checkbox that does nothing when cleared would read as a broken toggle.
 */
export type ProjectAccessReason = 'role' | 'creator' | 'grant' | 'none';

/** The organisation role from which a member reaches every project without a grant. */
export const PROJECT_ACCESS_BYPASS_ROLE: OrganizationRole = 'admin';

export interface ProjectAccessInput {
  /** The caller's role in the project's organisation, already resolved. */
  readonly role: OrganizationRole;
  readonly userId: string;
  /** `projects.created_by_user_id`; null once the creator's account is deleted. */
  readonly createdByUserId: string | null;
  /** Whether a `project_members` row exists for this (project, user). */
  readonly hasGrant: boolean;
}

/**
 * Whether a member of the organisation may open one of its projects.
 *
 * A pure function, and deliberately so: it is the whole of the rule, it is
 * asserted without a database, and the authorisation service's job is reduced to
 * fetching the four facts it takes.
 *
 * The order is the policy. Rank first, because an admin's access must not depend
 * on a query. Then the creator, so that making a project never locks you out of
 * it. Then the grant. Anything else is refused.
 */
export function decideProjectAccess(
  input: ProjectAccessInput,
): { allowed: boolean; reason: ProjectAccessReason } {
  if (ROLE_RANK[input.role] >= ROLE_RANK[PROJECT_ACCESS_BYPASS_ROLE]) {
    return { allowed: true, reason: 'role' };
  }

  if (input.createdByUserId !== null && input.createdByUserId === input.userId) {
    return { allowed: true, reason: 'creator' };
  }

  if (input.hasGrant) {
    return { allowed: true, reason: 'grant' };
  }

  return { allowed: false, reason: 'none' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && npx jest src/core/authz/project-access.spec.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Lint and typecheck**

```bash
cd backend && npm run lint && npm run typecheck
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/core/authz/project-access.ts backend/src/core/authz/project-access.spec.ts
git commit -m "feat(access): the project access rule, as a testable function (ADR-043)

Extracted rather than written inline in the authorisation service so the
policy can be asserted without a database, which is what every other test
in this repo does. The order is the policy: rank, then creator, then grant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema, enum and migration

The two tables, the status enumeration, and the backfill that means nobody loses access on the day this ships. No behaviour changes yet — the tables exist and are unread.

**Files:**
- Modify: `backend/src/core/enums.ts` (append near the other closed enumerations)
- Modify: `backend/src/core/database/schema.ts` (new tables after `projectDocuments`; relations near the existing `relations` block at ~line 733)
- Create: `backend/drizzle/0014_project_access.sql`
- Create: `backend/src/core/database/project-access-schema.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `PROJECT_ACCESS_REQUEST_STATUSES` and `type ProjectAccessRequestStatus` in `enums.ts`
  - `projectMembers` and `projectAccessRequests` table objects in `schema.ts`
  - `ProjectMemberRow` / `ProjectAccessRequestRow` inferred types

- [ ] **Step 1: Write the failing test**

Create `backend/src/core/database/project-access-schema.spec.ts`:

```typescript
import { PROJECT_ACCESS_REQUEST_STATUSES } from '../enums';
import { projectAccessRequests, projectMembers } from './schema';

/**
 * The shape of the access tables (ADR-043).
 *
 * A grant deliberately carries no role and no expiry: depth stays with the
 * organisation role, and a column added here would become a second source of
 * truth for it. These assertions fail if someone adds one.
 */
describe('project access tables', () => {
  it('declares a grant with no role and no expiry', () => {
    const columns = Object.keys(projectMembers);
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'projectId', 'userId', 'grantedByUserId']),
    );
    expect(columns).not.toContain('role');
    expect(columns).not.toContain('permissions');
    expect(columns).not.toContain('expiresAt');
  });

  it('keeps a decided request rather than only a pending one', () => {
    const columns = Object.keys(projectAccessRequests);
    expect(columns).toEqual(
      expect.arrayContaining([
        'projectId',
        'userId',
        'reason',
        'status',
        'decidedByUserId',
        'decidedAt',
        'decisionNote',
      ]),
    );
  });

  it('closes the request statuses', () => {
    expect([...PROJECT_ACCESS_REQUEST_STATUSES]).toEqual([
      'pending',
      'approved',
      'rejected',
      'cancelled',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npx jest src/core/database/project-access-schema.spec.ts
```

Expected: FAIL — `projectMembers` is not exported from `./schema`.

- [ ] **Step 3: Add the enumeration**

In `backend/src/core/enums.ts`, append after the `ORGANIZATION_ROLES` / `ROLE_RANK` block:

```typescript
/**
 * The lifecycle of a request for access to a project (ADR-043).
 *
 * A decided request is kept rather than deleted: "has this been asked before,
 * and what was said" is the question the queue exists to answer. `cancelled` is
 * the requester withdrawing their own ask, which is not the same as a refusal
 * and must not read as one.
 */
export const PROJECT_ACCESS_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type ProjectAccessRequestStatus = (typeof PROJECT_ACCESS_REQUEST_STATUSES)[number];
```

- [ ] **Step 4: Add the tables**

In `backend/src/core/database/schema.ts`, add `PROJECT_ACCESS_REQUEST_STATUSES` to the import from `../enums`, then add both tables after the `projectDocuments` table:

```typescript
/**
 * Who may open a project (ADR-043).
 *
 * The row is the whole grant: it carries no role, no permission set and no
 * expiry. What a person may do inside a project stays governed by their
 * organisation role, so that a single authorisation decision never has to choose
 * between two ranks for the same person.
 *
 * Owners and admins are absent by design — they reach every project by rank, and
 * a row for them would imply a revoke that would not work.
 */
export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for rows the migration backfilled: nobody decided them. */
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => ({
    grantUnique: uniqueIndex('project_members_project_user_unique').on(
      table.projectId,
      table.userId,
    ),
    // The project list asks "everything this user may open" on every page load.
    byUser: index('project_members_user_idx').on(table.userId),
  }),
);

/**
 * A request for access to a project, and what was decided (ADR-043).
 *
 * One pending request per (project, user) is enforced by a partial unique index
 * in the migration rather than by a read-then-write, for the reason ADR-029's
 * approval dedup was: two parallel requests can both read no pending row and
 * both insert, and the duplicate then sits in the queue forever.
 */
export const projectAccessRequests = pgTable(
  'project_access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Free text from the requester. Optional: a reason should not be a toll gate. */
    reason: text('reason'),
    status: text('status', { enum: asEnum(PROJECT_ACCESS_REQUEST_STATUSES) })
      .notNull()
      .default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Shown back to the requester, so a refusal can say why. */
    decisionNote: text('decision_note'),
    ...timestamps,
  },
  (table) => ({
    byProject: index('project_access_requests_project_idx').on(table.projectId),
    byUser: index('project_access_requests_user_idx').on(table.userId),
  }),
);
```

Then, next to the other `relations` declarations (~line 733):

```typescript
export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const projectAccessRequestsRelations = relations(projectAccessRequests, ({ one }) => ({
  project: one(projects, {
    fields: [projectAccessRequests.projectId],
    references: [projects.id],
  }),
  user: one(users, { fields: [projectAccessRequests.userId], references: [users.id] }),
}));
```

And with the other `$inferSelect` exports (~line 787):

```typescript
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type ProjectAccessRequestRow = typeof projectAccessRequests.$inferSelect;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && npx jest src/core/database/project-access-schema.spec.ts && npm run typecheck
```

Expected: PASS, 3 tests; typecheck clean.

- [ ] **Step 6: Write the migration by hand**

Create `backend/drizzle/0014_project_access.sql`:

```sql
-- Per-project access control (ADR-043).
--
-- Organisation membership was the only authorisation layer, so being in the
-- organisation was being in every project in it. These two tables add the
-- layer underneath it: a grant that says "may open this project", and a queue
-- for asking.

CREATE TABLE IF NOT EXISTS "project_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "granted_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_members_project_user_unique"
  ON "project_members" ("project_id", "user_id");
CREATE INDEX IF NOT EXISTS "project_members_user_idx"
  ON "project_members" ("user_id");

CREATE TABLE IF NOT EXISTS "project_access_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "reason" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "project_access_requests_project_idx"
  ON "project_access_requests" ("project_id");
CREATE INDEX IF NOT EXISTS "project_access_requests_user_idx"
  ON "project_access_requests" ("user_id");

-- One pending request per (project, user), as a fact of the schema rather than
-- of a read-modify-write. Two parallel requests can both see no pending row and
-- both insert; the duplicate then waits in the queue forever.
CREATE UNIQUE INDEX IF NOT EXISTS "project_access_requests_pending_unique"
  ON "project_access_requests" ("project_id", "user_id")
  WHERE "status" = 'pending';

-- Nobody loses access on the day this ships: every member who could open a
-- project yesterday is granted it explicitly. Owners and admins are excluded
-- because they reach every project by rank.
--
-- granted_by_user_id is left null: nobody decided these, and naming someone who
-- did not would be a false entry in the audit trail.
INSERT INTO "project_members" ("project_id", "user_id")
SELECT p."id", m."user_id"
  FROM "projects" p
  JOIN "organization_members" m ON m."organization_id" = p."organization_id"
 WHERE m."role" NOT IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
```

- [ ] **Step 7: Verify the migration applies and the backfill is right**

```bash
cd backend && npm run db:migrate
```

Expected: applies without error. Then check the backfill did what it claims — the count of grants must equal projects × non-admin members:

```bash
psql "$DATABASE_URL" -c "
  SELECT (SELECT count(*) FROM project_members) AS grants,
         (SELECT count(*) FROM projects p
            JOIN organization_members m ON m.organization_id = p.organization_id
           WHERE m.role NOT IN ('owner','admin')) AS expected;"
```

Expected: the two numbers match. On this deployment both may be `0` (a single owner account, no other members) — that is a pass, not a failure to investigate.

- [ ] **Step 8: Commit**

```bash
git add backend/src/core/enums.ts backend/src/core/database/schema.ts \
        backend/src/core/database/project-access-schema.spec.ts \
        backend/drizzle/0014_project_access.sql
git commit -m "feat(access): project_members and project_access_requests (ADR-043)

A grant carries nothing but 'may open this project' — no role, no expiry —
so depth stays with the organisation role and there is one source of truth
for it. One pending request per pair is a partial unique index rather than
a read-then-write, following 0007.

The backfill grants every existing member what they already had, so the
migration changes nobody's access on the day it runs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Enforcement in the authorisation service

The moment the feature becomes real. After this task an ungranted developer is refused, and the portal has not caught up yet — that is expected and is fixed in Tasks 5–8.

**Files:**
- Modify: `backend/src/core/authz/authorization.service.ts` (`requireProjectAccess`, ~line 110-145; `ProjectContext`, ~line 24)
- Modify: `backend/src/core/audit/audit-events.ts`

**Interfaces:**
- Consumes: `decideProjectAccess`, `ProjectAccessReason` (Task 1); `projectMembers` (Task 2)
- Produces: `ProjectContext.accessReason: ProjectAccessReason` and `ProjectContext.hasProjectGrant: boolean`, read by Task 4 and Task 6

- [ ] **Step 1: Add the audit events**

In `backend/src/core/audit/audit-events.ts`, after the `PROJECT_*` block:

```typescript
  /** A person was given, or had withdrawn, access to a single project (ADR-043). */
  PROJECT_ACCESS_GRANTED: 'project.access_granted',
  PROJECT_ACCESS_REVOKED: 'project.access_revoked',
  /** Somebody asked for access to a project they could not open, and what was decided. */
  PROJECT_ACCESS_REQUESTED: 'project.access_requested',
  PROJECT_ACCESS_DECIDED: 'project.access_decided',
```

- [ ] **Step 2: Extend `ProjectContext` and `requireProjectAccess`**

In `backend/src/core/authz/authorization.service.ts`:

Add to the imports:

```typescript
import { organizationMembers, projectMembers, projects } from '../database/schema';
import { decideProjectAccess, type ProjectAccessReason } from './project-access';
```

Extend the interface:

```typescript
export interface ProjectContext {
  readonly projectId: string;
  readonly organizationId: string;
  readonly membership: MembershipContext;
  readonly agentPermissions: Record<AgentPermission, boolean>;
  /**
   * Why this caller is allowed in (ADR-043): their rank, having created the
   * project, or an explicit grant. Carried so a caller that renders the
   * difference does not have to ask again.
   */
  readonly accessReason: ProjectAccessReason;
  readonly hasProjectGrant: boolean;
}
```

In `requireProjectAccess`, add `createdByUserId` to the existing select — the rule needs it and the query does not fetch it today:

```typescript
    const [project] = await this.database.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        agentPermissions: projects.agentPermissions,
        createdByUserId: projects.createdByUserId,
      })
      .from(projects)
      .where(scope)
      .limit(1);
```

Then, after the `requireOrganizationMember` call and before the return:

```typescript
    /**
     * Organisation membership is necessary but no longer sufficient (ADR-043).
     *
     * The grant is only read when the rule might need it: an admin is in by rank
     * and a creator by the row already fetched, so the common paths cost nothing.
     */
    const bypasses =
      ROLE_RANK[membership.role] >= ROLE_RANK[PROJECT_ACCESS_BYPASS_ROLE] ||
      project.createdByUserId === user.userId;

    const hasGrant = bypasses
      ? false
      : (
          await this.database.db
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, project.id),
                eq(projectMembers.userId, user.userId),
              ),
            )
            .limit(1)
        ).length > 0;

    const decision = decideProjectAccess({
      role: membership.role,
      userId: user.userId,
      createdByUserId: project.createdByUserId,
      hasGrant,
    });

    if (!decision.allowed) {
      await this.recordDenial(
        user,
        project.organizationId,
        project.id,
        'no grant for this project',
      );
      /**
       * Forbidden, not NotFound — deliberately unlike the organisation refusal
       * above, which hides an organisation's existence from a non-member. A
       * project's existence is published in the list on purpose, so hiding it
       * here would conceal nothing and would leave the portal's "Request access"
       * button with nothing to point at.
       */
      throw new ForbiddenException(
        'You do not have access to this project. You can request access from the projects list.',
      );
    }

    return {
      projectId: project.id,
      organizationId: project.organizationId,
      membership,
      agentPermissions: resolveAgentPermissions(project.agentPermissions),
      accessReason: decision.reason,
      hasProjectGrant: decision.reason === 'grant',
    };
```

Add `PROJECT_ACCESS_BYPASS_ROLE` to the `./project-access` import.

- [ ] **Step 3: Typecheck — this is the real test of the change**

```bash
cd backend && npm run typecheck && npm run lint
```

Expected: clean. A failure here naming `accessReason` means a construction site of `ProjectContext` was missed; fix it rather than loosening the type.

- [ ] **Step 4: Run the whole suite**

```bash
cd backend && npm test
```

Expected: everything passes, including Task 1's and Task 2's. No existing test constructs a `ProjectContext`, so nothing should break; if something does, that is a genuine regression — read it, do not silence it.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/authz/authorization.service.ts backend/src/core/audit/audit-events.ts
git commit -m "feat(access): enforce per-project grants in requireProjectAccess (ADR-043)

Enforcement sits at the single decision point all 28 call sites already
pass through, because one forgotten call site would be a silent hole. The
grant query is skipped for callers who are in by rank or by having created
the project, so the common paths cost nothing.

Refused with 403 rather than 404: the project's existence is published in
the list on purpose, so hiding it here would conceal nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The list tells you what you cannot open

Locked projects stay in the list, without the fields that would make "locked" cosmetic.

**Files:**
- Modify: `backend/src/modules/projects/projects.service.ts` (`list`, line 234-264)
- Create: `backend/src/modules/projects/project-access-list.spec.ts`
- Modify: `frontend/lib/types.ts` (`ProjectSummary`, line 73-86)

**Interfaces:**
- Consumes: `decideProjectAccess` (Task 1), `projectMembers`, `projectAccessRequests` (Task 2)
- Produces: `redactLockedProject(row, hasAccess)` exported from `projects.service.ts` for the test; `ProjectSummary.hasAccess` and `.accessRequestStatus` consumed by Task 7

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/projects/project-access-list.spec.ts`:

```typescript
import { redactLockedProject } from './projects.service';

/**
 * What a locked project shows in the list (ADR-043).
 *
 * The point of the redaction is that "locked" is a boundary and not a colour in
 * the UI. If the repository URL and the task counts are sent anyway, the data is
 * already in the browser and the padlock is decoration.
 */
describe('a locked project in the list', () => {
  const row = {
    id: 'p1',
    name: 'Finance rollout',
    description: 'Client X migration',
    projectType: 'odoo_sh' as const,
    odooVersion: '17.0',
    defaultBranch: 'main',
    repositoryUrl: 'git@github.com:client/private.git',
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    taskCount: 12,
    openTaskCount: 3,
  };

  it('withholds the repository URL, description and task counts', () => {
    const locked = redactLockedProject(row, false);

    expect(locked.repositoryUrl).toBeNull();
    expect(locked.description).toBeNull();
    expect(locked.taskCount).toBeNull();
    expect(locked.openTaskCount).toBeNull();
  });

  it('keeps enough to render the row', () => {
    const locked = redactLockedProject(row, false);

    expect(locked.name).toBe('Finance rollout');
    expect(locked.projectType).toBe('odoo_sh');
    expect(locked.odooVersion).toBe('17.0');
    expect(locked.hasAccess).toBe(false);
  });

  it('changes nothing for a project the caller may open', () => {
    const open = redactLockedProject(row, true);

    expect(open.repositoryUrl).toBe('git@github.com:client/private.git');
    expect(open.taskCount).toBe(12);
    expect(open.hasAccess).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npx jest src/modules/projects/project-access-list.spec.ts
```

Expected: FAIL — `redactLockedProject` is not exported.

- [ ] **Step 3: Implement the redaction and rewrite `list`**

In `backend/src/modules/projects/projects.service.ts`, add to the schema import: `projectAccessRequests, projectMembers`. Add `inArray` to the `drizzle-orm` import if absent.

Above the class, add the exported helper:

```typescript
/**
 * A project row as the list returns it, with the fields a locked row withholds.
 *
 * Exported and pure so the redaction can be asserted without a database — it is
 * the part of this feature most likely to be quietly undone by someone adding a
 * field to the select.
 */
export function redactLockedProject<
  T extends {
    description: string | null;
    repositoryUrl: string | null;
    taskCount: number;
    openTaskCount: number;
  },
>(row: T, hasAccess: boolean) {
  if (hasAccess) {
    return { ...row, hasAccess: true };
  }

  return {
    ...row,
    description: null,
    repositoryUrl: null,
    taskCount: null,
    openTaskCount: null,
    hasAccess: false,
  };
}
```

Replace the body of `list` (keep the signature and the `requireOrganizationMember` call):

```typescript
  async list(user: AuthenticatedUser, query: ListProjectsQueryDto) {
    const membership = await this.authz.requireOrganizationMember(user, query.organizationId);

    const where = query.includeArchived
      ? eq(projects.organizationId, query.organizationId)
      : and(eq(projects.organizationId, query.organizationId), isNull(projects.archivedAt));

    const rows = await this.database.db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        projectType: projects.projectType,
        odooVersion: projects.odooVersion,
        defaultBranch: projects.defaultBranch,
        repositoryUrl: projects.repositoryUrl,
        archivedAt: projects.archivedAt,
        createdByUserId: projects.createdByUserId,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        taskCount: sql<number>`(
          select count(*)::int from agent_tasks t where t.project_id = ${projects.id}
        )`,
        openTaskCount: sql<number>`(
          select count(*)::int from agent_tasks t
          where t.project_id = ${projects.id}
            and t.status not in ('completed', 'failed', 'cancelled')
        )`,
      })
      .from(projects)
      .where(where)
      .orderBy(desc(projects.updatedAt));

    /**
     * Every project in the organisation is listed, including the ones this
     * caller cannot open (ADR-043). What is withheld is access, not existence —
     * so the two lookups below are read once for the whole page rather than once
     * per row.
     */
    const projectIds = rows.map((row) => row.id);

    const grantedIds = new Set(
      projectIds.length === 0
        ? []
        : (
            await this.database.db
              .select({ projectId: projectMembers.projectId })
              .from(projectMembers)
              .where(
                and(
                  eq(projectMembers.userId, user.userId),
                  inArray(projectMembers.projectId, projectIds),
                ),
              )
          ).map((row) => row.projectId),
    );

    // Only a request that still tells the portal something is worth fetching: a
    // pending one ("awaiting approval") or a rejected one (which shows the note
    // and allows asking again). An approved one is indistinguishable from the
    // grant it produced.
    const requestStatuses = new Map<string, 'pending' | 'rejected'>(
      projectIds.length === 0
        ? []
        : (
            await this.database.db
              .select({
                projectId: projectAccessRequests.projectId,
                status: projectAccessRequests.status,
              })
              .from(projectAccessRequests)
              .where(
                and(
                  eq(projectAccessRequests.userId, user.userId),
                  inArray(projectAccessRequests.projectId, projectIds),
                  inArray(projectAccessRequests.status, ['pending', 'rejected']),
                ),
              )
              .orderBy(desc(projectAccessRequests.createdAt))
          ).map((row) => [row.projectId, row.status as 'pending' | 'rejected']),
    );

    return rows.map(({ createdByUserId, ...row }) => {
      const decision = decideProjectAccess({
        role: membership.role,
        userId: user.userId,
        createdByUserId,
        hasGrant: grantedIds.has(row.id),
      });

      return {
        ...redactLockedProject(row, decision.allowed),
        accessRequestStatus: decision.allowed ? null : requestStatuses.get(row.id) ?? null,
      };
    });
  }
```

Import `decideProjectAccess` from `../../core/authz/project-access`.

Note on the `Map` construction: rows arrive newest first, and a later `set` for the same key wins, so build it from the *reversed* list if you want newest-wins. Simpler and equivalent here: the pending index makes at most one pending row possible per pair, and a rejected row only shows when there is no pending one. Leave as written.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && npx jest src/modules/projects/project-access-list.spec.ts && npm run typecheck && npm run lint
```

Expected: PASS, 3 tests; typecheck and lint clean.

- [ ] **Step 5: Update the portal's type**

In `frontend/lib/types.ts`, replace the `ProjectSummary` interface:

```typescript
export interface ProjectSummary {
  id: string;
  name: string;
  /** Null when the caller cannot open the project (ADR-043). */
  description: string | null;
  projectType: ProjectType;
  odooVersion: string | null;
  defaultBranch: string;
  /** Null when the caller cannot open the project. */
  repositoryUrl: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null when the caller cannot open the project. */
  taskCount: number | null;
  openTaskCount: number | null;
  /** Whether this caller may open the project at all. */
  hasAccess: boolean;
  /** Their standing request, when they have one worth showing. */
  accessRequestStatus: 'pending' | 'rejected' | null;
}
```

- [ ] **Step 6: Typecheck the portal — expect failures, they are the work list**

```bash
cd frontend && npx tsc --noEmit
```

Expected: errors wherever `taskCount` etc. are used as non-null. Record them; Task 7 fixes them. Do not fix them here and do not loosen the type to silence them.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/projects/projects.service.ts \
        backend/src/modules/projects/project-access-list.spec.ts \
        frontend/lib/types.ts
git commit -m "feat(access): the list shows locked projects without their detail (ADR-043)

Every project in the organisation stays in the list — what is withheld is
access, not existence. A locked row loses its repository URL, description
and task counts, because sending them anyway would make 'locked' a colour
in the UI rather than a boundary.

Grants and standing requests are read once for the page, not once per row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The access module — grants and requests

**Files:**
- Create: `backend/src/modules/project-access/project-access.service.ts`
- Create: `backend/src/modules/project-access/project-access.controller.ts`
- Create: `backend/src/modules/project-access/project-access.module.ts`
- Create: `backend/src/modules/project-access/dto/project-access.dto.ts`
- Create: `backend/src/modules/project-access/project-access.spec.ts`
- Modify: `backend/src/app.module.ts`

**Interfaces:**
- Consumes: `AuthorizationService`, `DatabaseService`, `AuditService`, `projectMembers`, `projectAccessRequests`
- Produces: the six endpoints in the spec's API table; `describeProjectAccess(role, isCreator, hasGrant)` exported for the test and used by the members endpoint

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/project-access/project-access.spec.ts`:

```typescript
import { describeProjectAccess } from './project-access.service';

/**
 * How the project access panel describes each organisation member (ADR-043).
 *
 * The distinction that matters is revocable versus not: an admin is in by rank,
 * so rendering them a filled checkbox would promise a revoke that would do
 * nothing when cleared.
 */
describe('describing a member access on the panel', () => {
  it('marks an owner as in by role, with nothing to revoke', () => {
    expect(describeProjectAccess('owner', false, false)).toEqual({
      hasAccess: true,
      source: 'role',
      revocable: false,
    });
  });

  it('marks an admin as in by role, with nothing to revoke', () => {
    expect(describeProjectAccess('admin', false, false)).toEqual({
      hasAccess: true,
      source: 'role',
      revocable: false,
    });
  });

  it('marks the creator as in by creation, with nothing to revoke', () => {
    expect(describeProjectAccess('developer', true, false)).toEqual({
      hasAccess: true,
      source: 'creator',
      revocable: false,
    });
  });

  it('marks a granted developer as revocable', () => {
    expect(describeProjectAccess('developer', false, true)).toEqual({
      hasAccess: true,
      source: 'grant',
      revocable: true,
    });
  });

  it('marks an ungranted viewer as having no access', () => {
    expect(describeProjectAccess('viewer', false, false)).toEqual({
      hasAccess: false,
      source: 'none',
      revocable: false,
    });
  });

  it('does not offer a revoke for a creator who also holds a grant', () => {
    // Revoking would leave them with access anyway, via the creator rule. A
    // toggle that does not change the outcome is worse than no toggle.
    expect(describeProjectAccess('developer', true, true)).toEqual({
      hasAccess: true,
      source: 'creator',
      revocable: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npx jest src/modules/project-access/project-access.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the DTOs**

Create `backend/src/modules/project-access/dto/project-access.dto.ts`:

```typescript
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class GrantProjectAccessDto {
  @IsUUID('4', { message: 'A user id is required' })
  userId!: string;
}

export class RequestProjectAccessDto {
  /** Optional: asking for a reason as a condition would just produce empty ones. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  reason?: string;
}

export class DecideAccessRequestDto {
  @IsIn(['approved', 'rejected'], {
    message: 'decision must be approved or rejected',
  })
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  note?: string;
}
```

- [ ] **Step 4: Write the service**

Create `backend/src/modules/project-access/project-access.service.ts`:

```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import {
  organizationMembers,
  projectAccessRequests,
  projectMembers,
  projects,
  users,
} from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { PROJECT_ACCESS_BYPASS_ROLE } from '../../core/authz/project-access';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { ROLE_RANK, type OrganizationRole } from '../../core/enums';
import type {
  DecideAccessRequestDto,
  GrantProjectAccessDto,
  RequestProjectAccessDto,
} from './dto/project-access.dto';

/** How a member reaches a project, and whether that can be taken away. */
export interface ProjectAccessDescription {
  readonly hasAccess: boolean;
  readonly source: 'role' | 'creator' | 'grant' | 'none';
  readonly revocable: boolean;
}

/**
 * How the panel should describe one member's standing on one project (ADR-043).
 *
 * Pure, and exported, because the distinction it draws is the one the UI gets
 * wrong if left to infer: only a grant is revocable. Rank and authorship are
 * not, and offering a toggle for them would promise something clearing it
 * cannot deliver.
 */
export function describeProjectAccess(
  role: OrganizationRole,
  isCreator: boolean,
  hasGrant: boolean,
): ProjectAccessDescription {
  if (ROLE_RANK[role] >= ROLE_RANK[PROJECT_ACCESS_BYPASS_ROLE]) {
    return { hasAccess: true, source: 'role', revocable: false };
  }

  if (isCreator) {
    return { hasAccess: true, source: 'creator', revocable: false };
  }

  if (hasGrant) {
    return { hasAccess: true, source: 'grant', revocable: true };
  }

  return { hasAccess: false, source: 'none', revocable: false };
}

/**
 * Granting, revoking and deciding access to a single project (ADR-043).
 *
 * Separate from ProjectsService, which is already large and answers a different
 * question. Everything here resolves authority through AuthorizationService
 * rather than reading roles itself.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every member of the organisation with their standing on this project.
   *
   * Not only the granted rows: the panel's question is "who can open this", and
   * an admin missing from the list while being able to open it would read as a
   * bug in the panel rather than as the rank rule working.
   */
  async listMembers(user: AuthenticatedUser, projectId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    const [project] = await this.database.db
      .select({ createdByUserId: projects.createdByUserId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const members = await this.database.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, context.organizationId))
      .orderBy(users.name);

    const granted = new Set(
      (
        await this.database.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(eq(projectMembers.projectId, projectId))
      ).map((row) => row.userId),
    );

    return members.map((member) => ({
      ...member,
      ...describeProjectAccess(
        member.role as OrganizationRole,
        project?.createdByUserId === member.userId,
        granted.has(member.userId),
      ),
    }));
  }

  /** Give a member access to this project. Idempotent. */
  async grant(user: AuthenticatedUser, projectId: string, dto: GrantProjectAccessDto) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    await this.assertOrganizationMember(context.organizationId, dto.userId);

    await this.database.db
      .insert(projectMembers)
      .values({
        projectId,
        userId: dto.userId,
        grantedByUserId: user.userId,
      })
      .onConflictDoNothing();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_GRANTED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { grantedUserId: dto.userId },
    });

    return { granted: true };
  }

  /** Withdraw a grant. Leaves access that comes from rank or authorship alone. */
  async revoke(user: AuthenticatedUser, projectId: string, memberUserId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    await this.database.db
      .delete(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, memberUserId)),
      );

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_REVOKED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { revokedUserId: memberUserId },
    });

    return { revoked: true };
  }

  /**
   * Ask for access to a project you cannot open.
   *
   * Authority is resolved through requireOrganizationMember rather than
   * requireProjectAccess: a person who could already open the project has
   * nothing to ask for, and a person who cannot must still be able to ask.
   */
  async request(user: AuthenticatedUser, projectId: string, dto: RequestProjectAccessDto) {
    const [project] = await this.database.db
      .select({ id: projects.id, organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Membership of the project's organisation, so a request cannot be aimed at
    // a project in an organisation the caller has nothing to do with.
    await this.authz.requireOrganizationMember(user, project.organizationId);

    const [existing] = await this.database.db
      .select({ id: projectAccessRequests.id })
      .from(projectAccessRequests)
      .where(
        and(
          eq(projectAccessRequests.projectId, projectId),
          eq(projectAccessRequests.userId, user.userId),
          eq(projectAccessRequests.status, 'pending'),
        ),
      )
      .limit(1);

    if (existing) {
      throw new BadRequestException('You already have a pending request for this project.');
    }

    const [row] = await this.database.db
      .insert(projectAccessRequests)
      .values({
        projectId,
        userId: user.userId,
        reason: dto.reason ?? null,
        status: 'pending',
      })
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_REQUESTED,
      organizationId: project.organizationId,
      projectId,
      userId: user.userId,
      metadata: { requestId: row.id },
    });

    return row;
  }

  /** Every pending request across the organisation's projects. */
  async listPending(user: AuthenticatedUser, organizationId: string) {
    await this.authz.requireOrganizationMember(user, organizationId, 'admin');

    return this.database.db
      .select({
        id: projectAccessRequests.id,
        projectId: projectAccessRequests.projectId,
        projectName: projects.name,
        userId: projectAccessRequests.userId,
        userName: users.name,
        userEmail: users.email,
        reason: projectAccessRequests.reason,
        createdAt: projectAccessRequests.createdAt,
      })
      .from(projectAccessRequests)
      .innerJoin(projects, eq(projects.id, projectAccessRequests.projectId))
      .innerJoin(users, eq(users.id, projectAccessRequests.userId))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          eq(projectAccessRequests.status, 'pending'),
        ),
      )
      .orderBy(desc(projectAccessRequests.createdAt));
  }

  /**
   * Approve or reject a request.
   *
   * The decision and the grant are written in one transaction. Two statements
   * would allow a request that reads `approved` with no grant behind it, which
   * nobody would notice until the requester said so.
   */
  async decide(
    user: AuthenticatedUser,
    projectId: string,
    requestId: string,
    dto: DecideAccessRequestDto,
  ) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    const [request] = await this.database.db
      .select({
        id: projectAccessRequests.id,
        userId: projectAccessRequests.userId,
        status: projectAccessRequests.status,
      })
      .from(projectAccessRequests)
      .where(
        and(
          eq(projectAccessRequests.id, requestId),
          eq(projectAccessRequests.projectId, projectId),
        ),
      )
      .limit(1);

    if (!request) {
      throw new NotFoundException('Access request not found');
    }

    if (request.status !== 'pending') {
      throw new BadRequestException(`This request was already ${request.status}.`);
    }

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(projectAccessRequests)
        .set({
          status: dto.decision,
          decidedByUserId: user.userId,
          decidedAt: new Date(),
          decisionNote: dto.note ?? null,
          updatedAt: new Date(),
        })
        .where(eq(projectAccessRequests.id, requestId));

      if (dto.decision === 'approved') {
        await tx
          .insert(projectMembers)
          .values({
            projectId,
            userId: request.userId,
            grantedByUserId: user.userId,
          })
          .onConflictDoNothing();
      }
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ACCESS_DECIDED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { requestId, decision: dto.decision, requesterUserId: request.userId },
    });

    return { decision: dto.decision };
  }

  private async assertOrganizationMember(organizationId: string, userId: string): Promise<void> {
    const [member] = await this.database.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!member) {
      throw new BadRequestException(
        'That person is not a member of this organisation. Add them to the organisation first.',
      );
    }
  }
}
```

- [ ] **Step 5: Write the controller and module**

Create `backend/src/modules/project-access/project-access.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ProjectAccessService } from './project-access.service';
import {
  DecideAccessRequestDto,
  GrantProjectAccessDto,
  RequestProjectAccessDto,
} from './dto/project-access.dto';
import { CurrentUser } from '../../core/http/current-user.decorator';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';

/** Who may open a project, and how to ask (ADR-043). */
@Controller()
export class ProjectAccessController {
  constructor(private readonly access: ProjectAccessService) {}

  @Get('projects/:projectId/members')
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.access.listMembers(user, projectId);
  }

  @Post('projects/:projectId/members')
  @HttpCode(HttpStatus.CREATED)
  grant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: GrantProjectAccessDto,
  ) {
    return this.access.grant(user, projectId, dto);
  }

  @Delete('projects/:projectId/members/:memberUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
  ) {
    await this.access.revoke(user, projectId, memberUserId);
  }

  @Post('projects/:projectId/access-requests')
  @HttpCode(HttpStatus.CREATED)
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RequestProjectAccessDto,
  ) {
    return this.access.request(user, projectId, dto);
  }

  @Patch('projects/:projectId/access-requests/:requestId')
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecideAccessRequestDto,
  ) {
    return this.access.decide(user, projectId, requestId, dto);
  }

  @Get('organizations/:organizationId/access-requests')
  listPending(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.access.listPending(user, organizationId);
  }
}
```

Create `backend/src/modules/project-access/project-access.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ProjectAccessController } from './project-access.controller';
import { ProjectAccessService } from './project-access.service';

@Module({
  controllers: [ProjectAccessController],
  providers: [ProjectAccessService],
  exports: [ProjectAccessService],
})
export class ProjectAccessModule {}
```

In `backend/src/app.module.ts`, import it and add `ProjectAccessModule` to `imports`, after `ProjectsModule`.

- [ ] **Step 6: Run the test and the suite**

```bash
cd backend && npx jest src/modules/project-access/project-access.spec.ts && npm test && npm run typecheck && npm run lint
```

Expected: 6 new tests pass, whole suite green, typecheck and lint clean.

- [ ] **Step 7: Verify the routes are actually mounted**

```bash
cd backend && npm run start:dev
```

In another shell, confirm Nest logged the six routes:

```bash
grep -E "projects/:projectId/members|access-requests" /dev/stdout
```

Simpler: read the startup log for `Mapped {/api/v1/projects/:projectId/members, GET}` and the other five. Stop the server afterwards. A route that is not mapped is the failure this step exists to catch.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/project-access backend/src/app.module.ts
git commit -m "feat(access): grant, revoke and request endpoints (ADR-043)

A module of its own rather than more surface on ProjectsService, which is
already large and answers a different question.

Approving writes the decision and the grant in one transaction, so there
is no state where a request reads approved and no grant exists. The
request endpoints resolve authority through the organisation, because a
person who cannot open the project must still be able to ask.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Portal API client

**Files:**
- Modify: `frontend/lib/api.ts` (add to the `projects` object; add a new `access` object)
- Modify: `frontend/lib/types.ts`

**Interfaces:**
- Consumes: the endpoints from Task 5
- Produces: `api.access.*` and the types `ProjectAccessMember`, `PendingAccessRequest`, consumed by Tasks 7 and 8

- [ ] **Step 1: Add the types**

In `frontend/lib/types.ts`, after `ProjectSummary`:

```typescript
/** A member of the organisation, as the project access panel sees them (ADR-043). */
export interface ProjectAccessMember {
  userId: string;
  email: string;
  name: string;
  role: OrganizationRole;
  hasAccess: boolean;
  /** Where the access comes from: their rank, having created it, or a grant. */
  source: 'role' | 'creator' | 'grant' | 'none';
  /** Only a grant can be taken away. Rank and authorship cannot. */
  revocable: boolean;
}

export interface PendingAccessRequest {
  id: string;
  projectId: string;
  projectName: string;
  userId: string;
  userName: string;
  userEmail: string;
  reason: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Add the client methods**

In `frontend/lib/api.ts`, add a new top-level `access` object beside `projects`:

```typescript
  /** Per-project access: who may open a project, and requests to (ADR-043). */
  access: {
    members: (projectId: string) =>
      request<ProjectAccessMember[]>(`/projects/${projectId}/members`),

    grant: (projectId: string, userId: string) =>
      request<{ granted: boolean }>(`/projects/${projectId}/members`, {
        method: 'POST',
        body: { userId },
      }),

    revoke: (projectId: string, userId: string) =>
      request<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

    requestAccess: (projectId: string, reason?: string) =>
      request<{ id: string }>(`/projects/${projectId}/access-requests`, {
        method: 'POST',
        body: { reason },
      }),

    pendingRequests: (organizationId: string) =>
      request<PendingAccessRequest[]>(`/organizations/${organizationId}/access-requests`),

    decide: (
      projectId: string,
      requestId: string,
      decision: 'approved' | 'rejected',
      note?: string,
    ) =>
      request<{ decision: string }>(`/projects/${projectId}/access-requests/${requestId}`, {
        method: 'PATCH',
        body: { decision, note },
      }),
  },
```

Add `ProjectAccessMember` and `PendingAccessRequest` to the type imports at the top of the file.

- [ ] **Step 3: Typecheck**

```bash
cd frontend && npx tsc --noEmit
```

Expected: the Task 4 errors about nullable `taskCount` remain (Task 7 fixes them). No *new* errors from this task.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/api.ts frontend/lib/types.ts
git commit -m "feat(access): portal client for the access endpoints (ADR-043)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Locked cards and the request button

Clears the typecheck errors Task 4 introduced, which is how you know this task is complete.

**Files:**
- Modify: `frontend/app/projects/page.tsx`

**Interfaces:**
- Consumes: `ProjectSummary.hasAccess` / `.accessRequestStatus` (Task 4), `api.access.requestAccess` (Task 6)
- Produces: nothing consumed later

- [ ] **Step 1: See exactly what is broken**

```bash
cd frontend && npx tsc --noEmit
```

Record every error in `app/projects/page.tsx`. These are the places that assume a project's detail is always present, and each is a place a locked card must render differently.

- [ ] **Step 2: Render a locked card**

In `frontend/app/projects/page.tsx`, where the card is currently wrapped in `<Link href={...}>`, branch on `project.hasAccess`. Keep the card's existing classes so a locked card sits in the same grid; add `opacity-60` and a padlock beside the name.

```tsx
{projects.map((project) =>
  project.hasAccess ? (
    <Link key={project.id} href={`/projects/${project.id}`} className={CARD_CLASSES}>
      {renderCardBody(project)}
    </Link>
  ) : (
    /*
     * Not a link that refuses — not a link (ADR-043). The project stays in the
     * list because what is withheld is access, not existence, but a card that
     * navigated to a 403 would be a worse way to learn that.
     */
    <div key={project.id} className={`${CARD_CLASSES} opacity-60`}>
      {renderCardBody(project)}
      <AccessRequestButton
        projectId={project.id}
        status={project.accessRequestStatus}
        onRequested={load}
      />
    </div>
  ),
)}
```

Extract the existing card body into `renderCardBody`, and inside it guard the fields the API now withholds:

```tsx
{project.hasAccess ? (
  <span className="text-2xs text-muted">
    {project.taskCount} tasks · {project.openTaskCount} open
  </span>
) : (
  <span className="text-2xs text-muted">Access required</span>
)}
```

Do the same for `description` and `repositoryUrl` wherever the page renders them.

- [ ] **Step 3: Add the request button**

In the same file, below the page component:

```tsx
/**
 * Ask for access to a project in the list (ADR-043).
 *
 * The reason is optional — requiring one would mostly produce empty ones — and
 * a rejected request can be made again, because circumstances change and a
 * refusal is not a ban.
 */
function AccessRequestButton({
  projectId,
  status,
  onRequested,
}: {
  projectId: string;
  status: 'pending' | 'rejected' | null;
  onRequested: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'pending') {
    return <span className="text-2xs text-muted">Awaiting approval</span>;
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.access.requestAccess(projectId, reason.trim() || undefined);
      setOpen(false);
      setReason('');
      onRequested();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The request could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="text-2xs underline" onClick={() => setOpen(true)}>
        {status === 'rejected' ? 'Request again' : 'Request access'}
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why do you need access? (optional)"
        rows={2}
        className="w-full rounded border px-2 py-1 text-2xs"
      />
      {error ? <p className="text-2xs text-state-failure">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={submit} className="text-2xs underline">
          {busy ? 'Sending…' : 'Send request'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-2xs text-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}
```

Add `ApiError` to the `@/lib/api` import.

Match the existing class names in this file rather than the ones above if they differ — `text-2xs`, `text-muted` and `text-state-failure` are taken from sibling components and may not be what this page uses.

- [ ] **Step 3b: Check the classes you just used actually exist**

```bash
cd frontend && grep -rn "text-2xs\|text-state-failure\|text-muted" app/projects/page.tsx components/ui/alert.tsx tailwind.config.ts | head
```

Expected: each class appears somewhere in the codebase or in the Tailwind config. A class that exists nowhere renders as nothing and the card silently loses its styling — replace it with the nearest one this page already uses.

- [ ] **Step 4: Typecheck — this is the test**

```bash
cd frontend && npx tsc --noEmit
```

Expected: clean. Every error Task 4 introduced is now handled.

- [ ] **Step 5: Look at it**

```bash
cd backend && npm run start:dev    # one shell
cd frontend && npm run dev          # another
```

Open `/projects` as the owner: every card is a link, nothing is dimmed, no padlocks. That is the correct appearance for an owner and does not prove the locked path — Task 9 proves that end to end.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/projects/page.tsx
git commit -m "feat(access): locked project cards and a request button (ADR-043)

A locked card keeps its place in the list and loses its link — not a link
that refuses, not a link. The detail the API now withholds is replaced by
the way to ask for it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The two owner panels

**Files:**
- Create: `frontend/components/projects/project-access-panel.tsx`
- Create: `frontend/components/organizations/access-requests-panel.tsx`
- Modify: `frontend/app/projects/[projectId]/settings/page.tsx`
- Modify: `frontend/app/settings/page.tsx`

**Interfaces:**
- Consumes: `api.access.*`, `ProjectAccessMember`, `PendingAccessRequest` (Task 6)
- Produces: nothing consumed later

- [ ] **Step 1: Write the project access panel**

Create `frontend/components/projects/project-access-panel.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import type { ProjectAccessMember } from '@/lib/types';

/**
 * Who may open this project (ADR-043).
 *
 * Every member of the organisation is listed, not only the granted ones: the
 * question is "who can open this", and an admin missing from the list while
 * being able to open it would read as a bug rather than as the rank rule.
 *
 * Members who are in by rank or by having created the project get a label and no
 * toggle, because clearing a toggle that cannot revoke anything is a promise the
 * panel cannot keep.
 */
const SOURCE_LABEL: Record<ProjectAccessMember['source'], string> = {
  role: 'By role',
  creator: 'Created it',
  grant: 'Granted',
  none: 'No access',
};

export function ProjectAccessPanel({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<ProjectAccessMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMembers(await api.access.members(projectId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Access could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (member: ProjectAccessMember) => {
    setBusyUserId(member.userId);
    setError(null);
    try {
      if (member.source === 'grant') {
        await api.access.revoke(projectId, member.userId);
      } else {
        await api.access.grant(projectId, member.userId);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The change could not be saved.');
    } finally {
      setBusyUserId(null);
    }
  };

  if (!members) return <Spinner />;

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-sm font-medium">Project access</h2>
        <p className="text-2xs text-muted">
          Owners and admins reach every project. Everyone else needs to be given access here.
        </p>
      </header>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <ul className="divide-y">
        {members.map((member) => (
          <li key={member.userId} className="flex items-center justify-between py-2">
            <div>
              <p className="text-xs">{member.name}</p>
              <p className="text-2xs text-muted">
                {member.email} · {member.role}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-2xs text-muted">{SOURCE_LABEL[member.source]}</span>
              {member.revocable || member.source === 'none' ? (
                <button
                  type="button"
                  disabled={busyUserId === member.userId}
                  onClick={() => void toggle(member)}
                  className="text-2xs underline"
                >
                  {busyUserId === member.userId
                    ? 'Saving…'
                    : member.source === 'grant'
                      ? 'Revoke'
                      : 'Grant'}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Write the request queue panel**

Create `frontend/components/organizations/access-requests-panel.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { relativeTime } from '@/lib/format';
import type { PendingAccessRequest } from '@/lib/types';

/**
 * People waiting for access to a project (ADR-043).
 *
 * One list across every project, because the person deciding opens this page to
 * ask "is anyone waiting", not to audit a particular project.
 *
 * There is no notification behind this panel deliberately: one organisation, few
 * people, and a request that waits an hour costs nothing. The count here is the
 * whole mechanism until a request is seen getting stuck.
 */
export function AccessRequestsPanel({ organizationId }: { organizationId: string }) {
  const [requests, setRequests] = useState<PendingAccessRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await api.access.pendingRequests(organizationId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Requests could not be loaded.');
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (row: PendingAccessRequest, decision: 'approved' | 'rejected') => {
    setBusyId(row.id);
    setError(null);
    try {
      await api.access.decide(row.projectId, row.id, decision);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The decision could not be saved.');
    } finally {
      setBusyId(null);
    }
  };

  if (!requests) return null;

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-sm font-medium">
          Access requests{requests.length > 0 ? ` (${requests.length})` : ''}
        </h2>
      </header>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {requests.length === 0 ? (
        <p className="text-2xs text-muted">Nobody is waiting for access.</p>
      ) : (
        <ul className="divide-y">
          {requests.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-4 py-2">
              <div>
                <p className="text-xs">
                  {row.userName} · {row.projectName}
                </p>
                <p className="text-2xs text-muted">
                  {row.userEmail} · {relativeTime(row.createdAt)}
                </p>
                {row.reason ? <p className="mt-1 text-2xs">{row.reason}</p> : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busyId === row.id}
                  onClick={() => void decide(row, 'approved')}
                  className="text-2xs underline"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busyId === row.id}
                  onClick={() => void decide(row, 'rejected')}
                  className="text-2xs text-muted underline"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Mount both panels**

In `frontend/app/projects/[projectId]/settings/page.tsx`, import `ProjectAccessPanel` and render it beside the other panels (the page stacks panels; it has no tabs), guarded by role:

```tsx
{organization?.role === 'owner' || organization?.role === 'admin' ? (
  <ProjectAccessPanel projectId={projectId} />
) : null}
```

Use whatever the page already calls the viewer's role — read the file first; `useRequireAuth()` is the hook the other pages use.

In `frontend/app/settings/page.tsx`, import `AccessRequestsPanel` and render it directly after `<MembersPanel …/>`, with the same organisation id and the same role guard.

- [ ] **Step 4: Typecheck and lint**

```bash
cd frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/projects/project-access-panel.tsx \
        frontend/components/organizations/access-requests-panel.tsx \
        frontend/app/projects/\[projectId\]/settings/page.tsx \
        frontend/app/settings/page.tsx
git commit -m "feat(access): owner panels for granting access and deciding requests (ADR-043)

Both follow members-panel.tsx: the server owns every rule, the client
renders the refusal. Members who are in by rank get a label and no toggle,
because clearing one would promise a revoke it cannot deliver.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Prove it end to end

Every test so far is a unit test. Nothing yet has proven that a real second user is actually refused, which is the only claim that matters.

**Files:**
- Create: `infrastructure/scripts/smoke-test-access.sh`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Read an existing smoke test for the house style**

```bash
cd /home/masbintang/linkederp/cartenz_project && cat infrastructure/scripts/smoke-test-deletion.sh
```

Follow its conventions exactly: how it reads the API base URL, how it registers or logs a user in, how it reports pass and fail, and its `set -euo pipefail` header.

- [ ] **Step 2: Write the smoke test**

Create `infrastructure/scripts/smoke-test-access.sh`, following that style, asserting this sequence:

1. Log in as the owner; create a project. Record its id.
2. Register a second user, `access-probe@example.test`, and add them to the organisation as a `developer` (`POST /organizations/:id/members`).
3. As the probe user, `GET /projects?organizationId=…` — the project is present, `hasAccess` is `false`, and `repositoryUrl` and `taskCount` are `null`. **Assert all four.**
4. As the probe user, `GET /projects/:projectId` — **HTTP 403**, not 404 and not 200. This is the single most important assertion in the file.
5. As the probe user, `POST /projects/:projectId/access-requests` with a reason — 201.
6. As the probe user, the same POST again — 400, one pending request per pair.
7. As the owner, `GET /organizations/:id/access-requests` — the request is listed once.
8. As the owner, `PATCH …/access-requests/:requestId` with `{"decision":"approved"}` — 200.
9. As the probe user, `GET /projects/:projectId` — **HTTP 200**. The grant took effect.
10. As the owner, `DELETE /projects/:projectId/members/:probeUserId` — 204.
11. As the probe user, `GET /projects/:projectId` — **403 again**. The revoke took effect.
12. Clean up: delete the project permanently, following how `smoke-test-deletion.sh` does it.

Every step prints a `PASS` / `FAIL` line and the script exits non-zero on the first failure.

- [ ] **Step 3: Run it against the live stack**

```bash
cd /home/masbintang/linkederp/cartenz_project && bash infrastructure/scripts/smoke-test-access.sh
```

Expected: every step PASS. **If step 4 returns 200, the feature does not work** — enforcement is not reached on that path. Stop and fix Task 3 rather than adjusting the test.

- [ ] **Step 4: Record the run**

Append to `docs/implementation-status.md`, in the format the file already uses, that per-project access control (ADR-043) is implemented and what the smoke test verified, with today's date.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/scripts/smoke-test-access.sh docs/implementation-status.md
git commit -m "test(access): prove the boundary end to end (ADR-043)

The unit tests assert the rule; this asserts that a real second user is
actually refused, that the request survives a round trip, and that a
revoke puts the door back. Step 4 is the one that matters: a 200 there
means enforcement was never reached.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Both tables → Task 2. Enforcement order → Tasks 1 and 3. `403` and the four withheld fields → Tasks 3 and 4. Six endpoints → Task 5. Approve-in-one-transaction → Task 5. Partial unique index → Task 2. Backfill → Task 2. Four audit events → Task 3. Locked card, request button, both panels → Tasks 7 and 8. "Not built: notifications" → honoured; no task adds one.

**Placeholders.** None. Every code step carries the code.

**Type consistency.** `decideProjectAccess` (Task 1) is called in Tasks 3 and 4 with the same four-field input. `describeProjectAccess` (Task 5) returns the shape `ProjectAccessMember` declares (Task 6) and the panel reads (Task 8). `ProjectSummary.hasAccess` / `.accessRequestStatus` (Task 4) are what Task 7 branches on. `PROJECT_ACCESS_BYPASS_ROLE` is defined once in Task 1 and imported in Tasks 3 and 5.

**Known deviation from the spec.** The spec named the unit test file `authorization.service.spec.ts`. The plan puts the tests in `project-access.spec.ts` against a pure function instead, because every test in this repo runs without a database and testing `requireProjectAccess` directly would require mocking four collaborators — which `project-deletion.spec.ts` explicitly declines to do, for the stated reason that it would mostly test the mocks. The rule is still fully asserted; the wiring is asserted by Task 9 instead.
