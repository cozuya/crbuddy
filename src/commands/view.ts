import { existsSync } from 'node:fs';

import {
  homeConfigPath,
  projectConfigPath,
  readAndValidate,
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

export async function runView(
  options: ViewOptions,
  dependencies: ViewDependencies = {},
): Promise<number> {
  const ui = dependencies.ui ?? (await createWizardUI());
  const projectFile = options.repoRoot
    ? projectConfigPath(options.repoRoot)
    : null;
  const globalFile = dependencies.globalConfigFile ?? homeConfigPath();

  let summary: string;

  if (projectFile && existsSync(projectFile)) {
    const config = await readAndValidate(projectFile);
    summary = formatConfigSummary('project', projectFile, config, null);
  } else if (existsSync(globalFile)) {
    const config = await readAndValidate(globalFile);
    summary = formatConfigSummary('global', globalFile, config, null);
  } else {
    summary = 'Config: None\n\nNo repository or global config found.';
  }

  const settings = await loadGlobalSettings(
    (message) => ui.message(message, 'warn'),
    dependencies.settingsFile,
  );

  ui.note(
    `${summary}\nNotifications (global): ${settings.notifications ? 'ntfy' : 'Off'}`,
    'Configuration',
  );

  return 0;
}
