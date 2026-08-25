import { Finding } from './segment.js';

/**
 * Pass two of the merge (DESIGN.md §8).
 *
 * The model returns RELATIONSHIPS over finding IDs — never prose, never
 * edited text. crbuddy renders clusters mechanically from the originals.
 * The model therefore has no authority to delete or rewrite a finding, and
 * the failure mode is visible under-deduplication rather than silent loss.
 *
 * This is architectural on purpose. The identity/correctness boundary is
 * conceptually leaky — deciding whether two findings are "the same" often
 * IS correctness reasoning — so the authority is removed rather than
 * constrained by prompt wording.
 */

export interface Cluster {
  findingIds: string[];
}

export interface ValidatedClusters {
  clusters: Cluster[];
  /** Warnings that did not invalidate the result. */
  notes: string[];
}

export class MergeValidationError extends Error {}

export function buildMergePrompt(findings: Finding[]): string {
  const payload = findings.map((finding) => ({
    id: finding.id,
    reviewer: finding.runId,
    title: finding.title,
    locations: finding.locations,
    text: truncateForPrompt(finding.text),
  }));

  return [
    'You are performing duplicate identification, not code review.',
    '',
    'Every input finding is an opaque claim that must survive whether or not',
    'you believe it is correct. Group findings only when they describe the',
    'same underlying defect such that the same corrective action would',
    'address both. Similar symptoms, nearby locations, shared components, or',
    'competing explanations are NOT sufficient. Same file is not sufficient.',
    'Same line is not sufficient.',
    '',
    'Do not rank, reject, correct, rewrite, summarize, or omit findings.',
    'When uncertain, place a finding in its own group of one.',
    '',
    'Beware transitivity: if A resembles B and B resembles C, do not merge A',
    'and C unless the resulting group expresses one coherent defect.',
    '',
    'Return ONLY a JSON object, with no prose and no markdown fences:',
    '',
    '  { "clusters": [ { "findingIds": ["id1", "id2"] }, ... ] }',
    '',
    'Every input id must appear exactly once across all clusters. Do not',
    'invent ids. Do not emit empty clusters.',
    '',
    'FINDINGS:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function truncateForPrompt(text: string, limit = 4000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

/**
 * Tolerate a model that wraps JSON in fences or adds a sentence, but do not
 * tolerate a partition that loses findings.
 */
export function parseClusterResponse(raw: string): Cluster[] {
  const text = raw.trim();

  const candidates: string[] = [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1]);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;

      const clusters = (parsed as { clusters?: unknown })?.clusters;

      if (!Array.isArray(clusters)) continue;

      const shaped: Cluster[] = [];

      for (const item of clusters) {
        const ids = (item as { findingIds?: unknown })?.findingIds;

        if (!Array.isArray(ids)) continue;

        shaped.push({
          findingIds: ids.filter((id): id is string => typeof id === 'string'),
        });
      }

      if (shaped.length > 0) return shaped;
    } catch {
      // Try the next candidate shape.
    }
  }

  throw new MergeValidationError(
    'Merge model did not return a parseable { "clusters": [...] } object.',
  );
}

/**
 * The gate. Every input id present, exactly once, no unknown ids, no empty
 * clusters. Anything else and the caller falls back to raw-only.
 */
export function validateClusters(
  clusters: Cluster[],
  findings: Finding[],
): ValidatedClusters {
  const known = new Set(findings.map((finding) => finding.id));
  const seen = new Map<string, number>();
  const notes: string[] = [];
  const unknown: string[] = [];

  const cleaned: Cluster[] = [];

  for (const cluster of clusters) {
    const ids = cluster.findingIds.filter((id) => {
      if (!known.has(id)) {
        unknown.push(id);
        return false;
      }
      return true;
    });

    if (ids.length === 0) continue;

    for (const id of ids) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }

    cleaned.push({ findingIds: ids });
  }

  if (unknown.length > 0) {
    throw new MergeValidationError(
      `Merge model referenced ${unknown.length} unknown finding id(s): ` +
        `${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`,
    );
  }

  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);

  if (duplicated.length > 0) {
    throw new MergeValidationError(
      `Merge model placed ${duplicated.length} finding(s) in more than one cluster: ` +
        `${duplicated.slice(0, 5).map(([id]) => id).join(', ')}`,
    );
  }

  const missing = [...known].filter((id) => !seen.has(id));

  if (missing.length > 0) {
    throw new MergeValidationError(
      `Merge model dropped ${missing.length} finding(s): ` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
    );
  }

  return { clusters: cleaned, notes };
}

/**
 * Ordering: by number of DISTINCT reviewers that raised the finding.
 * Mechanical, requires no correctness judgment.
 *
 * This is a priority heuristic, not a confidence score — see the caveat in
 * the README. Models err in correlated ways, so agreement is weak evidence.
 */
export function orderClusters(
  clusters: Cluster[],
  findings: Finding[],
): Cluster[] {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));

  const isContextCluster = (cluster: Cluster): boolean =>
    cluster.findingIds.every((id) => byId.get(id)?.context === true);

  const reviewersOf = (cluster: Cluster): number =>
    new Set(
      cluster.findingIds
        .map((id) => byId.get(id)?.runId)
        .filter((runId): runId is string => runId !== undefined),
    ).size;

  return [...clusters].sort((a, b) => {
    // Context segments sink below every real finding regardless of how many
    // reviewers happened to emit similar boilerplate.
    const contextDiff = Number(isContextCluster(a)) - Number(isContextCluster(b));
    if (contextDiff !== 0) return contextDiff;

    const diff = reviewersOf(b) - reviewersOf(a);
    if (diff !== 0) return diff;

    // Stable-ish tiebreak: larger clusters first, then by first id.
    if (b.findingIds.length !== a.findingIds.length) {
      return b.findingIds.length - a.findingIds.length;
    }

    return (a.findingIds[0] ?? '').localeCompare(b.findingIds[0] ?? '');
  });
}

/** Fallback when merge is off or fails: one cluster per finding. */
export function singletons(findings: Finding[]): Cluster[] {
  return findings.map((finding) => ({ findingIds: [finding.id] }));
}
