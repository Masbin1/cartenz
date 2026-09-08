-- ADR-037: a project records its Odoo edition (community or enterprise). The
-- generated odoo.conf omits the enterprise addons path for a community project.
-- Additive: existing rows default to 'enterprise', the behaviour before this column.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "odoo_edition" text DEFAULT 'enterprise' NOT NULL;
