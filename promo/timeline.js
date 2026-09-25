// The cue sheet. The page (scene.js) and the sound (audio.mjs) both build
// from this file, so a key click can never drift from the letter it types.

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** mulberry32: small, fast, and the same numbers on every render. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp01 = (x) => Math.min(1, Math.max(0, x));

// --- terminal content ------------------------------------------------------
// Every string below is what crbuddy (or clack, which draws `crb init`)
// really prints. Versions, counts, hashes and times are made up.

// Span styles: '' plain, d dim, k gray, c cyan, g green, b bold, p prompt.

const BASE_SHA = '4c1e9a27d0b35f86e2a19c47b0d6f3e85a21c9d4';
const SNAPSHOT_SHA = 'b7d03f5e91c24a86f0e3d7b1c58a92e4f6d10b37';
export const REVIEWED_RANGE = `${BASE_SHA}..${SNAPSHOT_SHA}`;

export const LANES = [
  { vendor: 'Claude Code', model: 'opus', effort: 'max', doneAt: 770 },
  { vendor: 'Codex CLI', model: 'gpt-6-sol', effort: 'xhigh', doneAt: 570 },
  { vendor: 'Gemini CLI', model: 'gemini-3.1-pro-preview', effort: null, doneAt: 252 },
].map((lane) => ({
  ...lane,
  display: `${lane.vendor} (${lane.model}${lane.effort ? `, ${lane.effort}` : ''})`,
}));

export const FINDINGS = {
  claude: [
    '1. src/session.ts:42 - refresh() can race logout and revive a revoked token.',
    '2. src/api/retry.ts:88 - the retry loop never backs off on HTTP 429.',
  ],
  codex: [
    '- [P1] Refresh can resurrect a revoked session - src/session.ts:40-47',
    '- [P2] 429 responses are retried immediately - src/api/retry.ts:85-91',
  ],
  security: ['No injection, authz or secrets-handling issues in the changed files.'],
};

/** renderReport() output for this run, line for line. */
export const REPORT = [
  '# Code review',
  '',
  '<!-- crbuddy:raw runId=7f3a91c2 -->',
  '',
  '<!-- crbuddy:report -->',
  '**3 of 3 reviews completed.**',
  '',
  `Reviewed \`${REVIEWED_RANGE}\` - 35 file(s) changed.`,
  '<!-- /crbuddy:report -->',
  '',
  '<!-- crbuddy:review id=claude-opus vendor=claude model=opus effort=max -->',
  '## claude-opus - claude / opus, effort max',
  '',
  ...FINDINGS.claude,
  '',
  '<!-- /crbuddy:review id=claude-opus -->',
  '',
  '<!-- crbuddy:review id=codex-gpt-6-sol vendor=codex model=gpt-6-sol effort=xhigh -->',
  '## codex-gpt-6-sol - codex / gpt-6-sol, effort xhigh',
  '',
  ...FINDINGS.codex,
  '',
  '<!-- /crbuddy:review id=codex-gpt-6-sol -->',
  '',
  '<!-- crbuddy:review id=security vendor=gemini model=gemini-3.1-pro-preview -->',
  '## security - gemini / gemini-3.1-pro-preview',
  '',
  ...FINDINGS.security,
  '',
  '<!-- /crbuddy:review id=security -->',
];

/** "42s", "3m 05s" - the same as src/util/format.ts. */
export function formatElapsed(seconds) {
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const CLACK_SPINNER = ['◒', '◐', '◓', '◑'];

// --- the timeline ------------------------------------------------------------

export function buildTimeline() {
  const random = rng(20260925);
  const ops = [];
  const sfx = [];
  const cue = {};

  const op = (t, fields) => ops.push({ t, ...fields });
  const sound = (t, kind, extra = {}) => sfx.push({ t, kind, ...extra });
  const print = (t, spans, extra = {}) => op(t, { kind: 'print', spans, ...extra });

  function type(t0, text, cps = 21) {
    const times = [];
    let t = t0;
    for (const ch of text) {
      times.push(t);
      sound(t, 'key');
      t += (1 / cps) * (0.7 + random() * 0.6) + (ch === ' ' ? 0.035 : 0);
    }
    op(t0, { kind: 'type', text, times });
    return times.at(-1) ?? t0;
  }

  /** Prompt, pause, type, Enter. Returns the moment Enter lands. */
  function command(tPrompt, tType, text) {
    op(tPrompt, { kind: 'prompt' });
    const enter = type(tType, text) + 0.2;
    op(enter, { kind: 'enter' });
    sound(enter, 'enter');
    return enter;
  }

  // 1 · title ------------------------------------------------------------
  cue.wordmark = [];
  for (let i = 0; i < 'crbuddy'.length; i++) {
    const t = 0.35 + i * 0.085;
    cue.wordmark.push(t);
    sound(t, 'key', { gain: 0.8 });
  }
  cue.tagline = 1.3;
  sound(1.3, 'pop', { gain: 0.5, pitch: 1.2 });
  cue.titleOut = 3.0;

  // 2 · idea -------------------------------------------------------------
  sound(3.05, 'whoosh');
  cue.idea = 3.25;
  cue.ideaH1 = 3.3;
  cue.author = 3.5;
  sound(3.5, 'pop');
  cue.diffLines = [3.85, 3.95, 4.05, 4.15, 4.25];
  cue.ideaH2 = 4.55;
  cue.reviewers = [4.8, 4.97];
  cue.reviewers.forEach((t, i) => sound(t, 'pop', { pitch: 1.1 + i * 0.12 }));
  cue.findings = [6.05, 6.3];
  cue.findings.forEach((t, i) => sound(t, 'ding', { gain: 0.55, pitch: 1 + i * 0.12 }));
  cue.ideaOut = 6.95;
  sound(6.95, 'whoosh');

  // 3 · setup ------------------------------------------------------------
  cue.setup = 7.3;
  cue.setupHead = 7.65;
  cue.setupSub = 8.0;

  const install = command(7.75, 8.1, 'npm i -g crbuddy');
  print(install + 0.4, [['', 'added 11 packages in 2s']]);
  const init = command(install + 0.5, install + 0.65, 'crb init');

  let t = init + 0.2;
  print(t, [['k', '┌'], ['', '  '], ['b', 'crbuddy setup']]);
  print(t + 0.05, [['k', '│']]);
  print(t + 0.1, [], { id: 'spin', dyn: 'clack-spinner', label: 'Checking vendor CLIs' });
  t += 0.6;
  op(t, { kind: 'set', id: 'spin', spans: [['g', '◇'], ['', '  Vendor CLIs checked']] });
  print(t + 0.05, [['k', '│']]);
  print(t + 0.1, [['g', '◇'], ['', '  Vendor CLIs '], ['k', '─────────────────────╮']]);
  print(t + 0.15, [['k', '│                                   │']]);

  const detections = [
    ['Claude Code', '2.1.230 (claude)  '],
    ['Codex CLI', '0.155.0 (codex)     '],
    ['Gemini CLI', '0.42.0 (gemini)    '],
  ];
  cue.badges = [];
  detections.forEach(([label, rest], i) => {
    const at = t + 0.25 + i * 0.18;
    cue.badges.push(at);
    sound(at, 'pop', { pitch: 1 + i * 0.12 });
    print(at, [['k', '│'], ['', `  ✓ ${label}  ${rest}`], ['k', '│']]);
  });

  t += 0.25 + 3 * 0.18;
  print(t, [['k', '│                                   │']]);
  print(t + 0.04, [['k', '├───────────────────────────────────╯']]);
  print(t + 0.2, [['k', '│']]);

  // The output question, answered "Print it to the terminal": that choice
  // is what ends `crb go` on the clipboard menu later.
  t += 0.3;
  print(t, [['c', '◆'], ['', '  Where should the output go?']], { id: 'q' });
  print(t, [['c', '│'], ['', '  '], ['g', '●'], ['', ' Write a report to disk '],
    ['d', '(a markdown file you can point an agent at)']], { id: 'o1' });
  print(t, [['c', '│'], ['', '  '], ['d', '○ Print it to the terminal']], { id: 'o2' });
  print(t, [['c', '└']], { id: 'qend' });

  t += 0.6;
  sound(t, 'tick');
  op(t, { kind: 'set', id: 'o1', spans: [['c', '│'], ['', '  '], ['d', '○ Write a report to disk']] });
  op(t, { kind: 'set', id: 'o2', spans: [['c', '│'], ['', '  '], ['g', '●'],
    ['', ' Print it to the terminal '],
    ['d', '(nothing is written; copy it at the end or scroll back)']] });

  t += 0.45;
  sound(t, 'enter');
  op(t, { kind: 'set', id: 'q', spans: [['g', '◇'], ['', '  Where should the output go?']] });
  op(t, { kind: 'set', id: 'o1', spans: [['k', '│'], ['', '  '], ['d', 'Print it to the terminal']] });
  op(t, { kind: 'remove', id: 'o2' });
  op(t, { kind: 'remove', id: 'qend' });

  print(t + 0.2, [['k', '│']]);
  print(t + 0.25, [['k', '└'], ['', '  Config saved to .crbuddy/config.json']]);
  print(t + 0.25, [['', '   Run `crbuddy go` to start a review.']]);
  sound(t + 0.25, 'pop', { gain: 0.5, pitch: 1.4 });
  op(t + 0.5, { kind: 'prompt' });

  cue.setupOut = t + 1.1;
  sound(cue.setupOut, 'swipe');

  // 4 · run --------------------------------------------------------------
  cue.run = cue.setupOut + 0.2;
  op(cue.run, { kind: 'clear' });
  cue.runHead = cue.run + 0.15;

  const go = command(cue.run + 0.05, cue.run + 0.3, 'crb go');
  t = go + 0.22;
  print(t, [['d', 'crbuddy beginning run using local configuration']]);
  print(t + 0.15, [['d', 'Reviewing 35 file(s), 205 KB.']]);
  const started = t + 0.35;
  print(started, [['', 'Starting 3 reviews at 4:19pm…']]);

  cue.laneStart = [];
  LANES.forEach((lane, i) => {
    const at = started + 0.15 + i * 0.13;
    cue.laneStart.push(at);
    sound(at, 'pop', { pitch: 0.9 + i * 0.12 });
    print(at, [['d', `  ${lane.display} - started`]]);
  });

  cue.statusOn = cue.laneStart.at(-1) + 0.02;
  print(cue.statusOn, [], { id: 'status', dyn: 'status' });

  // Twelve minutes of waiting, played at about 220x.
  cue.ffStart = cue.statusOn + 0.55;
  cue.ffEnd = cue.ffStart + 3.4;
  cue.started = started;
  sound(cue.ffStart, 'whir', { dur: cue.ffEnd - cue.ffStart });

  cue.laneDone = [];
  LANES.forEach((lane, i) => {
    const at = timeAtElapsed(cue, lane.doneAt);
    cue.laneDone[i] = at;
  });
  [...LANES.keys()]
    .sort((a, b) => cue.laneDone[a] - cue.laneDone[b])
    .forEach((i, n) => {
      const at = cue.laneDone[i];
      sound(at, 'ding', { pitch: 1 + n * 0.15 });
      op(at, {
        kind: 'print',
        before: 'status',
        spans: [['d', `  ${LANES[i].display} - done in ${formatElapsed(LANES[i].doneAt)}`]],
      });
    });

  const allDone = Math.max(...cue.laneDone);
  op(allDone + 0.02, { kind: 'remove', id: 'status' });
  cue.bell = allDone + 0.06;
  sound(cue.bell, 'bell');

  // Terminal mode: the report goes to stdout, then the clipboard menu.
  t = cue.bell + 0.1;
  REPORT.forEach((line, i) => print(t + i * 0.026, [['', line]]));
  t += REPORT.length * 0.026 + 0.25;

  cue.menu = t;
  cue.clipScene = t - 0.3;
  sound(cue.clipScene, 'swipe');
  print(t, [['', '']]);
  print(t, [['', 'Report(s) done, pick one:']]);
  print(t, [['', '  '], ['c', '> Copy to clipboard and exit']]);
  print(t, [['', '    Exit']]);

  cue.copyEnter = t + 1.15;
  sound(cue.copyEnter, 'enter');
  cue.copied = cue.copyEnter + 0.12;
  print(cue.copied, [['d', '  Copied to clipboard.']], { id: 'copied' });
  sound(cue.copied, 'copy');
  op(cue.copied + 0.3, { kind: 'prompt' });

  // 5 · clipboard payoff (right column) ------------------------------------
  cue.paste = cue.copied + 1.2;
  sound(cue.paste - 0.12, 'key', { gain: 0.9 });
  sound(cue.paste, 'paste');

  const ask = 'fix these';
  cue.askStart = cue.paste + 0.7;
  cue.askTimes = [];
  let k = cue.askStart;
  for (const ch of ask) {
    cue.askTimes.push(k);
    sound(k, 'key', { gain: 0.8 });
    k += 0.065 * (0.7 + random() * 0.6) + (ch === ' ' ? 0.03 : 0);
  }
  cue.ask = ask;
  cue.send = k + 0.3;
  sound(cue.send, 'enter');
  sound(cue.send + 0.02, 'pop', { pitch: 1.5, gain: 0.6 });

  // 6 · file -------------------------------------------------------------
  cue.file = cue.send + 0.85;
  sound(cue.file - 0.05, 'whoosh');
  cue.fileHead = cue.file + 0.2;
  cue.doc = cue.file + 0.3;
  cue.wrote = cue.file + 0.75;
  sound(cue.wrote, 'bell', { gain: 0.55 });
  cue.docSections = [0.55, 0.75, 0.95, 1.15, 1.35].map((d) => cue.file + d);
  cue.docSections.forEach((at, i) => sound(at, 'tick', { gain: 0.6, pitch: 1 + i * 0.08 }));
  cue.fileOut = cue.file + 3.9;
  sound(cue.fileOut, 'whoosh');

  // 7 · end card -----------------------------------------------------------
  cue.end = cue.fileOut + 0.5;
  cue.endLetters = [];
  for (let i = 0; i < 'crbuddy'.length; i++) {
    const at = cue.end + 0.1 + i * 0.06;
    cue.endLetters.push(at);
    sound(at, 'key', { gain: 0.7 });
  }
  cue.confetti = cue.end + 0.55;
  sound(cue.confetti, 'chime');
  cue.endTag = cue.end + 0.7;
  cue.endRow = cue.end + 0.95;
  sound(cue.endRow, 'pop', { pitch: 1.2, gain: 0.6 });
  cue.endFine = cue.end + 1.2;

  const duration = cue.end + 4.2;

  ops.sort((a, b) => a.t - b.t);
  sfx.sort((a, b) => a.t - b.t);

  return { ops, sfx, cue, duration };
}

/**
 * The status line's clock: real time until the fast-forward, then an eased
 * sprint to the last reviewer's finish.
 */
export function elapsedAt(cue, t) {
  if (t < cue.started) return 0;
  const lead = cue.ffStart - cue.started;
  if (t <= cue.ffStart) return t - cue.started;
  const p = clamp01((t - cue.ffStart) / (cue.ffEnd - cue.ffStart));
  const eased = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
  const last = Math.max(...LANES.map((lane) => lane.doneAt));
  return lead + (last + 0.5 - lead) * eased;
}

function timeAtElapsed(cue, seconds) {
  let lo = cue.ffStart;
  let hi = cue.ffEnd;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (elapsedAt(cue, mid) < seconds) lo = mid;
    else hi = mid;
  }
  return hi;
}
