# ADR-030: Document ingestion — read a project's PRD and execute tasks from it

- Status: Accepted
- Date: 05 September 2026
- Milestone: Phase 5 (agentic chat + document-driven tasks)

## Context

A person often already has a product requirements document (PRD), a functional
spec, or design notes for the Odoo module they want built. Today the only way to
use that material is to paste it into the task prompt, which is limited to 8,000
characters and mixes the document with the request itself. The ask is: upload the
document once, then have the agent read it and execute tasks straight from it.

Two things are already in place that this decision builds on:

- `project_specifications` (the "AI project" flow) already turns a name, version,
  description and requirements into a structured, reviewable specification
  (ADR-017). A PRD is the free-form source of exactly those fields.
- The AI data boundary (ADR-020) filters every part that crosses to a model
  provider. Document text is customer content, so it must ride the same
  boundary rather than bypassing it.

## Decision

Add a `project_documents` table holding the uploaded document as its extracted
text, and let a task attach documents whose text is passed to the model as
ordinary prompt parts.

1. **Upload → extract → store text.** A multipart upload endpoint under the
   project (`POST /projects/:projectId/documents`) accepts one file per call:
   `text/markdown`, `text/plain`, `application/pdf`, and
   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
   (docx). Markdown and plain text are stored verbatim; PDF and DOCX are
   extracted server-side (pdf-parse, mammoth). What is stored is the extracted
   text — not the original binary — because the text is what the agent reads and
   what must pass the data boundary. The original bytes are discarded. An
   upload whose extraction yields no text (for example an image-only PDF with no
   text layer) is refused with a clear message rather than stored as an empty
   document.

2. **Bounded like everything else.** A file must be at most 10 MiB, and the
   extracted text at most 1 MiB. Text above the cap is refused. There is no
   client-side-only rule here; the server is the only guard that matters.

3. **Documents are project-scoped and delete like projects.** Rows reference the
   project with `onDelete: cascade`, so a project removal (ADR-024) removes its
   documents too. List, read and delete endpoints mirror the project surface.

4. **Attaching to a task.** `CreateTaskDto` gains an optional `documentIds`
   (array of UUIDs, capped at 20). At creation the service verifies every id
   belongs to the project. The workflow loads the attached documents and passes
   each one to the planner and the chat loop as a `PromptPart` labelled with its
   filename, marked `untrusted: true` so the AI data boundary redacts it exactly
   as it redacts repository files. The document is never concatenated into the
   stored prompt.

5. **No new agent capability.** The agent already reads files and produces plans;
   attaching a document only adds a prompt part. There is no new tool, no new
   permission, and no change to the push or approval machinery (ADR-021,
   ADR-011).

## Consequences

- A PRD can be uploaded once and referenced by many tasks, instead of pasted
  into every prompt.
- Document text is customer content and is redacted by the boundary; the source
  of truth remains the stored text, which is reviewable and deletable.
- Image-only PDFs and password-protected PDFs are rejected (no text layer), and
  DOCX that depends on embedded images for meaning loses that meaning — the
  extracted text is authoritative. This is an accepted MVP limitation.
- The upload surface is a new attack surface; the allowlist of MIME types, the
  size caps, and `multer` memory storage (no disk write) are the guards.
