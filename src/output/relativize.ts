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
