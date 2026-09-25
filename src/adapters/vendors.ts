import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
    '--permission-prompt-tool',
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
    // crbuddy captures Claude's final payload as plain text. Structured
    // output changes that contract, whether selected as an envelope format
    // or requested through a JSON schema.
    '--output-format',
    '--json-schema',
    // These modes disable hook execution, which would make every Claude lane
    // consume usage and then fail completion-evidence validation.
    '--bare',
    '--safe-mode',
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
  // one key. Value-taking short options may attach their value directly
  // (`-cfoo`, `-sread-only`), so classify those by the first short option;
  // short options remain case-sensitive (`-C` and `-c` differ for Codex).
  return flag.startsWith('--')
    ? flag.slice(2).replace(/-/g, '').toLowerCase()
    : flag.startsWith('-') && flag.length > 2
      ? flag.slice(0, 2)
      : flag;
}

function environmentFlagEnabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
}

export function claudeHookDisablingEnvironmentVariable(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return (
    ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE'].find((name) =>
      environmentFlagEnabled(env[name]),
    ) ?? null
  );
}

function assertClaudeHooksEnabledByEnvironment(): void {
  const disabledBy = claudeHookDisablingEnvironmentVariable();

  if (disabledBy) {
    throw new UnsafeInvocationError(
      `${disabledBy} disables Claude hooks, but crbuddy requires its per-run ` +
        `Stop hook to verify completion. Unset ${disabledBy} before running Claude ` +
        `through crbuddy.`,
    );
  }
}

/**
 * Claude Code settings files that can set `disableAllHooks`, most specific
 * first, which is also their precedence. Managed policy is not read: crbuddy
 * cannot override it, and a policy that blocks the Stop hook already fails
 * closed as missing completion evidence.
 */
function claudeSettingsFiles(repoRoot: string | null, env: NodeJS.ProcessEnv): string[] {
  const userDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
  const project = repoRoot
    ? [
        path.join(repoRoot, '.claude', 'settings.local.json'),
        path.join(repoRoot, '.claude', 'settings.json'),
      ]
    : [];

  return [...project, path.join(userDir, 'settings.json')];
}

/**
 * The settings file whose `"disableAllHooks": true` is in effect, if any. As
 * in Claude Code, the most specific file that sets the key decides, so a
 * project's `false` wins over a user-level `true`.
 */
export function claudeHookDisablingSettingsFile(
  repoRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const file of claudeSettingsFiles(repoRoot, env)) {
    let value: unknown;

    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      value = typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).disableAllHooks
        : undefined;
    } catch {
      continue;
    }

    if (typeof value === 'boolean') return value ? file : null;
  }

  return null;
}

/**
 * Never an absolute path: the message can land in a shared report. Relative
 * to the repository, then to CLAUDE_CONFIG_DIR, then to the home directory.
 */
function displaySettingsPath(
  file: string,
  repoRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const bases: Array<[string | null | undefined, string]> = [
    [repoRoot, ''],
    [configDir, '$CLAUDE_CONFIG_DIR/'],
    [homedir(), '~/'],
  ];

  for (const [base, prefix] of bases) {
    if (!base) continue;

    const relative = path.relative(base, file);

    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `${prefix}${relative.split(path.sep).join('/')}`;
    }
  }

  return path.basename(file);
}

/** Why Claude hooks would be off for a run in this repository, if they would. */
export function claudeHooksDisabledReason(
  repoRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const variable = claudeHookDisablingEnvironmentVariable(env);
  if (variable) return `${variable} disables Claude hooks`;

  const file = claudeHookDisablingSettingsFile(repoRoot, env);
  if (file) return `${displaySettingsPath(file, repoRoot, env)} sets "disableAllHooks": true`;

  return null;
}

/**
 * Refuse rather than override. Forcing `disableAllHooks: false` from the
 * command line would switch back on every hook the user turned off, including
 * hooks a cloned repository ships, just to install crbuddy's own.
 */
function assertClaudeHooksEnabledBySettings(repoRoot: string): void {
  const file = claudeHookDisablingSettingsFile(repoRoot);

  if (file) {
    throw new UnsafeInvocationError(
      `${displaySettingsPath(file, repoRoot)} sets "disableAllHooks": true, which also ` +
        `turns off the per-run Stop hook crbuddy needs to verify that a Claude review ` +
        `finished. crbuddy will not override it, because that would re-enable every hook ` +
        `you disabled. Remove the setting to use Claude reviewers here, or take the ` +
        `Claude entries out of this panel.`,
    );
  }
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

export const CLAUDE_COMPLETION_MARKER = '<!-- crbuddy:review-complete -->';

/**
 * Claude Code's Stop hook receives its own authoritative background-task
 * registry. Use that lifecycle signal instead of trying to infer "done" from
 * prose. The hook only records each Stop event: print mode already pauses for
 * background work, and crbuddy removes that wait ceiling at launch. Blocking
 * Stop here would force extra model turns and can loop while tasks are running.
 */
const CLAUDE_STOP_EVIDENCE_SCRIPT = [
  "const fs=require('node:fs');",
  "const file=process.argv[1];",
  "let input='';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',c=>input+=c);",
  "process.stdin.on('end',()=>{",
  // Up to five entries, each cut to its short scalar fields: enough to say
  // what was still in flight when a review is judged incomplete.
  "const brief=l=>Array.isArray(l)?l.slice(0,5).map(e=>{const o={};if(e&&typeof e==='object')for(const[k,v]of Object.entries(e)){if(typeof v==='string')o[k]=v.slice(0,80);else if(typeof v==='number'||typeof v==='boolean')o[k]=v;}return o;}):null;",
  "let stops=1;try{stops=(JSON.parse(fs.readFileSync(file,'utf8')).stops|0)+1;}catch{}",
  "let data={registryAvailable:false,backgroundTasks:null,sessionCrons:null,stops};",
  "try{const event=JSON.parse(input);const bg=event.background_tasks;const crons=event.session_crons;data={registryAvailable:Array.isArray(bg)&&Array.isArray(crons),backgroundTasks:Array.isArray(bg)?bg.length:null,sessionCrons:Array.isArray(crons)?crons.length:null,stops,tasks:brief(bg),crons:brief(crons)};}catch{}",
  "try{fs.writeFileSync(file,JSON.stringify(data));}catch{}",
  "});",
].join('');

type ClaudeEvidenceEntry = Record<string, string | number | boolean>;

interface ClaudeCompletionEvidence {
  registryAvailable: boolean;
  backgroundTasks: number | null;
  sessionCrons: number | null;
  /** Stop events seen in the run; every other field is from the last one. */
  stops?: number;
  /** Short fields of the background tasks and crons still listed. */
  tasks?: ClaudeEvidenceEntry[];
  crons?: ClaudeEvidenceEntry[];
}

const evidenceEntries = (value: unknown): ClaudeEvidenceEntry[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is ClaudeEvidenceEntry =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : undefined;

/** What the last Stop still listed, so an incomplete review can be traced. */
function describePending(evidence: ClaudeCompletionEvidence): string {
  const counts: Array<[number, string]> = [
    [evidence.backgroundTasks ?? 0, 'background task'],
    [evidence.sessionCrons ?? 0, 'session cron'],
  ];
  const counted = counts
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`);
  const listed = [...(evidence.tasks ?? []), ...(evidence.crons ?? [])]
    .map((entry) => JSON.stringify(entry))
    .join(', ');

  return (
    `Claude's last Stop${evidence.stops ? ` (of ${evidence.stops} in this run)` : ''} ` +
    `still listed ${counted.join(' and ')}${listed ? `: ${listed}` : ''}.`
  );
}

function claudeCompletionSettings(evidencePath: string): string {
  return JSON.stringify({
    // `disableAllHooks` is deliberately left alone; build() refuses instead
    // (see assertClaudeHooksEnabledBySettings). Anything that still blocks
    // this hook, such as managed policy, fails closed as missing evidence.
    hooks: {
      Stop: [
        {
          hooks: [
            {
              // Exec form: Claude Code runs `command` with `args` directly, no
              // shell, so a node path with spaces needs no quoting. Every
              // Claude lane depends on it; if `args` were ever ignored, each
              // would fail as completion_evidence_missing, never pass quietly.
              type: 'command',
              command: process.execPath,
              args: ['-e', CLAUDE_STOP_EVIDENCE_SCRIPT, evidencePath],
            },
          ],
        },
      ],
    },
  });
}

function readClaudeCompletionEvidence(
  evidencePath: string | undefined,
): ClaudeCompletionEvidence | null {
  if (!evidencePath) return null;

  try {
    const raw = JSON.parse(readFileSync(evidencePath, 'utf8')) as Partial<ClaudeCompletionEvidence>;
    if (
      typeof raw.registryAvailable !== 'boolean' ||
      (raw.backgroundTasks !== null && typeof raw.backgroundTasks !== 'number') ||
      (raw.sessionCrons !== null && typeof raw.sessionCrons !== 'number')
    ) {
      return null;
    }

    const tasks = evidenceEntries(raw.tasks);
    const crons = evidenceEntries(raw.crons);

    return {
      registryAvailable: raw.registryAvailable,
      backgroundTasks: raw.backgroundTasks ?? null,
      sessionCrons: raw.sessionCrons ?? null,
      ...(typeof raw.stops === 'number' ? { stops: raw.stops } : {}),
      ...(tasks ? { tasks } : {}),
      ...(crons ? { crons } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Kept deliberately (see the "legacy completion marker" test). The marker is
 * no longer requested, but a trailing copy is still protocol, not review
 * text. Only an exact final line is ever removed.
 */
function stripClaudeCompletionMarker(output: string): string {
  const trimmed = output.trimEnd();
  const lines = trimmed.split(/\r\n|\r|\n/);

  if (lines.at(-1)?.trim() !== CLAUDE_COMPLETION_MARKER) return output;

  lines.pop();
  return lines.join('\n').trimEnd();
}

/** Claude Code: invoke the native `/code-review` skill through print mode. */
export const claudeAdapter: Adapter = {
  name: 'claude',
  label: 'Claude Code',
  command: 'claude',
  nativeReview: true,
  nativeReviewCommand: '/code-review',
  // Stop-hook `background_tasks` / `session_crons` arrived in Claude Code
  // 2.1.145, so the existing native-review floor already covers them.
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
  listsStampedFor: '2.1.280',

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

    if (request.completionEvidencePath) {
      assertClaudeHooksEnabledByEnvironment();
      assertClaudeHooksEnabledBySettings(request.repoRoot);

      const settingsFlag = requireSafetyFlag(
        request,
        ['--settings'],
        'the Claude Stop-hook completion guard',
        this.command,
      );

      // `--settings` accepts inline JSON. Hook entries merge with user/project
      // hooks, so crbuddy adds this lifecycle observer without replacing them.
      args.push(settingsFlag, claudeCompletionSettings(request.completionEvidencePath));
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
        ...(request.completionEvidencePath
          ? { completionEvidencePath: request.completionEvidencePath }
          : {}),
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
      ...(request.completionEvidencePath
        ? { completionEvidencePath: request.completionEvidencePath }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  finalOutput(result) {
    return stripClaudeCompletionMarker(result.stdout);
  },

  // Completion is the Stop hook's evidence that no background work is left,
  // not anything in the text: once that holds, any nonempty final output is
  // the review, even a short one. Guessing from prose is what this replaced.
  checkCompletion(result, invocation): CompletionCheck {
    const review = stripClaudeCompletionMarker(result.stdout).trim();
    const base = defaultCompletion({ ...result, body: review });
    if (!base.ok) return base;

    const evidencePath = invocation?.completionEvidencePath;
    if (!evidencePath) {
      return { ok: false, reason: 'completion_evidence_missing' };
    }

    const evidence = readClaudeCompletionEvidence(evidencePath);
    if (!evidence) {
      return { ok: false, reason: 'completion_evidence_missing' };
    }
    if (!evidence.registryAvailable) {
      return { ok: false, reason: 'completion_registry_unavailable' };
    }
    if (evidence.backgroundTasks !== 0 || evidence.sessionCrons !== 0) {
      // Kept, not dropped: a finished review has been judged incomplete this
      // way, and discarding it lost every finding in it. The report marks it.
      return {
        ok: false,
        reason: 'incomplete_review',
        detail: describePending(evidence),
        keepOutput: true,
      };
    }

    return { ok: true };
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
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', hint: 'frontier' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', hint: 'workhorse' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', hint: 'fast and cheap' },
  ],
  defaultModel: 'gpt-6-sol',

  // `ultra` is omitted: Codex runs it as a costly subagent fan-out rather
  // than a plain reasoning level. Config still passes it through verbatim.
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'high',
  listsStampedFor: '0.155.0',

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

const GEMINI_ARGV_SAFE = 6000;

/**
 * cmd.exe treats literal newlines inside a `.cmd` argument as command
 * separators. Gemini is commonly installed as an npm `.cmd` shim on Windows,
 * so multiline prompts must go through stdin there even when `--prompt` exists.
 */
export function geminiCanUsePromptArg(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    prompt.length <= GEMINI_ARGV_SAFE &&
    !(platform === 'win32' && /[\r\n]/.test(prompt))
  );
}

/** Gemini CLI: generic agent runs only; no supported headless native review. */
export const geminiAdapter: Adapter = {
  name: 'gemini',
  label: 'Gemini CLI',
  command: 'gemini',
  nativeReview: false,
  nativeReviewCommand: null,
  minVersion: '0.1.0',

  models: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', hint: 'deep reasoning' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', hint: 'fast' },
  ],
  defaultModel: 'gemini-3.1-pro-preview',

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

    if (promptFlag && geminiCanUsePromptArg(prompt)) {
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
