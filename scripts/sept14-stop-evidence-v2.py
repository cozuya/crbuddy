from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


path = Path('src/adapters/vendors.ts')
text = path.read_text()

text = replace_once(
    text,
    '''/**
 * Claude Code's Stop hook receives its own authoritative background-task
 * registry. Use that lifecycle signal instead of trying to infer "done" from
 * prose. The hook records every Stop attempt and blocks the turn while work is
 * still in flight; crbuddy later requires evidence from the final Stop event.
 */''',
    '''/**
 * Claude Code's Stop hook receives its own authoritative background-task
 * registry. Use that lifecycle signal instead of trying to infer "done" from
 * prose. The hook only records each Stop event: print mode already pauses for
 * background work, and crbuddy removes that wait ceiling at launch. Blocking
 * Stop here would force extra model turns and can loop while tasks are running.
 */''',
    'update stop-hook comment',
)

text = replace_once(
    text,
    '''  "try{fs.writeFileSync(process.argv[1],JSON.stringify(data));}catch{}",
  "if(data.registryAvailable&&(data.backgroundTasks>0||data.sessionCrons>0)){process.stdout.write(JSON.stringify({decision:'block',reason:'crbuddy: background work is still running. Wait for all background/subagent tasks to finish and incorporate their results before stopping.'}));}",
  "});",''',
    '''  "try{fs.writeFileSync(process.argv[1],JSON.stringify(data));}catch{}",
  "});",''',
    'remove Stop blocking decision',
)

text = replace_once(
    text,
    '''function claudeCompletionSettings(evidencePath: string): string {
  return JSON.stringify({
    hooks: {''',
    '''function claudeCompletionSettings(evidencePath: string): string {
  return JSON.stringify({
    // Command-line settings outrank user/project/local settings, so a local
    // `disableAllHooks: true` cannot silently suppress crbuddy's evidence hook.
    // Managed policy can still prohibit non-managed hooks; in that case the
    // missing evidence remains a fail-closed completion error.
    disableAllHooks: false,
    hooks: {''',
    'force hooks on in session settings',
)

text = replace_once(
    text,
    '''  minVersion: '2.1.223',

  models:''',
    '''  // Stop-hook `background_tasks` / `session_crons` arrived in Claude Code
  // 2.1.145, so the existing native-review floor already covers them.
  minVersion: '2.1.223',

  models:''',
    'document completion-field version floor',
)

text = replace_once(
    text,
    '''    if (request.completionEvidencePath) {
      // `--settings` accepts inline JSON. Hook entries merge with user/project
      // hooks, so crbuddy adds this lifecycle guard without replacing them.
      args.push('--settings', claudeCompletionSettings(request.completionEvidencePath));
    }
''',
    '''    if (request.completionEvidencePath) {
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
''',
    'require settings support',
)

path.write_text(text)

path = Path('test/claude-completion.test.ts')
text = path.read_text()

text = replace_once(
    text,
    "import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';\n",
    "import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\n",
    'add hook execution imports',
)

anchor = """test('Claude rejects structured output modes because crbuddy captures plain-text payloads', () => {
"""
addition = r'''test('Claude Stop hook records pending work without blocking or emitting output', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crbuddy-claude-hook-run-'));
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
  const settingsIndex = invocation.args.indexOf('--settings');
  const settings = JSON.parse(invocation.args[settingsIndex + 1] ?? '{}');
  const hook = settings.hooks?.Stop?.[0]?.hooks?.[0];

  assert.equal(settings.disableAllHooks, false);
  const run = spawnSync(
    hook.command,
    hook.args,
    {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        stop_hook_active: false,
        background_tasks: [{ id: 'task-1' }],
        session_crons: [],
      }),
      encoding: 'utf8',
    },
  );

  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(completionEvidencePath, 'utf8')), {
    registryAvailable: true,
    backgroundTasks: 1,
    sessionCrons: 0,
  });
});

test('Claude fails before launch when --settings cannot install the completion hook', () => {
  assert.throws(
    () => claudeAdapter.build({
      operation: { kind: 'review', target },
      model: 'opus',
      effort: 'high',
      repoRoot: '/repo',
      completionEvidencePath: '/tmp/crbuddy-completion.json',
      supports: (flag) => flag !== '--settings',
    }),
    (error: unknown) =>
      error instanceof UnsafeInvocationError &&
      /Stop-hook completion guard/.test(error.message),
  );
});

'''
text = replace_once(text, anchor, addition + anchor, 'add stop-hook refinement tests')
path.write_text(text)
