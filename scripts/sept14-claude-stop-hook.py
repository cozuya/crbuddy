from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)

# --- adapter types ---------------------------------------------------------
path = Path('src/adapters/types.ts')
text = path.read_text()
text = replace_once(
    text,
    "  repoRoot: string;\n  /** Does the probed help surface advertise this flag? */",
    "  repoRoot: string;\n  /** Optional adapter-owned evidence file used to prove lifecycle completion. */\n  completionEvidencePath?: string;\n  /** Does the probed help surface advertise this flag? */",
    'add completion evidence request field',
)
text = replace_once(
    text,
    "  env?: Record<string, string>;\n  /** Effort value actually passed, for provenance. Null means none. */",
    "  env?: Record<string, string>;\n  /** Adapter-owned evidence file written by the child lifecycle guard. */\n  completionEvidencePath?: string;\n  /** Effort value actually passed, for provenance. Null means none. */",
    'add completion evidence invocation field',
)
text = replace_once(
    text,
    "  checkCompletion(result: {\n    code: number | null;\n    stdout: string;\n    stderr: string;\n  }): CompletionCheck;",
    "  checkCompletion(\n    result: {\n      code: number | null;\n      stdout: string;\n      stderr: string;\n    },\n    invocation?: Invocation,\n  ): CompletionCheck;",
    'pass invocation to completion check',
)
path.write_text(text)

# --- Claude adapter --------------------------------------------------------
path = Path('src/adapters/vendors.ts')
text = path.read_text()
text = replace_once(
    text,
    "import {\n  Adapter,",
    "import { readFileSync } from 'node:fs';\n\nimport {\n  Adapter,",
    'import evidence reader',
)

start = text.index("export const CLAUDE_COMPLETION_MARKER = '<!-- crbuddy:review-complete -->';")
end = text.index("/** Claude Code: invoke the native `/code-review` skill through print mode. */", start)
replacement = r'''export const CLAUDE_COMPLETION_MARKER = '<!-- crbuddy:review-complete -->';

/**
 * Claude Code's Stop hook receives its own authoritative background-task
 * registry. Use that lifecycle signal instead of trying to infer "done" from
 * prose. The hook records every Stop attempt and blocks the turn while work is
 * still in flight; crbuddy later requires evidence from the final Stop event.
 */
const CLAUDE_STOP_EVIDENCE_SCRIPT = [
  "const fs=require('node:fs');",
  "let input='';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',c=>input+=c);",
  "process.stdin.on('end',()=>{",
  "let data={registryAvailable:false,backgroundTasks:null,sessionCrons:null};",
  "try{const event=JSON.parse(input);const bg=event.background_tasks;const crons=event.session_crons;data={registryAvailable:Array.isArray(bg)&&Array.isArray(crons),backgroundTasks:Array.isArray(bg)?bg.length:null,sessionCrons:Array.isArray(crons)?crons.length:null};}catch{}",
  "try{fs.writeFileSync(process.argv[1],JSON.stringify(data));}catch{}",
  "if(data.registryAvailable&&(data.backgroundTasks>0||data.sessionCrons>0)){process.stdout.write(JSON.stringify({decision:'block',reason:'crbuddy: background work is still running. Wait for all background/subagent tasks to finish and incorporate their results before stopping.'}));}",
  "});",
].join('');

interface ClaudeCompletionEvidence {
  registryAvailable: boolean;
  backgroundTasks: number | null;
  sessionCrons: number | null;
}

function claudeCompletionSettings(evidencePath: string): string {
  return JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
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

    return {
      registryAvailable: raw.registryAvailable,
      backgroundTasks: raw.backgroundTasks ?? null,
      sessionCrons: raw.sessionCrons ?? null,
    };
  } catch {
    return null;
  }
}

function stripClaudeCompletionMarker(output: string): string {
  const trimmed = output.trimEnd();
  const lines = trimmed.split(/\r\n|\r|\n/);

  if (lines.at(-1)?.trim() !== CLAUDE_COMPLETION_MARKER) return output;

  lines.pop();
  return lines.join('\n').trimEnd();
}

'''
text = text[:start] + replacement + text[end:]

old = """    const completionPrompt = requireSafetyFlag(
      request,
      ['--append-system-prompt'],
      'the Claude completion protocol',
      this.command,
    );

    args.push(completionPrompt, CLAUDE_COMPLETION_INSTRUCTION);

"""
text = replace_once(text, old, '', 'remove model-authored completion marker prompt')

old = """    if (request.vendorArgs) {
      args.push(...request.vendorArgs);
    }

    if (request.operation.kind === 'review') {
"""
new = """    if (request.completionEvidencePath) {
      // `--settings` accepts inline JSON. Hook entries merge with user/project
      // hooks, so crbuddy adds this lifecycle guard without replacing them.
      args.push('--settings', claudeCompletionSettings(request.completionEvidencePath));
    }

    if (request.vendorArgs) {
      args.push(...request.vendorArgs);
    }

    if (request.operation.kind === 'review') {
"""
text = replace_once(text, old, new, 'install Claude Stop hook')

# Add completionEvidencePath to both Claude invocation return shapes.
text = text.replace(
    "        appliedEffort: reviewEffort,\n        ...(warnings.length > 0 ? { warnings } : {}),",
    "        appliedEffort: reviewEffort,\n        ...(request.completionEvidencePath\n          ? { completionEvidencePath: request.completionEvidencePath }\n          : {}),\n        ...(warnings.length > 0 ? { warnings } : {}),",
    1,
)
text = text.replace(
    "      appliedEffort,\n      ...(warnings.length > 0 ? { warnings } : {}),",
    "      appliedEffort,\n      ...(request.completionEvidencePath\n        ? { completionEvidencePath: request.completionEvidencePath }\n        : {}),\n      ...(warnings.length > 0 ? { warnings } : {}),",
    1,
)

old_start = text.index("  checkCompletion(result): CompletionCheck {", text.index("export const claudeAdapter"))
old_end = text.index("\n  },\n};", old_start) + len("\n  },")
new_check = r'''  checkCompletion(result, invocation): CompletionCheck {
    const review = stripClaudeCompletionMarker(result.stdout).trim();
    const base = defaultCompletion({ ...result, body: review });
    if (!base.ok) return base;

    const evidence = readClaudeCompletionEvidence(invocation?.completionEvidencePath);
    if (
      !evidence?.registryAvailable ||
      evidence.backgroundTasks !== 0 ||
      evidence.sessionCrons !== 0
    ) {
      return { ok: false, reason: 'incomplete_review' };
    }

    return { ok: true };
  },'''
text = text[:old_start] + new_check + text[old_end:]
path.write_text(text)

# --- go call sites ---------------------------------------------------------
path = Path('src/commands/go.ts')
text = path.read_text()
text = replace_once(
    text,
    "      repoRoot: args.repoRoot,\n      supports: args.supports,",
    "      repoRoot: args.repoRoot,\n      completionEvidencePath: path.join(\n        args.scratch,\n        `${entry.id}.claude-completion.json`,\n      ),\n      supports: args.supports,",
    'give reviewer invocation completion evidence path',
)
text = replace_once(
    text,
    "  const completion = adapter.checkCompletion(result);",
    "  const completion = adapter.checkCompletion(result, invocation);",
    'pass reviewer invocation to completion check',
)
text = replace_once(
    text,
    "    repoRoot: args.repoRoot,\n    supports: args.supports,\n  });\n\n  const result = await runProcess({",
    "    repoRoot: args.repoRoot,\n    completionEvidencePath: path.join(args.scratch, 'merge.claude-completion.json'),\n    supports: args.supports,\n  });\n\n  const result = await runProcess({",
    'give merge invocation completion evidence path',
)
text = replace_once(
    text,
    "  const completion = args.adapter.checkCompletion(result);",
    "  const completion = args.adapter.checkCompletion(result, invocation);",
    'pass merge invocation to completion check',
)
path.write_text(text)

# --- Claude completion tests ----------------------------------------------
Path('test/claude-completion.test.ts').write_text(r'''import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_COMPLETION_MARKER,
  claudeAdapter,
} from '../src/adapters/vendors.js';
import { UnsafeInvocationError, type Invocation } from '../src/adapters/types.js';
import { ResolvedTarget } from '../src/git/target.js';

const target: ResolvedTarget = {
  kind: 'uncommitted',
  snapshot: '2222222222222222222222222222222222222222',
  base: '1111111111111111111111111111111111111111',
  range:
    '1111111111111111111111111111111111111111..2222222222222222222222222222222222222222',
  diff: 'diff',
  digest: 'deadbeef',
  files: [{ status: 'M', path: 'src/a.ts' }],
  bytes: 4,
};

const result = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr });

function invocationWithEvidence(
  t: import('node:test').TestContext,
  evidence: { registryAvailable: boolean; backgroundTasks: number | null; sessionCrons: number | null },
): Invocation {
  const dir = mkdtempSync(path.join(tmpdir(), 'crbuddy-claude-completion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const completionEvidencePath = path.join(dir, 'completion.json');
  writeFileSync(completionEvidencePath, JSON.stringify(evidence));
  return {
    command: 'claude',
    args: [],
    appliedEffort: 'high',
    completionEvidencePath,
  };
}

function completeEvidence(t: import('node:test').TestContext): Invocation {
  return invocationWithEvidence(t, {
    registryAvailable: true,
    backgroundTasks: 0,
    sessionCrons: 0,
  });
}

test('Claude accepts any nonempty final review when Stop-hook evidence proves no work is pending', (t) => {
  for (const stdout of [
    'I found three issues in the changed code.',
    'No actionable regressions identified.',
    'The subagents are still running — quoted here only as part of the final review discussion.',
    '{"clusters":[]}',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout), completeEvidence(t)),
      { ok: true },
    );
  }
});

test('Claude rejects output when authoritative Stop evidence says background work remains', (t) => {
  const invocation = invocationWithEvidence(t, {
    registryAvailable: true,
    backgroundTasks: 2,
    sessionCrons: 0,
  });
  assert.deepEqual(
    claudeAdapter.checkCompletion(
      result('No issues found. I will report back once agents finish.'),
      invocation,
    ),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude rejects output when the task registry was unavailable', (t) => {
  const invocation = invocationWithEvidence(t, {
    registryAvailable: false,
    backgroundTasks: null,
    sessionCrons: null,
  });
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Finished review.'), invocation),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude rejects output when completion evidence is missing', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Finished review.'), {
      command: 'claude', args: [], appliedEffort: 'high',
      completionEvidencePath: '/definitely/missing/crbuddy-completion.json',
    }),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude rejects scheduled wakeups as unfinished session work', (t) => {
  const invocation = invocationWithEvidence(t, {
    registryAvailable: true,
    backgroundTasks: 0,
    sessionCrons: 1,
  });
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Finished review.'), invocation),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude still rejects empty output even with complete lifecycle evidence', (t) => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('   '), completeEvidence(t)),
    { ok: false, reason: 'empty' },
  );
});

test('legacy completion marker is stripped but is not itself review content', (t) => {
  const invocation = completeEvidence(t);
  const stdout = `Actual review\n${CLAUDE_COMPLETION_MARKER}\n`;
  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout), invocation), { ok: true });
  assert.equal(claudeAdapter.finalOutput(result(stdout)), 'Actual review');

  assert.deepEqual(
    claudeAdapter.checkCompletion(result(`${CLAUDE_COMPLETION_MARKER}\n`), invocation),
    { ok: false, reason: 'empty' },
  );
});

test('Claude preserves nonzero exit classification even with complete evidence', (t) => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Partial review', 2), completeEvidence(t)),
    { ok: false, reason: 'exit_2' },
  );
});

test('Claude invocation installs a Stop hook lifecycle guard instead of prompting for a marker', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crbuddy-claude-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const completionEvidencePath = path.join(dir, 'completion.json');
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target },
    model: 'opus',
    effort: 'high',
    repoRoot: '/repo',
    completionEvidencePath,
    supports: () => true,
  });

  assert.equal(invocation.completionEvidencePath, completionEvidencePath);
  assert.equal(invocation.args.includes('--append-system-prompt'), false);
  const settingsIndex = invocation.args.indexOf('--settings');
  assert.ok(settingsIndex >= 0);
  const settings = JSON.parse(invocation.args[settingsIndex + 1] ?? '{}');
  const hook = settings.hooks?.Stop?.[0]?.hooks?.[0];
  assert.equal(hook?.type, 'command');
  assert.equal(hook?.command, process.execPath);
  assert.match(hook?.args?.[1] ?? '', /background_tasks/);
  assert.equal(hook?.args?.[2], completionEvidencePath);
  assert.equal(invocation.args.at(-1), `/code-review high ${target.range}`);
});

test('Claude rejects structured output modes because crbuddy captures plain-text payloads', () => {
  for (const vendorArgs of [
    ['--output-format', 'json'],
    ['--output-format=stream-json'],
    ['--json-schema', '{"type":"object"}'],
    ['--json-schema={"type":"object"}'],
  ]) {
    assert.throws(
      () => claudeAdapter.build({
        operation: { kind: 'review', target },
        model: 'opus',
        effort: 'high',
        vendorArgs,
        repoRoot: '/repo',
        supports: () => true,
      }),
      UnsafeInvocationError,
    );
  }
});
''')

# --- docs: match the requested preview behavior, not a stronger privacy claim ---
path = Path('GUIDE.md')
text = path.read_text()
text = text.replace(
    'summary show only a sanitized, truncated first-line preview plus an approximate\nwrapped-line count, never the full prompt.',
    'summary show only a sanitized first-line preview (truncated when long) plus an\napproximate wrapped-line count; subsequent lines are never printed verbatim.',
)
path.write_text(text)
