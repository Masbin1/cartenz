CREATE TABLE IF NOT EXISTS "project_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"branch" text NOT NULL,
	"kind" text NOT NULL,
	"is_default_target" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_connections" ADD COLUMN "credential_kind" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_connections" ADD COLUMN "ssh_host_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_environments_project_name_unique" ON "project_environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_environments_project_branch_unique" ON "project_environments" USING btree ("project_id","branch");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_environments_project_idx" ON "project_environments" USING btree ("project_id");