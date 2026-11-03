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

/** The project brief is the agent's standing context for every task. */
describe('buildSystemPrompt — project brief', () => {
  const base = { projectName: 'Vania', odooVersion: '19.0', branch: 'ai/task_1', grantedTools: [] };

  it('states the brief when the project has one', () => {
    const prompt = buildSystemPrompt({ ...base, projectBrief: '  Manage employee equipment.  ' });
    expect(prompt).toContain('# What the project is for\nManage employee equipment.\n');
  });

  it.each([undefined, null, '   '])('omits the section for a brief of %p', (projectBrief) => {
    expect(buildSystemPrompt({ ...base, projectBrief })).not.toContain('What the project is for');
  });
});

/**
 * ADR-087/ADR-090: this instruction is what the `change` task path (the
 * planner, then `ModelImplementationLoop`) tells the model about the
 * signed-in browser - unlike the chat loop, which has always had its own copy
 * of this text, `buildSystemPrompt` had none at all until this was added.
 * Without it, a `change` task whose project grants `browser_control` still
 * saw `browser_navigate` named in its tool list but was never told what it
 * was for or that nothing on the Odoo host is refused to it - which is
 * exactly how a real task answered "the available tools do not include the
 * ability to write a Server Action" while holding a tool that could have
 * reached one.
 */
describe('buildSystemPrompt — the signed-in browser (ADR-087, ADR-090)', () => {
  const base = { projectName: 'Vania', odooVersion: '19.0', branch: 'ai/task_1' };

  it('explains the browser tools when they are granted', () => {
    const prompt = buildSystemPrompt({
      ...base,
      grantedTools: ['browser_snapshot', 'browser_navigate', 'browser_click', 'browser_type'],
    });

    expect(prompt).toContain('signed-in browser');
    expect(prompt).toContain('Automation Rules');
    expect(prompt).toContain('Server Actions');
    // ADR-090: no screen within the host is refused - the old "Users, access
    // rights... are refused" wording must not come back.
    expect(prompt).toContain('Nothing on this Odoo host is refused to the browser');
    expect(prompt).not.toMatch(/are refused\b/);
  });

  it('still carries the instruction when no browser tool is granted', () => {
    // Deliberately unconditional: the text itself says "only if ... are in
    // your tool list", so a project without browser_control sees it and
    // correctly concludes it does not apply, rather than the section being
    // hidden and the model never learning the capability could exist.
    const prompt = buildSystemPrompt({ ...base, grantedTools: ['read_file'] });
    expect(prompt).toContain('signed-in browser');
  });
});
