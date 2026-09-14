from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# ---- terminal sanitization -----------------------------------------------
path = 'src/util/ansi.ts'
text = read(path)
text = replace_once(
    text,
    """/** Some CLIs emit color even when piped; markdown should not carry it. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI, '');
}
""",
    r"""const OSC = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/g;

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
""",
    'add reusable terminal sanitizers',
)
write(path, text)


# ---- init/config summary -------------------------------------------------
path = 'src/commands/init.ts'
text = read(path)
text = replace_once(
    text,
    "import { WizardUI, createWizardUI } from '../util/wizard-prompt.js';\n",
    "import { WizardUI, createWizardUI } from '../util/wizard-prompt.js';\nimport { sanitizeTerminalInline, stripTerminalControls } from '../util/ansi.js';\n",
    'import terminal sanitizers',
)

old = r"""function formatReviewer(entry: PanelEntry): string {
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
    vendorLabel,
    modelLabel,
    entry.effort,
    entry.instructions ? 'custom instructions' : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}
"""
new = r"""function formatReviewer(entry: PanelEntry): string {
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
    .join(' · ');
}
"""
text = replace_once(text, old, new, 'sanitize reviewer summary fields')

pattern = re.compile(
    r"function stripTerminalControlSequences\(value: string\): string \{.*?\n\}\n\nexport function formatSavedReviewInstructions",
    re.S,
)
text, count = pattern.subn('export function formatSavedReviewInstructions', text, count=1)
if count != 1:
    raise SystemExit(f'remove duplicate terminal sanitizer: expected 1 match, got {count}')

text = replace_once(
    text,
    """  const logicalLines = stripTerminalControlSequences(
    instructions.replace(/\r\n?/g, '\n'),
  ).split('\n');
""",
    """  const logicalLines = stripTerminalControls(
    instructions.replace(/\r\n?/g, '\n'),
  ).split('\n');
""",
    'reuse terminal sanitizer for saved preview',
)

old = """  const first = logicalLines[0]?.trim().replace(/[\t ]+/g, ' ') ?? '';
  const preview =
    first.length > SAVED_REVIEW_PREVIEW_WIDTH
      ? `${first.slice(0, SAVED_REVIEW_PREVIEW_WIDTH - 1).trimEnd()}…`
      : first;

  const approximateLines = logicalLines.reduce((sum, line) => {
    const width = line.replace(/\t/g, '    ').trimEnd().length;
    return sum + Math.max(1, Math.ceil(width / SAVED_REVIEW_PREVIEW_WIDTH));
  }, 0);
"""
new = """  const first = logicalLines[0]?.trim().replace(/[\t ]+/g, ' ') ?? '';
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
"""
text = replace_once(text, old, new, 'make preview unicode-safe')

text = replace_once(
    text,
    "    `Path: ${targetFile}`,\n",
    "    `Path: ${sanitizeTerminalInline(targetFile)}`,\n",
    'sanitize summary path',
)
text = replace_once(
    text,
    "        : `Current branch vs ${config.target.base}`\n",
    "        : `Current branch vs ${sanitizeTerminalInline(config.target.base)}`\n",
    'sanitize target base',
)
text = replace_once(
    text,
    "    lines.push(`Output: ${config.output.merged}`);\n    if (config.merge.enabled) lines.push(`Raw audit: ${config.output.raw}`);\n",
    "    lines.push(`Output: ${sanitizeTerminalInline(config.output.merged)}`);\n    if (config.merge.enabled) {\n      lines.push(`Raw audit: ${sanitizeTerminalInline(config.output.raw)}`);\n    }\n",
    'sanitize output paths',
)
text = replace_once(
    text,
    "    lines.push(`.gitignore: Add ${gitignorePlan.missing.join(', ')}`);\n",
    "    lines.push(\n      `.gitignore: Add ${gitignorePlan.missing\n        .map(sanitizeTerminalInline)\n        .join(', ')}`,\n    );\n",
    'sanitize gitignore summary',
)
write(path, text)


# ---- doctor --------------------------------------------------------------
path = 'src/commands/doctor.ts'
text = read(path)
text = replace_once(
    text,
    "    { candidates: ['--append-system-prompt'], required: true },\n",
    "    { candidates: ['--settings'], required: true },\n",
    'align doctor with Claude settings requirement',
)
write(path, text)


# ---- Claude completion prerequisites ------------------------------------
path = 'src/adapters/vendors.ts'
text = read(path)
text = replace_once(
    text,
    "    '--json-schema',\n",
    "    '--json-schema',\n    // These modes disable hook execution, which would make every Claude lane\n    // consume usage and then fail completion-evidence validation.\n    '--bare',\n    '--safe-mode',\n",
    'block hook-disabling Claude flags',
)

anchor = """function assertSafeVendorArgs(vendor: string, args: string[] | undefined): void {
"""
helper = """function environmentFlagEnabled(value: string | undefined): boolean {
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

"""
text = replace_once(text, anchor, helper + anchor, 'add Claude hook environment guard')

text = replace_once(
    text,
    """    if (request.completionEvidencePath) {
      const settingsFlag = requireSafetyFlag(
""",
    """    if (request.completionEvidencePath) {
      assertClaudeHooksEnabledByEnvironment();

      const settingsFlag = requireSafetyFlag(
""",
    'check Claude hook environment before launch',
)

old = """    const evidence = readClaudeCompletionEvidence(invocation?.completionEvidencePath);
    if (
      !evidence?.registryAvailable ||
      evidence.backgroundTasks !== 0 ||
      evidence.sessionCrons !== 0
    ) {
      return { ok: false, reason: 'incomplete_review' };
    }

    return { ok: true };
"""
new = """    const evidencePath = invocation?.completionEvidencePath;
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

    return { ok: true };
"""
text = replace_once(text, old, new, 'differentiate Claude evidence failures')
write(path, text)


# ---- Keep Claude-only orchestration Claude-only --------------------------
path = 'src/commands/go.ts'
text = read(path)
old = """      repoRoot: args.repoRoot,
      completionEvidencePath: path.join(
        args.scratch,
        `${entry.id}.claude-completion.json`,
      ),
      supports: args.supports,
"""
new = """      repoRoot: args.repoRoot,
      ...(adapter.name === 'claude'
        ? {
            completionEvidencePath: path.join(
              args.scratch,
              `${entry.id}.claude-completion.json`,
            ),
          }
        : {}),
      supports: args.supports,
"""
text = replace_once(text, old, new, 'scope panel completion evidence to Claude')
text = replace_once(
    text,
    "    repoRoot: args.repoRoot,\n    completionEvidencePath: path.join(args.scratch, 'merge.claude-completion.json'),\n    supports: args.supports,\n",
    "    repoRoot: args.repoRoot,\n    ...(args.adapter.name === 'claude'\n      ? { completionEvidencePath: path.join(args.scratch, 'merge.claude-completion.json') }\n      : {}),\n    supports: args.supports,\n",
    'scope merge completion evidence to Claude',
)
write(path, text)


# ---- stale adapter test --------------------------------------------------
path = 'test/adapters.test.ts'
text = read(path)
pattern = re.compile(
    r"\ntest\('Claude status-only review response is not accepted as completed findings', \(\) => \{.*?\n\}\);\n",
    re.S,
)
text, count = pattern.subn('\n', text, count=1)
if count != 1:
    raise SystemExit(f'remove stale Claude completion test: expected 1 match, got {count}')
write(path, text)


# ---- Claude completion tests --------------------------------------------
path = 'test/claude-completion.test.ts'
text = read(path)
text = text.replace(
    "{ ok: false, reason: 'incomplete_review' },\n  );\n});\n\ntest('Claude rejects scheduled wakeups",
    "{ ok: false, reason: 'completion_evidence_missing' },\n  );\n});\n\ntest('Claude rejects scheduled wakeups",
    1,
)
text = text.replace(
    "claudeAdapter.checkCompletion(result('Finished review.'), invocation),\n    { ok: false, reason: 'incomplete_review' },\n  );\n});\n\ntest('Claude rejects output when completion evidence is missing'",
    "claudeAdapter.checkCompletion(result('Finished review.'), invocation),\n    { ok: false, reason: 'completion_registry_unavailable' },\n  );\n});\n\ntest('Claude rejects output when completion evidence is missing'",
    1,
)

anchor = """test('Claude rejects structured output modes because crbuddy captures plain-text payloads', () => {
"""
addition = """test('Claude rejects vendor modes that disable hooks before launch', () => {
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
text = replace_once(text, anchor, addition + anchor, 'add hook-disabling vendor arg tests')
write(path, text)


# ---- saved preview unicode regression -----------------------------------
path = 'test/saved-review-instructions.test.ts'
text = read(path)
anchor = """test('saved instruction preview strips terminal control sequences', () => {
"""
addition = """test('saved instruction preview does not split Unicode surrogate pairs', () => {
  const preview = formatSavedReviewInstructions(`${'A'.repeat(78)}😀BC`);
  assert.equal(preview, `${'A'.repeat(78)}😀…`);
  assert.doesNotMatch(preview, /[\\uD800-\\uDFFF](?![\\uDC00-\\uDFFF])/);
});

"""
text = replace_once(text, anchor, addition + anchor, 'add unicode preview regression')
write(path, text)


# ---- view summary injection regression ----------------------------------
path = 'test/view.test.ts'
text = read(path)
anchor = """test('view reports when no review config exists', async () => {
"""
addition = r"""test('view strips terminal controls and line injection from config fields', async () => {
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

"""
text = replace_once(text, anchor, addition + anchor, 'add view terminal sanitization regression')
write(path, text)
