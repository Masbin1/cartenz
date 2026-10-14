-- Outgoing mail and the portal's public address, edited in the portal (ADR-072
-- addendum). One row; the SMTP password lives sealed in secret_records.
CREATE TABLE "mail_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"smtp_user" text,
	"smtp_password_ref" text,
	"mail_from" text,
	"portal_url" text,
	"updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
