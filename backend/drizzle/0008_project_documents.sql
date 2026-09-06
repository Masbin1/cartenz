-- Documents attached to a project for the agent to read (ADR-030).
-- The original binary is not stored: upload extracts the text, and only the
-- text is kept, because it is what the agent reads and what must pass the AI
-- data boundary. Removal of a project removes its documents (cascade), and an
-- uploaded document that yields no text is refused at the service layer.
CREATE TABLE IF NOT EXISTS "project_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "uploaded_by_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "text_content" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "project_documents_project_idx" ON "project_documents" ("project_id");

-- A task may attach documents whose text the workflow passes to the model as
-- prompt parts (ADR-030). The ids are stored on the task so it runs with the
-- text captured at creation time even if a document is later deleted.
ALTER TABLE "agent_tasks"
  ADD COLUMN IF NOT EXISTS "attached_document_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
