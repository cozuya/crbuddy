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
 * Matches `path/to/file.ext:123` and `path/to/file.ext line 123`, plus bare
 * paths with an extension.
 */
const LOCATION =
  /\b((?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z0-9]{1,8})(?::(\d+)|\s+(?:line|lines)\s+(\d+))?/g;

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

    findings.push({
      id: `${runId}#${index + 1}`,
      runId,
      title: titleOf(text),
      text,
      locations: locationsIn(text),
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
