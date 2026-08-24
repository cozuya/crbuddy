import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeAdapter, codexAdapter, geminiAdapter } from '../src/adapters/vendors.js';
import { UnsafeInvocationError } from '../src/adapters/types.js';
import { ResolvedTarget } from '../src/git/target.js';

const supports = () => true;

const uncommitted: ResolvedTarget = {
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

const branch: ResolvedTarget = {
  kind: 'branch',
  snapshot: '3333333333333333333333333333333333333333',
  base: '1111111111111111111111111111111111111111',
  requestedBase: 'main',
  mergeBase: '1111111111111111111111111111111111111111',
  range:
    '1111111111111111111111111111111111111111..3333333333333333333333333333333333333333',
  diff: 'diff',
  digest: 'cafebabe',
  files: [{ status: 'M', path: 'src/b.ts' }],
  bytes: 4,
};

type VendorName = 'claude' | 'codex' | 'gemini';

function buildWithVendorArgs(vendor: VendorName, vendorArgs: string[]) {
  const common = {
    model: vendor === 'claude' ? 'opus' : vendor === 'codex' ? 'gpt-5.6-sol' : 'gemini-2.5-pro',
    repoRoot: '/repo',
    supports,
    vendorArgs,
  };

  if (vendor === 'claude') {
    return claudeAdapter.build({
      ...common,
      operation: { kind: 'review', target: uncommitted },
    });
  }

  if (vendor === 'codex') {
    return codexAdapter.build({
      ...common,
      operation: { kind: 'review', target: uncommitted },
    });
  }

  return geminiAdapter.build({
    ...common,
    operation: {
      kind: 'generic',
      target: uncommitted,
      instructions: 'Review for correctness.',
    },
  });
}

test('Claude native review invokes /code-review for uncommitted target', () => {
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target: uncommitted },
    model: 'opus',
    effort: 'high',
    repoRoot: '/repo',
    supports,
  });

  assert.equal(invocation.command, 'claude');
  assert.equal(invocation.stdin, undefined);
  assert.equal(invocation.args.at(-1), `/code-review high ${uncommitted.range}`);
  assert.equal(invocation.appliedEffort, 'high');
});

test('Claude native review uses an explicit default effort when config omits it', () => {
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target: uncommitted },
    model: 'opus',
    repoRoot: '/repo',
    supports,
  });

  assert.equal(invocation.args.at(-1), `/code-review high ${uncommitted.range}`);
  assert.equal(invocation.appliedEffort, 'high');
});

test('Claude branch review also uses /code-review with the captured range', () => {
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target: branch },
    model: 'opus',
    effort: 'xhigh',
    repoRoot: '/repo',
    supports,
  });

  assert.equal(invocation.args.at(-1), `/code-review xhigh ${branch.range}`);
  assert.ok(!invocation.args.some((arg) => arg.startsWith('/review')));
});

test('Claude refuses ultra on the normal native lane because -p does not wait for it', () => {
  assert.throws(
    () =>
      claudeAdapter.build({
        operation: { kind: 'review', target: uncommitted },
        model: 'opus',
        effort: 'ultra',
        repoRoot: '/repo',
        supports,
      }),
    (error: unknown) =>
      error instanceof UnsafeInvocationError &&
      /Ultrareview/.test(error.message) &&
      /launches asynchronously/.test(error.message),
  );
});

test('Claude status-only review response is not accepted as completed findings', () => {
  const completion = claudeAdapter.checkCompletion({
    code: 0,
    stdout: "Still waiting for the code-review skill's verification/synthesis stage to complete.\n",
    stderr: '',
  });

  assert.deepEqual(completion, { ok: false, reason: 'incomplete_review' });
});

test('Claude vendorArgs cannot override permission safety', () => {
  assert.throws(
    () =>
      claudeAdapter.build({
        operation: { kind: 'review', target: uncommitted },
        model: 'opus',
        repoRoot: '/repo',
        supports,
        vendorArgs: ['--permission-mode', 'bypassPermissions'],
      }),
    UnsafeInvocationError,
  );
});

test('Codex probes exec-level help where safety/config flags live', () => {
  assert.deepEqual(codexAdapter.helpArgs(), ['exec', '--help']);
});

test('Codex native review uses exec review --uncommitted', () => {
  const invocation = codexAdapter.build({
    operation: { kind: 'review', target: uncommitted },
    model: 'gpt-5.6-sol',
    effort: 'high',
    repoRoot: '/repo',
    supports,
  });

  assert.equal(invocation.command, 'codex');
  assert.equal(invocation.stdin, undefined);
  assert.ok(invocation.args.includes('review'));
  assert.ok(invocation.args.includes('--uncommitted'));
  assert.ok(!invocation.args.includes('--base'));
});

test('Codex native branch review uses exec review --base requested branch', () => {
  const invocation = codexAdapter.build({
    operation: { kind: 'review', target: branch },
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    repoRoot: '/repo',
    supports,
  });

  const reviewIndex = invocation.args.indexOf('review');
  assert.ok(reviewIndex >= 0);
  assert.deepEqual(invocation.args.slice(reviewIndex), ['review', '--base', 'main']);
  assert.equal(invocation.stdin, undefined);
});

test('Codex refuses when exec-level help does not advertise a safety sandbox', () => {
  assert.throws(
    () =>
      codexAdapter.build({
        operation: { kind: 'review', target: uncommitted },
        model: 'gpt-5.6-sol',
        repoRoot: '/repo',
        supports: (flag) => flag !== '--sandbox' && flag !== '-s',
      }),
    UnsafeInvocationError,
  );
});

test('Codex vendorArgs cannot weaken sandbox safety', () => {
  assert.throws(
    () =>
      codexAdapter.build({
        operation: { kind: 'review', target: uncommitted },
        model: 'gpt-5.6-sol',
        repoRoot: '/repo',
        supports,
        vendorArgs: ['--sandbox', 'danger-full-access'],
      }),
    UnsafeInvocationError,
  );
});

test('Codex vendorArgs cannot use arbitrary config overrides around safety', () => {
  assert.throws(
    () =>
      codexAdapter.build({
        operation: { kind: 'review', target: uncommitted },
        model: 'gpt-5.6-sol',
        repoRoot: '/repo',
        supports,
        vendorArgs: ['-c', 'approval_policy=never'],
      }),
    UnsafeInvocationError,
  );
});

test('known per-vendor safety and configuration flags are rejected in split and equals forms', () => {
  const blocked: Record<VendorName, string[]> = {
    claude: [
      '--permission-mode',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--allowedTools',
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
    ],
    codex: [
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
    ],
    gemini: [
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
    ],
  };

  for (const vendor of Object.keys(blocked) as VendorName[]) {
    for (const flag of blocked[vendor]) {
      assert.throws(
        () => buildWithVendorArgs(vendor, [flag, 'value']),
        UnsafeInvocationError,
        `${vendor} should reject ${flag} value`,
      );

      assert.throws(
        () => buildWithVendorArgs(vendor, [`${flag}=value`]),
        UnsafeInvocationError,
        `${vendor} should reject ${flag}=value`,
      );
    }
  }
});

test('an unknown vendor flag remains available as an escape hatch', () => {
  for (const vendor of ['claude', 'codex', 'gemini'] as VendorName[]) {
    const invocation = buildWithVendorArgs(vendor, ['--future-format=json']);
    assert.ok(invocation.args.includes('--future-format=json'), vendor);
  }
});

test('custom Codex instructions remain an explicit generic agent run', () => {
  const invocation = codexAdapter.build({
    operation: {
      kind: 'generic',
      target: uncommitted,
      instructions: 'Focus only on resource leaks.',
    },
    model: 'gpt-5.6-sol',
    effort: 'high',
    repoRoot: '/repo',
    supports,
  });

  assert.ok(!invocation.args.includes('review'));
  assert.match(invocation.stdin ?? '', /Focus only on resource leaks/);
  assert.match(invocation.stdin ?? '', new RegExp(uncommitted.snapshot));
});

test('adapter metadata says which vendors have native review', () => {
  assert.equal(claudeAdapter.nativeReview, true);
  assert.equal(codexAdapter.nativeReview, true);
  assert.equal(geminiAdapter.nativeReview, false);
});

test('Gemini refuses implicit review rather than faking native review with a prompt', () => {
  assert.throws(
    () =>
      geminiAdapter.build({
        operation: { kind: 'review', target: uncommitted },
        model: 'gemini-2.5-pro',
        repoRoot: '/repo',
        supports,
      }),
    (error: unknown) =>
      error instanceof UnsafeInvocationError &&
      /does not currently expose a supported headless native code-review/.test(error.message),
  );
});
