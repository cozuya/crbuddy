/**
 * Just enough of SemVer 2.0.0 precedence to compare two package versions.
 * Not for vendor CLI versions: those are read loosely in adapters/version.ts.
 */
interface SemVer {
  core: [number, number, number];
  prerelease: string[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(value: string): SemVer | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Negative, zero or positive as `left` sorts before, with or after `right`. */
function compareParsed(left: SemVer, right: SemVer): number {
  for (let i = 0; i < 3; i += 1) {
    const difference = left.core[i]! - right.core[i]!;
    if (difference !== 0) return Math.sign(difference);
  }

  // A release outranks any of its pre-releases.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);

  for (let i = 0; i < length; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);

    // Numeric identifiers compare as numbers and sort before alphanumeric ones.
    if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }

  return 0;
}

/** Whether `candidate` is a strictly newer version; false if either is invalid. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const next = parseSemver(candidate);
  const current = parseSemver(installed);

  return next !== null && current !== null && compareParsed(next, current) > 0;
}
