import { buildSystemPrompt } from './prompt-assembly';

/**
 * ADR-031. The reference is only useful if the model is told it exists, and
 * claiming a reference that is not configured would send the agent looking for
 * files it cannot read.
 */
describe('buildSystemPrompt — Odoo source reference (ADR-031)', () => {
  const base = {
    projectName: 'Vania',
    odooVersion: '19.0',
    branch: 'ai/task_1',
    grantedTools: ['read_file', 'search_code'],
  };

  it('names the prefixes and says they are read-only', () => {
    const prompt = buildSystemPrompt({ ...base, odooSourcePrefixes: ['odoo', 'enterprise'] });

    expect(prompt).toContain('# The Odoo source');
    expect(prompt).toContain('`odoo/`');
    expect(prompt).toContain('`enterprise/`');
    expect(prompt).toContain('READ-ONLY');
  });

  it('says nothing about a reference when none is configured', () => {
    expect(buildSystemPrompt(base)).not.toContain('# The Odoo source');
    expect(buildSystemPrompt({ ...base, odooSourcePrefixes: [] })).not.toContain(
      '# The Odoo source',
    );
  });

  it('carries the Odoo conventions whether or not a reference exists', () => {
    for (const prompt of [
      buildSystemPrompt(base),
      buildSystemPrompt({ ...base, odooSourcePrefixes: ['odoo'] }),
    ]) {
      expect(prompt).toContain('# Odoo conventions');
      expect(prompt).toContain('_inherit');
      expect(prompt).toContain('ir.model.access.csv');
    }
  });

  it('keeps the boundaries that do not depend on the reference', () => {
    const prompt = buildSystemPrompt({ ...base, odooSourcePrefixes: ['odoo'] });
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('Never include credentials');
  });
});
