import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { toPosixPath } from '../../core/path-utils';
import { odooSeriesFromVersion, parseOdooManifest, type OdooManifest } from './manifest-parser';
import { SOURCE_EXTENSIONS, walkRepository } from './repository-walker';

/** One addon module found in the repository. */
export interface DetectedModule {
  readonly technicalName: string;
  readonly path: string;
  readonly name: string | null;
  readonly version: string | null;
  readonly series: string | null;
  readonly depends: readonly string[];
  readonly installable: boolean | null;
  readonly isApplication: boolean;
  readonly fileCount: number;
}

export interface RepositoryStructure {
  readonly addonRoots: readonly string[];
  readonly fileCountByExtension: Readonly<Record<string, number>>;
  readonly totalFiles: number;
  readonly truncated: boolean;
  readonly symlinksSkipped: number;
}

export interface ProjectAnalysis {
  /** Detected from the repository, which may differ from the declared value. */
  readonly detectedOdooVersion: string | null;
  readonly pythonVersion: string | null;
  readonly modules: readonly DetectedModule[];
  readonly structure: RepositoryStructure;
  /** Technical observations worth surfacing. Never customer data. */
  readonly notes: readonly string[];
}

/**
 * Reads a cloned repository and reports what it is (ADR-019).
 *
 * This is what makes the agent "code-aware": before Phase 2 the analysing state
 * narrated invented facts, and the planner named files that might not exist. It
 * now reports the modules that are really there and the Odoo series the
 * repository's own manifests declare.
 *
 * Nothing is executed. Manifests are parsed as text (see manifest-parser), and
 * the Python version is read from declarative files rather than by asking an
 * interpreter.
 */
@Injectable()
export class OdooProjectAnalyser {
  private readonly logger = new Logger(OdooProjectAnalyser.name);

  async analyse(repositoryPath: string): Promise<ProjectAnalysis> {
    const walked = await walkRepository(repositoryPath, {
      extensions: new Set([...SOURCE_EXTENSIONS, '']),
      maxFiles: 20000,
    });

    const manifestFiles = walked.files.filter(
      (file) =>
        file.path.endsWith('__manifest__.py') || file.path.endsWith('__openerp__.py'),
    );

    const modules: DetectedModule[] = [];
    const seriesTally = new Map<string, number>();

    for (const manifestFile of manifestFiles) {
      const moduleDirectory = dirname(manifestFile.absolutePath);
      const technicalName = moduleDirectory.slice(moduleDirectory.lastIndexOf('/') + 1);

      const source = await readFile(manifestFile.absolutePath, 'utf8').catch(() => null);
      if (source === null) continue;

      const manifest: OdooManifest = parseOdooManifest(technicalName, source);
      const series = odooSeriesFromVersion(manifest.version);
      if (series) seriesTally.set(series, (seriesTally.get(series) ?? 0) + 1);

      const modulePrefix = `${toPosixPath(relative(repositoryPath, moduleDirectory))}/`;
      const fileCount = walked.files.filter((file) => file.path.startsWith(modulePrefix)).length;

      modules.push({
        technicalName,
        path: toPosixPath(relative(repositoryPath, moduleDirectory)),
        name: manifest.name,
        version: manifest.version,
        series,
        depends: manifest.depends,
        installable: manifest.installable,
        isApplication: manifest.applicationFlag === true,
        fileCount,
      });
    }

    const detectedOdooVersion = this.resolveSeries(seriesTally);
    const pythonVersion = await this.detectPythonVersion(repositoryPath, walked.files);

    const fileCountByExtension: Record<string, number> = {};
    for (const file of walked.files) {
      const key = file.extension || '(none)';
      fileCountByExtension[key] = (fileCountByExtension[key] ?? 0) + 1;
    }

    const structure: RepositoryStructure = {
      addonRoots: this.resolveAddonRoots(modules),
      fileCountByExtension,
      totalFiles: walked.files.length,
      truncated: walked.truncated,
      symlinksSkipped: walked.symlinksSkipped,
    };

    const notes = this.buildNotes(modules, detectedOdooVersion, seriesTally, structure);

    this.logger.log(
      `Analysed repository: ${modules.length} module(s), Odoo ${detectedOdooVersion ?? 'unknown'}, ${walked.files.length} file(s)`,
    );

    return { detectedOdooVersion, pythonVersion, modules, structure, notes };
  }

  /**
   * The series the repository targets, taken as the most frequently declared one.
   *
   * A repository can legitimately contain modules on different series - a vendored
   * third-party addon left behind after an upgrade, for instance - so the majority
   * is a better answer than the first one found, and the disagreement is reported
   * as a note rather than hidden.
   */
  private resolveSeries(tally: Map<string, number>): string | null {
    if (tally.size === 0) return null;

    let best: string | null = null;
    let bestCount = 0;
    for (const [series, count] of tally) {
      if (count > bestCount) {
        best = series;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * The directories that hold modules, which is what an Odoo `addons_path` needs.
   *
   * Derived from where the modules actually are rather than guessed from
   * convention, because a repository may keep its addons at the root, under
   * `addons/`, or under a vendor directory.
   */
  private resolveAddonRoots(modules: readonly DetectedModule[]): string[] {
    const roots = new Set<string>();
    for (const module of modules) {
      const parent = module.path.includes('/')
        ? module.path.slice(0, module.path.lastIndexOf('/'))
        : '.';
      roots.add(parent);
    }
    return [...roots].sort();
  }

  /**
   * Reads the Python version from declarative files.
   *
   * Never by running an interpreter: that would execute code from the repository's
   * environment, which is the boundary ADR-019 keeps.
   */
  private async detectPythonVersion(
    repositoryPath: string,
    files: readonly { path: string; absolutePath: string }[],
  ): Promise<string | null> {
    // A .python-version file is unambiguous, so it is preferred.
    const pinned = files.find((file) => file.path === '.python-version');
    if (pinned) {
      const contents = await readFile(pinned.absolutePath, 'utf8').catch(() => null);
      const version = contents?.trim().split('\n')[0]?.trim();
      if (version && /^[0-9]+[.][0-9]+/.test(version)) return version;
    }

    // pyproject.toml states a requirement rather than a version, so the lower
    // bound is reported and labelled as a requirement in the note.
    const pyproject = files.find((file) => file.path === 'pyproject.toml');
    if (pyproject) {
      const contents = await readFile(pyproject.absolutePath, 'utf8').catch(() => null);
      const match = contents ? /requires-python\s*=\s*['"][^0-9]*([0-9]+[.][0-9]+)/.exec(contents) : null;
      if (match) return match[1];
    }

    void repositoryPath;
    return null;
  }

  /**
   * Observations worth putting in front of a developer.
   *
   * Restricted to technical facts about the repository. Nothing here may derive
   * from customer data, because these notes are persisted to project memory,
   * which chapter 12 requires to hold technical information only.
   */
  private buildNotes(
    modules: readonly DetectedModule[],
    detectedSeries: string | null,
    seriesTally: Map<string, number>,
    structure: RepositoryStructure,
  ): string[] {
    const notes: string[] = [];

    if (modules.length === 0) {
      notes.push(
        'No Odoo module was found: the repository contains no __manifest__.py. It may hold Odoo core, configuration, or something other than addons.',
      );
    }

    if (seriesTally.size > 1) {
      const summary = [...seriesTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([series, count]) => `${series} (${count})`)
        .join(', ');
      notes.push(
        `Modules declare more than one Odoo series: ${summary}. ${detectedSeries} is taken as the target.`,
      );
    }

    const uninstallable = modules.filter((module) => module.installable === false);
    if (uninstallable.length > 0) {
      notes.push(
        `${uninstallable.length} module(s) are marked installable = False: ${uninstallable
          .map((module) => module.technicalName)
          .slice(0, 8)
          .join(', ')}.`,
      );
    }

    const unversioned = modules.filter((module) => module.version === null);
    if (unversioned.length > 0) {
      notes.push(
        `${unversioned.length} module(s) declare no version, so their target series could not be determined.`,
      );
    }

    if (structure.truncated) {
      notes.push(
        'The repository is larger than the analysis limit, so the module list may be incomplete.',
      );
    }

    if (structure.symlinksSkipped > 0) {
      notes.push(
        `${structure.symlinksSkipped} symbolic link(s) were skipped: links are never followed inside a workspace.`,
      );
    }

    return notes;
  }
}

/** Absolute path of a module's manifest, for the tools that read one. */
export function manifestPathFor(repositoryPath: string, modulePath: string): string {
  return join(repositoryPath, modulePath, '__manifest__.py');
}
