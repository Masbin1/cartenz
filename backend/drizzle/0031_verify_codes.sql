-- One-time codes beside verify links (ADR-072 addendum 3): the SHA-256 of a
-- 6-digit code, and how many guesses it has taken. Five wrong ones spend it.
ALTER TABLE "user_tokens" ADD COLUMN "code_hash" text;
--> statement-breakpoint
ALTER TABLE "user_tokens" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
