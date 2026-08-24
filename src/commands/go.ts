import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir, userInfo } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { Config, HOME_CONFIG_DIR, PanelEntry, WORK_DIR } from '../config/schema.js';
import { ConfigError, LoadedConfig, repoRelative } from '../config/load.js';
import { ResolvedTarget, resolveTarget } from '../git/target.js';
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
  strict: boolean;
}

export async function runGo(options: GoOptions): Promise<number> {
  const { repoRoot, loaded, version } = options;
  const config = loaded.config;

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
  const stateDir = repoStateDir(repoRoot);

  const scratch = path.join(stateDir, 'scratch');
  await mkdir(scratch, { recursive: true });

  // The consolidator's contract is that it sees findings and nothing else,
  // and `scratch` is where every lane spools `<id>.stdout`. Launching the
  // merge with that as its cwd hands a general-purpose agent the verbatim
  // reviews it is supposed to be working from summaries of.
  const mergeDir = path.join(stateDir, 'merge');
  await rm(mergeDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(mergeDir, { recursive: true });

  // Lock first. Cleanup touches `*.crbuddy-tmp-*` files, and doing that
  // before the lock lets a second invocation delete a live run's staged
  // output on its way to failing the lock check.
  const lock = await acquireLock(workDir);

  // Inside its own try from here on: a contended output lock throws, and
  // letting that escape before the main try would strand `<repo>/.crbuddy/
  // lock/` for the stale-pid check to clean up later.
  let outputLocks: Lock[] = [];

  try {
    outputLocks = await acquireOutputLocks(repoRoot, config);
  } catch (error) {
    await lock.release();
    throw error;
  }

  await cleanupTemps(repoRoot, [config.output.merged, config.output.raw]);

  // Recover anything a crashed run left in a holding directory before this
  // run stashes outputs of its own.
  //  ... and from where a pre-relocation crash would have left them.
  const recovered = [
    ...(await recoverStrandedOutputs(repoRoot, stateDir)),
    ...(await recoverStrandedOutputs(repoRoot, workDir)),
  ];

  if (recovered.length > 0) {
    progress.dim(
      `Recovered ${recovered.join(', ')} left behind by an interrupted run.`,
    );
  }

  let stashed: Awaited<ReturnType<typeof stashExistingOutputs>> | null = null;
  let interrupted = false;

  const onInterrupt = () => {
    if (interrupted) {
      // Second Ctrl-C: stop being polite.
      killAll('SIGKILL');
      process.exit(130);
    }

    interrupted = true;
    progress.dim('');
    progress.line('Interrupted - terminating agents and restoring previous output.');
    killAll('SIGTERM');
  };

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
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

    // A project-local config is a file that ships with a repository, so a
    // repository you merely cloned can choose where crbuddy writes. Combined
    // with out-of-repo output paths that means naming `~/.bashrc`: file mode
    // moves the target aside, replaces it with the report, and discards the
    // original - and `refuseIfOutputExists` is false by default. A global
    // config is one the user wrote themselves, so it needs no gate.
    const external = [config.output.merged, config.output.raw]
      .map((relative) => path.resolve(repoRoot, relative))
      .filter((absolute) => repoRelative(absolute, repoRoot) === null);

    if (loaded.scope === 'project' && external.length > 0) {
      progress.line('This repository’s own config writes outside the repository:');

      for (const file of [...new Set(external)]) progress.line(`  ${file}`);

      progress.dim(
        '  crbuddy did not choose these paths - the config in this repository did. ' +
          'An existing file there is moved aside and replaced by the report.',
      );

      if (!process.stdin.isTTY) {
        throw new PreflightError(
          'Refusing to write outside the repository from a project-local ' +
            'config without confirmation. Move that output setting into your ' +
            'global config (`crbuddy init --global`), or run this ' +
            'interactively once to confirm.',
        );
      }

      if (!(await confirm('Continue?'))) {
        progress.line('Aborted.');
        return EXIT_TOTAL_FAILURE;
      }
    }

    // The config validator can only compare the two paths as written, and
    // `same.md` and `<repo>/same.md` are the same file spelled two ways. It
    // would survive to `commitOutputs`, which stages both under one temp
    // path and fails the second rename - discarding an otherwise successful
    // run's report.
    if (config.output.destination === 'file') {
      const merged = path.resolve(repoRoot, config.output.merged);
      const raw = path.resolve(repoRoot, config.output.raw);

      if (merged === raw) {
        throw new ConfigError(
          `output.merged and output.raw resolve to the same file:\n` +
            `  ${merged}\n` +
            `They are spelled differently in the config, but they are one ` +
            `path. Point them at different files.`,
        );
      }
    }

    // Nothing is replaced when the report only ever reaches the terminal.
    if (config.refuseIfOutputExists && config.output.destination === 'file') {
      const existing = [config.output.merged, config.output.raw].filter((relative) =>
        existsSync(path.resolve(repoRoot, relative)),
      );

      if (existing.length > 0) {
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

    // --- target ----------------------------------------------------------

    const runId = randomUUID().slice(0, 8);

    progress.dim(
      `crbuddy beginning run using ${loaded.scope === 'project' ? 'local' : 'global'} configuration`,
    );

    const target = await resolveTarget(repoRoot, config.target, {
      // crbuddy's own artifacts must not become the thing under review.
      // The working directory counts: it is untracked, so "all uncommitted
      // changes" would otherwise sweep the config and scratch files in.
      //
      // Rewritten, not merely filtered: these become `:(exclude)`
      // pathspecs. git aborts the whole diff on one pointing outside the
      // worktree, and an absolute path that DOES resolve inside still has
      // to be handed over repo-relative or it is silently not excluded -
      // which would feed the last run's report back into this one.
      exclude: [config.output.merged, config.output.raw, `${WORK_DIR}/`]
        .map((entry) => repoRelative(entry, repoRoot))
        .filter((entry): entry is string => entry !== null),
    });

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
    const attended = Boolean(process.stdin.isTTY);
    const wholeCheckout = emptyDiff && (attended || options.force);

    if (emptyDiff && !wholeCheckout) {
      progress.line('Nothing to review — the target diff is empty.');
      progress.dim(
        '  Reviewing the whole checkout instead is possible, but it is broader, ' +
          'slower, and unbounded by the diff size limit, so it is not done ' +
          'unattended. Re-run with --force to ask for it.',
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
      [config.output.merged, config.output.raw],
      runId,
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

    progress.stopPulse();

    if (interrupted) {
      reportStranded(await stashed.restore());
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
      mergeState: 'off',
      // Displayed, not absolute: a full path leaks the machine's directory
      // layout into a file people paste into issues.
      configSource: displayPath(loaded.source, repoRoot),
      configScope: loaded.scope,
      ...(wholeCheckout ? { wholeCheckout: true } : {}),
      warnings,
      // Only a real path when one is actually written; the consolidated
      // report points at it, and pointing at a file that does not exist is
      // worse than not mentioning it.
      // Displayed, not absolute, for the same reason as configSource: an
       // absolute output directory would otherwise put the machine's layout
       // into a file people paste into issues.
      ...(config.output.destination === 'file'
        ? { rawPath: displayPath(path.resolve(repoRoot, config.output.raw), repoRoot) }
        : {}),
    };

    if (succeeded.length === 0) {
      reportStranded(await stashed.restore());
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

      try {
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

    // --- write -----------------------------------------------------------

    // Re-checked here, not just after the panel: a SIGINT during
    // consolidation surfaces as a merge failure, and execution would
    // otherwise carry straight on and replace the report anyway.
    if (interrupted) {
      reportStranded(await stashed.restore());
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
      reportStranded(await stashed.restore());
      stashed = null;

      progress.bell();

      // Released before the menu, not in the `finally`. These handlers
      // suppress default termination, and with no reviewer left to stop,
      // a SIGTERM arriving while the prompt waits would otherwise leave
      // the process blocked on stdin holding the lock.
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
              { relative: config.output.raw, content: renderRaw(context) },
              { relative: config.output.merged, content: deliverable },
            ]
          : [{ relative: config.output.merged, content: deliverable }];

      await commitOutputs(repoRoot, files);
      await stashed.discard();
      stashed = null;

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

    if (stashed) reportStranded(await stashed.restore().catch(() => []));

    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await releaseAll(outputLocks);
    await lock.release();
  }
}

export class PreflightError extends Error {}

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

function displayNames(
  panel: PanelEntry[],
  adapters: Map<string, Adapter>,
): Map<string, string> {
  const base = new Map<string, string>();
  const counts = new Map<string, number>();

  for (const entry of panel) {
    const label = adapters.get(entry.vendor)?.label ?? entry.vendor;
    const name = `${label} (${entry.model})`;

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

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
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
 * Whether the filesystem treats two spellings as one file.
 *
 * Folding unconditionally is wrong in both directions. On Linux `Review.md`
 * and `review.md` are two files that would share one lock key - and since
 * the second acquisition then finds the first lock holding this very pid,
 * the run deadlocks against itself. Not folding on Windows would let two
 * spellings of one file run unlocked.
 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

export function pathKey(file: string): string {
  const normalized = file.replace(/\\/g, '/');

  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

/**
 * Output locks are shared between repositories, so they cannot live in the
 * repository - but a world-writable `/tmp/crbuddy-locks` is shared between
 * USERS too, and the second user to run would hit EACCES on a directory
 * owned by the first. Per-user, so that never happens.
 */
function lockRoot(): string {
  let who = 'shared';

  try {
    const info = userInfo();
    who = info.uid >= 0 ? String(info.uid) : info.username;
  } catch {
    // No account information available; the shared name still works for a
    // single-user machine, which is the case that has no uid to read.
  }

  return path.join(tmpdir(), `crbuddy-locks-${who}`);
}

/**
 * Per-repository scratch and stash, outside the repository.
 *
 * Keyed by the repo's own path so two checkouts of the same project do not
 * share a holding directory, and so a report stranded by a crash is found
 * again by the next run in that same checkout.
 */
function repoStateDir(repoRoot: string): string {
  const key = createHash('sha1').update(pathKey(repoRoot)).digest('hex').slice(0, 16);

  return path.join(homedir(), HOME_CONFIG_DIR, 'state', key);
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
 * Kept in the OS temp directory so coordinating two repositories never
 * means dropping a lock file into someone's home or parent directory.
 */
async function acquireOutputLocks(
  repoRoot: string,
  config: Config,
): Promise<Lock[]> {
  const files = [config.output.merged, config.output.raw].map((relative) =>
    path.resolve(repoRoot, relative),
  );

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
  // No leading blank line. The document opens with `---`, and YAML
  // frontmatter is only frontmatter when its delimiter is the first
  // line - a spacer here would silently cost `crbuddy go > review.md`
  // its provenance block. The terminal gets its spacing from the
  // progress output that precedes this on stderr.
  process.stdout.write(`${document.trimEnd()}
`);

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
