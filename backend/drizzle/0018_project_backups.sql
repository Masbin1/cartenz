-- Per-client backups (ADR-054).
--
-- One row per backup of a project's estate: the database, filestore and addons
-- repository, snapshotted by the root-run backup-project.sh before a push onto
-- a staging (or main-named) branch, or on a person's request. The archive itself
-- lives under /opt/odoo/backups and is deliberately restorable without this
-- platform; the row records where it is and what it was for.

CREATE TABLE IF NOT EXISTS "project_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "task_id" uuid REFERENCES "agent_tasks"("id") ON DELETE set null,
  "status" text DEFAULT 'running' NOT NULL,
  "reason" text DEFAULT 'manual' NOT NULL,
  "backup_id" text,
  "path" text,
  "size_bytes" bigint,
  "error" text,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "project_backups_project_idx" ON "project_backups" ("project_id");
CREATE INDEX IF NOT EXISTS "project_backups_task_idx" ON "project_backups" ("task_id");
