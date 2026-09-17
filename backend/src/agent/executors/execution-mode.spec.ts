import { executionModeFor, isExecutionMode } from './execution-mode';

describe('executionModeFor', () => {
  it('maps the three product categories to their own modes', () => {
    expect(executionModeFor('odoo_online')).toBe('odoo_online');
    expect(executionModeFor('odoo_sh')).toBe('odoo_sh');
    expect(executionModeFor('on_premise')).toBe('on_premise');
  });

  it('maps a plain repository to the git-workspace mode', () => {
    expect(executionModeFor('repository')).toBe('odoo_sh');
  });

  it('maps an ai_project with no local directory to no execution mode', () => {
    expect(executionModeFor('ai_project')).toBeNull();
    expect(executionModeFor('ai_project', { hasLocalDirectory: false })).toBeNull();
  });

  it('runs an ai_project on-premise once it has a local directory (ADR-036)', () => {
    expect(executionModeFor('ai_project', { hasLocalDirectory: true })).toBe('on_premise');
  });

  it('runs a connected project with a repository as a clone-backed workspace (ADR-050)', () => {
    // The customer's Odoo may be on another host; the platform clones the branch
    // and pushes, and that host pulls for itself.
    expect(executionModeFor('on_premise', { hasRepository: true })).toBe('odoo_sh');
  });

  it('keeps a connected project with no repository in place (ADR-026)', () => {
    expect(executionModeFor('on_premise')).toBe('on_premise');
    expect(executionModeFor('on_premise', { hasRepository: false })).toBe('on_premise');
    expect(
      executionModeFor('on_premise', { hasLocalDirectory: true, hasRepository: false }),
    ).toBe('on_premise');
  });

  it('ignores the local-directory hint for types whose mode is fixed', () => {
    expect(executionModeFor('odoo_online', { hasLocalDirectory: true })).toBe('odoo_online');
    expect(executionModeFor('odoo_sh', { hasLocalDirectory: true })).toBe('odoo_sh');
    expect(executionModeFor('repository', { hasLocalDirectory: true })).toBe('odoo_sh');
  });
});

describe('isExecutionMode', () => {
  it('recognises the three modes and nothing else', () => {
    expect(isExecutionMode('odoo_online')).toBe(true);
    expect(isExecutionMode('odoo_sh')).toBe(true);
    expect(isExecutionMode('on_premise')).toBe(true);
    expect(isExecutionMode('repository')).toBe(false);
    expect(isExecutionMode('nonsense')).toBe(false);
  });
});
