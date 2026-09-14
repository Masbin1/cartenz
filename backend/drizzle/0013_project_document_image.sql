-- ADR-042: an attached document may be an image, stored as base64 bytes rather
-- than extracted text, so a pasted screenshot/mock-up reaches a multimodal model
-- as an image. Additive and nullable: existing text documents keep a null image
-- column and their extracted text is unchanged.
ALTER TABLE "project_documents" ADD COLUMN IF NOT EXISTS "image_data_base64" text;
