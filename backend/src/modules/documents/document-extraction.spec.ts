import {
  DOCUMENT_MAX_FILE_BYTES,
  DocumentExtractionError,
  extractDocumentText,
  isAcceptedDocumentMimeType,
  isAcceptedImageMimeType,
  normalizeMimeType,
} from './document-extraction';

describe('document-extraction', () => {
  describe('normalizeMimeType', () => {
    it('strips charset parameters', () => {
      expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
      expect(normalizeMimeType('TEXT/PLAIN')).toBe('text/plain');
    });
  });

  describe('isAcceptedDocumentMimeType', () => {
    it('accepts the four documented types only', () => {
      expect(isAcceptedDocumentMimeType('text/markdown')).toBe(true);
      expect(isAcceptedDocumentMimeType('text/plain')).toBe(true);
      expect(isAcceptedDocumentMimeType('application/pdf')).toBe(true);
      expect(
        isAcceptedDocumentMimeType(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).toBe(true);
      expect(isAcceptedDocumentMimeType('application/octet-stream')).toBe(false);
    });
  });

  describe('isAcceptedImageMimeType', () => {
    it('accepts the four documented image types only (ADR-042)', () => {
      expect(isAcceptedImageMimeType('image/png')).toBe(true);
      expect(isAcceptedImageMimeType('image/jpeg')).toBe(true);
      expect(isAcceptedImageMimeType('image/webp')).toBe(true);
      expect(isAcceptedImageMimeType('image/gif')).toBe(true);
      expect(isAcceptedImageMimeType('image/svg+xml')).toBe(false);
      expect(isAcceptedImageMimeType('application/pdf')).toBe(false);
    });

    it('does not treat an image type as a document type', () => {
      expect(isAcceptedDocumentMimeType('image/png')).toBe(false);
    });
  });

  describe('extractDocumentText', () => {
    it('stores markdown verbatim', async () => {
      const text = await extractDocumentText(
        'text/markdown',
        Buffer.from('# PRD\n\n- requirement one\n'),
      );
      expect(text).toBe('# PRD\n\n- requirement one');
    });

    it('refuses an unsupported type', async () => {
      await expect(
        extractDocumentText('application/zip', Buffer.from('pk')),
      ).rejects.toThrow(DocumentExtractionError);
    });

    it('refuses a file over the byte cap', async () => {
      await expect(
        extractDocumentText(
          'text/plain',
          Buffer.alloc(DOCUMENT_MAX_FILE_BYTES + 1, 'a'),
        ),
      ).rejects.toThrow(/limit is 10 MiB/);
    });

    it('refuses a document with no text rather than storing it empty', async () => {
      await expect(
        extractDocumentText('text/plain', Buffer.from('   \n\t  ')),
      ).rejects.toThrow(/No text could be extracted/);
    });
  });
});
