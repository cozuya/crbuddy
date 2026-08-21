import { Cluster } from '../merge/cluster.js';
import { Finding } from '../merge/segment.js';
import { ResolvedTarget } from '../git/target.js';

/**
 * Rendering (DESIGN.md §9). Both files are rendered FROM STRUCTURED DATA —
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
}

export interface ReportContext {
  version: string;
  runId: string;
  generated: string;
  target: ResolvedTarget;
  runs: RunRecord[];
  mergeState: 'off' | 'ok' | 'failed';
  mergeReason?: string;
  configSource: string;
  warnings: string[];
  /** Relative path of the raw file, referenced from the merged one. */
  rawPath?: string;
}

const OPEN_REPORT = '<!-- crbuddy:report -->';
const CLOSE_REPORT = '<!-- /crbuddy:report -->';

export function renderFrontmatter(
  context: ReportContext,
  kind: 'merged' | 'raw',
): string {
  const succeeded = context.runs.filter((run) => run.ok).length;
  const failed = context.runs.length - succeeded;

  const lines: string[] = [
    '---',
    'crbuddy:',
    `  version: ${context.version}`,
    `  kind: ${kind}`,
    `  runId: ${context.runId}`,
    `  generated: ${context.generated}`,
    `  configSource: ${yamlString(context.configSource)}`,
    '  target:',
    `    kind: ${context.target.kind}`,
    `    snapshot: ${context.target.snapshot}`,
    `    base: ${context.target.base}`,
  ];

  if (context.target.requestedBase) {
    lines.push(`    requestedBase: ${yamlString(context.target.requestedBase)}`);
  }

  if (context.target.mergeBase) {
    lines.push(`    mergeBase: ${context.target.mergeBase}`);
  }

  lines.push(
    `    digest: ${context.target.digest}`,
    `    files: ${context.target.files.length}`,
    `    bytes: ${context.target.bytes}`,
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

  if (context.mergeState === 'off') {
    body.push(
      '- Consolidation is off; the reviews below are unmerged, in the order they were configured.',
    );
  }

  for (const run of context.runs.filter((r) => !r.ok)) {
    body.push(`- \`${run.id}\` (${run.vendor}) failed: ${run.reason ?? 'unknown'}`);
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
    `Reviewed \`${context.target.range}\` — ${context.target.files.length} file(s) changed.`,
  );

  return [OPEN_REPORT, ...body, CLOSE_REPORT, ''].join('\n');
}

export function renderRaw(context: ReportContext): string {
  // When consolidation is off or failed, this content IS the deliverable,
  // so the heading should not call itself a secondary artifact.
  const heading =
    context.mergeState === 'ok'
      ? '# Code review — unmerged reviews'
      : '# Code review';

  const parts = [
    renderFrontmatter(context, context.mergeState === 'ok' ? 'raw' : 'merged'),
    `${heading}\n`,
    renderReportBlock(context),
  ];

  for (const run of context.runs) {
    parts.push(
      `<!-- crbuddy:review id=${run.id} vendor=${run.vendor} model=${run.modelRequested} -->`,
    );

    parts.push(`## ${run.id} — ${run.vendor} / ${run.modelRequested}\n`);

    if (run.ok) {
      parts.push(run.output.trim(), '');
    } else {
      parts.push(
        `_This run did not complete: ${run.reason ?? 'unknown'}._\n`,
      );

      if (run.diagnostics) {
        parts.push('```', run.diagnostics.trim(), '```', '');
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
    renderFrontmatter(context, 'merged'),
    `# Code review — consolidated\n`,
    renderReportBlock(context),
    `_Findings are grouped by apparent duplication and ordered by how many ` +
      `reviewers raised them. Agreement is a priority heuristic, not a ` +
      `confidence score. Unmerged reviews: \`${context.rawPath ?? ''}\`_\n`,
  ];

  clusters.forEach((cluster, index) => {
    const members = cluster.findingIds
      .map((id) => byId.get(id))
      .filter((finding): finding is Finding => finding !== undefined);

    if (members.length === 0) return;

    const reviewers = [...new Set(members.map((member) => member.runId))];
    const first = members[0]!;

    parts.push(
      `<!-- crbuddy:cluster n=${index + 1} reviewers=${reviewers.length} -->`,
    );

    parts.push(`## ${index + 1}. ${first.title}`);

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

    parts.push(`<!-- /crbuddy:cluster n=${index + 1} -->\n`);
  });

  return parts.join('\n');
}

function countRuns(context: ReportContext): number {
  return context.runs.filter((run) => run.ok).length;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
