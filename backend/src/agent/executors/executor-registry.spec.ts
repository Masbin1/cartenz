import { ExecutorRegistry, UnsupportedExecutionModeError } from './executor-registry';
import type { Executor } from './executor.interface';

describe('ExecutorRegistry', () => {
  const executor = (mode: Executor['mode']): Executor => ({
    mode,
    managesGit: mode !== 'odoo_online',
    pushesToRemote: mode !== 'odoo_online',
    touchesFilesystem: mode !== 'odoo_online',
  });

  it('resolves the executor bound for a mode', () => {
    const registry = new ExecutorRegistry([executor('odoo_sh')]);
    expect(registry.forMode('odoo_sh').mode).toBe('odoo_sh');
    expect(registry.has('odoo_sh')).toBe(true);
  });

  it('refuses a mode with no executor rather than falling through', () => {
    const registry = new ExecutorRegistry([executor('odoo_sh')]);
    expect(() => registry.forMode('on_premise')).toThrow(UnsupportedExecutionModeError);
    expect(registry.has('on_premise')).toBe(false);
  });

  it('rejects a duplicate mode registration at construction', () => {
    expect(
      () => new ExecutorRegistry([executor('odoo_sh'), executor('odoo_sh')]),
    ).toThrow(/Duplicate executor registration/);
  });

  it('lists the modes an executor is bound for', () => {
    const registry = new ExecutorRegistry([executor('odoo_sh'), executor('on_premise')]);
    expect(registry.boundModes()).toEqual(['odoo_sh', 'on_premise']);
  });
});
