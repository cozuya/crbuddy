import {
  Adapter,
  CompletionCheck,
  Invocation,
  InvocationRequest,
  UnsafeInvocationError,
  defaultCompletion,
} from './types.js';

/**
 * Native review is intentional. When a panel entry has no custom
 * `instructions`, crbuddy invokes the vendor's own review workflow rather
 * than trying to imitate it with a generic prompt. Custom instructions are a
 * separate generic-agent operation by design.
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
): string {
  const found = firstSupported(request, candidates);

  if (found) return found;

  throw new UnsafeInvocationError(
    `\`${cli}\` does not appear to support ${purpose} ` +
      `(looked for ${candidates.join(', ')} in the probed help output). crbuddy will ` +
      `not run a reviewer without it. Update ${cli} to a supported version.`,
  );
}

/**
 * `vendorArgs` is an escape hatch for capability flags, not a way to weaken
 * crbuddy's safety boundary. Reject anything that can plausibly change
 * sandbox / approval / permission behavior before argv is constructed.
 *
 * In particular, Codex `-c`/`--config` is blocked because arbitrary config
 * overrides can change sandbox or approval policy even if the visible argv
 * also contains `--sandbox read-only`.
 */
function assertSafeVendorArgs(vendor: string, args: string[] | undefined): void {
  if (!args || args.length === 0) return;

  const forbidden = args.find((arg) => {
    if (/permission|sandbox|approval|dangerously|\byolo\b/i.test(arg)) return true;
    if (vendor === 'codex' && (arg === '-s' || arg === '-c' || arg === '--config')) {
      return true;
    }
    if (vendor === 'codex' && (/^-s=/.test(arg) || /^-c=/.test(arg))) return true;
    return false;
  });

  if (forbidden) {
    throw new UnsafeInvocationError(
      `vendorArgs may not override crbuddy safety controls (${JSON.stringify(forbidden)}). ` +
        `Sandbox, approval, permission, dangerous-mode, and Codex config-override ` +
        `arguments are owned by crbuddy so a project-local config cannot weaken read-only review.`,
    );
  }
}

/** Claude Code: invoke the native `/code-review` skill through print mode. */
export const claudeAdapter: Adapter = {
  name: 'claude',
  label: 'Claude Code',
  command: 'claude',
  nativeReview: true,
  nativeReviewCommand: '/code-review',
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
    assertSafeVendorArgs(this.name, request.vendorArgs);

    const warnings: string[] = [];
    const args = ['-p', '--model', request.model];

    const permission = requireSafetyFlag(
      request,
      ['--permission-mode'],
      'read-only permissions',
      this.command,
    );

    args.push(permission, 'plan');

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
      // Native /code-review otherwise reuses the last interactively selected
      // level when no effort is supplied. Never inherit ambient session state:
      // an omitted config value resolves to crbuddy's documented default.
      const reviewEffort = request.effort ?? this.defaultEffort;

      if (reviewEffort?.toLowerCase() === 'ultra') {
        throw new UnsafeInvocationError(
          'Claude Code reserves `/code-review ultra` for Ultrareview, a separate ' +
            'cloud review product. Under `claude -p` it launches asynchronously and ' +
            'returns a tracking link instead of waiting for findings, and paid runs may ' +
            'consume usage credits. crbuddy\'s normal Claude lane supports the local ' +
            '`/code-review` effort levels (`low` through `max`) only. Run `claude ' +
            'ultrareview` directly if you intentionally want the cloud product.',
        );
      }

      // /code-review is the canonical native review surface and accepts an
      // explicit target such as a branch or ref range. Current Claude Code
      // (>=2.1.223) also treats /review as an alias, but crbuddy uses the
      // canonical spelling for both target kinds.
      const parts = ['/code-review'];
      if (reviewEffort) parts.push(reviewEffort);
      parts.push(request.operation.target.range);

      // Use the documented `claude -p "query"` form. In non-interactive mode
      // a non-ultra /code-review runs in the foreground: Claude Code waits for
      // the review and includes the findings in the response.
      args.push(parts.join(' '));

      return {
        command: this.command,
        args,
        appliedEffort: reviewEffort,
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
    const body = result.stdout.trim();

    // This exact class of status-only response was observed during the initial
    // build. It violates Claude Code's current documented non-interactive
    // contract (local /code-review should wait and return findings), so never
    // let a zero exit turn it into a successful review artifact.
    if (
      result.code === 0 &&
      body.length < 500 &&
      /still waiting for .*code-review.*verification\/synthesis stage to complete/i.test(body)
    ) {
      return { ok: false, reason: 'incomplete_review' };
    }

    return defaultCompletion({ ...result, body: result.stdout });
  },
};

/** Codex: native `codex exec review` for review operations. */
export const codexAdapter: Adapter = {
  name: 'codex',
  label: 'Codex CLI',
  command: 'codex',
  nativeReview: true,
  nativeReviewCommand: 'codex exec review',
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
    // The flags crbuddy itself passes (--sandbox, -c, --ephemeral, etc.) are
    // exec-level options. `codex exec review --help` may omit those parent
    // flags and would make a safe invocation look unsupported.
    return ['exec', '--help'];
  },

  parseVersion(stdout) {
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  },

  build(request: InvocationRequest): Invocation {
    assertSafeVendorArgs(this.name, request.vendorArgs);

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

    args.push(sandbox, 'read-only');

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
  nativeReview: false,
  nativeReviewCommand: null,
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
    assertSafeVendorArgs(this.name, request.vendorArgs);

    if (request.operation.kind === 'review') {
      throw new UnsafeInvocationError(
        'Gemini CLI does not currently expose a supported headless native code-review ' +
          'operation that crbuddy can invoke. Add explicit `instructions` to this Gemini ' +
          'panel entry to opt into generic read-only agent mode, or remove the lane.',
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

    args.push(approval, 'plan');

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
