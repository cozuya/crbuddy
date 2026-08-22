import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CONFIG_VERSION,
  Config,
  DEFAULTS,
  DEFAULT_OUTPUT,
  MergeConfig,
  PanelEntry,
  Target,
  WORK_DIR,
} from '../config/schema.js';
import {
  homeConfigPath,
  projectConfigPath,
  readAndValidate,
  slug,
} from '../config/load.js';
import { ADAPTERS, getAdapter } from '../adapters/vendors.js';
import { probe } from '../run/spawn.js';
import { Adapter } from '../adapters/types.js';
import { PromptAborted, confirm, dim, select, text } from '../util/prompt.js';

/**
 * `crbuddy init` and `crbuddy config` are the same command. `init` is the
 * discoverable name for first use; `config` is what people reach for later.
 * Both load-and-edit an existing config rather than overwriting blind.
 */

export interface InitOptions {
  repoRoot: string | null;
  scope?: 'global' | 'project';
}

export async function runInit(options: InitOptions): Promise<number> {
  try {
    return await wizard(options);
  } catch (error) {
    const name = (error as { name?: string })?.name;

    if (error instanceof PromptAborted || name === 'AbortError') {
      // A deliberate Ctrl-C is not a crash and should not print a stack.
      console.log('');
      console.log('crbuddy setup not completed — aborted. No config was written.');
      return 130;
    }

    throw error;
  }
}

async function wizard(options: InitOptions): Promise<number> {
  console.log('');
  console.log('crbuddy setup');

  // Outside a git repo the project option is not merely unavailable, it is
  // meaningless — so it is omitted rather than shown grayed out.
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

  const scope =
    options.scope ??
    (scopeChoices.length === 1
      ? 'global'
      : await select<'global' | 'project'>(
          'Where should this config live?',
          scopeChoices,
          0,
        ));

  const targetFile =
    scope === 'project' && options.repoRoot
      ? projectConfigPath(options.repoRoot)
      : homeConfigPath();

  // A project-local config REPLACES the global one, so editing global while
  // a local one exists here changes a file that will never be read in this
  // repo. Silence there is how you end up debugging a panel you did not run.
  if (scope === 'global' && options.repoRoot) {
    const local = projectConfigPath(options.repoRoot);

    if (existsSync(local)) {
      console.log('');
      console.log(
        `Heads up: this repository has its own config at ${local}, and a ` +
          `project config replaces the global one entirely.`,
      );
      console.log(
        dim('  `crbuddy go` here will use that file, not the one you are about to edit.'),
      );

      const switchToLocal = await confirm('  Edit the repository config instead?', true);

      if (switchToLocal) {
        return wizard({ ...options, scope: 'project' });
      }
    }
  }

  let existing: Config | null = null;

  if (existsSync(targetFile)) {
    console.log('');
    console.log(`Editing the existing config at ${targetFile}.`);

    try {
      existing = await readAndValidate(targetFile);
    } catch (error) {
      console.log(`  (could not parse it: ${String(error)})`);

      const start = await confirm(
        '  Start from scratch instead? The old file will be replaced.',
        false,
      );

      if (!start) return 1;
    }
  }

  console.log('');
  console.log('Checking which vendor CLIs are installed…');

  const detections = await detectAdapters();
  const available = detections.filter((d) => d.present).map((d) => d.adapter);

  for (const detection of detections) {
    // Dimmed: useful confirmation, but not something the user must act on.
    console.log(
      dim(
        `  ${detection.present ? '\u2713' : '\u00b7'} ${detection.adapter.label} ` +
          `(${detection.adapter.command})`,
      ),
    );

    // A bare dot with no reason makes a PATH problem indistinguishable from
    // a broken install. This one is not dimmed — it needs acting on.
    if (detection.error) {
      console.log(`      ${detection.error}`);
    }
  }

  if (available.length === 0) {
    console.log('');
    console.log(
      'No supported vendor CLIs are usable. crbuddy drives your own\n' +
        'installed agent CLIs, so at least one has to work here.\n' +
        'Run `crbuddy doctor` for details.',
    );
    return 1;
  }

  console.log('');
  console.log(
    dim('  (Presence only — crbuddy does not check whether they are logged in.)'),
  );

  const panel = await buildPanel(available, existing?.panel ?? []);
  const merge = await buildMerge(available, existing?.merge);
  const reviewTarget = await buildTarget(existing?.target);

  const config: Config = {
    configVersion: CONFIG_VERSION,
    output: existing?.output ?? { ...DEFAULT_OUTPUT },
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

  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (scope === 'project' && options.repoRoot) {
    await offerGitignore(options.repoRoot, config);
  }

  console.log('');
  console.log(`Wrote ${targetFile}`);
  console.log('');
  console.log('Run `crbuddy go` to start a review.');

  return 0;
}

/**
 * crbuddy's own artifacts are untracked files in the repo it reviews, and
 * the default target includes untracked files. `go` already excludes them
 * from the diff, but they would still show up in `git status` and get
 * committed by a careless `git add -A` — so offer to ignore them once, at
 * the point the user opts into a project-local setup.
 */
async function offerGitignore(repoRoot: string, config: Config): Promise<void> {
  const wanted = [config.output.merged, config.output.raw, `${WORK_DIR}/`];

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

  if (missing.length === 0) return;

  console.log('');
  console.log("crbuddy writes these into the repository:");

  for (const entry of missing) {
    console.log(dim(`  ${entry}`));
  }

  // Defaults to NO: .gitignore is usually a tracked file, and editing a
  // tracked file in the repo under review is not something to do on an
  // absent-minded Enter.
  const add = await confirm(
    existsSync(gitignorePath)
      ? 'Add them to .gitignore? (this edits a tracked file)'
      : 'Create a .gitignore with them?',
    false,
  );

  if (!add) return;

  const needsNewline = current !== '' && !current.endsWith('\n');

  const block =
    `${needsNewline ? '\n' : ''}` +
    `${current === '' ? '' : '\n'}# crbuddy\n${missing.join('\n')}\n`;

  await appendFile(gitignorePath, block, 'utf8');

  console.log(dim(`  Updated ${gitignorePath}`));
}

interface Detection {
  adapter: Adapter;
  present: boolean;
  error?: string;
}

async function detectAdapters(): Promise<Detection[]> {
  const results: Detection[] = [];

  for (const adapter of ADAPTERS) {
    const result = await probe(adapter.command, adapter.versionArgs());

    results.push({
      adapter,
      present: result.present,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  return results;
}

const OTHER = '\u0000other';

async function pickModel(adapter: Adapter, current?: string): Promise<string> {
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

  const chosen = await select(
    `Model for ${adapter.label}?`,
    choices,
    index >= 0 ? index : 0,
  );

  // The lists are advisory; config accepts any string, so a stale list is a
  // convenience problem rather than a blocker.
  if (chosen === OTHER) {
    console.log(
      dim(
        `  crbuddy passes this straight to \`${adapter.command}\` and does not ` +
          `validate it.\n  Run \`${adapter.command} ${adapter.versionArgs().join(' ')}\`` +
          ` or check the vendor's docs for current ids.`,
      ),
    );

    return text('  Model id:', current ?? '');
  }

  return chosen;
}

/**
 * Effort values come from the vendor and are stored verbatim. A vendor with
 * no effort control skips the question rather than asking about something
 * that will be ignored.
 */
async function pickEffort(
  adapter: Adapter,
  model: string,
  current?: string,
): Promise<string | undefined> {
  const efforts =
    adapter.models.find((entry) => entry.id === model)?.efforts ?? adapter.efforts;

  if (efforts.length === 0) {
    console.log('');
    console.log(dim(`  ${adapter.label} has no thinking-effort setting; skipping.`));
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

  const chosen = await select(
    `Thinking effort for ${adapter.label}?`,
    choices,
    index >= 0 ? index : 0,
  );

  return chosen === OTHER ? text('  Effort value:', current ?? '') : chosen;
}

async function buildPanel(
  available: Adapter[],
  existing: PanelEntry[],
): Promise<PanelEntry[]> {
  const panel: PanelEntry[] = [];

  if (existing.length > 0) {
    console.log('');
    console.log('Current panel:');

    existing.forEach((entry) => {
      // The id is an internal handle for provenance; it is not what someone
      // reading their own config wants to see.
      let label = entry.vendor;

      try {
        label = getAdapter(entry.vendor).label;
      } catch {
        // Unknown vendor in an existing config; show it as written.
      }

      console.log(
        dim(
          `  ${label}: ${entry.model}` +
            (entry.effort ? ` - thinking level: ${entry.effort}` : '') +
            (entry.instructions ? ' (custom instructions)' : ''),
        ),
      );
    });

    if (await confirm('Keep these entries?', true)) {
      panel.push(...existing);
    }
  }

  console.log('');
  console.log(
    'Add your review runs now - when `crbuddy go` is invoked, all of these ' +
      'run at once, independently.',
  );

  for (;;) {
    if (panel.length > 0) {
      const more = await confirm(`Add another run? (${panel.length} configured)`, false);
      if (!more) break;
    }

    const adapter = await select(
      'Which CLI?',
      available.map((candidate) => ({ label: candidate.label, value: candidate })),
      0,
    );

    const model = await pickModel(adapter);
    const effort = await pickEffort(adapter, model);

    const custom = await confirm(
      'Give this run custom review instructions? ' +
        '(default: the vendor\u2019s own review behavior)',
      false,
    );

    const instructions = custom ? await text('Instructions:') : undefined;

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

    console.log(`  added ${id}`);
  }

  if (panel.length === 0) {
    throw new Error('A panel needs at least one run.');
  }

  return panel;
}

async function buildMerge(
  available: Adapter[],
  existing: MergeConfig | undefined,
): Promise<MergeConfig> {
  console.log('');

  const enabled = await confirm(
    'Consolidate the reviews into a single merged file? This does not attempt to dedupe.',
    existing?.enabled ?? true,
  );

  if (!enabled) {
    return { enabled: false, vendor: '', model: '' };
  }

  const currentIndex = available.findIndex(
    (candidate) => candidate.name === existing?.vendor,
  );

  const adapter = await select(
    'Which CLI should consolidate?',
    available.map((candidate) => ({ label: candidate.label, value: candidate })),
    currentIndex >= 0 ? currentIndex : 0,
  );

  const model = await pickModel(adapter, existing?.model);
  const effort = await pickEffort(adapter, model, existing?.effort);

  const merge: MergeConfig = { enabled: true, vendor: adapter.name, model };
  if (effort) merge.effort = effort;

  return merge;
}

async function buildTarget(existing: Target | undefined): Promise<Target> {
  const kind = await select<'uncommitted' | 'branch'>(
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

  const base = await text(
    'Base branch to compare against?',
    typeof existing === 'object' ? existing.base : 'main',
  );

  return { base };
}
