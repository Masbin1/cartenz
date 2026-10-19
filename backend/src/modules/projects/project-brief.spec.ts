import { extractBrief, BriefExtractionError, PROJECT_BRIEF_MAX_CHARS } from './project-brief';

describe('extractBrief', () => {
  it('reads a markdown brief and reports it was not cut', async () => {
    const brief = await extractBrief(
      'brief.md',
      'text/markdown',
      Buffer.from('# Produksi kayu\n\n- Lacak lot per batch\n'),
    );
    expect(brief.text).toBe('# Produksi kayu\n\n- Lacak lot per batch');
    expect(brief.truncated).toBe(false);
    expect(brief.filename).toBe('brief.md');
  });

  it('resolves a .md file the browser labels application/octet-stream', async () => {
    const brief = await extractBrief('brief.md', 'application/octet-stream', Buffer.from('Isi brief'));
    expect(brief.text).toBe('Isi brief');
  });

  it('collapses blank-line runs and trailing spaces left by extraction', async () => {
    const brief = await extractBrief('b.txt', 'text/plain', Buffer.from('Satu   \r\n\r\n\r\n\r\nDua'));
    expect(brief.text).toBe('Satu\n\nDua');
  });

  it('cuts an over-long brief at a paragraph break under the limit', async () => {
    const paragraph = 'a'.repeat(999) + '\n\n';
    const text = paragraph.repeat(20); // ~20,000 chars
    const brief = await extractBrief('long.md', 'text/markdown', Buffer.from(text));
    expect(brief.truncated).toBe(true);
    expect(brief.originalLength).toBeGreaterThan(PROJECT_BRIEF_MAX_CHARS);
    expect(brief.text.length).toBeLessThanOrEqual(PROJECT_BRIEF_MAX_CHARS);
    expect(brief.text.endsWith('a')).toBe(true);
  });

  it('refuses slides and images, which the documents upload accepts', async () => {
    await expect(
      extractBrief(
        'deck.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        Buffer.from('pk'),
      ),
    ).rejects.toThrow(BriefExtractionError);
    await expect(extractBrief('shot.png', 'image/png', Buffer.from('x'))).rejects.toThrow(
      BriefExtractionError,
    );
  });

  it('turns an empty file into a BriefExtractionError, not a raw extraction error', async () => {
    await expect(extractBrief('empty.txt', 'text/plain', Buffer.from('   '))).rejects.toThrow(
      BriefExtractionError,
    );
  });
});
