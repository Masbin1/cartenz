-- Sign-in codes and trusted browsers (ADR-072 addendum 4). A login challenge is
-- a user_tokens row with purpose 'login'; a browser that passed one keeps a
-- token whose SHA-256 lives here for 30 days, until the password changes.
ALTER TABLE "user_tokens" DROP CONSTRAINT "user_tokens_purpose_check";
--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_purpose_check" CHECK ("purpose" IN ('invite', 'reset', 'verify', 'login'));
--> statement-breakpoint
CREATE TABLE "trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_devices_hash_unique" ON "trusted_devices" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "trusted_devices_user_idx" ON "trusted_devices" USING btree ("user_id");
