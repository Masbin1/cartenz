-- ADR-073: fit-gap database setup at project creation.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_setup_plan" jsonb;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_setup_status" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_setup_report" jsonb;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_setup_error" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_setup_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "db_setup_gaps" jsonb;
