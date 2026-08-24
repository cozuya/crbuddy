import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  CONFIG_VERSION,
  Config,
  DEFAULTS,
  DEFAULT_OUTPUT,
  MergeConfig,
  OutputConfig,
  OutputDestination,
  PanelEntry,
  Target,
  WORK_DIR,
} from '../config/schema.js';
import {
  assertUsableOutput,
  homeConfigPath,
  projectConfigPath,
  readAndValidate,
  repoRelative,
  slug,
} from '../config/load.js';
import { ADAPTERS, getAdapter } from '../adapters/vendors.js';
import { probe } from '../run/spawn.js';
import { Adapter } from '../adapters/types.js';
import { PromptAborted } from '../util/prompt.js';
import { WizardUI, createWizardUI } from '../util/wizard-prompt.js';

export interface InitOptions {
  repoRoot: string | null;
  scope?: 'global' | 'project';
}

export interface InitDependencies {
  ui?: WizardUI;
  detect?: (signal?: AbortSignal) => Promise<Detection[]>;
}

export async function runInit(
  options: InitOptions,
  dependencies: InitDependencies = {},
): Promise<number> {
  const ui = dependencies.ui ?? (await createWizardUI());

  try {
    return await wizard(options, ui, dependencies.detect ?? detectAdapters);
  } catch (error) {
    const name = (error as { name?: string })?.name;

    if (error instanceof PromptAborted || name === 'AbortError') {
      ui.cancel('crbuddy setup aborted. No config was written.');
      return 130;
    }

    throw error;
  }
}

async function wizard(
  options: InitOptions,
  ui: WizardUI,
  detect: (signal?: AbortSignal) => Promise<Detection[]>,
): Promise<number> {
  ui.intro('crbuddy setup');

  const scopeChoices = [
    { label: 'Global', value: 'global' as const, hint: homeConfigPath() },
    ...(options.repoRoot
      ? [
          {
            label: 'This repository',
            value: 'project' as const,
            hint: projectConfigPath(options.repoRoot),
          },
        ]
      : []),
  ];

  let scope =
    options.scope ??
    (scopeChoices.length === 1
      ? 'global'
      : await ui.select<'global' | 'project'>(
          'Where should this config live? Local overrides global.',
          scopeChoices,
          options.repoRoot ? 1 : 0,
        ));

  const effectiveScope = effectiveInitScope(scope, options.repoRoot);

  if (effectiveScope !== scope) {
    scope = effectiveScope;
    ui.message(
      'No Git repository was found, so this config will be saved globally.',
      'warn',
    );
  }

  // A project-local config REPLACES the global one, so editing global while
  // a local one exists here changes a file that will never be read in this
  // repo. Silence there is how you end up debugging a panel you did not run.
  if (scope === 'global' && options.repoRoot) {
    const local = projectConfigPath(options.repoRoot);

    if (existsSync(local)) {
      ui.note(
        `Heads up: this repository has its own config at ${local}, and a ` +
          `project config replaces the global one entirely.\n` +
          '`crbuddy go` here will use that file, not the global config.',
        'Project config takes precedence',
      );

      const switchToLocal = await ui.confirm(
        'Edit the repository config instead?',
        true,
      );

      if (switchToLocal) {
        scope = 'project';
      }
    }
  }

  const targetFile =
    scope === 'project' && options.repoRoot
      ? projectConfigPath(options.repoRoot)
      : homeConfigPath();

  let existing: Config | null = null;

  if (existsSync(targetFile)) {
    ui.message(`Editing the existing config at ${targetFile}.`);

    try {
      existing = await readAndValidate(targetFile);
    } catch (error) {
      ui.message(`Could not parse it: ${String(error)}`, 'error');

      const start = await ui.confirm(
        'Start from scratch instead? The old file will be replaced.',
        false,
      );

      if (!start) {
        ui.cancel('Existing config left unchanged.');
        return 1;
      }
    }
  }

  const detections = await ui.spinner(
    'Checking vendor CLIs',
    detect,
    'Vendor CLIs checked',
  );
  const available = detections.filter((d) => d.present).map((d) => d.adapter);

  ui.note(detections.map(formatDetection).join('\n'), 'Vendor CLIs');

  if (available.length === 0) {
    ui.cancel(
      'No supported vendor CLIs are usable. crbuddy drives your own\n' +
        'installed agent CLIs, so at least one has to work here.\n' +
        'Run `crbuddy doctor` for details.',
    );
    return 1;
  }

  ui.message(
    'Detection checks presence only; crbuddy does not check whether CLIs are logged in.',
  );

  const panel = await buildPanel(ui, available, existing?.panel ?? []);
  const { merge, output } = await buildMerge(
    ui,
    available,
    existing?.merge,
    existing?.output,
    options.repoRoot,
  );
  const reviewTarget = await buildTarget(ui, existing?.target);

  const config: Config = {
    configVersion: CONFIG_VERSION,
    output,
    target: reviewTarget,
    refuseIfOutputExists:
      existing?.refuseIfOutputExists ?? DEFAULTS.refuseIfOutputExists,
    timeoutMs: existing?.timeoutMs ?? DEFAULTS.timeoutMs,
    mergeTimeoutMs: existing?.mergeTimeoutMs ?? DEFAULTS.mergeTimeoutMs,
    maxConcurrent: existing?.maxConcurrent ?? DEFAULTS.maxConcurrent,
    maxDiffBytes: existing?.maxDiffBytes ?? DEFAULTS.maxDiffBytes,
    merge,
    panel,
  };

  const gitignorePlan =
    scope === 'project' && options.repoRoot
      ? await planGitignore(ui, options.repoRoot, config)
      : null;

  ui.note(
    formatConfigSummary(scope, targetFile, config, gitignorePlan),
    'Configuration',
  );

  // Piped setup deliberately keeps its existing answer sequence. The final
  // confirmation is a TTY safeguard and defaults to yes there.
  if (ui.interactive && !(await ui.confirm('Save this config?', true))) {
    ui.cancel('Setup cancelled. No config was written.');
    return 1;
  }

  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (gitignorePlan) await applyGitignorePlan(ui, gitignorePlan);

  ui.outro(`Config saved to ${targetFile}\n   Run \`crbuddy go\` to start a review.`);

  return 0;
}

export function effectiveInitScope(
  requested: 'global' | 'project',
  repoRoot: string | null,
): 'global' | 'project' {
  return requested === 'project' && !repoRoot ? 'global' : requested;
}

interface GitignorePlan {
  path: string;
  current: string;
  missing: string[];
}

async function planGitignore(
  ui: WizardUI,
  repoRoot: string,
  config: Config,
): Promise<GitignorePlan | null> {
  // Two filters, two reasons. A report written outside the repository has
  // no .gitignore spelling and needs none; a terminal-mode config writes no
  // report at all, so offering to ignore one means editing a tracked file
  // over a file that will never exist. The working directory is always
  // created, so it is always worth ignoring.
  const reports =
    config.output.destination === 'file'
      ? [config.output.merged, config.output.raw]
      : [];

  // Mapped, not filtered: an absolute path can still resolve inside the
  // repo, and .gitignore needs the repo-relative spelling of it.
  const wanted = [...reports, `${WORK_DIR}/`]
    .map((entry) => repoRelative(entry, repoRoot))
    .filter((entry): entry is string => entry !== null);

  if (wanted.length === 0) return null;

  const gitignorePath = path.join(repoRoot, '.gitignore');

  let current = '';

  try {
    current = await readFile(gitignorePath, 'utf8');
  } catch {
    // No .gitignore yet; one will be created if the user agrees.
  }

  const lines = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );

  const missing = wanted.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return null;

  ui.note(missing.join('\n'), 'Files crbuddy writes into this repository');

  // Defaults to NO: .gitignore is usually a tracked file, and editing a
  // tracked file in the repo under review is not something to do on an
  // absent-minded Enter.
  const add = await ui.confirm(
    existsSync(gitignorePath)
      ? 'Add them to .gitignore? (this edits a tracked file)'
      : 'Create a .gitignore with them?',
    false,
  );

  return add ? { path: gitignorePath, current, missing } : null;
}

async function applyGitignorePlan(
  ui: WizardUI,
  plan: GitignorePlan,
): Promise<void> {
  const needsNewline = plan.current !== '' && !plan.current.endsWith('\n');
  const block =
    `${needsNewline ? '\n' : ''}` +
    `${plan.current === '' ? '' : '\n'}# crbuddy\n${plan.missing.join('\n')}\n`;

  await appendFile(plan.path, block, 'utf8');
  ui.message(`Updated ${plan.path}`, 'success');
}

export interface Detection {
  adapter: Adapter;
  present: boolean;
  version: string | null;
  error?: string;
}

async function detectAdapters(signal?: AbortSignal): Promise<Detection[]> {
  const results: Detection[] = [];

  for (const adapter of ADAPTERS) {
    const result = await probe(adapter.command, adapter.versionArgs(), signal);

    if (signal?.aborted) throw new PromptAborted();

    results.push({
      adapter,
      present: result.present,
      version: result.present ? adapter.parseVersion(result.output ?? '') : null,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  return results;
}

function formatDetection(detection: Detection): string {
  const mark = detection.present ? '\u2713' : '\u00b7';
  const version = detection.present
    ? detection.version ?? 'installed; version unknown'
    : 'unavailable';
  const summary =
    `${mark} ${detection.adapter.label}  ${version} ` +
    `(${detection.adapter.command})`;

  return detection.error ? `${summary}\n  ${detection.error}` : summary;
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
    .join(' \u00b7 ');
}

function formatPanel(panel: PanelEntry[]): string {
  return panel.map(formatReviewer).join('\n');
}

function formatConfigSummary(
  scope: 'global' | 'project',
  targetFile: string,
  config: Config,
  gitignorePlan: GitignorePlan | null,
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
    lines.push(`Consolidation: Enabled \u00b7 ${formatReviewer(merger)}`);
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

  if (gitignorePlan) {
    lines.push(`.gitignore: Add ${gitignorePlan.missing.join(', ')}`);
  }

  return lines.join('\n');
}

const OTHER = '\u0000other';

async function pickModel(
  ui: WizardUI,
  adapter: Adapter,
  current?: string,
): Promise<string> {
  const choices = adapter.models.map((model) => ({
    label: model.label,
    value: model.id,
    ...(model.hint ? { hint: model.hint } : {}),
  }));

  choices.push({
    label: 'Other\u2026',
    value: OTHER,
    hint: `any id \`${adapter.command}\` accepts, passed through unchecked`,
  });

  const preferred = current ?? adapter.defaultModel;
  const index = adapter.models.findIndex((model) => model.id === preferred);

  const chosen = await ui.select(
    `Model for ${adapter.label}`,
    choices,
    index >= 0 ? index : 0,
  );

  if (chosen === OTHER) {
    ui.message(
      `crbuddy passes this straight to \`${adapter.command}\` and does not ` +
        `validate it. Run \`${adapter.command} ${adapter.versionArgs().join(' ')}\`` +
        ` or check the vendor's docs for current ids.`,
    );

    return ui.text('Model id', current ?? '');
  }

  return chosen;
}

async function pickEffort(
  ui: WizardUI,
  adapter: Adapter,
  model: string,
  current?: string,
): Promise<string | undefined> {
  const efforts =
    adapter.models.find((entry) => entry.id === model)?.efforts ?? adapter.efforts;

  if (efforts.length === 0) {
    ui.message(`${adapter.label} has no thinking-effort setting; skipping.`);
    return undefined;
  }

  const choices: Array<{ label: string; value: string; hint?: string }> =
    efforts.map((level) => ({ label: level, value: level }));

  choices.push({
    label: 'Other\u2026',
    value: OTHER,
    hint: `any value \`${adapter.command}\` accepts, passed through unchecked`,
  });

  const preferred = current ?? adapter.defaultEffort ?? efforts[efforts.length - 1]!;
  const index = efforts.indexOf(preferred);

  const chosen = await ui.select(
    `Thinking effort for ${adapter.label}`,
    choices,
    index >= 0 ? index : 0,
  );

  return chosen === OTHER ? ui.text('Effort value', current ?? '') : chosen;
}

async function buildPanel(
  ui: WizardUI,
  available: Adapter[],
  existing: PanelEntry[],
): Promise<PanelEntry[]> {
  const panel: PanelEntry[] = [];

  if (existing.length > 0) {
    ui.note(formatPanel(existing), 'Current panel');

    if (await ui.confirm('Keep these reviewers?', true)) {
      panel.push(...existing);
      ui.note(formatPanel(panel), 'Panel');
    } else {
      // Said out loud because nothing else on screen changes: the listing
      // above stays visible, and without this the next prompt reads as if
      // it were adding to the panel still printed there.
      ui.message('Panel cleared for now.');
    }
  }

  // "Run" is already taken: one `crbuddy go` invocation is a run, and the
  // report calls each lane's record a run too. The user-facing word for a
  // lane is "reviewer", which is also what makes the blindness legible.
  ui.message(
    'Now add the reviewers. `crbuddy go` starts all of them at once, ' +
      'each one blind to what the others find.',
  );

  for (;;) {
    if (panel.length > 0) {
      const more = await ui.confirm(
        `${panel.length} reviewer${panel.length === 1 ? '' : 's'} configured. ` +
          `Add another?`,
        false,
      );

      if (!more) break;
    }

    const adapter = await ui.select(
      'Add a reviewer',
      available.map((candidate) => ({ label: candidate.label, value: candidate })),
      0,
    );

    const model = await pickModel(ui, adapter);
    const effort = await pickEffort(ui, adapter, model);

    let instructions: string | undefined;

    if (!adapter.nativeReview) {
      ui.message(
        `${adapter.label} does not expose a supported headless native code-review ` +
          'operation, so this lane needs explicit review instructions.',
        'warn',
      );
      instructions = await ui.text('Review instructions');
    } else {
      const custom = await ui.confirm(
        `Give this reviewer custom instructions? ` +
          `(default: ${adapter.nativeReviewCommand ?? 'the vendor\u2019s own review'})`,
        false,
      );
      instructions = custom ? await ui.text('Review instructions') : undefined;
    }

    const seen = new Set(panel.map((entry) => entry.id));
    const base = slug(`${adapter.name}-${model}`);

    let id = base;
    let n = 2;

    while (seen.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }

    const entry: PanelEntry = { id, vendor: adapter.name, model };
    if (effort) entry.effort = effort;
    if (instructions) entry.instructions = instructions;

    panel.push(entry);
    ui.message(`Added ${formatReviewer(entry)}`, 'success');
    ui.note(formatPanel(panel), 'Panel');
  }

  if (panel.length === 0) {
    throw new Error('A panel needs at least one run.');
  }

  return panel;
}

/**
 * The consolidation answer and the destination are asked together because
 * they describe the same artifact, but the destination is asked either way:
 * `output.merged` is written whatever the answer is — holding the unmerged
 * reviews when consolidation is off — so skipping the question there would
 * silently pin those runs to the repository root.
 */
async function buildMerge(
  ui: WizardUI,
  available: Adapter[],
  existing: MergeConfig | undefined,
  existingOutput: OutputConfig | undefined,
  repoRoot: string | null,
): Promise<{ merge: MergeConfig; output: OutputConfig }> {
  const destination = await ui.select<OutputDestination>(
    'Where should the output go?',
    [
      {
        label: 'Write a report to disk',
        value: 'file',
        hint: 'a markdown file you can point an agent at',
      },
      {
        label: 'Print it to the terminal',
        value: 'terminal',
        hint: 'nothing is written; copy it at the end or scroll back',
      },
    ],
    (existingOutput ?? DEFAULT_OUTPUT).destination === 'terminal' ? 1 : 0,
  );

  const enabled = await ui.confirm(
    'When done, run a consolidation pass to group duplicate findings? ' +
      (destination === 'terminal'
        ? '(the report is printed either way)'
        : '(the report is written either way)'),
    existing?.enabled ?? true,
  );

  // Only "file" has anywhere to put it. The paths are still carried in the
  // config so switching back to "file" later restores the last choice.
  const output =
    destination === 'terminal'
      ? usableOrDefault(
          ui,
          { ...(existingOutput ?? DEFAULT_OUTPUT), destination: 'terminal' as const },
          repoRoot,
        )
      : await pickOutputLocation(ui, existingOutput, repoRoot, enabled);

  if (!enabled) {
    return { merge: { enabled: false, vendor: '', model: '' }, output };
  }

  const currentIndex = available.findIndex(
    (candidate) => candidate.name === existing?.vendor,
  );

  const adapter = await ui.select(
    'Which CLI should consolidate?',
    available.map((candidate) => ({ label: candidate.label, value: candidate })),
    currentIndex >= 0 ? currentIndex : 0,
  );

  const model = await pickModel(ui, adapter, existing?.model);
  const effort = await pickEffort(ui, adapter, model, existing?.effort);

  const merge: MergeConfig = { enabled: true, vendor: adapter.name, model };
  if (effort) merge.effort = effort;

  return { merge, output };
}

/**
 * Stored relative to the repository root, so one config can serve many
 * repositories: `../` means "beside whatever repo is under review", not one
 * fixed directory. A directory that cannot be said that way is stored
 * absolute, which pins every repository to the same file.
 */
async function pickOutputLocation(
  ui: WizardUI,
  existing: OutputConfig | undefined,
  repoRoot: string | null,
  consolidating: boolean,
): Promise<OutputConfig> {
  const current = existing ?? DEFAULT_OUTPUT;
  const currentDir = path.dirname(current.merged).replace(/\\/g, '/');

  const where = await ui.select<'root' | 'up' | 'custom'>(
    'Where should the report be written?',
    [
      {
        label: "The repository's root directory",
        value: 'root',
        hint: path.basename(current.merged),
      },
      {
        label: 'One level up from the repository root',
        value: 'up',
        // Worth saying: outside the repo, the report cannot land in a diff,
        // be committed by accident, or be read by the next run's reviewers.
        hint: `../${path.basename(current.merged)} - outside the repo entirely`,
      },
      {
        label: 'Somewhere else…',
        value: 'custom',
        hint: 'give a path below',
      },
    ],
    currentDir === '.' ? 0 : currentDir === '..' ? 1 : 2,
  );

  // Validated on every branch, not just the typed one. These two build
  // paths from an existing config, and a config can carry names that only
  // work in the directories they came from.
  if (where === 'root' || where === 'up') {
    return usableOrDefault(
      ui,
      inDirectory(where === 'root' ? '.' : '..', existing),
      repoRoot,
    );
  }

  for (;;) {
    ui.message(
      'Enter a directory, not a filename. It may be absolute or relative ' +
        'to the repository root.',
    );

    const answer = await ui.text(
      'Path to the directory?',
      currentDir === '.' || currentDir === '..' ? '' : currentDir,
    );

    const candidate = inDirectory(storedDirectory(answer, repoRoot), existing);

    try {
      assertUsableOutput(candidate, 'output', repoRoot ?? undefined);
    } catch (error) {
      ui.message(error instanceof Error ? error.message : String(error), 'error');
      continue;
    }

    // Echoed because the answer is rewritten: someone who typed an absolute
    // path should see that it became repo-relative, and vice versa.
    ui.message(`Writing to ${candidate.merged}`);

    if (path.isAbsolute(candidate.merged)) {
      ui.message(
        'This is an absolute path, so every repository shares this one file.',
        'warn',
      );
    }

    if (consolidating) ui.message(`Raw reviews will be written to ${candidate.raw}`);

    return candidate;
  }
}

/**
 * Last line of defence for the branches with no re-prompt loop: an
 * unusable choice falls back to the defaults with a note, rather than
 * throwing out of the wizard or writing a config that will not load.
 */
function usableOrDefault(
  ui: WizardUI,
  candidate: OutputConfig,
  repoRoot: string | null,
): OutputConfig {
  try {
    assertUsableOutput(candidate, 'output', repoRoot ?? undefined);
    return candidate;
  } catch (error) {
    ui.message(error instanceof Error ? error.message : String(error), 'error');
    ui.message('Using the default filenames instead.', 'warn');

    return { ...DEFAULT_OUTPUT, destination: candidate.destination };
  }
}

/**
 * Only the directory is chosen here, so a config that already names its
 * files keeps those names. Rebuilding both paths from the defaults would
 * silently rename a hand-edited `output.merged` the moment someone re-ran
 * `crbuddy config` and accepted the location it was already using.
 */
export function inDirectory(directory: string, existing?: OutputConfig): OutputConfig {
  const merged = path.basename(existing?.merged ?? DEFAULT_OUTPUT.merged);
  let raw = path.basename(existing?.raw ?? DEFAULT_OUTPUT.raw);

  // Two directories can hold two files of the same name; collapsing them
  // into one directory would make them one file, and the wizard would
  // write a config that `crbuddy go` then refuses to load.
  if (raw === merged) {
    const extension = path.extname(merged);
    raw = `${merged.slice(0, merged.length - extension.length)}.raw${extension}`;
  }

  if (directory === '.') return { destination: 'file', merged, raw };

  const clean = directory.replace(/\/+$/, '');

  return {
    destination: 'file',
    merged: `${clean}/${merged}`,
    raw: `${clean}/${raw}`,
  };
}

/**
 * One level up is a sibling of the repository — a relationship that still
 * holds in whichever repository the config is used from. Several levels up
 * is not: it would resolve somewhere different in every repo, so it is
 * pinned absolute instead of being stored as a pile of `..`.
 */
export function storedDirectory(answer: string, repoRoot: string | null): string {
  const typed = answer.trim();
  const expanded =
    typed === '~' || typed.startsWith('~/') || typed.startsWith('~\\')
      ? path.join(homedir(), typed.slice(1))
      : typed;

  // A relative answer is anchored to the repository root, matching how the
  // two fixed choices above are phrased.
  const anchor = repoRoot ?? process.cwd();
  const absolute = path.resolve(anchor, expanded);
  const posix = (value: string): string => value.replace(/\\/g, '/');

  if (!repoRoot) return posix(absolute);

  const relative = path.relative(repoRoot, absolute);

  if (relative === '') return '.';

  // A different drive on Windows has no relative spelling at all.
  if (path.isAbsolute(relative)) return posix(absolute);

  const climbs = posix(relative)
    .split('/')
    .filter((part) => part === '..').length;

  return climbs > 1 ? posix(absolute) : posix(relative);
}

async function buildTarget(
  ui: WizardUI,
  existing: Target | undefined,
): Promise<Target> {
  const kind = await ui.select<'uncommitted' | 'branch'>(
    'What should crbuddy review by default?',
    [
      {
        label: 'All uncommitted changes',
        value: 'uncommitted',
        hint: 'tracked and untracked',
      },
      {
        label: 'This branch versus another branch',
        value: 'branch',
        hint: 'PR-style',
      },
    ],
    existing && typeof existing === 'object' ? 1 : 0,
  );

  if (kind === 'uncommitted') return 'uncommitted';

  const base = await ui.text(
    'Base branch to compare against?',
    typeof existing === 'object' ? existing.base : 'main',
  );

  return { base };
}
