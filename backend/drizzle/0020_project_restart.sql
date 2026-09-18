-- Project instance restart tracking (ADR-057).
--
-- The merge half needs no schema change at all: it is an ordinary git push to
-- main, and its result belongs in the audit log rather than on the project row.
-- The restart half outlives the request that started it, because bringing an
-- instance up on upgraded code means running `odoo-bin -u all` first, which can
-- take minutes. The portal asks "is it back yet" the same way it asks about
-- provisioning, so the answer lives on the project row.
--
-- 'none' rather than a nullable column: every project starts out never-restarted
-- through the platform, and that is a state the portal has to render either way.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restart_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restart_error" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restart_commit" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restart_branch" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "restarted_at" timestamp with time zone;
