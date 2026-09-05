/**
 * Extracts text from an uploaded document (ADR-030).
 *
 * The upload stores the extracted text and discards the original bytes, so this
 * is the only place that ever sees the binary. Extraction is deliberately
 * synchronous in style: each function returns the text or throws a
 * `DocumentExtractionError` with a message a person can act on. PDF and DOCX are
 * extracted; markdown and plain text are stored verbatim.
 */

export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

/** MIME types the upload accepts, mapped to how their text is obtained. */
export const ACCEPTED_DOCUMENT_MIME_TYPES = [
  'text/markdown',
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export type AcceptedDocumentMimeType = (typeof ACCEPTED_DOCUMENT_MIME_TYPES)[number];

export function isAcceptedDocumentMimeType(value: string): value is AcceptedDocumentMimeType {
  return (ACCEPTED_DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}

/** Whole-file cap: an upload larger than this is refused before extraction. */
export const DOCUMENT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Extracted-text cap: a document longer than this is refused, not truncated. */
export const DOCUMENT_MAX_TEXT_CHARS = 1024 * 1024; // 1 MiB

/** How many documents a single task may attach (ADR-030). */
export const MAX_ATTACHED_DOCUMENTS = 20;

/**
 * Normalises a MIME type that may arrive with charset or other parameters,
 * e.g. `text/plain; charset=utf-8` -> `text/plain`.
 */
export function normalizeMimeType(mimeType: string): string {
  const semicolon = mimeType.indexOf(';');
  return (semicolon === -1 ? mimeType : mimeType.slice(0, semicolon)).trim().toLowerCase();
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // pdf-parse v2: construct with the data, then getText() loads and parses.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text ?? '';
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? '';
}

/**
 * Turns an uploaded buffer into the text to store.
 *
 * Throws `DocumentExtractionError` when the type is not accepted or the
 * extraction yields no text (for example an image-only PDF without a text
 * layer, or a password-protected document).
 */
export async function extractDocumentText(
  mimeType: string,
  buffer: Buffer,
): Promise<string> {
  const normalized = normalizeMimeType(mimeType);

  if (!isAcceptedDocumentMimeType(normalized)) {
    throw new DocumentExtractionError(
      `Unsupported file type "${normalized}". Accepts markdown, plain text, PDF and DOCX.`,
    );
  }

  if (buffer.length > DOCUMENT_MAX_FILE_BYTES) {
    throw new DocumentExtractionError(
      `The document is ${Math.round(buffer.length / 1024 / 1024)} MiB; the limit is 10 MiB.`,
    );
  }

  let text: string;
  try {
    if (normalized === 'application/pdf') {
      text = await extractPdf(buffer);
    } else if (
      normalized ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      text = await extractDocx(buffer);
    } else {
      text = buffer.toString('utf8');
    }
  } catch (error) {
    throw new DocumentExtractionError(
      `Could not read this document${
        error instanceof Error ? `: ${error.message}` : '.'
      } It may be password-protected or not a valid ${normalized} file.`,
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new DocumentExtractionError(
      'No text could be extracted from this document. Image-only PDFs and scanned documents without a text layer are not supported.',
    );
  }

  if (trimmed.length > DOCUMENT_MAX_TEXT_CHARS) {
    throw new DocumentExtractionError(
      `The extracted text is ${Math.round(trimmed.length / 1024)} KiB; the limit is 1 MiB. Split the document and upload it in parts.`,
    );
  }

  return trimmed;
}
