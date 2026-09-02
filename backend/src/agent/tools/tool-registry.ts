import { Injectable, Logger } from '@nestjs/common';
import type { AnyToolDefinition } from './tool.interface';
import { RealRepositoryTools } from './real/repository.tools';
import { RealGitTools } from './real/git.tools';
import { RealOdooTools } from './real/odoo.tools';
import { OdooOnlineTools } from './real/odoo-online.tools';
import { VALIDATION_TOOLS } from './simulated/validation.tools';

/**
 * The set of tools the agent may request.
 *
 * A tool that is not registered here cannot be executed: the execution service
 * resolves by name and refuses an unknown name. This is what makes the tool
 * surface a closed set rather than whatever the model happens to ask for.
 *
 * As of Phase 5 the repository, Git (including push) and Odoo-metadata tools are
 * real (ADR-019, ADR-021). The validation tools remain simulated because they
 * execute repository code. The split is not configurable: it is a property of what
 * each tool does, so there is no setting that could accidentally turn validation
 * into real execution.
 *
 * Registration rejects a duplicate name at construction, so the process fails at
 * boot rather than silently resolving to whichever definition was registered last.
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, AnyToolDefinition>();

  constructor(
    repositoryTools: RealRepositoryTools,
    gitTools: RealGitTools,
    odooTools: RealOdooTools,
    odooOnlineTools: OdooOnlineTools,
  ) {
    this.registerAll([
      ...repositoryTools.definitions,
      ...gitTools.definitions,
      ...odooTools.definitions,
      ...odooOnlineTools.definitions,
      ...VALIDATION_TOOLS,
    ]);

    const simulated = this.all().filter((tool) => tool.simulated);
    this.logger.log(
      `Registered ${this.tools.size} tools: ${this.tools.size - simulated.length} real, ` +
        `${simulated.length} simulated (${simulated.map((tool) => tool.name).join(', ')}) - see docs/adr/ADR-019`,
    );
  }

  private registerAll(definitions: readonly AnyToolDefinition[]): void {
    for (const definition of definitions) {
      if (this.tools.has(definition.name)) {
        throw new Error(
          `Duplicate tool registration for "${definition.name}". Tool names must be unique.`,
        );
      }
      this.tools.set(definition.name, definition);
    }
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): readonly AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * The capability categories that are still simulated, recorded on every task so
   * that the portal can state precisely which results were fabricated rather than
   * showing a single misleading flag (ADR-019).
   */
  simulatedCapabilities(): readonly string[] {
    const categories = new Set<string>();
    for (const tool of this.all()) {
      if (!tool.simulated) continue;
      if (tool.permission === 'run_tests') categories.add('validation');
      else categories.add(tool.name);
    }
    return [...categories].sort();
  }

  /** Tool catalogue for the portal, without the implementations. */
  describe() {
    return this.all().map((tool) => ({
      name: tool.name,
      description: tool.description,
      permission: tool.permission,
      modes: tool.modes ?? null,
      leavesPlatform: tool.leavesPlatform,
      simulated: tool.simulated,
    }));
  }
}
