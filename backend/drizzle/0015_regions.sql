-- ADR-044: the organisation is gone; region replaces it.
--
-- One flat space with a single selector. Region decides who may see which
-- project, `users.is_admin` decides who may manage anything, and the ADR-043
-- per-project grant is the only other gate. Every `organization_id` column on
-- every other table is dropped with it: once the organisation is gone the column
-- is denormalised noise that every query has to thread through and no query can
-- filter on.
--
-- Data safety, in order:
--   * every existing project lands in `indonesia`, so nobody's list empties;
--   * every org owner/admin becomes `users.is_admin = true`, so the people who
--     could manage before can still manage after;
--   * every non-admin org member already holds a project_members grant from
--     0014, so project access survives the organisation that granted it.
-- Backfill happens before any DROP, and the whole file is one migration so
-- ship-day is a single ALTER sequence.

-- 1. Region and admin flag on users.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "region" text DEFAULT 'indonesia' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- 2. Region on projects. Every existing row is Indonesia (see header).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "region" text DEFAULT 'indonesia' NOT NULL;
--> statement-breakpoint

-- 3. Promote the people who were owners or admins of any organisation. Read
--    before organization_members is dropped, after the column exists.
UPDATE "users" SET "is_admin" = true
 WHERE "id" IN (
   SELECT "user_id" FROM "organization_members" WHERE "role" IN ('owner', 'admin')
 );
--> statement-breakpoint

-- 4. Projects lose their organisation and get a global name space. A flat space
--    means one project per name for the whole deployment, so a plain unique
--    index replaces the per-organisation one - and it is created before the
--    org-scoped index is dropped, so the conflict, if any, is reported here
--    rather than silently deferred.
DO $$ BEGIN
 ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (
   SELECT 1 FROM "projects" GROUP BY "name" HAVING count(*) > 1
 ) THEN
   RAISE EXCEPTION
     'Cannot flatten to one name space: duplicate project names exist. Rename the duplicates, then re-run this migration.';
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_name_unique" ON "projects" USING btree ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_region_idx" ON "projects" USING btree ("region");
--> statement-breakpoint
DROP INDEX IF EXISTS "projects_org_name_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "projects_organization_idx";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint

-- 5. The model provider chain becomes global: one chain for the deployment, as
--    provider configuration is operator config rather than a region boundary.
ALTER TABLE IF EXISTS "organization_model_settings" RENAME TO "model_settings";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_settings" DROP CONSTRAINT IF EXISTS "organization_model_settings_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "organization_model_settings_priority_idx";
--> statement-breakpoint
ALTER TABLE "model_settings" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
-- One row at each position, now deployment-wide rather than per organisation.
-- Created before the backfill so a pre-existing tie is reported as a unique
-- violation on a named index rather than as a silent mis-ordering.
CREATE UNIQUE INDEX IF NOT EXISTS "model_settings_priority_unique" ON "model_settings" USING btree ("priority");
--> statement-breakpoint

-- 6. The Odoo estate becomes global too: one estate per deployment. The old
--    primary key WAS organization_id, so a surrogate id is added first and the
--    primary key moves to it.
ALTER TABLE IF EXISTS "organization_odoo_settings" RENAME TO "odoo_settings";
--> statement-breakpoint
ALTER TABLE "odoo_settings" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint
UPDATE "odoo_settings" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
--> statement-breakpoint
ALTER TABLE "odoo_settings" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "odoo_settings" DROP CONSTRAINT IF EXISTS "organization_odoo_settings_pkey";
--> statement-breakpoint
ALTER TABLE "odoo_settings" ADD PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE "odoo_settings" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint

-- 7. Every remaining organisation_id, its foreign key, and any index that
--    references it. Same shape six times over; written out rather than looped
--    because a migration should be readable as the list of things it did.
DO $$ BEGIN
 ALTER TABLE "secret_records" DROP CONSTRAINT IF EXISTS "secret_records_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "secret_records" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secret_data_keys" DROP CONSTRAINT IF EXISTS "secret_data_keys_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
-- The old scope index was (organization_id, project_id). A plain (project_id)
-- unique index cannot express "at most one global key" because Postgres treats
-- NULLs as distinct, so the scope is split into two partial indexes: one for the
-- projects, one for the single global row.
DROP INDEX IF EXISTS "secret_data_keys_scope_unique";
--> statement-breakpoint
ALTER TABLE "secret_data_keys" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secret_data_keys_project_unique"
  ON "secret_data_keys" USING btree ("project_id") WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secret_data_keys_global_unique"
  ON "secret_data_keys" USING btree ("project_id") WHERE "project_id" IS NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_documents" DROP CONSTRAINT IF EXISTS "project_documents_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "project_documents" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tasks" DROP CONSTRAINT IF EXISTS "agent_tasks_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_tasks_org_status_idx";
--> statement-breakpoint
ALTER TABLE "agent_tasks" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_workspaces" DROP CONSTRAINT IF EXISTS "agent_workspaces_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "agent_workspaces" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "project_memory" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_calls" DROP CONSTRAINT IF EXISTS "agent_model_calls_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_model_calls_org_created_idx";
--> statement-breakpoint
ALTER TABLE "agent_model_calls" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_environments" DROP CONSTRAINT IF EXISTS "project_environments_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "project_environments" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "approvals_org_status_idx";
--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_organization_id_organizations_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "audit_logs_org_created_idx";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "organization_id";
--> statement-breakpoint

-- 8. The organisation itself, last: every foreign key into it is gone by now, so
--    this cannot fail on a dependency and cannot leave a half-dropped pair.
DROP TABLE IF EXISTS "organization_members";
--> statement-breakpoint
DROP TABLE IF EXISTS "organizations";
