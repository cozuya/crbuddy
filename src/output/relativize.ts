/**
 * Rewrite absolute paths under the repository root to repo-relative form.
 *
 * Some CLIs emit fully-qualified local paths. Those leak a machine's
 * directory layout the moment a handoff is pasted into an issue or a PR, and
 * they are useless to anyone else. Only the repo-root prefix is stripped -
 * a deterministic, mechanical substitution, not the model rewriting text.
 *
 * The root is stripped only where it is a whole path, not a prefix of a
 * sibling (`/work/app` inside `/work/app-server/x.ts`) or the tail of a
 * longer path. Case is ignored only when the caller knows the volume folds
 * it; on a case-sensitive one `/work/APP` is a different directory.
 */
export function relativizePaths(
  text: string,
  repoRoot: string,
  options: { foldCase?: boolean } = {},
): string {
  if (!repoRoot) return text;

  const roots = new Set<string>();

  for (const base of [repoRoot, repoRoot.replace(/\\/g, '/')]) {
    const slashed = base.replace(/[\\/]+$/, '');

    // A filesystem root is a prefix of every absolute path; stripping it
    // would mangle all of them rather than relativize anything.
    if (slashed === '' || /^[A-Za-z]:$/.test(slashed)) continue;

    roots.add(slashed);
    roots.add(slashed.replace(/\//g, '\\'));
  }

  // Characters that continue a path segment. A `.` counts only when a name
  // follows it, so a root that ends a sentence is still stripped.
  const before = '(?<![\\p{L}\\p{N}_.~-])';
  const after = '(?:[\\\\/]|(?![\\p{L}\\p{N}_~-]|\\.[\\p{L}\\p{N}_~-]))';
  const flags = options.foldCase ? 'giu' : 'gu';

  let out = text;

  // Longest first, so a longer spelling is never cut short by a shorter one.
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${before}${escaped}${after}`, flags), '');
  }

  return out;
}
