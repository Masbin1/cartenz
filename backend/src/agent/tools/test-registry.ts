import { ToolRegistry } from './tool-registry';
import { RealRepositoryTools } from './real/repository.tools';
import { RealGitTools } from './real/git.tools';
import { RealOdooTools } from './real/odoo.tools';
import type { AppConfig } from '../../core/config/configuration';
import type { GitService } from '../git/git.service';
import type { OdooProjectAnalyser } from '../analysis/odoo-project-analyser';

/**
 * Builds a registry for tests, without a Nest container.
 *
 * The tools are constructed with their real definitions, because that is what the
 * tests are about: the permission each declares, whether it leaves the platform,
 * and what its validate() refuses. The collaborators a tool would need in order to
 * *execute* are stubbed, because no test here executes one - and a stub that
 * threw on use would make an accidental execution obvious rather than silent.
 *
 * Kept in `src` rather than a test directory so it type-checks with the rest of
 * the code: a helper that drifts from the constructors it calls is worse than no
 * helper.
 */
export function buildTestToolRegistry(): ToolRegistry {
  const config = {
    limits: {
      searchMaxResults: 60,
      searchMaxFileBytes: 1024 * 1024,
      readFileMaxBytes: 256 * 1024,
    },
  } as AppConfig;

  const refuse = (name: string) => () => {
    throw new Error(`${name} must not be called in a unit test`);
  };

  const git = {
    clone: refuse('GitService.clone'),
    createBranch: refuse('GitService.createBranch'),
    status: refuse('GitService.status'),
    diff: refuse('GitService.diff'),
    commit: refuse('GitService.commit'),
    revParse: refuse('GitService.revParse'),
  } as unknown as GitService;

  const analyser = {
    analyse: refuse('OdooProjectAnalyser.analyse'),
  } as unknown as OdooProjectAnalyser;

  return new ToolRegistry(
    new RealRepositoryTools(config),
    new RealGitTools(git),
    new RealOdooTools(analyser),
  );
}
