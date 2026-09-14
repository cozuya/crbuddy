import { existsSync } from 'node:fs';

import { getAdapter } from '../adapters/vendors.js';
import {
  homeConfigPath,
  projectConfigPath,
  readAndValidate,
} from '../config/load.js';
import { Config, PanelEntry } from '../config/schema.js';
import { loadGlobalSettings } from '../config/settings.js';
import { WizardUI, createWizardUI } from '../util/wizard-prompt.js';

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
    summary = formatConfigSummary('project', projectFile, config);
  } else if (existsSync(globalFile)) {
    const config = await readAndValidate(globalFile);
    summary = formatConfigSummary('global', globalFile, config);
  } else {
    summary = 'Config: None';
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

function formatReviewer(entry: PanelEntry): string {
  let vendorLabel = entry.vendor;
  let modelLabel = entry.model;

  try {
    const adapter = getAdapter(entry.vendor);
    vendorLabel = adapter.label;
    modelLabel =
      adapter.models.find((model) => model.id === entry.model)?.label ?? entry.model;
  } catch {
    // Existing hand-edited configs may name an adapter unknown to this build.
  }

  return [
    vendorLabel,
    modelLabel,
    entry.effort,
    entry.instructions ? 'custom instructions' : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function formatConfigSummary(
  scope: 'global' | 'project',
  targetFile: string,
  config: Config,
): string {
  const lines = [
    `Config: ${scope === 'project' ? 'This repository' : 'Global'}`,
    `Path: ${targetFile}`,
    '',
    'Reviewers:',
    ...config.panel.map((entry) => `  ${formatReviewer(entry)}`),
    '',
  ];

  if (config.merge.enabled) {
    const merger: PanelEntry = {
      id: 'summary',
      vendor: config.merge.vendor,
      model: config.merge.model,
      ...(config.merge.effort ? { effort: config.merge.effort } : {}),
    };
    lines.push(`Consolidation: Enabled · ${formatReviewer(merger)}`);
  } else {
    lines.push('Consolidation: Disabled');
  }

  lines.push(
    `Target: ${
      config.target === 'uncommitted'
        ? 'Uncommitted changes'
        : `Current branch vs ${config.target.base}`
    }`,
  );

  if (config.output.destination === 'terminal') {
    lines.push('Output: Terminal');
  } else {
    lines.push(`Output: ${config.output.merged}`);
    if (config.merge.enabled) lines.push(`Raw audit: ${config.output.raw}`);
  }

  return lines.join('\n');
}
