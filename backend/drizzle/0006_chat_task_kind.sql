-- ADR-029: a task has a kind (`change` or `chat`), and a chat task stores its
-- natural-language answer. Additive: existing rows become `change` with no answer.
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'change' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "answer" text;
