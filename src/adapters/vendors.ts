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

const BLOCKED_VENDOR_ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  claude: blockedVendorArgs([
    '--permission-mode',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--allowedtools',
    '--allowed-tools',
    '--settings',
    '--setting-sources',
    '--mcp-config',
    '--strict-mcp-config',
    '--add-dir',
    '--agents',
    '--plugin-dir',
    '--plugin-url',
    '--tools',
    '--system-prompt',
    '--system-prompt-file',
    '--append-system-prompt',
    '--append-system-prompt-file',
  ]),
  codex: blockedVendorArgs([
    '--config',
    '-c',
    '--sandbox',
    '-s',
    '--ask-for-approval',
    '-a',
    '--profile',
    '-p',
    '--enable',
    '--disable',
    '--approve-for-me',
    '--full-auto',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--add-dir',
    '--cd',
    '-C',
  ]),
  gemini: blockedVendorArgs([
    '--approval-mode',
    '--yolo',
    '-y',
    '--sandbox',
    '-s',
    '--allowed-tools',
    '--policy',
    '--admin-policy',
    '--skip-trust',
    '--extensions',
    '-e',
    '--include-directories',
    '--allowed-mcp-server-names',
  ]),
};

function blockedVendorArgs(flags: string[]): ReadonlySet<string> {
  return new Set(flags.map(vendorArgFlag));
}

function vendorArgFlag(arg: string): string {
  const equals = arg.indexOf('=');
  const flag = equals === -1 ? arg : arg.slice(0, equals);

  // Long-option parsers commonly expose kebab-case and camelCase spellings
  // for the same control. Case-fold and remove separators so both forms are
  // one key; short options remain case-sensitive (`-C` and `-c` differ for
  // Codex).
  return flag.startsWith('--')
    ? flag.slice(2).replace(/-/g, '').toLowerCase()
    : flag;
}

/**
 * Best-effort guardrail for known vendor flags that can change permissions,
 * configuration sources, loaded capabilities, or the review root. This is
 * exact per-vendor matching, not proof that an unknown flag is inert;
 * repository and vendor configuration remain trusted inputs.
 */
function assertSafeVendorArgs(vendor: string, args: string[] | undefined): void {
  if (!args || args.length === 0) return;

  const blocked = BLOCKED_VENDOR_ARGS[vendor];
  const forbidden = blocked
    ? args.find((arg) => blocked.has(vendorArgFlag(arg)))
    : undefined;

  if (forbidden) {
    throw new UnsafeInvocationError(
      `vendorArgs contains a known ${vendor} safety or configuration control ` +
        `(${JSON.stringify(forbidden)}). crbuddy blocks known controls that can change ` +
        `permissions, configuration sources, loaded capabilities, or the review root. ` +
        `This filter is best-effort; use only repository and vendor configuration you trust.`,
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
