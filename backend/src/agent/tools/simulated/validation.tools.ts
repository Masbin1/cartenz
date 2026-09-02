import type { AnyToolDefinition, ToolDefinition } from '../tool.interface';
import { RUN_LINTER_SCHEMA, VALIDATION_SCHEMA } from '../tool-schemas';

/**
 * Simulated validation tools (ADR-013, ADR-019).
 *
 * These are the tools that remain simulated after Phase 2, and the reason is
 * specific: each one executes code from the repository. `run_linter` runs a linter
 * over customer source, and `run_python_test` and `run_odoo_test` run the
 * repository's own test suite. That is Risk A of ADR-019 - untrusted code
 * execution - and the only adequate control for it is the kernel boundary of a
 * Firecracker microVM, which Phase 4 introduces.
 *
 * Everything around them is real: they are registered in the same registry,
 * declare the same `run_tests` permission, pass through the same permission
 * validator, and their results are persisted and published like any other tool's.
 * Making them real is a change to these three functions and nothing else.
 *
 * Note also what is absent. Chapter 7 lists `run_odoo_shell`, `install_module`,
 * `upgrade_module` and `check_registry`; every one of them executes Odoo, and
 * therefore repository code. None is implemented, not even as a stub, so there is
 * nothing a configuration change could switch on.
 */

function requireObject(input: unknown): string | null {
  return typeof input === 'object' && input !== null ? null : 'input must be an object';
}

export const runLinterTool: ToolDefinition<{ paths?: string[] }> = {
  name: 'run_linter',
  description: 'Run static analysis over the modified files',
  permission: 'run_tests',
  modes: ['odoo_sh', 'on_premise'],
  leavesPlatform: false,
  simulated: true,
  parameters: RUN_LINTER_SCHEMA,
  // Validation runs at a defined point in the lifecycle, after implementation.
  availableToModel: false,
  validate: requireObject,
  async execute(input) {
    const paths = Array.isArray(input.paths) ? input.paths : [];
    return {
      tool: 'ruff',
      filesChecked: paths.length,
      errors: 0,
      warnings: 0,
      passed: true,
      simulated: true,
      note: 'Simulated: running a linter executes repository tooling, which requires the isolated workspace of a later phase.',
    };
  },
};

export const runPythonTestTool: ToolDefinition<{ module?: string }> = {
  name: 'run_python_test',
  description: 'Run the Python test suite for the affected module',
  permission: 'run_tests',
  modes: ['odoo_sh', 'on_premise'],
  leavesPlatform: false,
  simulated: true,
  parameters: VALIDATION_SCHEMA,
  availableToModel: false,
  validate: requireObject,
  async execute(input) {
    return {
      module: input.module ?? 'all',
      passed: 0,
      failed: 0,
      skipped: 0,
      simulated: true,
      note: 'Simulated: no test was executed. Counts are zero rather than invented, so a reader is not misled into thinking a suite ran.',
    };
  },
};

export const runOdooTestTool: ToolDefinition<{ module?: string }> = {
  name: 'run_odoo_test',
  description: 'Run Odoo module tests against an isolated temporary database',
  permission: 'run_tests',
  modes: ['odoo_sh', 'on_premise'],
  leavesPlatform: false,
  simulated: true,
  parameters: VALIDATION_SCHEMA,
  availableToModel: false,
  validate: requireObject,
  async execute(input, context) {
    return {
      module: input.module ?? 'all',
      odooVersion: context.workspace.odooVersion,
      // Chapter 12: tests never touch a production database. When these become
      // real, the database is created for the task and destroyed with it.
      database: 'isolated-temporary',
      passed: 0,
      failed: 0,
      simulated: true,
      note: 'Simulated: no Odoo instance was started and no database was created.',
    };
  },
};

export const VALIDATION_TOOLS: readonly AnyToolDefinition[] = [
  runLinterTool,
  runPythonTestTool,
  runOdooTestTool,
];
