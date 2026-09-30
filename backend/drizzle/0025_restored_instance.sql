-- Restored copy of a connected project's instance (ADR-067).
--
-- Connecting an existing odoo.sh project never reaches the customer's own
-- instance (ADR-050). An operator instead downloads a backup zip from odoo.sh
-- and the platform builds a NEW Odoo on this host from it, neutralized before
-- it starts. These columns record that instance. It is for a person to look
-- at; the agent keeps working against the project's own template database.
--
-- Nullable/defaulted, so every existing row is unaffected.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restored_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restored_instance_name" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restored_port" integer;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restored_backup_file" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restored_error" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restored_at" timestamp with time zone;
