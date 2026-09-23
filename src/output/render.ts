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
    body.push(`- \`${run.id}\` (${run.vendor}) failed: ${run.reason ?? 'unknown'}`);
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
    parts.push(
      `<!-- crbuddy:review id=${run.id} vendor=${run.vendor} model=${run.modelRequested} -->`,
    );

    parts.push(`## ${run.id} - ${run.vendor} / ${run.modelRequested}\n`);

    if (run.ok) {
      parts.push(run.output.trim(), '');
    } else {
      parts.push(
        `_This run did not complete: ${run.reason ?? 'unknown'}._\n`,
      );

      if (run.diagnostics) {
        parts.push(
          diagnosticsLabel(run),
          '```text',
          run.diagnostics.trim(),
          '```',
          '',
        );
      }
    }

    parts.push(`<!-- /crbuddy:review id=${run.id} -->\n`);
  }

  return parts.join('\n');
}

function diagnosticsLabel(run: RunRecord): string {
  return run.reason === 'timeout'
    ? 'Last stderr captured before crbuddy terminated the timed-out process:'
    : 'Failure diagnostics:';
}
