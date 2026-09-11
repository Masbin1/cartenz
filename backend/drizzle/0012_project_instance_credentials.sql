-- ADR-040: HTTPS for provisioned instances, and a place to find a project's
-- connection details (URL, database name, master password) after creation.
--
-- Hand-written, IF NOT EXISTS, for the same reason as 0011: drizzle-kit's own
-- diff would replay every column already applied by hand since the last
-- snapshot it can see.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provisioning_database_name" text;
-- Reference into secret_records (ADR-014). Never the plaintext password itself -
-- that is written once, by ProjectProvisioningService, immediately after
-- create_project/create_project_enterprise prints it, and is read only through
-- the dedicated reveal endpoint, gated to admin/owner.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provisioning_master_password_ref" text;
-- 'none' | 'pending' | 'issued' | 'failed' — mirrors provisioning_status's shape
-- for the HTTPS step run after create_project succeeds (ADR-040).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "https_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "https_error" text;
