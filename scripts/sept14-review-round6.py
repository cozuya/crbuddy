from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)

# --- Claude hook environment semantics + stale comment -------------------
path = 'src/adapters/vendors.ts'
text = read(path)
text = replace_once(
    text,
    "    // crbuddy validates Claude's terminal marker in plain-text stdout.\n    // Structured output changes that contract, whether selected as an\n    // envelope format or requested through a JSON schema.\n",
    "    // crbuddy captures Claude's final payload as plain text. Structured\n    // output changes that contract, whether selected as an envelope format\n    // or requested through a JSON schema.\n",
    'refresh Claude structured-output comment',
)
old = """function environmentFlagEnabled(value: string | undefined): boolean {
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
new = """function environmentFlagEnabled(value: string | undefined): boolean {
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
"""
text = replace_once(text, old, new, 'match Claude env boolean semantics')
write(path, text)

# --- doctor shares the same environment guard ----------------------------
path = 'src/commands/doctor.ts'
text = read(path)
text = replace_once(
    text,
    "import { ADAPTERS } from '../adapters/vendors.js';\n",
    "import { ADAPTERS, claudeHookDisablingEnvironmentVariable } from '../adapters/vendors.js';\n",
    'import Claude hook environment helper',
)
old = """      // Preserve the existing fallback when help itself cannot be read: doctor
      // cannot prove a required flag is absent, so it reports the uncertainty
      // and lets go perform the authoritative build-time check.
      const requiredFlagsOk = help === null || missingRequired.length === 0;
      const adapterUsable = result.present && versionOk && requiredFlagsOk;
      const mark = !result.present
        ? 'MISS'
        : !versionOk
          ? 'OLD '
          : requiredFlagsOk
            ? 'OK  '
            : 'BAD ';
"""
new = """      // Preserve the existing fallback when help itself cannot be read: doctor
      // cannot prove a required flag is absent, so it reports the uncertainty
      // and lets go perform the authoritative build-time check.
      const requiredFlagsOk = help === null || missingRequired.length === 0;
      const hookDisabledBy =
        adapter.name === 'claude' ? claudeHookDisablingEnvironmentVariable() : null;
      const adapterUsable =
        result.present && versionOk && requiredFlagsOk && hookDisabledBy === null;
      const mark = !result.present
        ? 'MISS'
        : !versionOk
          ? 'OLD '
          : requiredFlagsOk && hookDisabledBy === null
            ? 'OK  '
            : 'BAD ';
"""
text = replace_once(text, old, new, 'doctor considers hook-disabling env')
old = """          if (missingRequired.length > 0) {
            console.log(
              `       problem:  required flag(s) missing; crbuddy go will refuse this adapter`,
            );
          }
        }
      }

      if (result.error) {
"""
new = """          if (missingRequired.length > 0) {
            console.log(
              `       problem:  required flag(s) missing; crbuddy go will refuse this adapter`,
            );
          }
        }

        if (hookDisabledBy) {
          console.log(
            `       problem:  ${hookDisabledBy} disables Claude hooks; crbuddy go will refuse Claude`,
          );
        }
      }

      if (result.error) {
"""
text = replace_once(text, old, new, 'doctor explains hook-disabling env')
write(path, text)

# --- sanitize config-controlled live go display names --------------------
path = 'src/commands/go.ts'
text = read(path)
text = replace_once(
    text,
    "import { notifyFinished, ReviewOutcome } from '../run/notify.js';\n",
    "import { notifyFinished, ReviewOutcome } from '../run/notify.js';\nimport { sanitizeTerminalInline } from '../util/ansi.js';\n",
    'import terminal sanitizer in go',
)
old = """  for (const entry of panel) {
    const label = adapters.get(entry.vendor)?.label ?? entry.vendor;
    const name = `${label} (${entry.model})`;

    base.set(entry.id, name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const names = new Map<string, string>();

  for (const entry of panel) {
    const name = base.get(entry.id)!;
    names.set(entry.id, (counts.get(name) ?? 0) > 1 ? `${name} [${entry.id}]` : name);
  }
"""
new = """  for (const entry of panel) {
    const label = sanitizeTerminalInline(
      adapters.get(entry.vendor)?.label ?? entry.vendor,
    );
    const model = sanitizeTerminalInline(entry.model);
    const name = `${label} (${model})`;

    base.set(entry.id, name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const names = new Map<string, string>();

  for (const entry of panel) {
    const name = base.get(entry.id)!;
    const id = sanitizeTerminalInline(entry.id);
    names.set(entry.id, (counts.get(name) ?? 0) > 1 ? `${name} [${id}]` : name);
  }
"""
text = replace_once(text, old, new, 'sanitize go reviewer display names')
write(path, text)

# --- malformed unterminated OSC should not erase later visible lines -----
path = 'src/util/ansi.ts'
text = read(path)
text = replace_once(
    text,
    "const OSC = /\\x1B\\][\\s\\S]*?(?:\\x07|\\x1B\\\\|$)/g;\n",
    "const OSC = /\\x1B\\][\\s\\S]*?(?:\\x07|\\x1B\\\\)/g;\nconst UNTERMINATED_OSC_LINE = /\\x1B\\][^\\r\\n]*/g;\n",
    'split terminated and unterminated OSC handling',
)
text = replace_once(
    text,
    "  return stripAnsi(input.replace(OSC, ''))\n",
    "  return stripAnsi(input.replace(OSC, '').replace(UNTERMINATED_OSC_LINE, ''))\n",
    'preserve text after malformed OSC line',
)
write(path, text)

# --- focused tests ---------------------------------------------------------
path = 'test/claude-completion.test.ts'
text = read(path)
text = replace_once(
    text,
    "  CLAUDE_COMPLETION_MARKER,\n  claudeAdapter,\n",
    "  CLAUDE_COMPLETION_MARKER,\n  claudeAdapter,\n  claudeHookDisablingEnvironmentVariable,\n",
    'import hook env helper in test',
)
insert_after = """const result = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr });
"""
addition = """

test('Claude hook-disabling environment values match Claude boolean semantics', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(
      claudeHookDisablingEnvironmentVariable({ CLAUDE_CODE_SIMPLE: value }),
      'CLAUDE_CODE_SIMPLE',
    );
  }

  for (const value of ['', ' ', '0', 'false', 'no', 'off', '2', 'anything']) {
    assert.equal(
      claudeHookDisablingEnvironmentVariable({ CLAUDE_CODE_SIMPLE: value }),
      null,
    );
  }

  assert.equal(
    claudeHookDisablingEnvironmentVariable({ CLAUDE_CODE_SAFE_MODE: 'yes' }),
    'CLAUDE_CODE_SAFE_MODE',
  );
});
"""
text = replace_once(text, insert_after, insert_after + addition, 'add hook env truthiness regression')
write(path, text)

path = 'test/ansi.test.ts'
Path(path).write_text("""import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeTerminalInline, stripTerminalControls } from '../src/util/ansi.js';

test('unterminated OSC removes only its malformed line and preserves later text', () => {
  const input = 'First line\\n\\x1b]0;unterminated title\\nSecond line\\nThird line';
  assert.equal(
    stripTerminalControls(input),
    'First line\\n\\nSecond line\\nThird line',
  );
  assert.equal(
    sanitizeTerminalInline(input),
    'First line Second line Third line',
  );
});
""")
