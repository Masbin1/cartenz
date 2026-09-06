-- Where an organisation's Odoo estate lives (ADR-033).
-- Filesystem locations rather than credentials: stored in plain columns and
-- shown in the portal, because being able to see and correct them is the reason
-- they moved out of the environment. One row per organisation; absent means the
-- deployment's ODOO_SOURCE_PATHS fallback still applies (ADR-031).
CREATE TABLE IF NOT EXISTS "organization_odoo_settings" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "base_path" text,
  "enterprise_path" text,
  "projects_root" text,
  "updated_by_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
