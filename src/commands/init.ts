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
  insideRepo,
  projectConfigPath,
  readAndValidate,
  slug,
} from '../config/load.js';
import { ADAPTERS, getAdapter } from '../adapters/vendors.js';
import { probe } from '../run/spawn.js';
import { Adapter } from '../adapters/types.js';
import { PromptAborted, confirm, dim, select, text } from '../util/prompt.js';

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
      console.log('');
      console.log('crbuddy setup aborted. No config was written.');
      return 130;
    }

    throw error;
  }
}

async function wizard(options: InitOptions): Promise<number> {
  console.log('');
  console.log('crbuddy setup');

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
          'Where should this config live? Local overrides global.',
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
    console.log(
      dim(
        `  ${detection.present ? '\u2713' : '\u00b7'} ${detection.adapter.label} ` +
          `(${detection.adapter.command})`,
      ),
    );

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
    dim('  (Presence only; crbuddy does not check whether they are logged in.)'),
  );

  const panel = await buildPanel(available, existing?.panel ?? []);
  const { merge, output } = await buildMerge(
    available,
    existing?.merge,
    existing?.output,
    options.repoRoot,
  );
  const reviewTarget = await buildTarget(existing?.target);

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

async function offerGitignore(repoRoot: string, config: Config): Promise<void> {
  // Two filters, two reasons. A report written outside the repository has
  // no .gitignore spelling and needs none; a terminal-mode config writes no
  // report at all, so offering to ignore one means editing a tracked file
  // over a file that will never exist. The working directory is always
  // created, so it is always worth ignoring.
  const reports =
    config.output.destination === 'file'
      ? [config.output.merged, config.output.raw]
      : [];

  const wanted = [...reports, `${WORK_DIR}/`].filter((entry) => insideRepo(entry));

  if (wanted.length === 0) return;

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
  console.log('crbuddy writes these into the repository:');

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

    if (await confirm('Keep these reviewers?', true)) {
      panel.push(...existing);
    } else {
      // Said out loud because nothing else on screen changes: the listing
      // above stays visible, and without this the next prompt reads as if
      // it were adding to the panel still printed there.
      console.log(dim('  Panel cleared for now.'));
    }
  }

  console.log('');
  // "Run" is already taken: one `crbuddy go` invocation is a run, and the
  // report calls each lane's record a run too. The user-facing word for a
  // lane is "reviewer", which is also what makes the blindness legible.
  console.log(
    'Now add the reviewers. `crbuddy go` starts all of them at once, ' +
      'each one blind to what the others find.',
  );

  for (;;) {
    if (panel.length > 0) {
      const more = await confirm(
        `${panel.length} reviewer${panel.length === 1 ? '' : 's'} configured. ` +
          `Add another?`,
        false,
      );

      if (!more) break;
    }

    const adapter = await select(
      'Which CLI?',
      available.map((candidate) => ({ label: candidate.label, value: candidate })),
      0,
    );

    const model = await pickModel(adapter);
    const effort = await pickEffort(adapter, model);

    let instructions: string | undefined;

    if (!adapter.nativeReview) {
      console.log('');
      console.log(
        dim(
          `  ${adapter.label} does not expose a supported headless native code-review ` +
            'operation, so this lane needs explicit review instructions.',
        ),
      );
      instructions = await text('Instructions:');
    } else {
      const custom = await confirm(
        `Give this reviewer custom instructions? ` +
          `(default: ${adapter.nativeReviewCommand ?? 'the vendor\u2019s own review'})`,
        false,
      );
      instructions = custom ? await text('Instructions:') : undefined;
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
    console.log(`  added ${id}`);
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
  available: Adapter[],
  existing: MergeConfig | undefined,
  existingOutput: OutputConfig | undefined,
  repoRoot: string | null,
): Promise<{ merge: MergeConfig; output: OutputConfig }> {
  console.log('');

  const destination = await select<OutputDestination>(
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

  const enabled = await confirm(
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
      ? { ...(existingOutput ?? DEFAULT_OUTPUT), destination: 'terminal' as const }
      : await pickOutputLocation(existingOutput, repoRoot, enabled);

  if (!enabled) {
    return { merge: { enabled: false, vendor: '', model: '' }, output };
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

  return { merge, output };
}

/**
 * Stored relative to the repository root, so one config can serve many
 * repositories: `../` means "beside whatever repo is under review", not one
 * fixed directory. A directory that cannot be said that way is stored
 * absolute, which pins every repository to the same file.
 */
async function pickOutputLocation(
  existing: OutputConfig | undefined,
  repoRoot: string | null,
  consolidating: boolean,
): Promise<OutputConfig> {
  const current = existing ?? DEFAULT_OUTPUT;
  const currentDir = path.dirname(current.merged).replace(/\\/g, '/');

  console.log('');

  const where = await select<'root' | 'up' | 'custom'>(
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

  if (where === 'root') return inDirectory('.', existing);
  if (where === 'up') return inDirectory('..', existing);

  for (;;) {
    console.log(
      dim(
        '  A directory, not a filename. Absolute, or relative to the ' +
          'repository root.',
      ),
    );

    const answer = await text(
      'Path to the directory?',
      currentDir === '.' || currentDir === '..' ? '' : currentDir,
    );

    const candidate = inDirectory(storedDirectory(answer, repoRoot), existing);

    try {
      assertUsableOutput(candidate, 'output');
    } catch (error) {
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    // Echoed because the answer is rewritten: someone who typed an absolute
    // path should see that it became repo-relative, and vice versa.
    console.log(dim(`  writing to ${candidate.merged}`));

    if (path.isAbsolute(candidate.merged)) {
      console.log(
        dim('  (an absolute path, so every repository shares this one file)'),
      );
    }

    if (consolidating) console.log(dim(`  alongside ${candidate.raw}`));

    return candidate;
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
  const raw = path.basename(existing?.raw ?? DEFAULT_OUTPUT.raw);

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
