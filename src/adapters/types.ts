import { Effort } from '../config/schema.js';
import { ResolvedTarget } from '../git/target.js';

/**
 * Adapters expose SEMANTIC operations, not command strings.
 *
 * The vendor's own slash command or subcommand is an implementation detail
 * living inside the adapter. See DESIGN.md §5 for why: vendor review
 * commands are scope-SELECTING operations, so passing one through as an
 * opaque string contradicts crbuddy owning the target.
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
  /**
   * Does this installed CLI accept the given flag? Derived from its own
   * `--help` at preflight.
   *
   * Vendor flags churn, and a wrong one produces a usage error (exit 2 from
   * a clap-based CLI) that looks like a crbuddy bug. Asking the binary what
   * it supports beats shipping a guess and waiting for a bug report.
   */
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
  /**
   * Effort values this specific model accepts, when they differ from the
   * vendor's. Omitted means the vendor's list applies.
   */
  efforts?: string[];
}

/**
 * Thrown when a flag crbuddy relies on for SAFETY is unavailable.
 *
 * Optional flags degrade with a warning. Read-only enforcement does not: a
 * reviewer running without it can edit the working tree, and under a
 * `uncommitted` target those edits are the changeset under review. Refusing
 * the lane is the only safe response.
 */
export class UnsafeInvocationError extends Error {}

export interface Adapter {
  /** Registry key, also what config `vendor` matches. */
  readonly name: string;
  /** Human label for prompts and reports. */
  readonly label: string;
  /** Executable expected on PATH. */
  readonly command: string;

  /**
   * The vendor's OWN effort values, lowest to highest, passed through
   * verbatim. Empty means this CLI has no effort control.
   */
  readonly efforts: string[];
  /** Pre-selected in `init`. Null when the vendor has no effort control. */
  readonly defaultEffort: string | null;
  /**
   * CLI version the model and effort lists were written against. Used only
   * to tell the user those lists may be incomplete — it does not affect what
   * runs, because effort is passed through rather than translated.
   */
  readonly listsStampedFor: string;
  /**
   * Models offered by `crbuddy init`. Advisory only — the config accepts any
   * string, and the wizard has an "other" escape, so a stale list here is a
   * convenience problem rather than a blocker.
   */
  readonly models: VendorModel[];
  /** Which model `init` pre-selects; not necessarily the first listed. */
  readonly defaultModel: string;
  /** Minimum CLI version this adapter was written against. */
  readonly minVersion: string;

  /** Argv that prints a version. */
  versionArgs(): string[];
  /** Argv that prints help for the subcommand crbuddy actually invokes. */
  helpArgs(): string[];
  parseVersion(stdout: string): string | null;

  build(request: InvocationRequest): Invocation;

  /**
   * Which stream carries the final model output. Some CLIs put progress on
   * stderr and the answer on stdout; concatenating both is wrong.
   */
  finalOutput(result: { stdout: string; stderr: string }): string;

  /**
   * Exit code is primary, but a zero exit with an error body or empty output
   * is not a successful review.
   */
  checkCompletion(result: {
    code: number | null;
    stdout: string;
    stderr: string;
  }): CompletionCheck;
}

const RATE_LIMIT = /rate.?limit|429|quota exceeded|too many requests|usage limit/i;
const AUTH = /not (logged in|authenticated)|unauthorized|401|invalid api key|please (log|sign) in/i;

/**
 * Shared default completion check.
 *
 * IMPORTANT: failure patterns are matched against stderr ONLY, and only once
 * the exit code already says something went wrong. Scanning the model's own
 * output for words like "rate limit" or "unauthorized" misclassifies a
 * perfectly good review that happens to discuss rate limiting or auth — which
 * is a review discarded silently, the worst failure this tool can have.
 *
 * Exit code is the primary signal. A zero exit with a non-empty body is a
 * successful review, whatever words are in it.
 */
export function defaultCompletion(result: {
  code: number | null;
  stdout: string;
  stderr: string;
  body: string;
}): CompletionCheck {
  if (result.code === 0) {
    return result.body.trim() === '' ? { ok: false, reason: 'empty' } : { ok: true };
  }

  // Non-zero exit: now it is worth asking why, using the diagnostic stream.
  if (RATE_LIMIT.test(result.stderr)) {
    return { ok: false, reason: 'rate_limited' };
  }

  if (AUTH.test(result.stderr)) {
    return { ok: false, reason: 'auth' };
  }

  return { ok: false, reason: `exit_${result.code ?? 'signal'}` };
}
