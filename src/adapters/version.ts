import type { Adapter, ModelCliMinimum, VendorModel } from './types.js';

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

/**
 * Listed models that need a newer CLI than the detected one. Empty when the
 * version is unknown: go already refuses an unreadable version for every model.
 */
export function modelsNeedingNewerCli(
  adapter: Pick<Adapter, 'models'>,
  detected: string | null,
): Array<VendorModel & { cliMinimum: ModelCliMinimum }> {
  if (detected === null) return [];

  return adapter.models.filter(
    (model): model is VendorModel & { cliMinimum: ModelCliMinimum } =>
      model.cliMinimum !== undefined && !isVersionAtLeast(detected, model.cliMinimum.version),
  );
}

/** One line for setup and doctor, which still count the CLI as usable. */
export function modelMinimumNote(
  model: VendorModel & { cliMinimum: ModelCliMinimum },
  detected: string,
): string {
  return (
    `${model.id} needs ${model.cliMinimum.version} or newer (crbuddy's tested ` +
    `baseline); other models run on ${detected}`
  );
}

/**
 * Why a lane must not run `model` on the detected CLI, or null. Only an exact
 * listed ID has a model minimum; any other string passes through as before.
 */
export function modelVersionProblem(
  adapter: Pick<Adapter, 'label' | 'models' | 'npmPackage'>,
  model: string,
  detected: string | null,
): string | null {
  const listed = modelsNeedingNewerCli(adapter, detected).find((entry) => entry.id === model);
  if (!listed) return null;

  const { version, instead } = listed.cliMinimum;

  return [
    `${listed.id} requires ${adapter.label} >= ${version} in crbuddy (tested ` +
      `compatibility baseline); found ${detected}.`,
    `Upgrade ${adapter.label} in the environment where crbuddy runs (updating ` +
      `crbuddy does not update it), or select ${instead}.`,
    ...(adapter.npmPackage
      ? [`For npm installations: npm install -g ${adapter.npmPackage}@${version}`]
      : []),
  ].join('\n');
}
