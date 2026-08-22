import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { Config, PanelEntry, WORK_DIR } from '../config/schema.js';
import { LoadedConfig } from '../config/load.js';
import { ResolvedTarget, resolveTarget } from '../git/target.js';
import { Adapter, UnsafeInvocationError } from '../adapters/types.js';
import { getAdapter } from '../adapters/vendors.js';
import { isVersionAtLeast } from '../adapters/version.js';
import { Semaphore } from '../util/semaphore.js';
import { acquireLock } from '../util/lock.js';
import { killAll, probe, runProcess } from '../run/spawn.js';
import { Finding, segment } from '../merge/segment.js';
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
import { formatClock, formatElapsed, formatSize } from '../util/format.js';

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

  const scratch = path.join(workDir, 'scratch');
  await mkdir(scratch, { recursive: true });

  // Lock first. Cleanup touches `*.crbuddy-tmp-*` files, and doing that
  // before the lock lets a second invocation delete a live run's staged
  // output on its way to failing the lock check.
  const lock = await acquireLock(workDir);

  await cleanupTemps(repoRoot, [config.output.merged, config.output.raw]);

  // Recover anything a crashed run left in a holding directory before this
  // run stashes outputs of its own.
  const recovered = await recoverStrandedOutputs(repoRoot, workDir);

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
    progress.line('Interrupted — terminating agents and restoring previous output.');
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
            `version-sensitive native-review behavior. Run \`crbuddy check\` for details.`,
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

    if (config.refuseIfOutputExists) {
      const existing = [config.output.merged, config.output.raw].filter((relative) =>
        existsSync(path.join(repoRoot, relative)),
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
      exclude: [config.output.merged, config.output.raw, `${WORK_DIR}/`],
    });

    if (target.files.length === 0) {
      progress.line('Nothing to review — the target diff is empty.');
      return EXIT_TOTAL_FAILURE;
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
      workDir,
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
            ...(options.instructionsOverride
              ? { instructionsOverride: options.instructionsOverride }
              : {}),
          }),
        ),
      ),
    );

    progress.stopPulse();

    if (interrupted) {
      await stashed.restore();
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
      configSource: loaded.source,
      warnings,
      rawPath: config.output.raw,
    };

    if (succeeded.length === 0) {
      await stashed.restore();
      progress.dim('');
      progress.line('Every review failed. Previous output left in place.');
      return EXIT_TOTAL_FAILURE;
    }

    // --- merge -----------------------------------------------------------

    const findings: Finding[] = succeeded.flatMap((record) =>
      segment(record.id, record.output),
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
          scratch,
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

    const files =
      context.mergeState === 'ok'
        ? [
            { relative: config.output.raw, content: renderRaw(context) },
            {
              relative: config.output.merged,
              content: renderMerged(context, clusters, findings),
            },
          ]
        : [{ relative: config.output.merged, content: renderRaw(context) }];

    await commitOutputs(repoRoot, files);
    await stashed.discard();
    stashed = null;

    progress.dim('');
    progress.line(
      context.mergeState === 'ok'
        ? `Wrote ${config.output.merged} and ${config.output.raw}.`
        : `Wrote ${config.output.merged}.`,
    );

    progress.bell();

    const partial =
      succeeded.length < records.length || context.mergeState === 'failed';

    if (partial && options.strict) return EXIT_PARTIAL;

    return EXIT_OK;
  } finally {
    progress.stopPulse();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);

    if (stashed) await stashed.restore().catch(() => {});

    await rm(scratch, { recursive: true, force: true }).catch(() => {});
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
      operation: instructions
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
        `  ${args.display} — FAILED: unsafe_invocation\n      ` +
          `${firstLine(outcome.diagnostics)}`,
      );

      return outcome;
    }

    throw error;
  }

  for (const warning of invocation.warnings ?? []) {
    progress.line(`  ${args.display} — ${warning}`);
  }

  progress.laneStarted(args.display);
  progress.dim(`  ${args.display} — started`);

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
      progress.dim(`  ${args.display} — done in ${formatElapsed(outcome.wallClockMs)}`);
    } else {
      const detail = firstLine(outcome.diagnostics);

      progress.line(
        `  ${args.display} — FAILED: ${outcome.reason}${detail ? `\n      ${detail}` : ''}`,
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

  return report({ ...record, ok: true, output: body });
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
    cwd: args.repoRoot,
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
