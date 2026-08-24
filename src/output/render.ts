import { Cluster } from '../merge/cluster.js';
import { Finding } from '../merge/segment.js';
import { ResolvedTarget } from '../git/target.js';

/**
 * Rendering (DESIGN.md §9). Both files are rendered FROM STRUCTURED DATA -
 * the merged file is never produced by parsing markdown back out of the raw
 * one. The HTML comment markers are navigation aids for humans; a model's
 * verbatim output can contain the closing marker, so they are not a parsing
 * boundary and nothing in crbuddy treats them as one.
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
  /** Completed, but returned so little it may not be a review at all. */
  suspiciouslyShort?: boolean;
}

export interface ReportContext {
  version: string;
  runId: string;
  generated: string;
  target: ResolvedTarget;
  runs: RunRecord[];
  mergeState: 'off' | 'ok' | 'failed';
  mergeReason?: string;
  /** Repo-relative or ~-prefixed; never a full machine path. */
  configSource: string;
  configScope: 'project' | 'global';
  /**
   * True when the target diff was empty and the panel reviewed the checkout
   * as it stands instead. A different kind of run, so the report says so
   * rather than reporting zero changed files as if that were normal.
   */
  wholeCheckout?: boolean;
  /** Canonical live-checkout snapshot used by a whole-checkout review. */
  reviewedSnapshot?: string;
  warnings: string[];
  /** Relative path of the raw file, referenced from the merged one. */
  rawPath?: string;
}

const OPEN_REPORT = '<!-- crbuddy:report -->';
const CLOSE_REPORT = '<!-- /crbuddy:report -->';

export function renderFrontmatter(context: ReportContext): string {
  const succeeded = context.runs.filter((run) => run.ok).length;
  const failed = context.runs.length - succeeded;
  const wholeCheckout = context.wholeCheckout && context.reviewedSnapshot;

  const lines: string[] = [
    '---',
    'crbuddy:',
    `  version: ${context.version}`,
    '  kind: consolidated',
    `  runId: ${context.runId}`,
    `  generated: ${context.generated}`,
    `  configSource: ${yamlString(context.configSource)}`,
    `  configScope: ${context.configScope}`,
    '  target:',
  ];

  if (wholeCheckout) {
    lines.push(
      '    kind: whole-checkout',
      `    snapshot: ${context.reviewedSnapshot}`,
      `    requestedKind: ${context.target.kind}`,
      `    requestedSnapshot: ${context.target.snapshot}`,
    );
  } else {
    lines.push(
      `    kind: ${context.target.kind}`,
      `    snapshot: ${context.target.snapshot}`,
      `    base: ${context.target.base}`,
    );
  }

  if (context.target.requestedBase) {
    lines.push(`    requestedBase: ${yamlString(context.target.requestedBase)}`);
  }

  if (context.target.mergeBase) {
    lines.push(`    mergeBase: ${context.target.mergeBase}`);
  }

  if (!wholeCheckout) {
    lines.push(
      `    digest: ${context.target.digest}`,
      `    files: ${context.target.files.length}`,
      `    bytes: ${context.target.bytes}`,
    );
  }

  lines.push(
    '  runs:',
    `    configured: ${context.runs.length}`,
    `    succeeded: ${succeeded}`,
    `    failed: ${failed}`,
  );

  const failures = context.runs.filter((run) => !run.ok);

  if (failures.length > 0) {
    lines.push('  failures:');
    for (const run of failures) {
      lines.push(
        `    - { id: ${yamlString(run.id)}, vendor: ${yamlString(run.vendor)}, ` +
          `reason: ${yamlString(run.reason ?? 'unknown')} }`,
      );
    }
  }

  lines.push('  adapters:');

  for (const run of context.runs) {
    lines.push(
      `    - { id: ${yamlString(run.id)}, cli: ${yamlString(run.cli)}, ` +
        `cliVersion: ${yamlString(run.cliVersion ?? 'unknown')}, ` +
        `model: ${yamlString(run.modelRequested)}, ` +
        `effort: ${yamlString(run.effortApplied ?? 'none')}, ` +
        `wallClockMs: ${run.wallClockMs} }`,
    );
  }

  lines.push(`  merge: ${context.mergeState}`);

  if (context.mergeReason) {
    lines.push(`  mergeReason: ${yamlString(context.mergeReason)}`);
  }

  lines.push('---', '');

  return lines.join('\n');
}

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

  if (context.mergeState === 'off') {
    body.push(
      '- Consolidation is off; the reviews below are unmerged, in the order they were configured.',
    );
  }

  for (const run of context.runs.filter((r) => !r.ok)) {
    body.push(`- \`${run.id}\` (${run.vendor}) failed: ${run.reason ?? 'unknown'}`);
  }

  for (const run of context.runs.filter((r) => r.suspiciouslyShort)) {
    body.push(
      `- \`${run.id}\` completed but returned very little text; check whether ` +
        `it actually produced a review.`,
    );
  }

  if (context.mergeState === 'failed') {
    body.push(
      `- Consolidation failed (${context.mergeReason ?? 'unknown'}). ` +
        `This file contains the unmerged reviews.`,
    );
  }

  for (const warning of context.warnings) {
    body.push(`- ${warning}`);
  }

  body.push(
    '',
    context.wholeCheckout
      ? `Reviewed the checkout at \`${context.reviewedSnapshot ?? context.target.snapshot}\` - no diff; the whole tree was the subject.`
      : `Reviewed \`${context.target.range}\` - ${context.target.files.length} file(s) changed.`,
  );

  return [OPEN_REPORT, ...body, CLOSE_REPORT, ''].join('\n');
}

export function renderRaw(context: ReportContext): string {
  // When consolidation is off or failed, this content IS the deliverable,
  // so the heading should not call itself a secondary artifact.
  const heading =
    context.mergeState === 'ok'
      ? '# Code review - unmerged reviews'
      : '# Code review';

  const parts = [
    `${heading}\n`,
    // The raw report intentionally omits the large YAML provenance block,
    // but it still needs a run identity. If a process dies between the raw
    // and merged renames, this marker makes a mixed pair detectable by
    // comparing it with the consolidated report's frontmatter.
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

export function renderMerged(
  context: ReportContext,
  clusters: Cluster[],
  findings: Finding[],
): string {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));

  const parts = [
    renderFrontmatter(context),
    `# Code review - consolidated\n`,
    renderReportBlock(context),
    `_Findings are grouped by apparent duplication and ordered by how many ` +
      `reviewers raised them. Cluster labels (C1, C2…) are crbuddy's; any ` +
      `numbering inside a finding is the reviewer's own. Agreement is a ` +
      `priority heuristic, not a confidence score.` +
      // Absent in terminal mode: there is no unmerged file on disk, and
      // pointing the reader at one that does not exist is worse than
      // saying nothing.
      `${context.rawPath ? ` Unmerged reviews: \`${context.rawPath}\`` : ''}_\n`,
  ];

  const resolve = (cluster: Cluster): Finding[] =>
    cluster.findingIds
      .map((id) => byId.get(id))
      .filter((finding): finding is Finding => finding !== undefined);

  const isContextCluster = (cluster: Cluster): boolean => {
    const members = resolve(cluster);
    return members.length > 0 && members.every((member) => member.context === true);
  };

  const real = clusters.filter((cluster) => !isContextCluster(cluster));
  const contextOnly = clusters.filter(isContextCluster);

  let counter = 0;

  const renderCluster = (cluster: Cluster, label: string): void => {
    const members = resolve(cluster);

    if (members.length === 0) return;

    const reviewers = [...new Set(members.map((member) => member.runId))];
    const first = members[0]!;

    parts.push(
      `<!-- crbuddy:cluster id=${label} reviewers=${reviewers.length} -->`,
    );

    // Labelled C1, C2… rather than 1, 2… because reviewers number their own
    // findings, and two competing "finding 3"s in one document is a
    // guaranteed miscommunication.
    parts.push(`## ${label}. ${first.title}`);

    parts.push(
      `_Raised by ${reviewers.length} of ${countRuns(context)} reviewer(s): ` +
        `${reviewers.map((r) => `\`${r}\``).join(', ')}_\n`,
    );

    members.forEach((member) => {
      parts.push(`<!-- crbuddy:finding id=${member.id} -->`);
      parts.push(`**${member.runId}**\n`);
      parts.push(member.text.trim(), '');
      parts.push(`<!-- /crbuddy:finding id=${member.id} -->\n`);
    });

    parts.push(`<!-- /crbuddy:cluster id=${label} -->\n`);
  };

  for (const cluster of real) {
    counter += 1;
    renderCluster(cluster, `C${counter}`);
  }

  if (contextOnly.length > 0) {
    parts.push(
      `---\n`,
      `## Reviewer preamble\n`,
      `_Kept verbatim for completeness. These segments carried no file ` +
        `reference and no substantive body, so they are not treated as ` +
        `findings._\n`,
    );

    for (const cluster of contextOnly) {
      counter += 1;
      renderCluster(cluster, `P${counter - real.length}`);
    }
  }

  return parts.join('\n');
}

function diagnosticsLabel(run: RunRecord): string {
  return run.reason === 'timeout'
    ? 'Last stderr captured before crbuddy terminated the timed-out process:'
    : 'Failure diagnostics:';
}

function countRuns(context: ReportContext): number {
  return context.runs.filter((run) => run.ok).length;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
