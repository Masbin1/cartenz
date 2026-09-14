# ADR-042: Image attachments — paste a screenshot or mock-up and have the agent see it

- Status: Accepted
- Date: 14 September 2026
- Milestone: Phase 5 (agentic chat + document-driven tasks)

## Context

ADR-030 lets a person attach a PRD or spec and have the agent read its text. The
next ask is visual: paste a screenshot of an Odoo screen, an error dialog, a
wireframe or a mock-up into the chat box and have the agent actually *see* it,
not just read text lifted from it.

Two facts about the existing design decide the shape of this change:

- **ADR-030 stores extracted text and discards the binary.** An image has no
  text layer, so the ADR-030 pipeline refuses it outright
  (`document-extraction.ts` throws when extraction yields nothing). Reading the
  *writing* in an image (OCR) was considered and rejected for this decision: it
  cannot convey a layout, a diagram, or a colour, which is the point of pasting a
  screenshot. The agent must be given the image itself.

- **The prompt is assembled as one text string** (`assemblePrompt`) and sent to
  the model via the SDK's `prompt:` field. An image cannot ride a text string; it
  has to travel as a structured message content block, which means the provider
  call changes from `prompt` to `messages` when an image is present.

The user's chosen approach (recorded in session) is vision-multimodal: send the
original image to a model that can see it, not OCR-to-text.

## Decision

Extend the ADR-030 attachment mechanism to carry images end-to-end to a
multimodal model, reusing the `project_documents` table, the upload/list/delete
endpoints, and the `documentIds` task-attachment path rather than building a
parallel one.

1. **One more accepted kind, stored as bytes.** The upload endpoint additionally
   accepts `image/png`, `image/jpeg`, `image/webp` and `image/gif`. An image is
   NOT text-extracted: its base64 is stored in a new nullable column
   `image_data_base64`, and `text_content` holds a short human placeholder
   (`[Image: <filename>]`) so the `NOT NULL` invariant and the list/read views
   keep working, and a non-vision model still learns an image was attached. A
   text document continues to store its extracted text and a null image column,
   exactly as before — the two kinds are told apart by MIME type, not a flag.

2. **A tighter size cap for images.** An image is capped at 5 MiB on upload
   (versus 10 MiB for a document), because the base64 lands in a row and a model
   request, and a screenshot has no business being larger. The whole-file cap is
   still enforced server-side; the client hint is not the guard.

3. **`PromptPart` gains an optional `image`.** A part may now carry
   `image?: { base64: string; mimeType: string }` alongside its text. The planner
   and the chat loop build one image part per attached image, labelled with the
   filename. Text parts are unchanged.

4. **The provider switches to a message with content blocks when an image is
   present.** `AiSdkModelProvider` collects the image parts; if there are none it
   sends `prompt:` exactly as before (no behavioural change for the text-only
   path). If there are images it sends `messages: [{ role: 'user', content:
   [{ type: 'text', text }, { type: 'image', image: <data-url> }, ...] }]`, which
   both the Anthropic and OpenAI-compatible bindings accept. This is confined to
   the one file that already isolates the SDK.

5. **Images are user-supplied trusted input, like the prompt.** The AI data
   boundary (ADR-020) is a *text* filter over customer repository content on its
   way to and from the model. An image pasted by the operator is the operator's
   own deliberate input — the same trust class as the words they type into the
   prompt (`untrusted: false`), not repository egress. Its bytes therefore pass
   the boundary unredacted; the placeholder `text_content` still passes the text
   boundary like any other part. This is a real and DOCUMENTED consequence: a
   person who pastes a screenshot containing a secret has chosen to send it,
   exactly as if they had typed it.

6. **Vision requires a multimodal model; a non-vision endpoint refuses honestly.**
   No new failover behaviour is invented. If priority-1 cannot accept image
   content it errs, and the existing chain falls through to the next provider on a
   retryable/`400` error as it does today. The dev-box default (Claude via the
   gateway) is multimodal, so the common path works.

## Consequences

- A screenshot, dialog or mock-up pasted into the chat box reaches a multimodal
  model as an image, and the model can reason about layout and visuals, not just
  transcribable text.
- Images reuse the entire ADR-030 surface — upload, list, delete, per-project
  cascade delete (ADR-024), and `documentIds` attachment — so there is no new
  endpoint, no new permission and no new task field.
- The `project_documents` row now sometimes holds a base64 image. The 5 MiB cap
  bounds row and request size; a model request carrying several large images is
  correspondingly heavier, which is the operator's choice at paste time.
- Image bytes bypass the text data boundary by design (point 5). This is the one
  place a person can deliberately put non-repository binary in front of the
  model; it is user input, not customer repository content.
- A non-multimodal provider at priority 1 will refuse a task that carries an
  image; the chain either falls through or the task fails with the provider's own
  message. Pointing the chain at a vision-capable model is a configuration
  decision, not a code change.

## Retirement condition

Retire or revise this decision if attachments move to object storage (images in a
database column stop being acceptable at volume), or if the platform gains a
binary-aware data boundary that must inspect image bytes before they reach a
model — at which point point 5's "trusted user input" stance is the thing to
revisit.

## Verification

- A `chat` task with a pasted image attached completes and the model's answer
  refers to visual content only present in the image (not derivable from the
  filename or prompt), proving the bytes reached a multimodal model.
- Uploading a `image/png` stores a row with `image_data_base64` populated and
  `text_content` = `[Image: <name>]`; uploading a `.md` still stores extracted
  text and a null image column (no regression to ADR-030).
- An oversized image (>5 MiB) is refused server-side with a clear message.
- The text-only path is unchanged: a task with only text documents sends
  `prompt:` and produces the same request as before this ADR (no `messages`).
- `backend` jest suite and both `tsc` projects are green.
