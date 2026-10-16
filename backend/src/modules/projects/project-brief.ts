/**
 * The project brief: how long it may be, and turning an uploaded file into one.
 *
 * One constant so the DTOs, the brief-extract endpoint and the portal's
 * textarea all agree. It was 4000 characters, which a real customer brief
 * (requirements written in Word, a PRD exported to PDF) routinely exceeds.
 */

import {
  DocumentExtractionError,
  extractDocumentText,
  resolveUploadMimeType,
} from '../documents/document-extraction';

export const PROJECT_BRIEF_MAX_CHARS = 12000;

/**
 * File types a brief may be read from. Narrower than the project-documents
 * allowlist (ADR-030): a brief is prose, so slides and images are refused.
 */
export const BRIEF_FILE_MIME_TYPES = [
  'text/markdown',
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export interface ExtractedBrief {
  /** The brief text, cut to PROJECT_BRIEF_MAX_CHARS. */
  readonly text: string;
  /** Characters in the document before cutting. */
  readonly originalLength: number;
  /** True when the document was longer than the limit and was cut. */
  readonly truncated: boolean;
  readonly filename: string;
}

export class BriefExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefExtractionError';
  }
}

/**
 * Reads a brief out of an uploaded file. Nothing is stored: the text goes back
 * to the form, where the person reviews and edits it before it becomes the
 * project's description.
 *
 * Too-long text is cut rather than refused, unlike a project document: the
 * person sees the cut text in the textarea, and being told only "too long"
 * leaves them nothing to edit.
 */
export async function extractBrief(
  filename: string,
  mimeType: string | undefined,
  buffer: Buffer,
): Promise<ExtractedBrief> {
  const resolved = resolveUploadMimeType(mimeType, filename);
  if (!(BRIEF_FILE_MIME_TYPES as readonly string[]).includes(resolved)) {
    throw new BriefExtractionError(
      `A brief can be read from a DOCX, PDF, Markdown or plain-text file, not "${resolved || 'unknown'}".`,
    );
  }

  let text: string;
  try {
    text = await extractDocumentText(resolved, buffer);
  } catch (error) {
    if (error instanceof DocumentExtractionError) {
      throw new BriefExtractionError(error.message);
    }
    throw error;
  }

  const normalised = normaliseWhitespace(text);
  const truncated = normalised.length > PROJECT_BRIEF_MAX_CHARS;
  return {
    text: truncated ? cutAtBoundary(normalised, PROJECT_BRIEF_MAX_CHARS) : normalised,
    originalLength: normalised.length,
    truncated,
    filename,
  };
}

/**
 * Collapses the whitespace PDF and DOCX extraction leave behind: trailing
 * spaces, runs of blank lines. Every character saved this way is one more
 * character of the brief that fits under the limit.
 */
function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cuts at the last paragraph or line break before the limit, if near one. */
function cutAtBoundary(text: string, limit: number): string {
  const head = text.slice(0, limit);
  const floor = Math.floor(limit * 0.9);
  for (const separator of ['\n\n', '\n', '. ']) {
    const at = head.lastIndexOf(separator);
    if (at >= floor) return head.slice(0, at + (separator === '. ' ? 1 : 0)).trimEnd();
  }
  return head.trimEnd();
}
