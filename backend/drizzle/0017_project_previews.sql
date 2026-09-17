-- Ephemeral preview instances (ADR-052).
--
-- A preview is a short-lived running Odoo built from a task's retained draft,
-- so a reviewer sees the real UI before approving. The row records what the
-- root-run script built so the portal can show a link and a remaining time, and
-- so a crashed worker's preview can be found and torn down. No secret is stored
-- here: the preview's database is the standard baseline.

CREATE TABLE IF NOT EXISTS "project_previews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "task_id" uuid NOT NULL REFERENCES "agent_tasks"("id") ON DELETE cascade,
  "ref" text NOT NULL,
  "status" text DEFAULT 'creating' NOT NULL,
  "branch" text NOT NULL,
  "base_commit" text,
  "odoo_version" text,
  "odoo_edition" text,
  "region" text,
  "port" integer,
  "url" text,
  "database_name" text,
  "error" text,
  "expires_at" timestamp with time zone NOT NULL,
  "started_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_previews_ref_unique"
  ON "project_previews" ("ref");
CREATE INDEX IF NOT EXISTS "project_previews_project_idx"
  ON "project_previews" ("project_id");
CREATE INDEX IF NOT EXISTS "project_previews_status_idx"
  ON "project_previews" ("status");
CREATE INDEX IF NOT EXISTS "project_previews_expires_idx"
  ON "project_previews" ("expires_at");
