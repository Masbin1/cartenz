import { Injectable } from '@nestjs/common';
import { OdooProjectAnalyser } from '../../analysis/odoo-project-analyser';
import { NO_ARGUMENTS_SCHEMA } from '../tool-schemas';
import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext } from '../tool.interface';

/**
 * Real Odoo metadata tools (ADR-019).
 *
 * Both read the repository's own manifest text. Neither executes Python, connects
 * to a database, or reads a record - which is why they sit under
 * `database_metadata_read`, the capability Table 7 permits by default because it
 * carries no customer data.
 *
 * Note what is absent, and deliberately: `run_odoo_shell`, `upgrade_module`,
 * `install_module` and `check_registry` are all listed in chapter 7 but every one
 * of them executes Odoo, and therefore repository code. They stay unimplemented
 * until the isolation boundary exists.
 */

function requireObject(input: unknown): string | null {
  return typeof input === 'object' && input !== null ? null : 'input must be an object';
}

function assertRepository(context: ToolExecutionContext): void {
  if (context.workspace.simulated) {
    throw new Error('This project has no repository connected, so there is nothing to inspect.');
  }
}

@Injectable()
export class RealOdooTools {
  constructor(private readonly analyser: OdooProjectAnalyser) {}

  get definitions(): readonly AnyToolDefinition[] {
    return [this.detectOdooVersion, this.listModules];
  }

  private readonly detectOdooVersion: ToolDefinition<Record<string, never>> = {
    name: 'detect_odoo_version',
    description: 'Detect the Odoo version the repository targets, from its module manifests',
    permission: 'database_metadata_read',
    leavesPlatform: false,
    simulated: false,
    parameters: NO_ARGUMENTS_SCHEMA,
    availableToModel: true,
    validate: requireObject,
    execute: async (_input, context) => {
      assertRepository(context);
      const analysis = await this.analyser.analyse(context.workspace.repositoryPath);

      // Both values are reported. A mismatch between what the project record says
      // and what the repository declares is exactly the kind of thing a developer
      // needs to see, so it is surfaced rather than reconciled silently.
      return {
        detectedVersion: analysis.detectedOdooVersion,
        declaredVersion: context.workspace.odooVersion,
        matchesProjectSetting:
          analysis.detectedOdooVersion !== null &&
          context.workspace.odooVersion !== null &&
          analysis.detectedOdooVersion === context.workspace.odooVersion,
        pythonVersion: analysis.pythonVersion,
        source: 'module manifests',
        moduleCount: analysis.modules.length,
      };
    },
  };

  private readonly listModules: ToolDefinition<Record<string, never>> = {
    name: 'list_modules',
    description: 'List the Odoo addon modules in the repository, with versions and dependencies',
    permission: 'database_metadata_read',
    leavesPlatform: false,
    simulated: false,
    parameters: NO_ARGUMENTS_SCHEMA,
    availableToModel: true,
    validate: requireObject,
    execute: async (_input, context) => {
      assertRepository(context);
      const analysis = await this.analyser.analyse(context.workspace.repositoryPath);

      return {
        moduleCount: analysis.modules.length,
        addonRoots: analysis.structure.addonRoots,
        modules: analysis.modules.slice(0, 200).map((module) => ({
          technicalName: module.technicalName,
          name: module.name,
          version: module.version,
          path: module.path,
          depends: module.depends.slice(0, 20),
          installable: module.installable,
          isApplication: module.isApplication,
        })),
        truncated: analysis.modules.length > 200 || analysis.structure.truncated,
        notes: analysis.notes,
      };
    },
  };
}
