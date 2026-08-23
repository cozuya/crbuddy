/**
 * Config shape. See DESIGN.md §3.
 *
 * Named fields only — no positional tuples.
 */

export const CONFIG_VERSION = 1;

/**
 * Effort is a VENDOR-NATIVE string, passed through verbatim — not a portable
 * crbuddy vocabulary. `init` offers each vendor's own values; anything else
 * is accepted and left for the vendor to accept or reject, so a vendor
 * adding a level does not require a crbuddy release.
 *
 * Absent means "pass no effort flag", which is also what vendors with no
 * effort control get.
 */
export type Effort = string;

/** `"uncommitted"` or a branch/ref comparison. */
export type Target = 'uncommitted' | { base: string };

export interface PanelEntry {
  /** Stable, used in provenance. Generated from vendor+model if absent. */
  id: string;
  /** Vendor key as registered in the adapter registry. */
  vendor: string;
  /** Vendor-native model identifier. */
  model: string;
  effort?: Effort;
  /**
   * Optional review criteria. When absent the adapter runs its native
   * review operation over the crbuddy-resolved target. When present the
   * adapter runs a generic read-only agent with these instructions.
   */
  instructions?: string;
  /** Escape hatch: extra argv appended verbatim. See DESIGN.md §7. */
  vendorArgs?: string[];
}

export interface MergeConfig {
  enabled: boolean;
  vendor: string;
  model: string;
  effort?: Effort;
}

/**
 * Where a finished review goes. `terminal` writes nothing to disk: the
 * report is printed and the run ends on a prompt offering the clipboard.
 */
export type OutputDestination = 'file' | 'terminal';

export interface OutputConfig {
  destination: OutputDestination;
  /** Only meaningful when `destination` is "file". */
  merged: string;
  raw: string;
}

export interface Config {
  configVersion: number;
  output: OutputConfig;
  target: Target;
  /**
   * When true, `go` refuses to start if an output file already exists and
   * prompts before touching it. This is NOT the self-contamination
   * mechanism — see DESIGN.md §6.
   */
  refuseIfOutputExists: boolean;
  /** Per-run wall-clock ceiling. Converts a hang into an ordinary failure. */
  timeoutMs: number;
  /** Separate ceiling for the consolidation pass. */
  mergeTimeoutMs: number;
  /** 0 means unlimited. The semaphore exists from day one regardless. */
  maxConcurrent: number;
  /** Refuse (without --force) past this many bytes of diff. */
  maxDiffBytes: number;
  merge: MergeConfig;
  panel: PanelEntry[];
  /** Reserved for later inheritance. Presence is an error in v0.1. */
  extends?: string;
}

export const DEFAULT_OUTPUT: OutputConfig = {
  destination: 'file',
  merged: 'CODE-REVIEW-HANDOFF.md',
  raw: 'CODE-REVIEW-HANDOFF.raw.md',
};

export const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  target: 'uncommitted' as Target,
  refuseIfOutputExists: false,
  timeoutMs: 15 * 60 * 1000,
  mergeTimeoutMs: 10 * 60 * 1000,
  maxConcurrent: 0,
  maxDiffBytes: 2_000_000,
};

export const CONFIG_FILENAME = 'config.json';
export const HOME_CONFIG_DIR = '.crbuddy';
export const PROJECT_CONFIG_DIR = '.crbuddy';
export const WORK_DIR = '.crbuddy';
