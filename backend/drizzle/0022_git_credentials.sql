-- Deployment-wide git credentials (ADR-021, ADR-058).
--
-- Until now a credential could only live on a project connection, so an
-- operator connecting a private repository had to paste the same SSH key into
-- every project-creation form. A key that is retyped is a key that is pasted
-- wrong: the flattened-newline failure ("error in libcrypto") reached several
-- forms before it was understood.
--
-- This table lets one credential be registered once, at deployment scope, and
-- selected as the default. The value is not here: `secret_ref` points into
-- `secret_records`, sealed under the single global data key (project_id NULL),
-- which is the same mechanism `project_connections` already uses.
--
-- `hosts` limits which remotes a credential may be presented to (empty = any),
-- and `is_default` is guarded by a partial unique index so at most one row can
-- hold it even if two admins set it at once.

CREATE TABLE IF NOT EXISTS "git_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" text NOT NULL,
  "secret_ref" text NOT NULL,
  "credential_kind" text NOT NULL DEFAULT 'ssh_key',
  "hosts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_default" boolean NOT NULL DEFAULT false,
  "enabled" boolean NOT NULL DEFAULT true,
  "note" text,
  "last_verified_at" timestamp with time zone,
  "last_verify_error" text,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "git_credentials_label_unique" ON "git_credentials" ("label");
CREATE INDEX IF NOT EXISTS "git_credentials_label_idx" ON "git_credentials" ("label");
CREATE UNIQUE INDEX IF NOT EXISTS "git_credentials_single_default"
  ON "git_credentials" ("is_default") WHERE "is_default";
