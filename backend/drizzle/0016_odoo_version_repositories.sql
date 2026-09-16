CREATE TABLE IF NOT EXISTS "odoo_version_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"base_path" text NOT NULL,
	"enterprise_path" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "odoo_version_repositories_version_unique" ON "odoo_version_repositories" USING btree ("version");