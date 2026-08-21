/**
 * Vendor CLI version comparison.
 *
 * Effort translation used to live here. It was removed: crbuddy already
 * stores vendor-native model ids in config, so an abstract, portable effort
 * vocabulary was inconsistent with the rest of the schema — and the
 * clamping it required was a silent-degradation risk that then needed
 * version stamps and warnings to detect. `init` now offers each vendor's own
 * effort values and stores the chosen string verbatim.
 *
 * What remains is used only to tell the user their CLI is newer than the
 * lists crbuddy ships, which affects what `init` can offer, not what runs.
 */

/** Naive semver-ish comparison; true when `detected` > `stamped`. */
export function isNewerThanStamp(detected: string, stamped: string): boolean {
  const parse = (value: string): number[] =>
    (value.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));

  const a = parse(detected);
  const b = parse(stamped);

  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;

    if (left > right) return true;
    if (left < right) return false;
  }

  return false;
}
