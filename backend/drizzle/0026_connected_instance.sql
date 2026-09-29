-- Provisioned instance for a connected odoo.sh project (ADR-069).
--
-- Connecting an existing odoo.sh project gives the platform a repository and
-- nothing else (ADR-050). This records a NEW, empty Odoo instance the platform
-- provisions for that project on this host, so the project owner can reach
-- /web/database/manager over HTTPS and restore their own database into it.
--
-- Distinct from restored_* (ADR-067): that instance is loaded from an odoo.sh
-- backup and stays locked to localhost; this one starts empty and is reachable.
-- A project can have both.
--
-- Nullable/defaulted, so every existing row is unaffected.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "connected_instance_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "connected_instance_name" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "connected_instance_port" integer;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "connected_instance_url" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "connected_instance_master_password_ref" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "connected_instance_error" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "connected_instance_created_at" timestamp with time zone;
