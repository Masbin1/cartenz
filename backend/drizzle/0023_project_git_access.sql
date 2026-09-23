-- Per-project git access (ADR-059).
--
-- Until now a project's transport was whatever its repository URL happened to
-- say, and its credential was whichever connection happened to be created
-- first. Both were facts nobody could change afterwards from the portal, which
-- is how a project whose remote is https://github.com/... ended up with only an
-- SSH key registered: the push reached git, git asked for a username for an
-- HTTPS remote, and a headless process cannot answer that.
--
-- These two columns make the choice explicit and per project.

-- 'auto' keeps the historical behaviour: the transport is read from the URL.
-- 'ssh' and 'https' override it, and the service rewrites repository_url to
-- match, so the URL the agent clones from and the scheme git uses to push are
-- never in disagreement.
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "git_transport" text NOT NULL DEFAULT 'auto';

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_git_transport_check"
  CHECK ("git_transport" IN ('auto', 'ssh', 'https'));

-- The credential this project uses, overriding the ADR-058 deployment default.
-- A reference rather than a copy, exactly as project_connections.secret_ref is:
-- rotating the registered credential reaches every project pointing at it.
-- ON DELETE SET NULL because deleting a credential must not delete a project —
-- the project falls back to the default rather than disappearing with it.
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "git_credential_id" uuid;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_git_credential_id_fkey"
  FOREIGN KEY ("git_credential_id") REFERENCES "git_credentials"("id")
  ON DELETE SET NULL;

-- The account an HTTPS remote authenticates as, when it is not derived from the
-- token. Git's own convention is `x-access-token` for GitHub Apps and the token
-- owner's login otherwise; an empty value here means "use the built-in
-- default", not "no account".
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "git_username" text;
