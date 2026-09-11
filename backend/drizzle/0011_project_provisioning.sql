-- ADR-039: a project records how its "Create with AI" directory was turned
-- into a real, running Odoo instance by the operator's own
-- create_project / create_project_enterprise scripts.
--
-- Hand-written rather than left as drizzle-kit's raw diff: the generator diffed
-- against the last snapshot it has on disk (0004), and migrations 0005-0010
-- were applied by hand without regenerating a snapshot after each one, so its
-- output duplicated columns already present (odoo_edition, agent_tasks.kind,
-- etc). Only the new columns are applied here, defensively with
-- IF NOT EXISTS, matching the pattern 0010_project_odoo_edition.sql already
-- established for the same reason.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provisioning_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provisioning_port" integer;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provisioning_url" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provisioning_error" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provisioned_at" timestamp with time zone;
