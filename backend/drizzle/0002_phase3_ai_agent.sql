CREATE TABLE IF NOT EXISTS "agent_model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"called_external_service" boolean DEFAULT false NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"steps" integer DEFAULT 1 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"boundary_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redaction_count" integer DEFAULT 0 NOT NULL,
	"boundary_refused" boolean DEFAULT false NOT NULL,
	"halt_reason" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_calls" ADD CONSTRAINT "agent_model_calls_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_calls" ADD CONSTRAINT "agent_model_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_model_calls_task_idx" ON "agent_model_calls" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_model_calls_org_created_idx" ON "agent_model_calls" USING btree ("organization_id","created_at");