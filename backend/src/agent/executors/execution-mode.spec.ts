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

  it('maps an ai_project to no execution mode', () => {
    expect(executionModeFor('ai_project')).toBeNull();
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
