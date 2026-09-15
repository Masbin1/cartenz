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
