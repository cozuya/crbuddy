import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Finding,
  locationsIn,
  reassemble,
  relativizePaths,
  segment,
} from '../src/merge/segment.js';
import {
  MergeValidationError,
  orderClusters,
  parseClusterResponse,
  singletons,
  validateClusters,
} from '../src/merge/cluster.js';
import { isNewerThanStamp } from '../src/adapters/effort.js';
import { defaultCompletion } from '../src/adapters/types.js';
import { formatElapsed, formatSize } from '../src/util/format.js';

const HEADING_REVIEW = `Some preamble about the diff.

## Unhandled promise rejection
In \`src/api.ts:42\` the await is missing.

## Missing null check
\`src/db.ts:10\` can return undefined.
`;

const NUMBERED_REVIEW = `1. First problem in src/a.ts:1
   more detail
2. Second problem in src/b.ts:9
`;

test('segmentation is lossless - reassembly reproduces the input', () => {
  for (const input of [HEADING_REVIEW, NUMBERED_REVIEW, 'just one paragraph\n']) {
    const findings = segment('run-1', input);
    assert.equal(reassemble(findings), input, 'segmentation must not lose bytes');
  }
});

test('splits on headings when the document uses them', () => {
  const findings = segment('run-1', HEADING_REVIEW);

  // preamble + two headings
  assert.equal(findings.length, 3);
  assert.equal(findings[1]?.title, 'Unhandled promise rejection');
  assert.equal(findings[2]?.title, 'Missing null check');
});

test('splits on numbered items when there are no headings', () => {
  const findings = segment('run-1', NUMBERED_REVIEW);

  assert.equal(findings.length, 2);
  assert.match(findings[0]!.title, /First problem/);
});

test('does not split inside fenced code blocks', () => {
  const input = [
    '## Real finding',
    'Here is a snippet:',
    '```md',
    '## not a heading',
    '- not a bullet',
    '```',
    'Trailing prose.',
  ].join('\n');

  const findings = segment('run-1', input);

  assert.equal(findings.length, 1);
  assert.equal(reassemble(findings), input);
});

test('extracts file:line locations outside code fences', () => {
  const found = locationsIn('Problem in src/api.ts:42 and also src/db.ts line 7');

  assert.ok(found.includes('src/api.ts:42'));
  assert.ok(found.includes('src/db.ts:7'));
});

test('ignores locations inside code fences', () => {
  const found = locationsIn('```\nexample/only.ts:1\n```\nreal/file.ts:2');

  assert.ok(found.includes('real/file.ts:2'));
  assert.ok(!found.includes('example/only.ts:1'));
});

function makeFindings(): Finding[] {
  return [
    { id: 'a#1', runId: 'a', title: 'x', text: 'x', locations: [] },
    { id: 'a#2', runId: 'a', title: 'y', text: 'y', locations: [] },
    { id: 'b#1', runId: 'b', title: 'x again', text: 'x', locations: [] },
  ];
}

test('validation accepts a complete partition', () => {
  const findings = makeFindings();

  const result = validateClusters(
    [{ findingIds: ['a#1', 'b#1'] }, { findingIds: ['a#2'] }],
    findings,
  );

  assert.equal(result.clusters.length, 2);
});

test('validation REJECTS a dropped finding - the merge cannot delete', () => {
  const findings = makeFindings();

  assert.throws(
    () => validateClusters([{ findingIds: ['a#1', 'b#1'] }], findings),
    (error: unknown) =>
      error instanceof MergeValidationError && /dropped 1 finding/.test(error.message),
  );
});

test('validation rejects a finding placed in two clusters', () => {
  const findings = makeFindings();

  assert.throws(
    () =>
      validateClusters(
        [
          { findingIds: ['a#1', 'b#1'] },
          { findingIds: ['a#1', 'a#2'] },
        ],
        findings,
      ),
    /more than one cluster/,
  );
});

test('validation rejects invented ids', () => {
  const findings = makeFindings();

  assert.throws(
    () =>
      validateClusters(
        [{ findingIds: ['a#1', 'a#2', 'b#1', 'ghost#9'] }],
        findings,
      ),
    /unknown finding id/,
  );
});

test('a merge that returns nothing is a failure, not an empty report', () => {
  assert.throws(() => parseClusterResponse('I could not do that.'), MergeValidationError);
});

test('tolerates fenced or chatty JSON from the merge model', () => {
  const fenced = '```json\n{"clusters":[{"findingIds":["a#1"]}]}\n```';
  assert.equal(parseClusterResponse(fenced).length, 1);

  const chatty =
    'Here is the grouping:\n{"clusters":[{"findingIds":["a#1"],"note":"ignored"}]}\nDone.';
  assert.equal(parseClusterResponse(chatty).length, 1);
});

test('ordering puts multi-reviewer clusters first', () => {
  const findings = makeFindings();

  const ordered = orderClusters(
    [{ findingIds: ['a#2'] }, { findingIds: ['a#1', 'b#1'] }],
    findings,
  );

  assert.deepEqual(ordered[0]?.findingIds, ['a#1', 'b#1']);
});

test('two findings from the SAME run do not count as agreement', () => {
  const findings: Finding[] = [
    { id: 'a#1', runId: 'a', title: 'x', text: 'x', locations: [] },
    { id: 'a#2', runId: 'a', title: 'x', text: 'x', locations: [] },
    { id: 'b#1', runId: 'b', title: 'y', text: 'y', locations: [] },
    { id: 'c#1', runId: 'c', title: 'y', text: 'y', locations: [] },
  ];

  const ordered = orderClusters(
    [
      { findingIds: ['a#1', 'a#2'] },
      { findingIds: ['b#1', 'c#1'] },
    ],
    findings,
  );

  assert.deepEqual(
    ordered[0]?.findingIds,
    ['b#1', 'c#1'],
    'two distinct reviewers should outrank one reviewer saying it twice',
  );
});

test('singleton fallback covers every finding exactly once', () => {
  const findings = makeFindings();
  const clusters = singletons(findings);

  assert.doesNotThrow(() => validateClusters(clusters, findings));
});

test('a successful review that DISCUSSES rate limiting is not marked failed', () => {
  const check = defaultCompletion({
    code: 0,
    stdout: 'The new endpoint has no rate limiting and returns 401 inconsistently.',
    stderr: '',
    body: 'The new endpoint has no rate limiting and returns 401 inconsistently.',
  });

  assert.equal(check.ok, true, 'content must never be scanned for failure patterns');
});

test('a non-zero exit with a rate limit on stderr is classified', () => {
  const check = defaultCompletion({
    code: 1,
    stdout: '',
    stderr: 'Error: usage limit reached, try again later',
    body: '',
  });

  assert.equal(check.ok, false);
  assert.equal(check.reason, 'rate_limited');
});

test('a zero exit with an empty body is not a review', () => {
  const check = defaultCompletion({ code: 0, stdout: '', stderr: '', body: '   ' });

  assert.equal(check.ok, false);
  assert.equal(check.reason, 'empty');
});

test('version comparison drives only the "lists may be stale" note', () => {
  assert.equal(isNewerThanStamp('2.2.0', '2.1.0'), true);
  assert.equal(isNewerThanStamp('2.1.0', '2.1.0'), false);
  assert.equal(isNewerThanStamp('0.9.9', '0.50.0'), false);
  assert.equal(isNewerThanStamp('0.51.0', '0.50.0'), true);
});

test('sizes are shown in units people reason in', () => {
  assert.equal(formatSize(512), '512 bytes');
  assert.equal(formatSize(193000), '188 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
});

test('elapsed time reads naturally at each scale', () => {
  assert.equal(formatElapsed(42_000), '42s');
  assert.equal(formatElapsed(185_000), '3m 05s');
  assert.equal(formatElapsed(4_320_000), '1h 12m');
});

test('preamble segments are marked as context, real findings are not', () => {
  const review = [
    'Reviewed abc123..def456 (21 commits, ~5.7k lines). Findings ordered by severity.',
    '',
    '## Unhandled rejection',
    'In `src/api.ts:42` the await is missing, so failures are swallowed silently.',
    '',
    '## Minor',
  ].join('\n');

  const findings = segment('run-1', review);

  const preamble = findings.find((f) => f.title.startsWith('Reviewed abc123'));
  const real = findings.find((f) => f.title === 'Unhandled rejection');
  const bareHeading = findings.find((f) => f.title === 'Minor');

  assert.equal(preamble?.context, true, 'preamble is not a finding');
  assert.equal(bareHeading?.context, true, 'a bare heading is not a finding');
  assert.equal(real?.context, undefined, 'a located finding must stay a finding');
});

test('context clusters sort below every real finding', () => {
  const findings: Finding[] = [
    { id: 'a#1', runId: 'a', title: 'preamble', text: 'x', locations: [], context: true },
    { id: 'a#2', runId: 'a', title: 'bug', text: 'y', locations: ['f.ts:1'] },
  ];

  const ordered = orderClusters(
    [{ findingIds: ['a#1'] }, { findingIds: ['a#2'] }],
    findings,
  );

  assert.deepEqual(ordered[0]?.findingIds, ['a#2']);
});

test('absolute repo paths are rewritten to repo-relative', () => {
  const root = 'C:/Users/Chris/ai/crbuddy';

  const text =
    'Problem at [src/run/spawn.ts:178](C:/Users/Chris/ai/crbuddy/src/run/spawn.ts:178) here.';

  const out = relativizePaths(text, root);

  assert.ok(!out.includes('C:/Users/Chris'), `machine layout leaked: ${out}`);
  assert.ok(out.includes('src/run/spawn.ts:178'));
});

test('backslash spellings of the repo root are stripped too', () => {
  const out = relativizePaths(
    'see C:\\Users\\Chris\\ai\\crbuddy\\src\\a.ts:1',
    'C:/Users/Chris/ai/crbuddy',
  );

  assert.ok(!out.includes('Users'), `machine layout leaked: ${out}`);
});

test('paths outside the repo root are left alone', () => {
  const text = 'compare with /usr/lib/node/thing.js:9';
  assert.equal(relativizePaths(text, '/home/someone/repo'), text);
});

test('commit ranges and line counts are not mistaken for file paths', () => {
  // A loose pattern matched these as files, which polluted clustering hints
  // and made preamble text look like a located finding.
  assert.deepEqual(locationsIn('Reviewed abc123..def456 (~5.7k lines)'), []);
  assert.deepEqual(locationsIn('version 1.2.3 released'), []);
  assert.deepEqual(locationsIn('takes 3.5s to run'), []);
});

test('real file references still parse, including nested and multi-dot names', () => {
  assert.deepEqual(locationsIn('see src/api.ts:42'), ['src/api.ts:42']);
  assert.deepEqual(locationsIn('see a/b/c.test.ts:7'), ['a/b/c.test.ts:7']);
  assert.deepEqual(locationsIn('check package.json'), ['package.json']);
});
