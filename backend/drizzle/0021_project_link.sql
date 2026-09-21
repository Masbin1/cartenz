-- Connect-existing link metadata (ADR-050, ADR-054).
--
-- A connect-existing project may need a second URL besides its repository:
-- the customer's own instance (odoo.sh or on-premise) whose database manager
-- a restore is eventually pointed at. This is metadata about that link, not a
-- new connection mechanism — no code path creates a repository from it, and a
-- repository-backed project keeps pulling from its own repositoryUrl exactly
-- as before (ADR-049).
--
-- All three are nullable/defaulted so every existing row is unaffected.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "project_url" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "project_database" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "is_odoosh" boolean DEFAULT false NOT NULL;
