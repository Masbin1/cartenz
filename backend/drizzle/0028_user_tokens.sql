-- One-time invitation and password-reset links (ADR-072). Only the SHA-256 of
-- the token is stored, so reading this table does not yield a usable link.
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"purpose" text NOT NULL CHECK ("purpose" IN ('invite', 'reset')),
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_tokens_hash_unique" ON "user_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "user_tokens_user_idx" ON "user_tokens" USING btree ("user_id");
