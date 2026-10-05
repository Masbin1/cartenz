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
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export type AcceptedDocumentMimeType = (typeof ACCEPTED_DOCUMENT_MIME_TYPES)[number];

export function isAcceptedDocumentMimeType(value: string): value is AcceptedDocumentMimeType {
  return (ACCEPTED_DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Extensions that identify a type the browser may not label. Browsers take the
 * MIME type from the OS, and many systems (most Linux desktops among them) have
 * no entry for `.md`, so a markdown file arrives as `application/octet-stream`
 * or with no type at all and was refused as unsupported.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Labels a browser sends when it does not know the type. */
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * The MIME type to treat an upload as. A specific type from the browser is
 * trusted as sent; a generic or missing one is resolved from the filename's
 * extension. An unknown extension leaves the generic type in place, so the
 * allowlist still refuses it.
 */
export function resolveUploadMimeType(mimeType: string | undefined, filename: string | undefined): string {
  const normalized = normalizeMimeType(mimeType ?? '');
  if (!GENERIC_MIME_TYPES.has(normalized)) return normalized;
  const dot = (filename ?? '').lastIndexOf('.');
  if (dot === -1) return normalized;
  const extension = (filename ?? '').slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? normalized;
}

/**
 * Image types the upload accepts (ADR-042). An image is not text-extracted; its
 * bytes are stored so a multimodal model can see it. Kept separate from the
 * document allowlist because the two are handled differently at every step.
 */
export const ACCEPTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AcceptedImageMimeType = (typeof ACCEPTED_IMAGE_MIME_TYPES)[number];

export function isAcceptedImageMimeType(value: string): value is AcceptedImageMimeType {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Whole-file cap: an upload larger than this is refused before extraction. */
export const DOCUMENT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Image cap (ADR-042): tighter than a document because the base64 lands in a row
 * and in every model request that attaches it. A screenshot has no business
 * being larger.
 */
export const IMAGE_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

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
 * Extracts the visible text of a PPTX, slide by slide, in slide order.
 *
 * A PPTX is a zip of XML parts; each slide's text runs live in
 * `ppt/slides/slideN.xml` as `<a:t>...</a:t>` elements (DrawingML text runs,
 * inside shapes, tables and speaker-note-free body text). There is no library
 * already in this project that reads pptx text directly (mammoth is docx-only,
 * pdf-parse is pdf-only), so this unzips with the `jszip` dependency already
 * used elsewhere in the monorepo and pulls text runs out of each slide's XML
 * with a regex rather than a full XML parser - robust enough for this, since
 * `<a:t>` never nests and its content cannot itself contain an unescaped `<`.
 * Slides are read in numeric order (`slide1.xml`, `slide2.xml`, ...) rather than
 * zip entry order, which a producer is free to write in any order.
 */
async function extractPptx(buffer: Buffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => {
      const numberOf = (path: string) => parseInt(path.match(/slide(\d+)\.xml$/)![1], 10);
      return numberOf(a) - numberOf(b);
    });

  if (slideFiles.length === 0) {
    return '';
  }

  const slideTexts: string[] = [];
  for (const path of slideFiles) {
    const xml = await zip.files[path].async('string');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decodeXmlEntities(match[1]));
    const slideText = runs.join(' ').trim();
    if (slideText.length > 0) {
      slideTexts.push(slideText);
    }
  }

  return slideTexts.join('\n\n');
}

/** Decodes the handful of XML entities that appear inside a `<a:t>` run. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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
      `Unsupported file type "${normalized}". Accepts markdown, plain text, PDF, DOCX and PPTX.`,
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
    } else if (
      normalized ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ) {
      text = await extractPptx(buffer);
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
