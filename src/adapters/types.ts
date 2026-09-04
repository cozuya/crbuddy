import { Effort } from '../config/schema.js';
import { ResolvedTarget } from '../git/target.js';

/**
 * Adapters expose semantic operations, not caller-built command strings.
 * Vendor-specific slash commands and subcommands stay inside the adapter.
 */
export type Operation =
  | { kind: 'review'; target: ResolvedTarget }
  | { kind: 'generic'; target: ResolvedTarget | null; instructions: string };

export interface InvocationRequest {
  operation: Operation;
  model: string;
  effort?: Effort;
  vendorArgs?: string[];
  repoRoot: string;
  /** Does the probed help surface advertise this flag? */
  supports: (flag: string) => boolean;
}

export interface Invocation {
  /** Executable name. Resolved through PATH by the spawner. */
  command: string;
  args: string[];
  /** Non-fatal notes, e.g. an optional flag this CLI version lacks. */
  warnings?: string[];
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  env?: Record<string, string>;
  /** Effort value actually passed, for provenance. Null means none. */
  appliedEffort: string | null;
}

export interface CompletionCheck {
  ok: boolean;
  /** Machine-ish reason when not ok: rate_limited, auth, empty, unknown. */
  reason?: string;
}

export interface VendorModel {
  /** Value written into config and passed to the CLI. */
  id: string;
  label: string;
  hint?: string;
  /** Model-specific effort values; omitted means the vendor list applies. */
  efforts?: string[];
}

export interface ModelDiscoveryContext {
  /** Working directory whose vendor/project configuration should apply. */
  cwd: string;
  signal?: AbortSignal;
}

/**
 * Thrown when crbuddy cannot construct an operation with its required safety
 * guarantees, or when a requested native operation does not exist.
 */
export class UnsafeInvocationError extends Error {}

export interface Adapter {
  /** Registry key, also what config `vendor` matches. */
  readonly name: string;
  /** Human label for prompts and reports. */
  readonly label: string;
  /** Executable expected on PATH. */
  readonly command: string;
  /** Whether this adapter has a supported headless vendor-native review path. */
  readonly nativeReview: boolean;
  /**
   * What the native review actually invokes, for prompts that would
   * otherwise say "the vendor's own review behavior" and leave the user
   * guessing. Null when there is no native lane. Deliberately omits the
   * target flags: which of them applies is decided per run, not per entry.
   */
  readonly nativeReviewCommand: string | null;

  /** Vendor-native effort values, lowest to highest. */
  readonly efforts: string[];
  /** Pre-selected in `init`. Null when the vendor has no effort control. */
  readonly defaultEffort: string | null;
  /** CLI version the fallback model/effort lists were written against. */
  readonly listsStampedFor: string;
  /**
   * Fallback models used when this vendor has no discovery surface or model
   * discovery fails. Config may still use any string.
   */
  readonly models: VendorModel[];
  /** Which model `init` prefers when it appears in the effective catalog. */
  readonly defaultModel: string;
  /** Minimum CLI version this adapter was written against. */
  readonly minVersion: string;

  /**
   * Best-effort model discovery from the installed/authenticated vendor CLI.
   * Return null when no usable catalog can be obtained; callers fall back to
   * `models`. Throwing is also treated as a discovery failure, not a fatal
   * setup error.
   */
  discoverModels?(context: ModelDiscoveryContext): Promise<VendorModel[] | null>;

  /** Argv that prints a version. */
  versionArgs(): string[];
  /**
   * Argv for the help surface containing flags crbuddy itself passes. This
   * need not be the deepest native-review subcommand: parent options often
   * live on a parent help page (for example `codex exec --help`).
   */
  helpArgs(): string[];
  parseVersion(stdout: string): string | null;

  build(request: InvocationRequest): Invocation;

  /** Which stream carries the final model output. */
  finalOutput(result: { stdout: string; stderr: string }): string;

  /** Exit code is primary, but zero + blank output is not success. */
  checkCompletion(result: {
    code: number | null;
    stdout: string;
    stderr: string;
  }): CompletionCheck;
}

const RATE_LIMIT = /rate.?limit|429|quota exceeded|too many requests|usage limit/i;
const AUTH = /not (logged in|authenticated)|unauthorized|401|invalid api key|please (log|sign) in/i;

export function defaultCompletion(result: {
  code: number | null;
  stdout: string;
  stderr: string;
  body: string;
}): CompletionCheck {
  if (result.code === 0) {
    return result.body.trim() === '' ? { ok: false, reason: 'empty' } : { ok: true };
  }

  if (RATE_LIMIT.test(result.stderr)) {
    return { ok: false, reason: 'rate_limited' };
  }

  if (AUTH.test(result.stderr)) {
    return { ok: false, reason: 'auth' };
  }

  return { ok: false, reason: `exit_${result.code ?? 'signal'}` };
}
