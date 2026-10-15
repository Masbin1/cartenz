-- The organisation and the email domains allowed to sign up (ADR-072 addendum
-- 2). One row. Self-registration needs a verified inbox, so users gain
-- email_verified_at; every existing account counts as verified.
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"allowed_domains" text[] DEFAULT '{}' NOT NULL,
	"updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seeded with the first admin's domain, so invitations keep working on an
-- existing deployment before anyone opens the new settings.
INSERT INTO "organization" ("allowed_domains")
SELECT coalesce(array_agg(d), '{}') FROM (
	SELECT split_part(lower("email"), '@', 2) AS d FROM "users"
	WHERE "is_admin" ORDER BY "created_at" LIMIT 1
) first_admin;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "users" SET "email_verified_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "user_tokens" DROP CONSTRAINT "user_tokens_purpose_check";
--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_purpose_check" CHECK ("purpose" IN ('invite', 'reset', 'verify'));
