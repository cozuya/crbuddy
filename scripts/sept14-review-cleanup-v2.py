from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def sub_once(text: str, pattern: str, repl, label: str, flags=0) -> str:
    regex = re.compile(pattern, flags)
    text, count = regex.subn(repl, text, count=1)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


# util/ansi.ts: one shared sanitizer for summaries and output helpers.
write('src/util/ansi.ts', r'''const ANSI =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const OSC = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/g;

// Preserve tab/newline/CR for callers that intentionally handle layout. Strip
// the rest of C0/C1 plus any escape sequence our ANSI matcher did not consume.
// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Some CLIs emit color even when piped; markdown should not carry it. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI, '');
}

/** Remove terminal-control sequences while preserving ordinary text layout. */
export function stripTerminalControls(input: string): string {
  return stripAnsi(input.replace(OSC, ''))
    .replace(/\x1B./g, '')
    .replace(OTHER_CONTROLS, '');
}

/** Safe one-line rendering for config-controlled terminal summaries. */
export function sanitizeTerminalInline(input: string): string {
  return stripTerminalControls(input)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}
''')


# init.ts: reuse sanitizer, sanitize every config-controlled summary field,
# and truncate previews by Unicode code point rather than UTF-16 code unit.
path = 'src/commands/init.ts'
text = read(path)
if "../util/ansi.js" not in text:
    text = replace_once(
        text,
        "import { WizardUI, createWizardUI } from '../util/wizard-prompt.js';\n",
        "import { WizardUI, createWizardUI } from '../util/wizard-prompt.js';\nimport { sanitizeTerminalInline, stripTerminalControls } from '../util/ansi.js';\n",
        'import terminal sanitizers',
    )

reviewer = r'''function formatReviewer(entry: PanelEntry): string {
  let vendorLabel = entry.vendor;
  let modelLabel = entry.model;

  try {
    const adapter = getAdapter(entry.vendor);
    vendorLabel = adapter.label;
    modelLabel =
      adapter.models.find((model) => model.id === entry.model)?.label ?? entry.model;
  } catch {
    // Existing hand-edited configs may name an adapter unknown to this build.
  }

  return [
    sanitizeTerminalInline(vendorLabel),
    sanitizeTerminalInline(modelLabel),
    entry.effort ? sanitizeTerminalInline(entry.effort) : undefined,
    entry.instructions ? 'custom instructions' : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' \u00b7 ');
}

'''
text = sub_once(
    text,
    r"function formatReviewer\(entry: PanelEntry\): string \{.*?\n\}\n\n(?=function formatPanel)",
    lambda _: reviewer,
    'replace formatReviewer',
    re.S,
)

saved = r'''export function formatSavedReviewInstructions(instructions: string): string {
  const logicalLines = stripTerminalControls(
    instructions.replace(/\r\n?/g, '\n'),
  ).split('\n');

  while (logicalLines.length > 0 && logicalLines[0]?.trim() === '') {
    logicalLines.shift();
  }
  while (logicalLines.length > 0 && logicalLines.at(-1)?.trim() === '') {
    logicalLines.pop();
  }

  const first = logicalLines[0]?.trim().replace(/[\t ]+/g, ' ') ?? '';
  const firstCharacters = Array.from(first);
  const preview =
    firstCharacters.length > SAVED_REVIEW_PREVIEW_WIDTH
      ? `${firstCharacters
          .slice(0, SAVED_REVIEW_PREVIEW_WIDTH - 1)
          .join('')
          .trimEnd()}…`
      : first;

  const approximateLines = logicalLines.reduce((sum, line) => {
    const width = Array.from(line.replace(/\t/g, '    ').trimEnd()).length;
    return sum + Math.max(1, Math.ceil(width / SAVED_REVIEW_PREVIEW_WIDTH));
  }, 0);
  const more = Math.max(0, approximateLines - 1);

  return more > 0
    ? `${preview} (and ~${more} more line${more === 1 ? '' : 's'})`
    : preview;
}

'''
text = sub_once(
    text,
    r"(?:function stripTerminalControlSequences\(value: string\): string \{.*?\n\}\n\n)?export function formatSavedReviewInstructions\(instructions: string\): string \{.*?\n\}\n\n(?=export function formatConfigSummary)",
    lambda _: saved,
    'replace saved preview formatter',
    re.S,
)

text = text.replace('`Path: ${targetFile}`', '`Path: ${sanitizeTerminalInline(targetFile)}`')
text = text.replace(
    ': `Current branch vs ${config.target.base}`',
    ': `Current branch vs ${sanitizeTerminalInline(config.target.base)}`',
)
text = text.replace(
    'lines.push(`Output: ${config.output.merged}`);',
    'lines.push(`Output: ${sanitizeTerminalInline(config.output.merged)}`);',
)
text = text.replace(
    'if (config.merge.enabled) lines.push(`Raw audit: ${config.output.raw}`);',
    "if (config.merge.enabled) {\n      lines.push(`Raw audit: ${sanitizeTerminalInline(config.output.raw)}`);\n    }",
)
text = text.replace(
    "lines.push(`.gitignore: Add ${gitignorePlan.missing.join(', ')}`);",
    "lines.push(\n      `.gitignore: Add ${gitignorePlan.missing\n        .map(sanitizeTerminalInline)\n        .join(', ')}`,\n    );",
)
write(path, text)


# doctor.ts: match the flag execution actually requires.
path = 'src/commands/doctor.ts'
text = read(path)
text = text.replace(
    "{ candidates: ['--append-system-prompt'], required: true },",
    "{ candidates: ['--settings'], required: true },",
)
write(path, text)


# vendors.ts: reject known hook-disabling modes up front and report hook
# evidence failures distinctly instead of calling all of them incomplete work.
path = 'src/adapters/vendors.ts'
text = read(path)
if "'--bare'," not in text:
    text = replace_once(
        text,
        "    '--json-schema',\n",
        "    '--json-schema',\n    // These modes disable hook execution, which would make every Claude lane\n    // consume usage and then fail completion-evidence validation.\n    '--bare',\n    '--safe-mode',\n",
        'block hook-disabling Claude flags',
    )

if 'function environmentFlagEnabled' not in text:
    text = replace_once(
        text,
        'function assertSafeVendorArgs(vendor: string, args: string[] | undefined): void {\n',
        """function environmentFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !/^(?:0|false|no|off)$/i.test(value.trim());
}

function assertClaudeHooksEnabledByEnvironment(): void {
  const disabledBy = [
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_SAFE_MODE',
  ].find((name) => environmentFlagEnabled(process.env[name]));

  if (disabledBy) {
    throw new UnsafeInvocationError(
      `${disabledBy} disables Claude hooks, but crbuddy requires its per-run ` +
        `Stop hook to verify completion. Unset ${disabledBy} before running Claude ` +
        `through crbuddy.`,
    );
  }
}

function assertSafeVendorArgs(vendor: string, args: string[] | undefined): void {
""",
        'add Claude hook environment guard',
    )

text = replace_once(
    text,
    """    if (request.completionEvidencePath) {
      const settingsFlag = requireSafetyFlag(
""",
    """    if (request.completionEvidencePath) {
      assertClaudeHooksEnabledByEnvironment();

      const settingsFlag = requireSafetyFlag(
""",
    'guard hook-disabling environment',
)

text = sub_once(
    text,
    r"    const evidence = readClaudeCompletionEvidence\(invocation\?\.completionEvidencePath\);\n    if \(\n      !evidence\?\.registryAvailable \|\|\n      evidence\.backgroundTasks !== 0 \|\|\n      evidence\.sessionCrons !== 0\n    \) \{\n      return \{ ok: false, reason: 'incomplete_review' \};\n    \}\n\n    return \{ ok: true \};",
    """    const evidencePath = invocation?.completionEvidencePath;
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
      return { ok: false, reason: 'incomplete_review' };
    }

    return { ok: true };""",
    'refine Claude completion failure reasons',
)
write(path, text)


# go.ts: do not manufacture Claude evidence paths for other adapters.
path = 'src/commands/go.ts'
text = read(path)
text = sub_once(
    text,
    r"      repoRoot: args\.repoRoot,\n      completionEvidencePath: path\.join\(\n        args\.scratch,\n        `\$\{entry\.id\}\.claude-completion\.json`,\n      \),\n      supports: args\.supports,",
    """      repoRoot: args.repoRoot,
      ...(adapter.name === 'claude'
        ? {
            completionEvidencePath: path.join(
              args.scratch,
              `${entry.id}.claude-completion.json`,
            ),
          }
        : {}),
      supports: args.supports,""",
    'scope panel evidence path to Claude',
)
text = sub_once(
    text,
    r"    repoRoot: args\.repoRoot,\n    completionEvidencePath: path\.join\(args\.scratch, 'merge\.claude-completion\.json'\),\n    supports: args\.supports,",
    """    repoRoot: args.repoRoot,
    ...(args.adapter.name === 'claude'
      ? { completionEvidencePath: path.join(args.scratch, 'merge.claude-completion.json') }
      : {}),
    supports: args.supports,""",
    'scope merge evidence path to Claude',
)
write(path, text)


# Remove stale test whose result only came from missing lifecycle evidence.
path = 'test/adapters.test.ts'
text = read(path)
text = sub_once(
    text,
    r"\ntest\('Claude status-only review response is not accepted as completed findings', \(\) => \{.*?\n\}\);\n",
    '\n',
    'remove stale Claude completion test',
    re.S,
)
write(path, text)


# Completion tests: distinct evidence errors plus hook-disabling flags.
path = 'test/claude-completion.test.ts'
text = read(path)
text = text.replace(
    "test('Claude rejects output when the task registry was unavailable', (t) => {",
    "test('Claude reports when the task registry was unavailable', (t) => {",
)
# First registry-unavailable assertion in that test.
marker = "claudeAdapter.checkCompletion(result('Finished review.'), invocation),\n    { ok: false, reason: 'incomplete_review' },"
pos = text.find(marker, text.find("test('Claude reports when the task registry was unavailable'"))
if pos == -1:
    raise SystemExit('could not find registry unavailable assertion')
text = text[:pos] + marker.replace("'incomplete_review'", "'completion_registry_unavailable'") + text[pos + len(marker):]

text = text.replace(
    "{ ok: false, reason: 'incomplete_review' },\n  );\n});\n\ntest('Claude rejects scheduled wakeups as unfinished session work'",
    "{ ok: false, reason: 'completion_evidence_missing' },\n  );\n});\n\ntest('Claude rejects scheduled wakeups as unfinished session work'",
    1,
)

if "Claude rejects vendor modes that disable hooks before launch" not in text:
    insertion = """test('Claude rejects vendor modes that disable hooks before launch', () => {
  for (const vendorArgs of [['--bare'], ['--safe-mode']]) {
    assert.throws(
      () => claudeAdapter.build({
        operation: { kind: 'review', target },
        model: 'opus',
        effort: 'high',
        vendorArgs,
        repoRoot: '/repo',
        completionEvidencePath: '/tmp/crbuddy-completion.json',
        supports: () => true,
      }),
      UnsafeInvocationError,
    );
  }
});

"""
    text = text.replace(
        "test('Claude rejects structured output modes because crbuddy captures plain-text payloads', () => {",
        insertion + "test('Claude rejects structured output modes because crbuddy captures plain-text payloads', () => {",
        1,
    )
write(path, text)


# Preview regression for surrogate pairs.
path = 'test/saved-review-instructions.test.ts'
text = read(path)
if 'does not split Unicode surrogate pairs' not in text:
    addition = """test('saved instruction preview does not split Unicode surrogate pairs', () => {
  const preview = formatSavedReviewInstructions(`${'A'.repeat(78)}😀BC`);
  assert.equal(preview, `${'A'.repeat(78)}😀…`);
});

"""
    text = text.replace(
        "test('saved instruction preview strips terminal control sequences', () => {",
        addition + "test('saved instruction preview strips terminal control sequences', () => {",
        1,
    )
write(path, text)


# View regression: repository-controlled summary fields cannot emit terminal
# controls or inject their own lines.
path = 'test/view.test.ts'
text = read(path)
if 'view strips terminal controls and line injection from config fields' not in text:
    addition = r'''test('view strips terminal controls and line injection from config fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-view-sanitize-'));

  try {
    const repoRoot = path.join(root, 'repo');
    await mkdir(repoRoot, { recursive: true });
    const malicious = config('evil\x1b]0;owned\x07\x1b[31m\nspoofed', {
      base: 'main\x1b[2J\nFAKE STATUS',
    });
    await writeJson(projectConfigPath(repoRoot), malicious);

    const { ui, notes } = recordingUi();
    await runView(
      { repoRoot },
      { ui, settingsFile: path.join(root, 'missing-settings.json') },
    );

    const message = notes[0]?.message ?? '';
    assert.doesNotMatch(message, /\x1b|owned/);
    assert.doesNotMatch(message, /\nspoofed|\nFAKE STATUS/);
    assert.match(message, /evil spoofed/);
    assert.match(message, /Current branch vs main FAKE STATUS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

'''
    text = text.replace(
        "test('view reports when no review config exists', async () => {",
        addition + "test('view reports when no review config exists', async () => {",
        1,
    )
write(path, text)
