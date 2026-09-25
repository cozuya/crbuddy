import { existsSync } from 'node:fs';

import {
  ConfigError,
  assertUsableOutput,
  homeConfigPath,
  loadConfig,
  obsoleteKeysNote,
  projectConfigPath,
  readConfigFile,
} from '../config/load.js';
import { loadGlobalSettings } from '../config/settings.js';
import { WizardUI, createWizardUI } from '../util/wizard-prompt.js';
import { formatConfigSummary } from './init.js';

export interface ViewOptions {
  repoRoot: string | null;
}

export interface ViewDependencies {
  ui?: WizardUI;
  /** Test seam; normal view always uses ~/.crbuddy/config.json. */
  globalConfigFile?: string;
  /** Test seam; normal view always uses ~/.crbuddy/settings.json. */
  settingsFile?: string;
}

async function configSummary(
  options: ViewOptions,
  dependencies: ViewDependencies,
): Promise<string> {
  // Production inside a repository deliberately shares the exact loader
  // with `crb go`, including project-over-global precedence and the
  // repo-root-aware output-path checks.
  if (options.repoRoot && dependencies.globalConfigFile === undefined) {
    try {
      const loaded = await loadConfig(options.repoRoot);
      return withObsoleteNote(
        formatConfigSummary(loaded.scope, loaded.source, loaded.config, null),
        obsoleteKeysNote(loaded, options.repoRoot, 'this config'),
      );
    } catch (error) {
      if (
        error instanceof ConfigError &&
        error.message.startsWith('No config found.')
      ) {
        return 'Config: None';
      }
      throw error;
    }
  }

  // Outside a repository there is no repo root against which relative
  // output paths can be resolved. The injected global path is also kept
  // as a test seam for precedence tests.
  const projectFile = options.repoRoot
    ? projectConfigPath(options.repoRoot)
    : null;
  const globalFile = dependencies.globalConfigFile ?? homeConfigPath();

  if (projectFile && existsSync(projectFile)) {
    const read = await readConfigFile(projectFile);
    assertUsableOutput(read.config.output, `${projectFile}.output`, options.repoRoot!);
    return summarize('project', projectFile, read, options.repoRoot);
  }

  if (existsSync(globalFile)) {
    const read = await readConfigFile(globalFile);
    if (options.repoRoot) {
      assertUsableOutput(read.config.output, `${globalFile}.output`, options.repoRoot);
    }
    return summarize('global', globalFile, read, options.repoRoot);
  }

  return 'Config: None';
}

/** `crb go` prints this note for the same file, so view shows it too. */
function withObsoleteNote(summary: string, note: string | null): string {
  return note ? `${summary}\n\n${note}` : summary;
}

function summarize(
  scope: 'project' | 'global',
  file: string,
  read: Awaited<ReturnType<typeof readConfigFile>>,
  repoRoot: string | null,
): string {
  const loaded = {
    config: read.config,
    scope,
    obsoleteKeys: read.obsoleteKeys,
    ...(read.legacyRawOutput ? { legacyRawOutput: read.legacyRawOutput } : {}),
  };

  return withObsoleteNote(
    formatConfigSummary(scope, file, read.config, null),
    obsoleteKeysNote(loaded, repoRoot, 'this config'),
  );
}

export async function runView(
  options: ViewOptions,
  dependencies: ViewDependencies = {},
): Promise<number> {
  const ui = dependencies.ui ?? (await createWizardUI());
  const summary = await configSummary(options, dependencies);
  const settings = await loadGlobalSettings(
    (message) => ui.message(message, 'warn'),
    dependencies.settingsFile,
  );

  ui.note(
    `${summary}
Notifications (global): ${settings.notifications ? 'ntfy' : 'Off'}`,
    'Configuration',
  );

  return 0;
}
