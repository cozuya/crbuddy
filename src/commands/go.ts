import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { HOME_CONFIG_DIR, PanelEntry, WORK_DIR } from '../config/schema.js';
import {
  assertUsableOutput,
  canonicalOutputPath,
  legacyRawOutputPaths,
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
import { relativizePaths } from '../output/relativize.js';
import { ReportContext, RunRecord, renderReport } from '../output/render.js';
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
import { notifyFinished, ReviewOutcome } from '../run/notify.js';
import { sanitizeTerminalInline } from '../util/ansi.js';

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

  if (loaded.obsoleteKeys.length > 0) {
    progress.dim(
      `Ignoring ${loaded.obsoleteKeys.join(', ')} in ` +
        `${displayPath(loaded.source, repoRoot)}: consolidation was removed in ` +
        '0.4.0. `crbuddy config` drops them, keeping output.raw only while the ' +
        'old report it names may still exist.',
    );
  }

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
  let ownsRunState = true;

  const cleanupRunState = async (): Promise<void> => {
    if (!ownsRunState) return;
    ownsRunState = false;

    await rm(scratch, { recursive: true, force: true }).catch(() => {});
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
  // A raw report left by a version before 0.4.0. Hidden while reviewers run,
  // like the previous report, but always put back: this run replaces it with
  // nothing, so discarding it would only delete the user's file.
  let legacyStashed: Awaited<ReturnType<typeof stashExistingOutputs>> | null = null;
  let interrupted = false;
  const launchedReviewers = new Set<string>();
  let notificationOutcome: ReviewOutcome = 'failed';
  const notificationCancellation = new AbortController();
  const cancelNotification = () => notificationCancellation.abort();
  let terminalReport: string | null = null;
  let exitCode = EXIT_OK;

  const onInterrupt = () => {
    cancelNotification();
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

  const restoreLegacyOutput = async (): Promise<void> => {
    const pending = legacyStashed;
    legacyStashed = null;

    if (pending) reportStranded(await pending.restore());
  };

  const restorePreviousOutput = async (): Promise<void> => {
    const pending = stashed;
    stashed = null;

    if (pending) reportStranded(await pending.restore());
    await restoreLegacyOutput();
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
    const legacyRaw = legacyRawOutputPaths(
      repoRoot,
      loaded.legacyRawOutput,
      outputPaths.merged,
    );
    const ownOutputs = [outputPaths.merged, ...legacyRaw];

    // A project-local config is a file that ships with a repository, so a
    // repository you merely cloned can choose where crbuddy writes. Obtain
    // consent before cleanup or crash recovery touches any such path.
    const external = [outputPaths.merged]
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
    outputLocks = await acquireOutputLocks(ownOutputs);

    // Recover anything a crashed run left in a holding directory before
    // deciding whether an existing report may be replaced. Otherwise the
    // refusal check sees an empty destination, recovery restores the report,
    // and this run overwrites it without the configured confirmation.
    // External project-config paths have already passed their separate gate.
    // A crash stash from before 0.4.0 also holds the raw report, and a batch
    // is restored whole or not at all, so that path must be allowed too.
    const recovered = [
      ...(await recoverStrandedOutputs(repoRoot, stateDir, {
        allowedPaths: ownOutputs,
      })),
      ...(await recoverStrandedOutputs(repoRoot, workDir, {
        allowedPaths: ownOutputs,
      })),
    ];

    if (recovered.length > 0) {
      progress.dim(
        `Recovered ${recovered.join(', ')} left behind by an interrupted run.`,
      );
    }

    // Nothing is replaced when the report only ever reaches the terminal.
    if (config.refuseIfOutputExists && config.output.destination === 'file') {
      const existing = [outputPaths.merged].filter((absolute) =>
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

    // `scratch` is where every panel lane spools `<id>.stdout`.
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });

    await cleanupTemps(repoRoot, ownOutputs, {
      allowedPaths: ownOutputs,
    });

    // --- preflight -------------------------------------------------------

    const adapters = new Map<string, Adapter>();
    const vendors = new Set<string>(config.panel.map((entry) => entry.vendor));

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
      exclude: [...ownOutputs, `${WORK_DIR}/`]
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
      [outputPaths.merged],
      runId,
      { allowedPaths: [outputPaths.merged] },
    );

    if (legacyRaw.some((absolute) => existsSync(absolute))) {
      legacyStashed = await stashExistingOutputs(
        repoRoot,
        stateDir,
        legacyRaw,
        `${runId}-legacy`,
        { allowedPaths: legacyRaw },
      );

      for (const absolute of legacyStashed.moved) {
        progress.dim(
          `${repoRelative(absolute, repoRoot) ?? absolute} is a report from crbuddy ` +
            'before 0.4.0, which no longer updates it. It is hidden from reviewers ' +
            'and put back afterwards; delete it when convenient.',
        );
      }
    }

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
            onStart: () => { launchedReviewers.add(entry.id); },
            onSpawnFailure: () => { launchedReviewers.delete(entry.id); },
            ...(wholeCheckout ? { wholeCheckout: true } : {}),
            ...(options.instructionsOverride
              ? { instructionsOverride: options.instructionsOverride }
              : {}),
          }),
        ),
      ),
    );

    // The per-lane terminal animation is done, but VS Code's tab stays busy
    // through output commit.
    progress.pausePulse();

    if (interrupted) {
      await restorePreviousOutput();
      progress.line('No output written.');
      return 130;
    }

    const succeeded = records.filter((record) => record.ok);

    const context: ReportContext = {
      version,
      runId,
      generated: new Date().toISOString(),
      target,
      runs: records,
      // Displayed, not absolute: a full path leaks the machine's directory
      // layout into a file people paste into issues.
      configSource: displayPath(loaded.source, repoRoot),
      configScope: loaded.scope,
      ...(wholeCheckout ? { wholeCheckout: true } : {}),
      ...(checkoutLaunchSnapshot ? { checkoutLaunchSnapshot } : {}),
      warnings,
    };

    if (succeeded.length === 0) {
      await restorePreviousOutput();
      progress.dim('');
      progress.line('Every review failed. Previous output left in place.');
      return EXIT_TOTAL_FAILURE;
    }

    // --- write -----------------------------------------------------------

    const deliverable = renderReport(context);

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

      printReport(deliverable);
      terminalReport = deliverable;
    } else {
      await commitOutputs(
        repoRoot,
        [{ relative: outputPaths.merged, content: deliverable }],
        { allowedPaths: [outputPaths.merged] },
      );
      await stashed.discard();
      stashed = null;
      await restoreLegacyOutput();

      progress.stopPulse();
      progress.dim('');
      progress.line(`Wrote ${config.output.merged}.`);

      progress.bell();
    }

    const partial = succeeded.length < records.length;
    notificationOutcome = partial ? 'partial' : 'complete';

    exitCode = partial && options.strict ? EXIT_PARTIAL : EXIT_OK;
  } finally {
    progress.stopPulse();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);

    try {
      await restorePreviousOutput().catch(() => {});
      await cleanupRunState();
      await releaseRunLocks();
    } catch (error) {
      notificationOutcome = 'failed';
      throw error;
    } finally {
      if (launchedReviewers.size > 0 && !notificationCancellation.signal.aborted) {
        await notifyFinished(
          path.basename(repoRoot),
          notificationOutcome,
          notificationCancellation.signal,
        );
      }
    }
  }

  // The review result and notification are settled before waiting for input.
  // Early failures return through the same finally without opening this menu.
  if (terminalReport !== null) await offerClipboard(terminalReport);
  return exitCode;
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

/**
 * Terminal labels, e.g. `Codex CLI (gpt-6-sol, high)`. Each is a function of
 * the effort the adapter actually applied, which is only known once the
 * invocation is built (Claude's native review fills in its default).
 */
function displayNames(
  panel: PanelEntry[],
  adapters: Map<string, Adapter>,
): Map<string, (effort: string | null) => string> {
  const base = new Map<string, string>();
  const counts = new Map<string, number>();

  for (const entry of panel) {
    const label = sanitizeTerminalInline(
      adapters.get(entry.vendor)?.label ?? entry.vendor,
    );
    const model = sanitizeTerminalInline(entry.model);
    const name = `${label} (${model})`;

    base.set(entry.id, name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const names = new Map<string, (effort: string | null) => string>();

  for (const entry of panel) {
    const name = base.get(entry.id)!;
    const id = sanitizeTerminalInline(entry.id);
    const suffix = (counts.get(name) ?? 0) > 1 ? ` [${id}]` : '';

    names.set(entry.id, (effort) => {
      const shown = effort
        ? `${name.slice(0, -1)}, ${sanitizeTerminalInline(effort)})`
        : name;
      return `${shown}${suffix}`;
    });
  }

  return names;
}

interface ExecuteArgs {
  onStart: () => void;
  onSpawnFailure: () => void;
  entry: PanelEntry;
  adapter: Adapter;
  cliVersion: string | null;
  supports: (flag: string) => boolean;
  display: (effort: string | null) => string;
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
  const instructions = args.instructionsOverride ?? entry.instructions;

  const base = {
    id: entry.id,
    vendor: adapter.name,
    cli: adapter.command,
    cliVersion: args.cliVersion,
    modelRequested: entry.model,
    effortRequested: entry.effort ?? null,
    effortApplied: null as string | null,
    wallClockMs: 0,
  };

  let invocation;

  try {
    invocation = adapter.build({
      // With no diff there is no range for a native review to anchor to, so
      // every entry drops to a general-purpose run — including entries that
      // would normally use the vendor's own review workflow. A configured
      // `instructions` still wins; it is what the user asked for either way.
      operation: args.wholeCheckout
        ? {
            kind: 'generic',
            target: null,
            // `genericPrompt` appends the read-only reminder only when there
            // is a range, so a whole-checkout run carries it itself. The
            // sandbox flags are the real guarantee; this just stops the
            // prompt from contradicting them.
            instructions: wholeCheckoutPrompt(instructions),
          }
        : instructions
          ? { kind: 'generic', target, instructions }
          : { kind: 'review', target },
      model: entry.model,
      ...(entry.effort ? { effort: entry.effort } : {}),
      ...(entry.vendorArgs ? { vendorArgs: entry.vendorArgs } : {}),
      repoRoot: args.repoRoot,
      ...(adapter.name === 'claude'
        ? {
            completionEvidencePath: path.join(
              args.scratch,
              `${entry.id}.claude-completion.json`,
            ),
          }
        : {}),
      supports: args.supports,
    });
  } catch (error) {
    if (error instanceof UnsafeInvocationError) {
      const display = args.display(entry.effort ?? null);
      progress.laneFinished(display);

      const outcome: RunRecord = {
        ...base,
        ok: false,
        reason: 'unsafe_invocation',
        output: '',
        diagnostics: error.message,
      };

      progress.line(
        `  ${display} - FAILED: unsafe_invocation\n      ` +
          `${firstLine(outcome.diagnostics)}`,
      );

      return outcome;
    }

    throw error;
  }

  const display = args.display(invocation.appliedEffort);

  for (const warning of invocation.warnings ?? []) {
    progress.line(`  ${display} - ${warning}`);
  }

  progress.laneStarted(display);
  progress.dim(`  ${display} - started`);

  const result = await runProcess({
    command: invocation.command,
    args: invocation.args,
    cwd: args.repoRoot,
    stdin: invocation.stdin,
    env: invocation.env,
    timeoutMs: args.timeoutMs,
    scratchDir: args.scratch,
    id: entry.id,
    onStart: args.onStart,
  });

  progress.laneFinished(display);

  const record = {
    ...base,
    effortApplied: invocation.appliedEffort,
    wallClockMs: result.wallClockMs,
  };

  const report = (outcome: RunRecord): RunRecord => {
    if (outcome.ok) {
      progress.dim(`  ${display} - done in ${formatElapsed(outcome.wallClockMs)}`);
    } else {
      const detail = firstLine(outcome.diagnostics);

      progress.line(
        `  ${display} - FAILED: ${outcome.reason}${detail ? `\n      ${detail}` : ''}`,
      );
    }

    return outcome;
  };

  if (result.spawnError) {
    // On Windows the shim host may emit 'spawn' before cross-spawn reports
    // that the requested executable did not exist. That is not reviewer work.
    args.onSpawnFailure();
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
  const completion = adapter.checkCompletion(result, invocation);

  if (!completion.ok) {
    return report({
      ...record,
      ok: false,
      reason: completion.reason ?? 'unknown',
      output: '',
      diagnostics: tail(result.stderr || result.stdout),
    });
  }

  const output = relativizePaths(body, args.repoRoot, {
    foldCase: repoFoldsCase(args.repoRoot),
  });

  return report({
    ...record,
    ok: true,
    output,
  });
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

/** Whether the volume holding this repository treats path case as equal. */
function repoFoldsCase(repoRoot: string): boolean {
  try {
    return filesystemFoldsCase(realpathSync.native(path.resolve(repoRoot)));
  } catch {
    return false;
  }
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
 * One lock per path, sorted, so runs that share a path always take it in the
 * same order and cannot deadlock on each other.
 *
 * Taken for every path regardless of where it sits: a file inside THIS repo
 * can be another repo's external output, so containment says nothing about
 * whether it is shared. Taken in terminal mode too - that mode writes no
 * report but still runs cleanupTemps, stash and restore over these paths.
 *
 * Kept in the user's crbuddy state rather than a predictable shared-temp
 * path that another local account could pre-create or redirect.
 */
/**
 * Every path this run moves, replaces or sweeps temp files beside, including
 * a leftover pre-0.4 raw report: another repository may use one as its own
 * output, and cleanup here would otherwise delete that run's staged report.
 */
async function acquireOutputLocks(files: string[]): Promise<Lock[]> {

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
function printReport(document: string): void {
  // No leading blank line: a redirect must begin with the report's own
  // heading. Terminal spacing comes from progress output on stderr.
  process.stdout.write(`${document.trimEnd()}
`);
}

/** Optional post-run UI; report output and notification have already finished. */
async function offerClipboard(document: string): Promise<void> {
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

/** First meaningful line of a CLI's error output, for the terminal. */
function firstLine(text: string | undefined): string {
  if (!text) return '';

  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');

  if (!line) return '';
  return line.length > 160 ? `${line.slice(0, 157)}\u2026` : line;
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