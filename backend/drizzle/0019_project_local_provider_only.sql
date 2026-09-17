-- Per-project "local provider only" flag (ADR-055).
--
-- When true, the project's tasks may only use model providers whose base URL is
-- loopback, so nothing about the project leaves the host. Defaulted false: the
-- existing data-processing posture is unchanged until a person turns it on.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "local_provider_only" boolean DEFAULT false NOT NULL;
