import {
  Adapter,
  CompletionCheck,
  Invocation,
  InvocationRequest,
  UnsafeInvocationError,
  defaultCompletion,
} from './types.js';

/**
 * NOTE FOR WHOEVER RUNS THIS FIRST.
 *
 * These adapters were written against vendor documentation, not against
 * running binaries — the authoring environment had none installed. The
 * shapes below are the least-surprising reading of each CLI's
 * non-interactive interface, and they are the most likely part of crbuddy
 * to be wrong. Every flag is in one place per vendor so a fix is local.
 *
 * Two invariants that must survive any correction:
 *   - reviewers get read-only permissions, unconditionally
 *   - the reviewed range is the crbuddy-resolved one, not one the vendor picks
 */

function reviewPrompt(range: string, extra?: string): string {
  const base =
    `Review the changes in the git range ${range}.\n\n` +
    `Report concrete, actionable findings. For each finding give the file ` +
    `path and line number where it applies, a short title, and an explanation. ` +
    `Do not modify any files. Do not run tests or make commits.`;

  return extra ? `${base}\n\nAdditional review criteria:\n${extra}` : base;
}

function genericPrompt(instructions: string, range: string | null): string {
  if (!range) return instructions;

  return (
    `You are reviewing the changes in the git range ${range}.\n\n` +
    `${instructions}\n\n` +
    `Report concrete, actionable findings with file paths and line numbers. ` +
    `Do not modify any files.`
  );
}

/**
 * Pick the first spelling this CLI actually accepts.
 *
 * `purpose` is only used when nothing matches: for a safety-critical flag
 * that means refusing the lane, and for anything else a dropped flag plus a
 * warning.
 */
function firstSupported(
  request: InvocationRequest,
  candidates: string[],
): string | null {
  return candidates.find((flag) => request.supports(flag)) ?? null;
}

/** Index of a safety flag inside vendorArgs, or -1. */
function findInVendorArgs(vendorArgs: string[], candidates: string[]): number {
  return vendorArgs.findIndex((arg) =>
    candidates.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

/**
 * `vendorArgs` is appended AFTER generated args, so a user-supplied copy of a
 * safety flag wins on most CLIs. That makes it a bypass unless its value is
 * checked: `vendorArgs: ["--sandbox", "workspace-write"]` would otherwise
 * both satisfy the requirement and hand the reviewer a writable sandbox.
 */
function assertVendorArgsSafe(
  request: InvocationRequest,
  candidates: string[],
  allowedValues: string[],
  purpose: string,
  cli: string,
): boolean {
  const vendorArgs = request.vendorArgs ?? [];
  const index = findInVendorArgs(vendorArgs, candidates);

  if (index === -1) return false;

  const arg = vendorArgs[index]!;
  const value = arg.includes('=') ? arg.split('=').slice(1).join('=') : vendorArgs[index + 1];

  if (value !== undefined && allowedValues.includes(value)) return true;

  throw new UnsafeInvocationError(
    `"vendorArgs" sets ${purpose} for \`${cli}\` to ` +
      `"${value ?? '(no value)'}", which is not read-only. crbuddy appends ` +
      `vendorArgs last, so this would override its own read-only setting and ` +
      `let the reviewer modify the working tree. Use one of: ` +
      `${allowedValues.join(', ')} — or remove it and let crbuddy set it.`,
  );
}

function requireSafetyFlag(
  request: InvocationRequest,
  candidates: string[],
  allowedValues: string[],
  purpose: string,
  cli: string,
): string | null {
  // Checked first, and unconditionally: a user-supplied unsafe value must be
  // rejected even when the CLI does advertise the flag.
  const suppliedSafely = assertVendorArgsSafe(
    request,
    candidates,
    allowedValues,
    purpose,
    cli,
  );

  if (suppliedSafely) return null;

  const found = firstSupported(request, candidates);

  if (found) return found;

  throw new UnsafeInvocationError(
    `\`${cli}\` does not appear to support ${purpose} ` +
      `(looked for ${candidates.join(', ')} in \`${cli} --help\`). crbuddy will ` +
      `not run a reviewer without it, because an agent that can edit the working ` +
      `tree changes the very diff under review. Update ${cli}; or, if it does ` +
      `support this, pass the flag AND a read-only value yourself via ` +
      `"vendorArgs" on that panel entry.`,
  );
}

function promptFor(request: InvocationRequest): string {
  return request.operation.kind === 'review'
    ? reviewPrompt(request.operation.target.range)
    : genericPrompt(
        request.operation.instructions,
        request.operation.target?.range ?? null,
      );
}

/** Claude Code: `claude -p` in print mode. */
export const claudeAdapter: Adapter = {
  name: 'claude',
  label: 'Claude Code',
  command: 'claude',
  minVersion: '2.0.0',

  // Highest capability first. `defaultModel` decides where the cursor lands,
  // which is not necessarily the top of the list.
  models: [
    { id: 'fable', label: 'Fable', hint: 'frontier tier' },
    { id: 'opus', label: 'Opus', hint: 'deep reasoning, slowest' },
    { id: 'sonnet', label: 'Sonnet', hint: 'balanced' },
    { id: 'haiku', label: 'Haiku', hint: 'fast and cheap' },
  ],
  defaultModel: 'opus',

  // Passed through verbatim. `ultracode` is deliberately absent: it
  // activates a different mode rather than being another effort level.
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'high',
  listsStampedFor: '2.1.239',

  versionArgs() {
    return ['--version'];
  },

  helpArgs() {
    return ['--help'];
  },

  parseVersion(stdout) {
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  },

  build(request: InvocationRequest): Invocation {
    const prompt = promptFor(request);
    const warnings: string[] = [];

    const args = ['-p', '--model', request.model];

    // Reviewers never need write access.
    const permission = requireSafetyFlag(
      request,
      ['--permission-mode'],
      ['plan'],
      'read-only permissions',
      this.command,
    );

    // Null means the user supplied it themselves via vendorArgs.
    if (permission) args.push(permission, 'plan');

    const noSession = firstSupported(request, [
      '--no-session-persistence',
      '--no-save-session',
    ]);

    if (noSession) {
      args.push(noSession);
    } else {
      warnings.push(
        `${this.label} has no session-persistence flag; review sessions will ` +
          `appear in its history.`,
      );
    }

    // Tracked separately from what was REQUESTED: reporting a requested
    // effort as applied misstates the run in the output provenance.
    let appliedEffort: string | null = null;

    if (request.effort) {
      const effortFlag = firstSupported(request, ['--effort', '--reasoning-effort']);

      if (effortFlag) {
        args.push(effortFlag, request.effort);
        appliedEffort = request.effort;
      } else {
        warnings.push(
          `${this.label} does not accept an effort flag; "${request.effort}" was ` +
            `not applied.`,
        );
      }
    }

    if (request.vendorArgs) {
      args.push(...request.vendorArgs);
    }

    return {
      command: this.command,
      // Prompt goes on stdin, never argv: diffs and instructions are large
      // and argv has hard limits (especially on Windows).
      args,
      stdin: prompt,
      appliedEffort,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  finalOutput(result) {
    return result.stdout;
  },

  checkCompletion(result): CompletionCheck {
    return defaultCompletion({ ...result, body: result.stdout });
  },
};

/** Codex: `codex exec` for non-interactive runs. */
export const codexAdapter: Adapter = {
  name: 'codex',
  label: 'Codex CLI',
  command: 'codex',
  minVersion: '0.20.0',

  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', hint: 'flagship' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', hint: 'balanced workhorse' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', hint: 'fast and cheap' },
  ],
  defaultModel: 'gpt-5.6-sol',

  efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'high',
  listsStampedFor: '0.149.0',

  versionArgs() {
    return ['--version'];
  },

  helpArgs() {
    return ['exec', '--help'];
  },

  parseVersion(stdout) {
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  },

  build(request: InvocationRequest): Invocation {
    const prompt = promptFor(request);
    const warnings: string[] = [];

    const args = ['exec', '--model', request.model];

    // `codex exec` is non-interactive by construction — it reads the prompt
    // from stdin and offers no approval-policy flag, only an opt-in
    // `--approve-for-me` (which escalates to workspace-write, the opposite of
    // what a reviewer wants). Its absence is therefore normal and not worth
    // warning about; the sandbox below is what actually constrains the run.
    const approval = firstSupported(request, ['--ask-for-approval']);

    if (approval) args.push(approval, 'never');

    const sandbox = requireSafetyFlag(
      request,
      ['--sandbox', '-s'],
      ['read-only'],
      'a read-only sandbox',
      this.command,
    );

    // Null means the user supplied it themselves via vendorArgs.
    if (sandbox) args.push(sandbox, 'read-only');

    // Both of these have come and gone across releases; neither is required.
    const ephemeral = firstSupported(request, ['--ephemeral']);
    if (ephemeral) args.push(ephemeral);

    const skipGitCheck = firstSupported(request, ['--skip-git-repo-check']);
    if (skipGitCheck) args.push(skipGitCheck);

    // Keep output free of terminal control sequences at the source rather
    // than only stripping them after the fact.
    const color = firstSupported(request, ['--color']);
    if (color) args.push(color, 'never');

    let appliedEffort: string | null = null;

    if (request.effort) {
      if (request.supports('-c')) {
        // Unquoted on purpose: `-c` parses the value as TOML and falls back
        // to the raw string, so `key=xhigh` works without embedding quotes
        // that would need escaping through cmd.exe on Windows.
        args.push('-c', `model_reasoning_effort=${request.effort}`);
        appliedEffort = request.effort;
      } else {
        warnings.push(
          `${this.label} does not accept config overrides; effort ` +
            `"${request.effort}" was not applied.`,
        );
      }
    }

    if (request.vendorArgs) {
      args.push(...request.vendorArgs);
    }

    return {
      command: this.command,
      args,
      // Omitting the prompt argument makes codex read it from stdin.
      stdin: prompt,
      appliedEffort,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  finalOutput(result) {
    // Progress goes to stderr; the final agent message goes to stdout.
    return result.stdout;
  },

  checkCompletion(result): CompletionCheck {
    return defaultCompletion({ ...result, body: result.stdout });
  },
};

/** Gemini CLI: `gemini -p`. */
export const geminiAdapter: Adapter = {
  name: 'gemini',
  label: 'Gemini CLI',
  command: 'gemini',
  minVersion: '0.1.0',

  models: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'deep reasoning' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'fast' },
  ],
  defaultModel: 'gemini-2.5-pro',

  // This CLI exposes no effort control; `init` skips the question entirely.
  efforts: [],
  defaultEffort: null,
  listsStampedFor: '0.55.1',

  versionArgs() {
    return ['--version'];
  },

  helpArgs() {
    return ['--help'];
  },

  parseVersion(stdout) {
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  },

  build(request: InvocationRequest): Invocation {
    const prompt = promptFor(request);
    const warnings: string[] = [];

    const args = ['--model', request.model];

    // `default` approval mode permits tool actions, which breaks the
    // review-only guarantee exactly as `--permission-mode plan` does for
    // Claude and `--sandbox read-only` for Codex. `plan` is the read-only
    // equivalent and is treated as safety-critical here too.
    const approval = requireSafetyFlag(
      request,
      ['--approval-mode'],
      ['plan'],
      'a read-only approval mode',
      this.command,
    );

    if (approval) args.push(approval, 'plan');

    if (request.vendorArgs) {
      args.push(...request.vendorArgs);
    }

    // `-p` is Gemini's documented non-interactive switch; without it the CLI
    // may not treat a piped run as headless. It takes the prompt as a value,
    // so very large prompts (the consolidation pass) go to stdin instead
    // rather than risk an argv limit, especially on Windows.
    const promptFlag = firstSupported(request, ['--prompt', '-p']);
    const ARGV_SAFE = 6000;

    if (promptFlag && prompt.length <= ARGV_SAFE) {
      args.push(promptFlag, prompt);

      return {
        command: this.command,
        args,
        appliedEffort: null,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (!promptFlag) {
      warnings.push(
        `${this.label} has no --prompt flag; relying on piped stdin for ` +
          `non-interactive execution.`,
      );
    }

    return {
      command: this.command,
      args,
      stdin: prompt,
      appliedEffort: null,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  finalOutput(result) {
    return result.stdout;
  },

  checkCompletion(result): CompletionCheck {
    return defaultCompletion({ ...result, body: result.stdout });
  },
};

export const ADAPTERS: Adapter[] = [claudeAdapter, codexAdapter, geminiAdapter];

export function getAdapter(name: string): Adapter {
  const found = ADAPTERS.find((adapter) => adapter.name === name);

  if (!found) {
    throw new Error(
      `Unknown vendor "${name}". Known vendors: ${ADAPTERS.map((a) => a.name).join(', ')}.`,
    );
  }

  return found;
}
