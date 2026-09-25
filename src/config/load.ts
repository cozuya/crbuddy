import { readFile } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  CONFIG_FILENAME,
  CONFIG_VERSION,
  Config,
  DEFAULTS,
  DEFAULT_OUTPUT,
  HOME_CONFIG_DIR,
  LEGACY_RAW_OUTPUT,
  OutputConfig,
  OutputDestination,
  PROJECT_CONFIG_DIR,
  PanelEntry,
  Target,
} from './schema.js';

export class ConfigError extends Error {}

export interface LoadedConfig {
  config: Config;
  /** Absolute path the config came from. */
  source: string;
  scope: 'project' | 'global';
  /** Keys from removed features that were present and ignored. */
  obsoleteKeys: string[];
  /**
   * The obsolete `output.raw` value, if the file still has one. Ignored as
   * configuration, but it names a file an earlier version may have left in
   * the repository.
   */
  legacyRawOutput?: string;
}

export function homeConfigPath(): string {
  return path.join(homedir(), HOME_CONFIG_DIR, CONFIG_FILENAME);
}

export function projectConfigPath(repoRoot: string): string {
  return path.join(repoRoot, PROJECT_CONFIG_DIR, CONFIG_FILENAME);
}

/**
 * Project-local config REPLACES the global one entirely. No implicit
 * merging — see DESIGN.md §3 for why.
 */
export async function loadConfig(repoRoot: string): Promise<LoadedConfig> {
  const projectPath = projectConfigPath(repoRoot);

  if (existsSync(projectPath)) {
    const { config, obsoleteKeys, legacyRawOutput } = await readConfigFile(projectPath);
    assertUsableOutput(config.output, `${projectPath}.output`, repoRoot);

    return {
      config,
      source: projectPath,
      scope: 'project',
      obsoleteKeys,
      ...(legacyRawOutput ? { legacyRawOutput } : {}),
    };
  }

  const globalPath = homeConfigPath();

  if (existsSync(globalPath)) {
    const { config, obsoleteKeys, legacyRawOutput } = await readConfigFile(globalPath);
    assertUsableOutput(config.output, `${globalPath}.output`, repoRoot);

    return {
      config,
      source: globalPath,
      scope: 'global',
      obsoleteKeys,
      ...(legacyRawOutput ? { legacyRawOutput } : {}),
    };
  }

  throw new ConfigError(
    `No config found.\n` +
      `  Looked for: ${projectPath}\n` +
      `              ${globalPath}\n` +
      `Run \`crb init\` to create one.`,
  );
}

export async function readAndValidate(file: string): Promise<Config> {
  return (await readConfigFile(file)).config;
}

async function readConfigFile(
  file: string,
): Promise<{ config: Config; obsoleteKeys: string[]; legacyRawOutput: string | null }> {
  let text: string;

  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config at ${file}: ${String(error)}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new ConfigError(`Config at ${file} is not valid JSON: ${String(error)}`);
  }

  return {
    config: validate(parsed, file),
    obsoleteKeys: obsoleteKeys(parsed),
    legacyRawOutput: legacyRawOutput(parsed),
  };
}

/** Tolerate // and /* *\/ comments so the shipped example stays annotated. */
export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (ch === '\\') {
        const following = input[i + 1];
        if (following !== undefined) {
          out += following;
          i += 1;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Keys left behind by the consolidation pass, removed in 0.4.0. Accepted and
 * ignored rather than rejected, so configs written by earlier versions keep
 * loading; `crb config` drops them on its next save.
 */
const OBSOLETE_TOP_LEVEL_KEYS = ['merge', 'mergeTimeoutMs'];

export function obsoleteKeys(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];

  const raw = input as Record<string, unknown>;
  const found = OBSOLETE_TOP_LEVEL_KEYS.filter((key) => key in raw);
  const output = raw.output;

  if (typeof output === 'object' && output !== null && 'raw' in output) {
    found.push('output.raw');
  }

  return found;
}

/** The obsolete `output.raw` path, when it is a usable string. */
export function legacyRawOutput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;

  const output = (input as Record<string, unknown>).output;
  if (typeof output !== 'object' || output === null) return null;

  const raw = (output as Record<string, unknown>).raw;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

const TOP_LEVEL_KEYS = new Set([
  'configVersion',
  'output',
  'target',
  'savedReviewInstructions',
  'refuseIfOutputExists',
  'timeoutMs',
  'maxConcurrent',
  'maxDiffBytes',
  'panel',
  'extends',
  ...OBSOLETE_TOP_LEVEL_KEYS,
]);

const ENTRY_KEYS = new Set([
  'id',
  'vendor',
  'model',
  'effort',
  'instructions',
  'vendorArgs',
]);

/** Unknown keys are fatal — a typo silently doing nothing is worse. */
export function validate(input: unknown, where = 'config'): Config {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError(`${where}: expected a JSON object at the top level.`);
  }

  const raw = input as Record<string, unknown>;

  rejectUnknown(raw, TOP_LEVEL_KEYS, where);

  if ('extends' in raw) {
    throw new ConfigError(
      `${where}: "extends" is reserved for a future release and is not implemented. ` +
        `A project-local config replaces the global one entirely.`,
    );
  }

  const configVersion = raw.configVersion ?? CONFIG_VERSION;

  if (typeof configVersion !== 'number' || !Number.isInteger(configVersion)) {
    throw new ConfigError(`${where}: "configVersion" must be an integer.`);
  }

  if (configVersion > CONFIG_VERSION) {
    throw new ConfigError(
      `${where}: config declares version ${configVersion} but this crbuddy understands ` +
        `up to ${CONFIG_VERSION}. Upgrade crbuddy.`,
    );
  }

  const output = validateOutput(raw.output, where);
  const target = validateTarget(raw.target, where);
  const panel = validatePanel(raw.panel, where);
  const savedReviewInstructions =
    raw.savedReviewInstructions === undefined
      ? undefined
      : str(
          raw.savedReviewInstructions,
          undefined,
          `${where}.savedReviewInstructions`,
        );

  const config: Config = {
    configVersion,
    output,
    target,
    ...(savedReviewInstructions ? { savedReviewInstructions } : {}),
    refuseIfOutputExists: bool(
      raw.refuseIfOutputExists,
      DEFAULTS.refuseIfOutputExists,
      `${where}.refuseIfOutputExists`,
    ),
    timeoutMs: positiveInt(raw.timeoutMs, DEFAULTS.timeoutMs, `${where}.timeoutMs`),
    maxConcurrent: nonNegativeInt(
      raw.maxConcurrent,
      DEFAULTS.maxConcurrent,
      `${where}.maxConcurrent`,
    ),
    maxDiffBytes: positiveInt(
      raw.maxDiffBytes,
      DEFAULTS.maxDiffBytes,
      `${where}.maxDiffBytes`,
    ),
    panel,
  };

  return config;
}

function rejectUnknown(
  raw: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));

  if (unknown.length > 0) {
    throw new ConfigError(
      `${where}: unknown key(s): ${unknown.join(', ')}. ` +
        `Known keys: ${[...allowed].join(', ')}.`,
    );
  }
}

function validateOutput(value: unknown, where: string): OutputConfig {
  if (value === undefined) {
    return { ...DEFAULT_OUTPUT };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `${where}.output: expected an object with "destination" and "merged". ` +
        `(A two-element array was an earlier design and is no longer accepted.)`,
    );
  }

  const raw = value as Record<string, unknown>;

  // `raw` named the consolidation pass's second file; see obsoleteKeys().
  rejectUnknown(raw, new Set(['destination', 'merged', 'raw']), `${where}.output`);

  const merged = str(raw.merged, DEFAULT_OUTPUT.merged, `${where}.output.merged`);
  const destination = validateDestination(raw.destination, `${where}.output.destination`);

  // Validated even for "terminal", so switching a config back to "file"
  // cannot surface a path problem that was sitting there unnoticed.
  assertUsableOutput({ merged }, `${where}.output`);

  return { destination, merged };
}

function validateDestination(value: unknown, where: string): OutputDestination {
  if (value === undefined) return DEFAULT_OUTPUT.destination;

  if (value !== 'file' && value !== 'terminal') {
    throw new ConfigError(
      `${where}: expected "file" or "terminal", got ${JSON.stringify(value)}.`,
    );
  }

  return value;
}

/**
 * Shared by the validator and the setup wizard, so a path the wizard offers
 * can never be one `crbuddy go` refuses to load.
 *
 * A report may live outside the repository — that is the point of the "one
 * level up" option, and it takes the file out of the review universe
 * entirely rather than relying on the diff exclusion. So `..` and absolute
 * paths are both accepted; these guards are about not destroying state, not
 * about staying inside the repo.
 */
/**
 * The repository-relative spelling of a configured path, or null when it
 * lands outside the repository.
 *
 * Output paths may sit outside the repo, and an outside path is not merely
 * uninteresting to git — it is fatal. Passing one as a `:(exclude)`
 * pathspec makes git abort with "is outside repository", so every caller
 * that builds a pathspec or a .gitignore entry has to filter first.
 *
 * Absolute is NOT the same as outside. An absolute path can resolve inside
 * the repository, and treating it as external would drop it from the
 * exclusion — letting the last run's report be swept into the snapshot and
 * reviewed, which is the exact thing the exclusion exists to prevent. So
 * this resolves first and answers with the spelling git wants.
 */
export function repoRelative(entry: string, repoRoot: string): string | null {
  // A trailing slash means "everything beneath"; path.relative eats it.
  const directory = entry.endsWith('/') || entry.endsWith('\\');
  const trimmed = directory ? entry.slice(0, -1) : entry;

  const canonicalRoot = canonicalizeExistingAncestors(path.resolve(repoRoot));
  const absolute = path.resolve(repoRoot, trimmed);
  const canonical = directory
    ? canonicalizeExistingAncestors(absolute)
    : canonicalOutputPath(repoRoot, trimmed);
  const relative = path.relative(canonicalRoot, canonical);

  // Segment-wise: a file legitimately named `..config` is not an escape.
  const segments = relative.split(/[\\/]/);

  if (relative === '' || segments[0] === '..' || path.isAbsolute(relative)) {
    return null;
  }

  const posix = relative.replace(/\\/g, '/');

  return directory ? `${posix}/` : posix;
}

export function assertUsableOutput(
  output: { merged: string },
  where: string,
  repoRoot?: string,
): void {
  const key = 'merged';
  const candidate = output.merged;

  // Normalize before every check: `a/../../b` and `./.git/config` both
  // slip past naive prefix tests.
  const concrete = repoRoot
    ? canonicalOutputPath(repoRoot, candidate)
    : candidate;
  const normalized = path.normalize(concrete).replace(/\\/g, '/');

  // For a path inside the repository, inspect only the part below the Git
  // root: a checkout may itself live beneath an unrelated ancestor named
  // `.crbuddy`. For an external path retain the full absolute check, since
  // `../other/.git/HEAD` is still a destructive destination.
  const relativeToRepo = repoRoot ? repoRelative(concrete, repoRoot) : null;
  const reservedPath = relativeToRepo ?? normalized;
  const segments = reservedPath.split('/').filter((part) => part !== '');

  for (const reserved of ['.git', PROJECT_CONFIG_DIR]) {
    if (segments.includes(reserved)) {
      throw new ConfigError(
        `${where}.${key}: must not write inside a "${reserved}" directory. ` +
          `crbuddy moves its output paths aside and overwrites them, and ` +
          `"${reserved}" holds git's or crbuddy's own state - including ` +
          `crbuddy's stash of your previous report. This applies anywhere ` +
          `in the path, not just at the repository root, because an ` +
          `output path may now point outside the repository. Choose a ` +
          `directory that is not named "${reserved}".`,
      );
    }
  }

  const absolute = path.resolve(repoRoot ?? process.cwd(), concrete);

  if (absolute === path.parse(absolute).root) {
    throw new ConfigError(`${where}.${key}: must not be a filesystem root.`);
  }

  const named = segments.at(-1);

  if (named === undefined || named === '.' || named === '..') {
    throw new ConfigError(`${where}.${key}: must name a file.`);
  }

  // Stashing is a move followed by recursive disposal after a successful
  // run. Accepting a directory here would therefore move the whole tree
  // into crbuddy's holding area and delete it as if it were an old report.
  // Inspect the directory entry itself: a final symlink is intentionally
  // moved as a link rather than followed (see canonicalOutputPath).
  if (repoRoot && existsSync(concrete) && lstatSync(concrete).isDirectory()) {
    throw new ConfigError(`${where}.${key}: must name a file, not a directory.`);
  }
}

/**
 * Resolve an output destination through every existing PARENT directory.
 *
 * The final path component is deliberately not dereferenced. Stashing and
 * committing use rename(2)-style operations, which move or replace a final
 * symlink directory entry rather than writing through it. Parent symlinks,
 * however, redirect every one of those operations and must be frozen to
 * their real destination before consent, locking, or mutation.
 */
export function canonicalOutputPath(repoRoot: string, entry: string): string {
  const absolute = path.resolve(repoRoot, entry);
  const parent = canonicalizeExistingAncestors(path.dirname(absolute));
  return path.join(parent, path.basename(absolute));
}

export function resolveOutputPaths(
  repoRoot: string,
  output: { merged: string },
): { merged: string } {
  return { merged: canonicalOutputPath(repoRoot, output.merged) };
}

/**
 * Canonical paths where a version before 0.4.0 may have left a raw report:
 * the configured `output.raw`, and its default name. Nothing writes these any
 * more, but such a file still has to be moved aside while reviewers run, and
 * a crash stash holding one has to stay recoverable.
 *
 * Only usable paths inside the repository qualify. An ignored key never gets
 * the consent a path outside it needs, and outside the repository the file
 * is not in front of the reviewers anyway.
 */
export function legacyRawOutputPaths(
  repoRoot: string,
  configured: string | undefined,
  merged: string,
): string[] {
  const paths = new Set<string>();

  for (const candidate of [configured, LEGACY_RAW_OUTPUT]) {
    if (!candidate) continue;

    try {
      assertUsableOutput({ merged: candidate }, 'output.raw', repoRoot);
      const absolute = canonicalOutputPath(repoRoot, candidate);

      if (absolute !== merged && repoRelative(absolute, repoRoot) !== null) {
        paths.add(absolute);
      }
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
    }
  }

  return [...paths];
}

/** Resolve the longest existing prefix and preserve any missing suffix. */
function canonicalizeExistingAncestors(candidate: string): string {
  let current = path.resolve(candidate);
  const missing: string[] = [];

  while (true) {
    try {
      return path.join(realpathSync.native(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new ConfigError(
          `Cannot resolve output path ancestor ${current}: ${String(error)}`,
        );
      }

      // realpath reports ENOENT for a dangling symlink even though the
      // directory entry itself exists. Treat it as unusable rather than
      // lexically classifying it inside the repository.
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new ConfigError(
            `Output path contains a dangling symlink at ${current}.`,
          );
        }
      } catch (lstatError) {
        if (lstatError instanceof ConfigError) throw lstatError;

        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
          throw new ConfigError(
            `Cannot inspect output path ancestor ${current}: ${String(lstatError)}`,
          );
        }
      }

      const parent = path.dirname(current);

      if (parent === current) {
        throw new ConfigError(`Cannot resolve output path ancestor ${candidate}.`);
      }

      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function validateTarget(value: unknown, where: string): Target {
  if (value === undefined) {
    return DEFAULTS.target;
  }

  if (value === 'uncommitted') {
    return 'uncommitted';
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;

    rejectUnknown(raw, new Set(['base']), `${where}.target`);

    if (typeof raw.base !== 'string' || raw.base.trim() === '') {
      throw new ConfigError(`${where}.target.base: expected a non-empty ref name.`);
    }

    return { base: raw.base };
  }

  throw new ConfigError(
    `${where}.target: expected "uncommitted" or { "base": "<ref>" }.`,
  );
}

function validatePanel(value: unknown, where: string): PanelEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(
      `${where}.panel: expected a non-empty array of review entries.`,
    );
  }

  const seen = new Set<string>();

  return value.map((item, index) => {
    const at = `${where}.panel[${index}]`;

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ConfigError(`${at}: expected an object.`);
    }

    const raw = item as Record<string, unknown>;

    rejectUnknown(raw, ENTRY_KEYS, at);

    const vendor = str(raw.vendor, undefined, `${at}.vendor`);
    const model = str(raw.model, undefined, `${at}.model`);

    const id =
      raw.id === undefined
        ? uniqueId(`${vendor}-${model}`, seen)
        : uniqueId(str(raw.id, undefined, `${at}.id`), seen, at);

    const entry: PanelEntry = { id, vendor, model };

    if (raw.effort !== undefined) {
      entry.effort = effort(raw.effort, `${at}.effort`);
    }

    if (raw.instructions !== undefined) {
      entry.instructions = str(raw.instructions, undefined, `${at}.instructions`);
    }

    if (raw.vendorArgs !== undefined) {
      if (
        !Array.isArray(raw.vendorArgs) ||
        raw.vendorArgs.some((arg) => typeof arg !== 'string')
      ) {
        throw new ConfigError(`${at}.vendorArgs: expected an array of strings.`);
      }

      entry.vendorArgs = raw.vendorArgs as string[];
    }

    return entry;
  });
}

function uniqueId(candidate: string, seen: Set<string>, at?: string): string {
  const base = slug(candidate);

  if (at && seen.has(base)) {
    throw new ConfigError(`${at}.id: duplicate id "${base}".`);
  }


  let id = base;
  let n = 2;

  while (seen.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }

  seen.add(id);
  return id;
}

export function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned === '' ? 'entry' : cleaned;
}

function str(value: unknown, fallback: string | undefined, at: string): string {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new ConfigError(`${at}: required.`);
    }
    return fallback;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${at}: expected a non-empty string.`);
  }

  return value;
}

function bool(value: unknown, fallback: boolean, at: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(`${at}: expected true or false.`);
  return value;
}

function positiveInt(value: unknown, fallback: number, at: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${at}: expected a positive integer.`);
  }
  return value;
}

function nonNegativeInt(value: unknown, fallback: number, at: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${at}: expected a non-negative integer.`);
  }
  return value;
}

/**
 * Effort is vendor-native and passed through verbatim, so any non-empty
 * string is accepted. Validating against a hardcoded list here would mean a
 * vendor adding a level breaks configs until crbuddy ships a release -
 * exactly the rot the translation layer was removed to avoid. An unusable
 * value surfaces as a fast, clearly-attributed lane failure instead.
 */
function effort(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `${at}: expected a non-empty vendor effort value (for example "high").`,
    );
  }

  return value;
}
