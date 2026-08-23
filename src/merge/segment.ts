/**
 * Pass one of the merge (DESIGN.md §8): split each run's freeform output
 * into an enumerated finding list.
 *
 * This is mechanical rather than a model call, which makes it deterministic,
 * free, and testable — and lets it hold an invariant a model could not:
 *
 *   SEGMENTATION IS LOSSLESS. Concatenating every segment's raw text, in
 *   order, reproduces the input byte for byte. Nothing is summarized,
 *   rewritten, or dropped.
 *
 * If the heuristic splits badly, the failure is a finding that is too large
 * or too small — never a finding that vanished.
 */

export interface Finding {
  /** Stable within a panel: `<runId>#<n>`. */
  id: string;
  runId: string;
  /**
   * True when this segment is scene-setting rather than a finding — a
   * preamble line, a bare section heading, a sign-off. Still carried
   * verbatim (segmentation stays lossless), just rendered apart from the
   * numbered findings instead of masquerading as one.
   */
  context?: boolean;
  /** Best-effort title pulled from the segment's first heading or line. */
  title: string;
  /** Verbatim text. Never modified. */
  text: string;
  /** file:line references discovered in the text, for clustering hints. */
  locations: string[];
}

const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+\S/;
const BULLET = /^\s{0,3}[-*+]\s+\S/;
const HRULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Matches `path/to/file.ext:123`, `file.ext line 12`, and bare paths.
 *
 * Deliberately strict about what counts as a file. A loose pattern matched
 * things like `abc123..def456` (a commit range) and `5.7k` (a line count) as
 * file paths, which both polluted the clustering hints and made preamble
 * text look like a located finding. So: no consecutive dots before the
 * extension, and the extension must start with a letter.
 */
const LOCATION =
  /(?<![\w.\-/\\])((?:[\w.\-]+[/\\])*[\w\-]+(?:\.[\w\-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)|\s+(?:line|lines)\s+(\d+))?/g;

/**
 * Rewrite absolute paths under the repository root to repo-relative form.
 *
 * Some CLIs emit fully-qualified local paths. Those leak a machine's
 * directory layout the moment a handoff is pasted into an issue or a PR, and
 * they are useless to anyone else. Only the repo-root prefix is stripped -
 * a deterministic, mechanical substitution, not the model rewriting text.
 */
export function relativizePaths(text: string, repoRoot: string): string {
  if (!repoRoot) return text;

  const variants = new Set<string>();

  for (const base of [repoRoot, repoRoot.replace(/\\/g, '/')]) {
    const slashed = base.replace(/[\\/]+$/, '');

    variants.add(`${slashed}/`);
    variants.add(`${slashed.replace(/\//g, '\\')}\\`);
    variants.add(slashed);
    variants.add(slashed.replace(/\//g, '\\'));
  }

  let out = text;

  // Longest first, so trailing-separator forms win over their prefixes.
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (variant === '') continue;

    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '');
  }

  return out;
}

export function segment(runId: string, output: string): Finding[] {
  const lines = output.split('\n');

  // Choose the split rule by what the document actually uses, preferring the
  // coarsest structure present so findings do not fragment into sub-bullets.
  const usesHeadings = lines.some((line) => HEADING.test(line));
  const usesNumbers = lines.some((line) => NUMBERED.test(line));

  const isBoundary = (line: string, inFence: boolean): boolean => {
    if (inFence) return false;
    if (usesHeadings) return HEADING.test(line);
    if (usesNumbers) return NUMBERED.test(line);
    return BULLET.test(line) || HRULE.test(line);
  };

  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (fence) {
      const marker = fence[1]!;

      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0]!;
      } else if (marker[0] === fenceMarker) {
        inFence = false;
      }
    }

    if (isBoundary(line, inFence) && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
    }

    current.push(line);
  }

  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }

  // A preamble before the first boundary is kept as its own segment rather
  // than discarded — losslessness is the whole point.
  const findings: Finding[] = [];

  chunks.forEach((text, index) => {
    if (text.trim() === '' && findings.length > 0) {
      // Fold whitespace-only tails into the previous segment so no bytes
      // are lost and no empty finding is emitted.
      const previous = findings[findings.length - 1]!;
      previous.text = `${previous.text}\n${text}`;
      return;
    }

    const locations = locationsIn(text);

    findings.push({
      id: `${runId}#${index + 1}`,
      runId,
      title: titleOf(text),
      text,
      locations,
      ...(isContext(text, locations) ? { context: true } : {}),
    });
  });

  return findings;
}

export function titleOf(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    return trimmed
      .replace(/^#{1,6}\s*/, '')
      .replace(/^\d{1,3}[.)]\s*/, '')
      .replace(/^[-*+]\s*/, '')
      .replace(/^\*\*(.+?)\*\*:?\s*/, '$1')
      .slice(0, 160);
  }

  return '(untitled)';
}

export function locationsIn(text: string): string[] {
  const found = new Set<string>();

  // Ignore fenced code so example paths inside snippets do not dominate.
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');

  for (const match of withoutFences.matchAll(LOCATION)) {
    const file = match[1]!;
    const line = match[2] ?? match[3];

    found.add(line ? `${file}:${line}` : file);
  }

  return [...found].slice(0, 12);
}

/** Test hook: segmentation must reproduce its input exactly. */
export function reassemble(findings: Finding[]): string {
  return findings.map((finding) => finding.text).join('\n');
}

/**
 * A finding says something about specific code. A segment with no file
 * reference and no substance behind its heading is a preamble, a section
 * divider, or a sign-off — clustering those as findings produced entries
 * like "Findings ordered by severity" sitting beside real bugs.
 *
 * Conservative on purpose: any file reference at all, or a real body, makes
 * it a finding. The cost of a false negative here is one tidy line in the
 * wrong section; the cost of a false positive is a buried bug.
 */
export function isContext(text: string, locations: string[]): boolean {
  if (locations.length > 0) return false;

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (lines.length === 0) return true;

  // A lone heading or one-liner with nothing under it.
  if (lines.length === 1) return true;

  // A heading plus only trivial body text.
  const body = lines.slice(1).join(' ');

  return body.length < 80;
}
