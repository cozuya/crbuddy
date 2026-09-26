import { ResolvedTarget } from '../git/target.js';

/**
 * Rendering (DESIGN.md §9). The report is rendered FROM STRUCTURED DATA. The
 * HTML comment markers are navigation aids for humans; a model's verbatim
 * output can contain the closing marker, so they are not a parsing boundary
 * and nothing in crbuddy treats them as one.
 */

export interface RunRecord {
  id: string;
  vendor: string;
  cli: string;
  cliVersion: string | null;
  modelRequested: string;
  effortRequested: string | null;
  effortApplied: string | null;
  ok: boolean;
  reason?: string;
  wallClockMs: number;
  output: string;
  /** Truncated diagnostics, kept when a run fails and has nowhere else to go. */
  diagnostics?: string;
}

/**
 * `version`, `generated`, `configSource` and `configScope` (and a run's
 * `cliVersion`) are not rendered: they went unused when the report's
 * frontmatter was removed with the consolidation pass in 0.4.0, and nothing
 * else reads them. Kept for now as provenance a report block could show.
 */
export interface ReportContext {
  version: string;
  runId: string;
  generated: string;
  target: ResolvedTarget;
  runs: RunRecord[];
  /** Repo-relative or ~-prefixed; never a full machine path. */
  configSource: string;
  configScope: 'project' | 'global';
  /**
   * True when the target diff was empty and the panel reviewed the checkout
   * as it stands instead. A different kind of run, so the report says so
   * rather than reporting zero changed files as if that were normal.
   */
  wholeCheckout?: boolean;
  /** Snapshot captured immediately before a live whole-checkout review starts. */
  checkoutLaunchSnapshot?: string;
  warnings: string[];
}

const OPEN_REPORT = '<!-- crbuddy:report -->';
const CLOSE_REPORT = '<!-- /crbuddy:report -->';

export function renderReportBlock(context: ReportContext): string {
  const succeeded = context.runs.filter((run) => run.ok).length;
  const total = context.runs.length;

  const body: string[] = [
    `**${succeeded} of ${total} review${total === 1 ? '' : 's'} completed.**`,
  ];

  if (context.wholeCheckout) {
    body.push(
      '- There was no diff, so the reviews below cover the whole checkout rather than a change. ' +
        'No vendor CLI has a native review mode for that, so every entry ran as a ' +
        'general-purpose agent pointed at the repository.',
    );
  }

  for (const run of context.runs.filter((r) => !r.ok)) {
    body.push(
      `- \`${run.id}\` (${run.vendor}) failed: ${run.reason ?? 'unknown'}` +
        (run.output ? ' - its output is kept below, possibly incomplete' : ''),
    );
  }

  for (const warning of context.warnings) {
    body.push(`- ${warning}`);
  }

  body.push(
    '',
    context.wholeCheckout
      ? `Checkout snapshot captured at launch: \`${context.checkoutLaunchSnapshot ?? context.target.snapshot}\` - no diff; reviewers ran against the live working tree.`
      : `Reviewed \`${context.target.range}\` - ${context.target.files.length} file(s) changed.`,
  );

  return [OPEN_REPORT, ...body, CLOSE_REPORT, ''].join('\n');
}

/** The reviews in the order they were configured, each kept verbatim. */
export function renderReport(context: ReportContext): string {
  const parts = [
    '# Code review\n',
    // Identifies which run produced a report found on disk.
    `<!-- crbuddy:raw runId=${context.runId} -->\n`,
    renderReportBlock(context),
  ];

  for (const run of context.runs) {
    // The applied effort, not the configured one: an adapter may fill in its
    // default or be unable to pass the setting at all.
    const effort = run.effortApplied;

    parts.push(
      `<!-- crbuddy:review id=${run.id} vendor=${run.vendor} model=${run.modelRequested}` +
        `${effort ? ` effort=${effort}` : ''} -->`,
    );

    parts.push(
      `## ${run.id} - ${run.vendor} / ${run.modelRequested}` +
        `${effort ? `, effort ${effort}` : ''}\n`,
    );

    if (run.ok) {
      parts.push(run.output.trim(), '');
    } else {
      parts.push(
        `_This run did not complete: ${run.reason ?? 'unknown'}._\n`,
      );

      if (run.diagnostics) {
        const diagnostics = run.diagnostics.trim();
        const fence = fenceFor(diagnostics);

        parts.push(diagnosticsLabel(run), `${fence}text`, diagnostics, fence, '');
      }

      if (run.output.trim()) {
        parts.push(
          '_Its output is kept below, but treat it as possibly incomplete._\n',
          run.output.trim(),
          '',
        );
      }
    }

    parts.push(`<!-- /crbuddy:review id=${run.id} -->\n`);
  }

  return parts.join('\n');
}

/**
 * A fence longer than any backtick run in the text. Diagnostics are the tail
 * of a reviewer's own markdown, and a ``` inside a fixed three-backtick fence
 * ended the block early, spilling the rest of the report out of it.
 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function diagnosticsLabel(run: RunRecord): string {
  return run.reason === 'timeout'
    ? 'Last stderr captured before crbuddy terminated the timed-out process:'
    : 'Failure diagnostics:';
}
