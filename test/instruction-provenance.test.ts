import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ResolvedTarget } from '../src/git/target.js';
import {
  renderFrontmatter,
  renderRaw,
  type ReportContext,
} from '../src/output/render.js';
import { PRIORITIZED_FINDINGS_PRESET_ID } from '../src/review/instructions.js';

const target: ResolvedTarget = {
  kind: 'branch',
  snapshot: '3333333333333333333333333333333333333333',
  base: '1111111111111111111111111111111111111111',
  requestedBase: 'main',
  mergeBase: '1111111111111111111111111111111111111111',
  range:
    '1111111111111111111111111111111111111111..3333333333333333333333333333333333333333',
  diff: 'diff',
  digest: 'cafebabe',
  files: [{ status: 'M', path: 'src/a.ts' }],
  bytes: 4,
};

function context(): ReportContext {
  return {
    version: '0.3.0',
    runId: 'abc12345',
    generated: '2026-09-04T18:00:00.000Z',
    target,
    runs: [
      {
        id: 'codex',
        vendor: 'codex',
        cli: 'codex',
        cliVersion: '0.149.0',
        modelRequested: 'gpt-5.6-sol',
        effortRequested: 'xhigh',
        effortApplied: 'xhigh',
        instructionSource: 'preset',
        instructionsPreset: PRIORITIZED_FINDINGS_PRESET_ID,
        ok: true,
        wallClockMs: 1234,
        output: '[P2] Fix the race — src/a.ts:10\nConcrete impact.',
      },
    ],
    mergeState: 'off',
    configSource: '.crbuddy/config.json',
    configScope: 'project',
    warnings: [],
  };
}

test('consolidated frontmatter records instruction source and preset id', () => {
  const rendered = renderFrontmatter(context());

  assert.match(rendered, /instructions: "preset"/);
  assert.match(rendered, /preset: "prioritized-findings-v1"/);
});

test('raw review output makes the instruction mode human-visible', () => {
  const rendered = renderRaw(context());

  assert.match(
    rendered,
    /instructions=preset preset=prioritized-findings-v1/,
  );
  assert.match(rendered, /_Instructions: prioritized-findings-v1\._/);
});
