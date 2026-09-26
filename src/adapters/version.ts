/** Compare dotted CLI versions numerically, ignoring surrounding text. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    (value.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));

  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  return 0;
}

export function isVersionAtLeast(detected: string, minimum: string): boolean {
  return compareVersions(detected, minimum) >= 0;
}

/**
 * The version a probe found, read from everything the CLI printed. Setup,
 * doctor and go all use this one reading, so they cannot disagree about
 * whether a CLI is usable; the first line alone missed versions printed later.
 */
export function probedVersion(
  adapter: { parseVersion(text: string): string | null },
  result: { present: boolean; text?: string },
): string | null {
  return result.present ? adapter.parseVersion(result.text ?? '') : null;
}
