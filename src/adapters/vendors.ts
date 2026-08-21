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
 * Native review is intentional. When a panel entry has no custom
 * `instructions`, crbuddy invokes the vendor's own review workflow rather
 * than trying to imitate it with a generic prompt. Custom instructions are a
 * separate generic-agent operation by design.
 *
 * Two invariants that must survive any correction:
 *   - reviewers get read-only permissions, unconditionally
 *   - native review stays native; do not replace it with "review this diff" prose
 */

function genericPrompt(instructions: string, range: string | null): string {
  if (!range) return instructions;

  return (
    `You are reviewing the changes in the git range ${range}.\n\n` +
    `${instructions}\n\n` +
    `Report concrete, actionable findings with file paths and line numbers. ` +
    `Do not modify any files.`
  );
}

/** Pick the first spelling this CLI actually accepts. */
function firstSupported(
  request: InvocationRequest,
  candidates: string[],
): string | null {
  return candidates.find((flag) => request.supports(flag)) ?? null;
}

function requireSafetyFlag(
  request: InvocationRequest,
  candidates: string[],
  purpose: string,
  cli: string,
): string | null {
  const found = firstSupported(request, candidates);

  if (found) return found;

  const manual = (request.vendorArgs ?? []).some((arg) =>
    candidates.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );

  if (manual) return null;

  throw new UnsafeInvocationError(
    `\`${cli}\` does not appear to support ${purpose} ` +
      `(looked for ${candidates.join(', ')} in \`${cli} --help\`). crbuddy will ` +
      `not run a reviewer without it, because an agent that can edit the working ` +
      `tree changes the very diff under review. Update ${cli}; or, if it does ` +
      `support this, pass the flag yourself via "vendorArgs" on that panel entry.`,
  );
}

/** Claude Code: native `/code-review` / `/review` via non-interactive `-p`. */
export const claudeAdapter: Adapter = {
  name: 'claude',
  label: 'Claude Code',
  command: 'claude',
  minVersion: '2.1.223',

  models: [
    { id: 'fable', label: 'Fable', hint: 'frontier tier' },
    { id: 'opus', label: 'Opus', hint: 'deep reasoning, slowest' },
    { id: 'sonnet', label: 'Sonnet', hint: 'balanced' },
    { id: 'haiku', label: 'Haiku', hint: 'fast and cheap' },
  ],
  defaultModel: 'opus',

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
    const warnings: string[] = [];
    const args = ['-p', '--model', request.model];

    const permission = requireSafetyFlag(
      request,
      ['--permission-mode'],
      'read-only permissions',
      this.command,
    );

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

    if (request.vendorArgs) {
      args.push(...request.vendorArgs);
    }

    if (request.operation.kind === 'review') {
      const target = request.operation.target;
      const command = target.kind === 'uncommitted' ? '/code-review' : '/review';
      const parts = [command];

      if (request.effort) parts.push(request.effort);

      // /code-review accepts an explicit ref range. Supplying crbuddy's pinned
      // range keeps Claude on the same captured changeset, including untracked
      // files represented in the snapshot commit.
      parts.push(target.range);

      return {
        command: this.command,
        args,
        stdin: parts.join(' '),
        appliedEffort: request.effort ?? null,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const prompt = genericPrompt(
      request.operation.instructions,
      request.operation.target?.range ?? null,
    );

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

    return {
      command: this.command,
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

/** Codex: native `codex exec review` for review operations. */
export const codexAdapter: Adapter = {
  name: 'codex',
  label: 'Codex CLI',
  command: 'codex',
  minVersion: '0.130.0',

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
    return ['exec', 'review', '--help'];
  },

  parseVersion(stdout) {
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  },

  build(request: InvocationRequest): Invocation {
    const warnings: string[] = [];
    const args = ['exec', '--model', request.model];

    const approval = firstSupported(request, ['--ask-for-approval']);
    if (approval) args.push(approval, 'never');

    const sandbox = requireSafetyFlag(
      request,
      ['--sandbox', '-s'],
      'a read-only sandbox',
      this.command,
    );

    if (sandbox) args.push(sandbox, 'read-only');

    const ephemeral = firstSupported(request, ['--ephemeral']);
    if (ephemeral) args.push(ephemeral);

    const skipGitCheck = firstSupported(request, ['--skip-git-repo-check']);
    if (skipGitCheck) args.push(skipGitCheck);

    const color = firstSupported(request, ['--color']);
    if (color) args.push(color, 'never');

    let appliedEffort: string | null = null;

    if (request.effort) {
      if (request.supports('-c')) {
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

    if (request.operation.kind === 'review') {
      // This is Codex's real review engine: the headless equivalent of /review.
      // Scoped review flags and custom prompts are mutually exclusive, which
      // is why custom crbuddy instructions take the generic path below.
      args.push('review');

      if (request.operation.target.kind === 'uncommitted') {
        args.push('--uncommitted');
      } else {
        args.push(
          '--base',
          request.operation.target.requestedBase ?? request.operation.target.base,
        );
      }

      return {
        command: this.command,
        args,
        appliedEffort,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const prompt = genericPrompt(
      request.operation.instructions,
      request.operation.target?.range ?? null,
    );

    return {
      command: this.command,
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

/** Gemini CLI: generic agent runs only; no supported headless native review. */
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
    if (request.operation.kind === 'review') {
      throw new UnsafeInvocationError(
        'Gemini CLI does not currently expose a supported headless native code-review ' +
          'operation that crbuddy can invoke. crbuddy will not silently replace native ' +
          'review with a generic "review this diff" prompt. Add explicit `instructions` ' +
          'to this Gemini panel entry to opt into generic read-only agent mode, or remove ' +
          'the lane.',
      );
    }

    const prompt = genericPrompt(
      request.operation.instructions,
      request.operation.target?.range ?? null,
    );
    const warnings: string[] = [];
    const args = ['--model', request.model];

    const approval = requireSafetyFlag(
      request,
      ['--approval-mode'],
      'a read-only approval mode',
      this.command,
    );

    if (approval) args.push(approval, 'plan');

    if (request.vendorArgs) {
      args.push(...request.vendorArgs);
    }

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
