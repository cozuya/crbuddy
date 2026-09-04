import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { HOME_CONFIG_DIR, PanelEntry, WORK_DIR } from '../config/schema.js';
import {
  assertUsableOutput,
  canonicalOutputPath,
  ConfigError,
  LoadedConfig,
  repoRelative,
  resolveOutputPaths,
} from '../config/load.js';
import {
  captureCheckoutSnapshot,
  ResolvedTarget,
  resolveTarget,
} from '../git/target.js';
import { Adapter, UnsafeInvocationError } from '../adapters/types.js';
import { getAdapter } from '../adapters/vendors.js';
import { isVersionAtLeast } from '../adapters/version.js';
import { Semaphore } from '../util/semaphore.js';
import { Lock, acquireLock, acquireLockAt } from '../util/lock.js';
import { killAll, probe, runProcess } from '../run/spawn.js';
import { Finding, relativizePaths, segment } from '../merge/segment.js';
import {
  MergeValidationError,
  buildMergePrompt,
  orderClusters,
  parseClusterResponse,
  singletons,
  validateClusters,
} from '../merge/cluster.js';
import {
  ReportContext,
  RunRecord,
  renderMerged,
  renderRaw,
} from '../output/render.js';
import {
  cleanupTemps,
  commitOutputs,
  recoverStrandedOutputs,
  stashExistingOutputs,
} from '../output/write.js';
import { progress } from '../run/progress.js';
import { copyToClipboard } from '../util/clipboard.js';
import { PromptAborted, dim, select } from '../util/prompt.js';
import { formatClock, formatElapsed, formatSize } from '../util/format.js';
import { buildReviewerOperation } from '../review/instructions.js';

/** Below this, a "successful" review is more likely a status message. */
const SUSPICIOUSLY_SHORT = 200;

/** What every whole-checkout run has to establish before anything else. */
const WHOLE_CHECKOUT_SUBJECT =
  'Review this repository as it currently stands. There is no diff to review, ' +
  'so treat the checked-out code itself as the subject.';

/**
 * Used when there is no diff at all and the entry has no instructions of its
 * own. Deliberately not phrased as a diff prompt: there is no range to anchor
 * to, so the reviewer is pointed at the checkout itself. The "do not modify"
 * line is spelled out because `genericPrompt` only appends it when there IS a
 * range.
 */
const WHOLE_CHECKOUT_INSTRUCTIONS =
  `${WHOLE_CHECKOUT_SUBJECT} Report concrete, actionable defects with file ` +
  `paths and line numbers, covering correctness bugs, error handling, ` +
  `resource cleanup, and security. Do not modify any files.`;

/**
 * Custom instructions say what to look FOR; they never say what the subject
 * IS. With `target: null` there is no range for `genericPrompt` to describe,
 * so without this the reviewer gets a brief with nothing to apply it to.
 * The framing goes first and the user's words after, so theirs read as the
 * instruction and this as the setting.
 */
export function wholeCheckoutPrompt(instructions: string | undefined): string {
  if (!instructions) return WHOLE_CHECKOUT_INSTRUCTIONS;

  return (
    `${WHOLE_CHECKOUT_SUBJECT}\n\n` +
    `${instructions}\n\n` +
    `Report concrete, actionable findings with file paths and line numbers. ` +
    `Do not modify any files.`
  );
}

export const EXIT_OK = 0;
export const EXIT_TOTAL_FAILURE = 1;
/** Reserved for partial success so `--strict` can be added without breakage. */
export const EXIT_PARTIAL = 2;

export interface GoOptions {
  repoRoot: string;
  loaded: LoadedConfig;
  version: string;
  /** Positional argument: overrides `instructions` on EVERY panel entry. */
  instructionsOverride?: string;
  force: boolean;
  wholeCheckout: boolean;
  strict: boolean;
}

export async function runGo(options: GoOptions): Promise<number> {
  const { repoRoot, loaded, version } = options;
  const config = loaded.config;

  // Resolve and validate this before creating any per-run directory. A
  // repository rooted at the home directory would otherwise contain the
  // supposedly external state used to isolate concurrent review lanes.
  const stateDir = repoStateDir(repoRoot);
  const workDir = path.join(repoRoot, WORK_DIR);
  await mkdir(workDir, { recursive: true });

  // Volatile state lives outside the repository, not under `.crbuddy/`.
  // Reviewers read the tree freely, so a previous report stashed inside it
  // and one lane's live stdout are both readable by another lane - blindness
  // that the diff pathspec cannot enforce, and that a whole-checkout run
  // (no pathspec at all) loses entirely.
  //
  // Under the home directory rather than the OS temp directory because a
  // crashed run's only copy of the previous report lives here until the next
  // run recovers it, and temp is not somewhere to keep the only copy.
  const scratch = path.join(stateDir, 'scratch');
  let mergeDir: string | null = null;
  let ownsRunState = true;

  const cleanupRunState = async (): Promise<void> => {
    if (!ownsRunState) return;
    ownsRunState = false;

    const pendingMergeDir = mergeDir;
    mergeDir = null;
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (pendingMergeDir) {
      await rm(pendingMergeDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  // No volatile shared state is touched until this succeeds. In particular,
  // a second invocation must not clear the active run's scratch or stash on
  // its way to reporting lock contention.
  let lock: Lock | null = await acquireLock(workDir);
  let outputLocks: Lock[] = [];

  const releaseRunLocks = async (): Promise<void> => {
    await releaseAll(outputLocks);
    outputLocks = [];

    if (lock) {
      const held = lock;
      lock = null;
      await held.release();
    }
  };

  let stashed: Awaited<ReturnType<typeof stashExistingOutputs>> | null = null;
  let interrupted = false;

  const onInterrupt = () => {
    if (interrupted) {
      // Second Ctrl-C: stop being polite.
      progress.stopPulse();
      killAll('SIGKILL');
      process.exit(130);
    }

    interrupted = true;
    progress.dim('');
    progress.line('Interrupted - terminating agents and restoring previous output.');
    killAll('SIGTERM');
  };

  const restorePreviousOutput = async (): Promise<void> => {
    const pending = stashed;
    stashed = null;

    if (pending) reportStranded(await pending.restore());
  };

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    // Freeze the real destinations before making any safety decision. Every
    // later output operation receives these same canonical absolute paths,
    // so a parent-directory symlink cannot be "inside" for consent but
    // somewhere else for locking or writes.
    assertUsableOutput(config.output, 'output', repoRoot);
    const outputPaths = resolveOutputPaths(repoRoot, config.output);

    // The config validator can only compare the two paths as written, and
    // `same.md` and `<repo>/same.md` are the same file spelled two ways.
    // Terminal mode also stashes both paths for reviewer blindness, so this
    // is an invalid configuration regardless of the final destination.
    const mergedOutput = outputPaths.merged;
    const rawOutput = outputPaths.raw;

    if (pathKey(mergedOutput) === pathKey(rawOutput)) {
      throw new ConfigError(
        `output.merged and output.raw resolve to the same file:\n` +
          `  ${mergedOutput}\n` +
          `They are spelled differently in the config, but they are one ` +
          `path. Point them at different files.`,
      );
    }

    // A project-local config is a file that ships with a repository, so a
    // repository you merely cloned can choose where crbuddy writes. Obtain
    // consent before cleanup or crash recovery touches any such path.
    const external = [outputPaths.merged, outputPaths.raw]
      .filter((absolute) => repoRelative(absolute, repoRoot) === null);

    if (loaded.scope === 'project' && external.length > 0) {
      progress.line(
        config.output.destination === 'file'
          ? 'This repository’s own config writes outside the repository:'
          : 'This repository’s own config uses output paths outside the repository:',
      );

      for (const file of [...new Set(external)]) progress.line(`  ${file}`);

      progress.dim(
        config.output.destination === 'file'
          ? '  crbuddy did not choose these paths - the config in this repository did. ' +
            'An existing file there is moved aside and replaced by the report.'
          : '  crbuddy did not choose these paths - the config in this repository did. ' +
            'Existing files there may be moved aside while reviewers run, then restored.',
      );

      if (!canConfirm()) {
        throw new PreflightError(
          'Refusing to use output paths outside the repository from a project-local ' +
            'config without confirmation. Move that output setting into your ' +
            'global config (`crbuddy init --global`), or run interactively ' +
            'to confirm this run.',
        );
      }

      if (!(await confirm('Continue?'))) {
        progress.line('Aborted.');
        return EXIT_TOTAL_FAILURE;
      }
    }

    // Hold the destination locks while checking whether existing files may
    // be replaced. Otherwise another repository sharing an output path can
    // change that answer between confirmation and commit.
    outputLocks = await acquireOutputLocks(outputPaths);

    // Recover anything a crashed run left in a holding directory before
    // deciding whether an existing report may be replaced. Otherwise the
    // refusal check sees an empty destination, recovery restores the report,
    // and this run overwrites it without the configured confirmation.
    // External project-config paths have already passed their separate gate.
    const recovered = [
      ...(await recoverStrandedOutputs(repoRoot, stateDir, {
        allowedPaths: [outputPaths.merged, outputPaths.raw],
      })),
      ...(await recoverStrandedOutputs(repoRoot, workDir, {
        allowedPaths: [outputPaths.merged, outputPaths.raw],
      })),
    ];

    if (recovered.length > 0) {
      progress.dim(
        `Recovered ${recovered.join(', ')} left behind by an interrupted run.`,
      );
    }

    // Nothing is replaced when the report only ever reaches the terminal.
    if (config.refuseIfOutputExists && config.output.destination === 'file') {
      const existing = [outputPaths.merged, outputPaths.raw].filter((absolute) =>
        existsSync(absolute),
      );

      if (existing.length > 0) {
        if (!canConfirm()) {
          throw new PreflightError(
            '`refuseIfOutputExists` is enabled and review output already exists, ' +
              'but crbuddy cannot ask for confirmation because stdin and stderr ' +
              'are not both attached to a terminal. Run interactively with stderr ' +
              'visible, or disable `refuseIfOutputExists` if replacement is intended.',
          );
        }

        const ok = await confirm(
          `These files already exist and will be replaced:\n` +
            existing.map((file) => `  ${file}`).join('\n') +
            `\nContinue?`,
        );

        if (!ok) {
          progress.line('Aborted.');
          return EXIT_TOTAL_FAILURE;
        }
      }
    }

    // `scratch` is where every panel lane spools `<id>.stdout`. It is removed
    // before consolidation, and the consolidator later receives its own
    // unique cwd outside this state tree.
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });

    await cleanupTemps(repoRoot, [outputPaths.merged, outputPaths.raw], {
      allowedPaths: [outputPaths.merged, outputPaths.raw],
    });

    // --- preflight -------------------------------------------------------

    const adapters = new Map<string, Adapter>();
    const vendors = new Set<string>(config.panel.map((entry) => entry.vendor));

    if (config.merge.enabled) vendors.add(config.merge.vendor);

    for (const vendor of vendors) {
      adapters.set(vendor, getAdapter(vendor));
    }

    const warnings: string[] = [];
    const versions = new Map<string, string | null>();
    // Flag support is read from each CLI's own help, once, at preflight.
    const supports = new Map<string, (flag: string) => boolean>();

    for (const [name, adapter] of adapters) {
      const result = await probe(adapter.command, adapter.versionArgs());

      if (!result.present) {
        throw new PreflightError(
          `Vendor CLI "${adapter.command}" (${adapter.label}) is not available.\n` +
            (result.error ? `  ${result.error}\n` : '') +
            `Install it, or remove the "${name}" entries from your config.`,
        );
      }

      const detected =
        adapter.parseVersion(result.version ?? '') ?? (await detectVersion(adapter, scratch));

      if (!detected) {
        throw new PreflightError(
          `Could not determine ${adapter.label} version. crbuddy requires ` +
            `${adapter.command} ${adapter.minVersion} or newer so it does not guess at ` +
            `version-sensitive native-review behavior. Run \`crbuddy doctor\` for details.`,
        );
      }

      if (!isVersionAtLeast(detected, adapter.minVersion)) {
        throw new PreflightError(
          `${adapter.label} ${detected} is too old for this crbuddy adapter; ` +
            `${adapter.minVersion} or newer is required. Update ${adapter.command}, then retry.`,
        );
      }

      versions.set(name, detected);
      supports.set(name, await flagProbe(adapter, scratch));
    }

    // --- target ----------------------------------------------------------

    const runId = randomUUID().slice(0, 8);

    progress.dim(
      `crbuddy beginning run using ${loaded.scope === 'project' ? 'local' : 'global'} configuration`,
    );

    const targetOptions = {
      // crbuddy's own artifacts must not become the thing under review.
      // The working directory counts: it is untracked, so "all uncommitted
      // changes" would otherwise sweep the config and scratch files in.
      //
      // Rewritten, not merely filtered: these become `:(exclude)`
      // pathspecs. git aborts the whole diff on one pointing outside the
      // worktree, and an absolute path that DOES resolve inside still has
      // to be handed over repo-relative or it is silently not excluded -
      // which would feed the last run's report back into this one.
      exclude: [outputPaths.merged, outputPaths.raw, `${WORK_DIR}/`]
        .map((entry) => repoRelative(entry, repoRoot))
        .filter((entry): entry is string => entry !== null),
    };
    const target = await resolveTarget(repoRoot, config.target, targetOptions);

    // An empty diff is usually an accident — `go` run straight after
    // committing, or a base branch that resolved to the same commit — so
    // interactively it falls back rather than exiting. The fallback is a
    // materially different run, which is why it warns rather than proceeding
    // quietly.
    //
    // Gated on a terminal because the warning is the whole safeguard, and an
    // unattended caller has nobody to read it: a hook or CI job on a clean
    // tree would silently spend one full agent run per panel entry, with no
    // diff size limit to bound any of them. Unattended, that has to be asked
    // for rather than inferred.
    const emptyDiff = target.files.length === 0;
    const attended = canConfirm();
    const wholeCheckout = shouldReviewWholeCheckout(
      emptyDiff,
      attended,
      options.wholeCheckout,
    );

    if (emptyDiff && !wholeCheckout) {
      progress.line('Nothing to review — the target diff is empty.');
      progress.dim(
          '  Reviewing the whole checkout instead is possible, but it is broader, ' +
          'slower, and unbounded by the diff size limit, so it is not done ' +
          'unattended. Re-run with --whole-checkout to ask for it.',
      );

      return EXIT_TOTAL_FAILURE;
    }

    if (wholeCheckout) {
      progress.line(
        'Warning: the target diff is empty, so there is nothing to review. ' +
          'Reviewing the whole checkout instead.',
      );

      progress.dim(
        '  Broader and slower than a diff review, and it ignores the diff size ' +
          'limit. No vendor CLI has a native review mode for "everything", so ' +
          'every entry runs as a general-purpose agent rather than the native ' +
          'review workflow it would normally use.',
      );
    }

    const checkoutLaunchSnapshot = wholeCheckout
      ? target.kind === 'uncommitted'
        ? target.snapshot
        : await captureCheckoutSnapshot(repoRoot, targetOptions)
      : undefined;

    if (target.bytes > config.maxDiffBytes && !options.force) {
      throw new PreflightError(
        `Diff is ${target.bytes} bytes, over the ${config.maxDiffBytes} byte limit. ` +
          `Reviews of a truncated diff look normal and are not. ` +
          `Narrow the target or re-run with --force.`,
      );
    }

    progress.dim(
      `Reviewing ${target.files.length} file(s), ${formatSize(target.bytes)}.`,
    );

    stashed = await stashExistingOutputs(
      repoRoot,
      stateDir,
      [outputPaths.merged, outputPaths.raw],
      runId,
      { allowedPaths: [outputPaths.merged, outputPaths.raw] },
    );

    // --- panel -----------------------------------------------------------

    const semaphore = new Semaphore(config.maxConcurrent);
    const startedAt = Date.now();

    progress.line(
      `Starting ${config.panel.length} review${config.panel.length === 1 ? '' : 's'} ` +
        `at ${formatClock()}…`,
    );

    const names = displayNames(config.panel, adapters);
    progress.startPulse(startedAt);

    const records = await Promise.all(
      config.panel.map((entry) =>
        semaphore.run(() =>
          executeEntry({
            entry,
            adapter: adapters.get(entry.vendor)!,
            cliVersion: versions.get(entry.vendor) ?? null,
            supports: supports.get(entry.vendor)!,
            display: names.get(entry.id)!,
            target,
            repoRoot,
            scratch,
            timeoutMs: config.timeoutMs,
            ...(wholeCheckout ? { wholeCheckout: true } : {}),
            ...(options.instructionsOverride
              ? { instructionsOverride: options.instructionsOverride }
              : {}),
          }),
        ),
      ),
    );

    // The per-lane terminal animation is done, but VS Code's tab stays busy
    // through consolidation and output commit.
    progress.pausePulse();

    let mergeIsolationError: string | null = null;

    try {
      // All panel results are in memory now. Delete their verbatim spool
      // files before a general-purpose consolidator is allowed to start.
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      mergeIsolationError =
        `could not clear panel scratch before consolidation: ${String(error)}`;
    }

    if (interrupted) {
      await restorePreviousOutput();
      progress.line('No output written.');
      return 130;
    }

    const succeeded = records.filter((record) => record.ok);
    const rawPath =
      config.output.destination === 'file'
        ? reportRelativePath(repoRoot, outputPaths.merged, outputPaths.raw)
        : null;

    const context: ReportContext = {
      version,
      runId,
      generated: new Date().toISOString(),
      target,
      runs: records,
      mergeState: 'off',
      // Displayed, not absolute: a full path leaks the machine's directory
      // layout into a file people paste into issues.
      configSource: displayPath(loaded.source, repoRoot),
      configScope: loaded.scope,
      ...(wholeCheckout ? { wholeCheckout: true } : {}),
      ...(checkoutLaunchSnapshot ? { checkoutLaunchSnapshot } : {}),
      warnings,
      // Only a real path when one is actually written; the consolidated
      // report points at it, and pointing at a file that does not exist is
      // worse than not mentioning it.
      // Relative to the consolidated report itself, so the reference still
      // resolves when the configured output files are outside the repository
      // or in different directories. Omitted across filesystem roots, where
      // no relative reference exists.
      ...(rawPath ? { rawPath } : {}),
    };

    if (succeeded.length === 0) {
      await restorePreviousOutput();
      progress.dim('');
      progress.line('Every review failed. Previous output left in place.');
      return EXIT_TOTAL_FAILURE;
    }

    // --- merge -----------------------------------------------------------

    const findings: Finding[] = succeeded.flatMap((record) =>
      // Absolute local paths are stripped to repo-relative first: they leak
      // a machine's directory layout into a file people paste into issues.
      segment(record.id, relativizePaths(record.output, repoRoot)),
    );

    let clusters = singletons(findings);

    if (config.merge.enabled && findings.length > 1) {
      progress.dim(`Consolidating ${findings.length} findings…`);

      if (mergeIsolationError) {
        context.mergeState = 'failed';
        context.mergeReason = mergeIsolationError;
        progress.line(`  Consolidation failed: ${context.mergeReason}`);
      } else {
        try {
          mergeDir = await mkdtemp(path.join(tmpdir(), 'crbuddy-merge-'));
          const merged = await runMerge({
            adapter: adapters.get(config.merge.vendor)!,
            supports: supports.get(config.merge.vendor)!,
            model: config.merge.model,
            ...(config.merge.effort ? { effort: config.merge.effort } : {}),
            findings,
            target,
            repoRoot,
            scratch: mergeDir,
            timeoutMs: config.mergeTimeoutMs,
          });

          clusters = orderClusters(merged, findings);
          context.mergeState = 'ok';
        } catch (error) {
          context.mergeState = 'failed';
          context.mergeReason =
            error instanceof MergeValidationError ? error.message : String(error);

          progress.line(`  Consolidation failed: ${context.mergeReason}`);
        }
      }
    }

    // --- write -----------------------------------------------------------

    // Re-checked here, not just after the panel: a SIGINT during
    // consolidation surfaces as a merge failure, and execution would
    // otherwise carry straight on and replace the report anyway.
    if (interrupted) {
      await restorePreviousOutput();
      progress.line('No output written.');
      return 130;
    }

    // `output.merged` is ALWAYS the deliverable, whatever happened to
    // consolidation. Anything else means the filename a user points an agent
    // at sometimes does not exist — or worse, is left over from a previous
    // run while the fresh reviews sit under a different name.
    const deliverable =
      context.mergeState === 'ok'
        ? renderMerged(context, clusters, findings)
        : renderRaw(context);

    if (config.output.destination === 'terminal') {
      // Restored, not discarded: this run wrote nothing, so a report left by
      // an earlier file-mode run is still the newest copy on disk and was
      // only moved aside to keep it out of the reviewers' sight.
      await restorePreviousOutput();

      progress.stopPulse();
      progress.bell();

      // Release both signal ownership and every lock before the menu. All
      // output lifecycle work is complete, and waiting for clipboard input
      // must not block this repository or another repository that shares an
      // output path.
      // Scratch has a stable per-repository name. Remove it while the repo
      // lock is still held so this run's `finally` can never delete scratch
      // belonging to a new run that starts while the menu is open.
      await cleanupRunState();
      await releaseRunLocks();
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);

      // Only the deliverable is rendered in this mode: the unmerged reviews
      // are an audit trail worth keeping on disk, not worth doubling the
      // scrollback for, so they are never built at all.
      await printReport(deliverable);
    } else {
      const files =
        context.mergeState === 'ok'
          ? [
              { relative: outputPaths.raw, content: renderRaw(context) },
              { relative: outputPaths.merged, content: deliverable },
            ]
          : [{ relative: outputPaths.merged, content: deliverable }];

      await commitOutputs(repoRoot, files, {
        allowedPaths: [outputPaths.merged, outputPaths.raw],
      });
      await stashed.discard();
      stashed = null;

      progress.stopPulse();
      progress.dim('');
      progress.line(
        context.mergeState === 'ok'
          ? `Wrote ${config.output.merged} and ${config.output.raw}.`
          : `Wrote ${config.output.merged}.`,
      );

      // Two filenames that differ by one word need saying out loud once.
      // Only when consolidation actually ran: otherwise there is one file
      // and nothing to tell apart.
      if (context.mergeState === 'ok') {
        progress.dim(
          `  ${config.output.merged} is the deliverable: duplicate findings grouped ` +
            `and ordered by how many reviewers raised them. ${config.output.raw} is ` +
            `every review verbatim, to check that grouping against.`,
        );
      }

      progress.bell();
    }

    const partial =
      succeeded.length < records.length || context.mergeState === 'failed';

    if (partial && options.strict) return EXIT_PARTIAL;

    return EXIT_OK;
  } finally {
    progress.stopPulse();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);

    await restorePreviousOutput().catch(() => {});

    await cleanupRunState();
    await releaseRunLocks();
  }
}

export class PreflightError extends Error {}

export function shouldReviewWholeCheckout(
  emptyDiff: boolean,
  attended: boolean,
  explicitlyRequested: boolean,
): boolean {
  return emptyDiff && (attended || explicitlyRequested);
}

async function detectVersion(adapter: Adapter, scratch: string): Promise<string | null> {
  const result = await runProcess({
    command: adapter.command,
    args: adapter.versionArgs(),
    cwd: scratch,
    timeoutMs: 15_000,
    scratchDir: scratch,
    id: `version-${adapter.name}`,
  });

  return adapter.parseVersion(`${result.stdout}\n${result.stderr}`);
}

export function displayNames(
  panel: PanelEntry[],
  adapters: Map<string, Adapter>,
): Map<string, string> {
  const base = new Map<string, string>();
  const counts = new Map<string, number>();

  for (const entry of panel) {
    const label = adapters.get(entry.vendor)?.label ?? entry.vendor;
    const modelAndEffort = entry.effort
      ? `${entry.model} ${entry.effort}`
      : entry.model;
    const name = `${label} (${modelAndEffort})`;

    base.set(entry.id, name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const names = new Map<string, string>();

  for (const entry of panel) {
    const name = base.get(entry.id)!;
    names.set(entry.id, (counts.get(name) ?? 0) > 1 ? `${name} [${entry.id}]` : name);
  }

  return names;
}

interface ExecuteArgs {
  entry: PanelEntry;
  adapter: Adapter;
  cliVersion: string | null;
  supports: (flag: string) => boolean;
  display: string;
  target: ResolvedTarget;
  repoRoot: string;
  scratch: string;
  timeoutMs: number;
  instructionsOverride?: string;
  /** No diff: review the checkout itself rather than a range. */
  wholeCheckout?: boolean;
}

async function executeEntry(args: ExecuteArgs): Promise<RunRecord> {
  const { entry, adapter, target } = args;
  const instructionSelection = buildReviewerOperation({
    entry,
    target,
    nativeReview: adapter.nativeReview,
    wholeCheckout: args.wholeCheckout ?? false,
    ...(args.instructionsOverride
      ? { instructionsOverride: args.instructionsOverride }
      : {}),
  });

  const base = {
    id: entry.id,
    vendor: adapter.name,
    cli: adapter.command,
    cliVersion: args.cliVersion,
    modelRequested: entry.model,
    effortRequested: entry.effort ?? null,
    effortApplied: null as string | null,
    instructionSource: instructionSelection.source,
    instructionsPreset: instructionSelection.presetId,
    wallClockMs: 0,
  };

  let invocation;

  try {
    invocation = adapter.build({
      operation: instructionSelection.operation,
      model: entry.model,
      ...(entry.effort ? { effort: entry.effort } : {}),
      ...(entry.vendorArgs ? { vendorArgs: entry.vendorArgs } : {}),
      repoRoot: args.repoRoot,
      supports: args.supports,
    });
  } catch (error) {
    if (error instanceof UnsafeInvocationError) {
      progress.laneFinished(args.display);

      const outcome: RunRecord = {
        ...base,
        ok: false,
        reason: 'unsafe_invocation',
        output: '',
        diagnostics: error.message,
      };

      progress.line(
        `  ${args.display} - FAILED: unsafe_invocation\n      ` +
          `${firstLine(outcome.diagnostics)}`,
      );

      return outcome;
    }

    throw error;
  }

  for (const warning of invocation.warnings ?? []) {
    progress.line(`  ${args.display} - ${warning}`);
  }

  progress.laneStarted(args.display);
  progress.dim(`  ${args.display} - started`);

  const result = await runProcess({
    command: invocation.command,
    args: invocation.args,
    cwd: args.repoRoot,
    stdin: invocation.stdin,
    env: invocation.env,
    timeoutMs: args.timeoutMs,
    scratchDir: args.scratch,
    id: entry.id,
  });

  progress.laneFinished(args.display);

  const record = {
    ...base,
    effortApplied: invocation.appliedEffort,
    wallClockMs: result.wallClockMs,
  };

  const report = (outcome: RunRecord): RunRecord => {
    if (outcome.ok) {
      progress.dim(`  ${args.display} - done in ${formatElapsed(outcome.wallClockMs)}`);
    } else {
      const detail = firstLine(outcome.diagnostics);

      progress.line(
        `  ${args.display} - FAILED: ${outcome.reason}${detail ? `\n      ${detail}` : ''}`,
      );
    }

    return outcome;
  };

  if (result.spawnError) {
    return report({
      ...record,
      ok: false,
      reason: 'spawn_failed',
      output: '',
      diagnostics: result.spawnError,
    });
  }

  if (result.timedOut) {
    return report({
      ...record,
      ok: false,
      reason: 'timeout',
      output: '',
      diagnostics: tail(result.stderr),
    });
  }

  const body = adapter.finalOutput(result);
  const completion = adapter.checkCompletion(result);

  if (!completion.ok) {
    return report({
      ...record,
      ok: false,
      reason: completion.reason ?? 'unknown',
      output: '',
      diagnostics: tail(result.stderr || result.stdout),
    });
  }

  const output = relativizePaths(body, args.repoRoot);

  // A vendor CLI can exit zero having returned a progress or status message
  // rather than a review — seen in the wild as "still waiting for the
  // code-review skill to complete". It is not a failure crbuddy can prove,
  // so it is surfaced as a warning rather than discarded.
  const suspicious = output.trim().length < SUSPICIOUSLY_SHORT;

  if (suspicious) {
    progress.line(
      `  ${args.display} - warning: returned only ${output.trim().length} characters; ` +
        `this may be a status message rather than a review.`,
    );
  }

  return report({
    ...record,
    ok: true,
    output,
    ...(suspicious ? { suspiciouslyShort: true } : {}),
  });
}

interface MergeArgs {
  adapter: Adapter;
  supports: (flag: string) => boolean;
  model: string;
  effort?: string;
  findings: Finding[];
  target: ResolvedTarget;
  repoRoot: string;
  scratch: string;
  timeoutMs: number;
}

async function runMerge(args: MergeArgs) {
  const invocation = args.adapter.build({
    operation: {
      kind: 'generic',
      target: null,
      instructions: buildMergePrompt(args.findings),
    },
    model: args.model,
    ...(args.effort ? { effort: args.effort } : {}),
    repoRoot: args.repoRoot,
    supports: args.supports,
  });

  const result = await runProcess({
    command: invocation.command,
    args: invocation.args,
    // Deliberately NOT the repository, and deliberately not the panel's
    // scratch directory either. The consolidator's contract is that it sees
    // findings and nothing else; the repo as cwd handed it the live tree,
    // and the shared scratch dir handed it every lane's verbatim stdout.
    cwd: args.scratch,
    stdin: invocation.stdin,
    env: invocation.env,
    timeoutMs: args.timeoutMs,
    scratchDir: args.scratch,
    id: 'merge',
  });

  if (result.timedOut) throw new MergeValidationError('merge timed out');
  if (result.spawnError) throw new MergeValidationError(result.spawnError);

  const completion = args.adapter.checkCompletion(result);

  if (!completion.ok) {
    throw new MergeValidationError(completion.reason ?? 'merge run failed');
  }

  const parsed = parseClusterResponse(args.adapter.finalOutput(result));
  return validateClusters(parsed, args.findings).clusters;
}

function tail(text: string, limit = 2000): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

type ConfirmationInput = NodeJS.ReadableStream & { isTTY?: boolean };
type ConfirmationOutput = NodeJS.WritableStream & { isTTY?: boolean };

export function canConfirm(
  input: ConfirmationInput = process.stdin,
  output: ConfirmationOutput = process.stderr,
): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export async function confirm(
  question: string,
  input: ConfirmationInput = process.stdin,
  output: ConfirmationOutput = process.stderr,
): Promise<boolean> {
  if (!canConfirm(input, output)) return false;

  const rl = readline.createInterface({
    input,
    output,
  });

  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * A restore that could not put everything back is not a quiet event: the
 * previous report is still sitting in the holding directory and nothing
 * else will mention it.
 */
function reportStranded(stranded: string[]): void {
  if (stranded.length === 0) return;

  progress.line('Could not move the previous output back into place.');

  for (const file of stranded) progress.line(`  it is still at ${file}`);
}

/**
 * Conservative identity for output-file locks.
 *
 * Windows and the default macOS filesystems fold case. A case-sensitive macOS
 * volume may therefore over-coordinate two distinct output paths, which is
 * safe; treating one real file as two lock identities is not. Repository
 * state uses canonical filesystem paths separately, so this conservative
 * output-lock rule can never merge two checkouts' scratch directories.
 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

export function pathKey(file: string): string {
  const absolute = path.resolve(file);
  const canonical = canonicalOutputPath(path.parse(absolute).root, absolute);
  const normalized = canonical.replace(/\\/g, '/');

  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

/** Output locks coordinate repositories without using a predictable /tmp path. */
function lockRoot(): string {
  return path.join(homedir(), HOME_CONFIG_DIR, 'locks');
}

/**
 * Per-repository scratch and stash, outside the repository.
 *
 * Keyed by the repo's own path so two checkouts of the same project do not
 * share a holding directory, and so a report stranded by a crash is found
 * again by the next run in that same checkout.
 */
export function repoStateDir(
  repoRoot: string,
  stateRoot = path.join(homedir(), HOME_CONFIG_DIR, 'state'),
): string {
  let canonical = path.resolve(repoRoot);

  try {
    // Preserves distinct paths on a case-sensitive APFS/HFS volume while
    // canonicalizing alternate spellings of one path on a folding volume.
    canonical = realpathSync.native(canonical);
  } catch {
    // The caller normally supplies an existing git root. Keeping the exact
    // resolved spelling is safer than folding two unknown paths together.
  }

  const normalized = canonical.replace(/\\/g, '/');
  const identity = filesystemFoldsCase(canonical)
    ? normalized.toLowerCase()
    : normalized;
  const key = createHash('sha1').update(identity).digest('hex').slice(0, 16);

  let canonicalStateRoot: string;

  try {
    // Follow the state directory itself when it is a symlink. A user may
    // deliberately redirect ~/.crbuddy/state outside a home-root repository.
    canonicalStateRoot = realpathSync.native(path.resolve(stateRoot));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;

    // The directory need not exist on a first run; resolve every existing
    // parent so containment cannot be hidden behind an ancestor symlink.
    const absoluteStateRoot = path.resolve(stateRoot);
    canonicalStateRoot = canonicalOutputPath(
      path.parse(absoluteStateRoot).root,
      absoluteStateRoot,
    );
  }

  const relativeState = path.relative(canonical, canonicalStateRoot);
  const stateIsInsideRepository =
    relativeState === '' ||
    (relativeState !== '..' &&
      !relativeState.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeState));

  if (stateIsInsideRepository) {
    throw new PreflightError(
      `Cannot isolate crbuddy run state because ${canonicalStateRoot} is inside ` +
        `the repository at ${canonical}. Repositories rooted at or above crbuddy's ` +
        `state directory are not supported.`,
    );
  }

  return path.join(canonicalStateRoot, key);
}

/** Probe the actual volume instead of assuming every macOS volume folds. */
function filesystemFoldsCase(canonical: string): boolean {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;

  let alternate = '';

  for (let index = canonical.length - 1; index >= 0; index -= 1) {
    const character = canonical[index]!;

    if (/[a-z]/.test(character)) {
      alternate =
        `${canonical.slice(0, index)}${character.toUpperCase()}` +
        canonical.slice(index + 1);
      break;
    }

    if (/[A-Z]/.test(character)) {
      alternate =
        `${canonical.slice(0, index)}${character.toLowerCase()}` +
        canonical.slice(index + 1);
      break;
    }
  }

  if (alternate === '') return false;

  try {
    return realpathSync.native(alternate) === canonical;
  } catch {
    return false;
  }
}

/**
 * Locks keyed by the output files themselves, held alongside the repo lock.
 *
 * The repo lock cannot see other repositories, and these paths are shared
 * across them: `../CODE-REVIEW-HANDOFF.md` in two siblings is ONE file.
 * Without this, run A can stash the previous report, run B write a fresh
 * one, and A's restore() put the stale copy back over it.
 *
 * One lock PER PATH, not one for the set. Two configs that share only the
 * merged report would hash to different keys and never contend, which is
 * the overlap that matters most. Sorted, so two runs always take a shared
 * pair in the same order and cannot deadlock on each other.
 *
 * Taken for every path regardless of where it sits: a file inside THIS repo
 * can be another repo's external output, so containment says nothing about
 * whether it is shared. Taken in terminal mode too - that mode writes no
 * report but still runs cleanupTemps, stash and restore over these paths.
 *
 * Kept in the user's crbuddy state rather than a predictable shared-temp
 * path that another local account could pre-create or redirect.
 */
async function acquireOutputLocks(
  output: { merged: string; raw: string },
): Promise<Lock[]> {
  const files = [output.merged, output.raw];

  // Keyed by the same string that decides identity, so two spellings can
  // never collapse to one key while still counting as two locks to take.
  const byKey = new Map<string, string>();

  for (const file of files) byKey.set(pathKey(file), file);

  const held: Lock[] = [];

  try {
    for (const [identity, file] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = createHash('sha1').update(identity).digest('hex').slice(0, 16);

      held.push(
        await acquireLockAt(path.join(lockRoot(), key), `for the output file ${file}`),
      );
    }
  } catch (error) {
    // Never strand the ones already taken when a later one is contended.
    await releaseAll(held);
    throw error;
  }

  return held;
}

async function releaseAll(locks: Lock[]): Promise<void> {
  for (const held of locks.reverse()) {
    await held.release().catch(() => {});
  }
}

/**
 * Terminal mode. The report goes to stdout so `crbuddy go > review.md` still
 * works, while every progress line has gone to stderr all along - the two
 * never interleave in a redirect.
 *
 * Nothing here clears the screen or uses the alternate buffer, so the report
 * stays in the scrollback after the process exits and can be selected by
 * hand if the clipboard is unavailable.
 */
async function printReport(document: string): Promise<void> {
  // No leading blank line: a redirect must begin with the report itself,
  // whether that is consolidated YAML frontmatter or an unconsolidated
  // heading. Terminal spacing comes from progress output on stderr.
  process.stdout.write(`${document.trimEnd()}\n`);

  // stdout matters as much as stdin here: `select` draws its menu there, so
  // prompting under `crbuddy go > review.md` would write the menu into the
  // file. A redirect or a pipe wants the report and nothing else.
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    return;
  }

  let choice: 'copy' | 'exit';

  try {
    choice = await select<'copy' | 'exit'>(
      'Report(s) done, pick one:',
      [
        { label: 'Copy to clipboard and exit', value: 'copy' },
        { label: 'Exit', value: 'exit' },
      ],
      0,
    );
  } catch (error) {
    // Ctrl-C at this prompt is a choice, not a failure: the report is
    // already printed and there is nothing left to clean up.
    if (error instanceof PromptAborted || (error as { name?: string })?.name === 'AbortError') {
      console.error('');
      return;
    }

    throw error;
  }

  if (choice !== 'copy') return;

  const result = await copyToClipboard(document);

  console.error(
    result.ok
      ? dim('  Copied to clipboard.')
      : `  Could not copy: ${result.reason ?? 'unknown error'}. ` +
          `The report is above; scroll up to select it.`,
  );
}

/** Repo-relative if inside the repo, else ~-prefixed. Never a full path. */
function displayPath(file: string, repoRoot: string): string {
  const normalized = file.replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');

  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1);
  }

  const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '');

  if (home && normalized.toLowerCase().startsWith(`${home.toLowerCase()}/`)) {
    return `~/${normalized.slice(home.length + 1)}`;
  }

  return path.basename(normalized);
}

/**
 * A link from the consolidated report to its raw companion.
 *
 * Configured paths are resolved independently, so basename-only display can
 * point nowhere when the two outputs live in different directories. A path
 * relative to the consolidated report remains valid after both are written.
 * Different Windows drives have no relative spelling; omit the link there.
 */
export function reportRelativePath(
  repoRoot: string,
  merged: string,
  raw: string,
): string | null {
  const mergedFile = path.resolve(repoRoot, merged);
  const rawFile = path.resolve(repoRoot, raw);
  const relative = path.relative(path.dirname(mergedFile), rawFile);

  if (relative === '' || path.isAbsolute(relative)) return null;

  return relative.replace(/\\/g, '/');
}

/** First meaningful line of a CLI's error output, for the terminal. */
function firstLine(text: string | undefined): string {
  if (!text) return '';

  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');

  if (!line) return '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

async function flagProbe(
  adapter: Adapter,
  scratch: string,
): Promise<(flag: string) => boolean> {
  const result = await runProcess({
    command: adapter.command,
    args: adapter.helpArgs(),
    cwd: scratch,
    timeoutMs: 20_000,
    scratchDir: scratch,
    id: `help-${adapter.name}`,
  });

  const help = `${result.stdout}\n${result.stderr}`;

  if (help.trim() === '') return () => true;

  return (flag: string) => {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[\\s,\\[])${escaped}([\\s,=\\]]|$)`, 'm').test(help);
  };
}
