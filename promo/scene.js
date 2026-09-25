// Every frame is a pure function of time: render(t) sets every element from
// t alone, with no CSS animations or timers, so frames can be rendered in
// any order and in parallel.

import {
  buildTimeline,
  clamp01,
  elapsedAt,
  formatElapsed,
  rng,
  CLACK_SPINNER,
  FINDINGS,
  LANES,
  REPORT,
  REVIEWED_RANGE,
  SPINNER,
} from './timeline.js';

const TL = buildTimeline();
const { cue } = TL;
export const DURATION = TL.duration;

// --- easing --------------------------------------------------------------

const E = {
  outCubic: (p) => 1 - (1 - p) ** 3,
  inCubic: (p) => p ** 3,
  inOutCubic: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  outExpo: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  outBack: (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2,
  outBackBig: (p) => 1 + 3.6 * (p - 1) ** 3 + 2.6 * (p - 1) ** 2,
};
const prog = (t, start, dur) => clamp01((t - start) / dur);

function tf(el, { x = 0, y = 0, s = 1, r = 0, o = 1 }) {
  if (o <= 0.001) {
    el.style.visibility = 'hidden';
    return;
  }
  // Empty, not 'visible': children must still inherit a hidden parent.
  el.style.visibility = '';
  el.style.opacity = o >= 0.999 ? '1' : o.toFixed(3);
  el.style.transform =
    `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(4)}) rotate(${r.toFixed(2)}deg)`;
}

/** Enter with overshoot at tIn; slide away at tOut. */
function inOut(el, t, tIn, tOut, o = {}) {
  const {
    dx = 0, dy = 40, s0 = 0.92, dur = 0.55, ease = E.outBack,
    outDur = 0.35, outDx = 0, outDy = -30, outS = 0.97, r = 0,
  } = o;

  if (t < tIn || (tOut != null && t >= tOut + outDur)) return tf(el, { o: 0 });

  const a = ease(prog(t, tIn, dur));
  let x = dx * (1 - a);
  let y = dy * (1 - a);
  let s = s0 + (1 - s0) * a;
  let op = clamp01((t - tIn) / (dur * 0.35));

  if (tOut != null && t >= tOut) {
    const b = E.inCubic(prog(t, tOut, outDur));
    x += outDx * b;
    y += outDy * b;
    s *= 1 + (outS - 1) * b;
    op *= 1 - b;
  }

  tf(el, { x, y, s, r, o: op });
}

// --- markup ----------------------------------------------------------------

const ICON_PATHS = {
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  clipboard:
    '<path d="M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1z"/>' +
    '<path d="M16 5h1.5A1.5 1.5 0 0 1 19 6.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-13A1.5 1.5 0 0 1 6.5 5H8"/>' +
    '<path d="M9 12h6M9 16h4"/>',
  file:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  ff: '<path d="M3 6l8 6-8 6zM12 6l8 6-8 6z" fill="currentColor" stroke="none"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  eyeoff:
    '<path d="M3 3l18 18"/>' +
    '<path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 5 9 7a9.6 9.6 0 0 1-2.4 3.4M6.6 6.6C4.3 8 3 10.4 3 12c0 2 4 7 9 7a9.7 9.7 0 0 0 4.4-1.1"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
};

const icon = (name, width = 2.2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" ` +
  `stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DIFF = [
  ['', ' function refresh(token) {'],
  ['del', '-  return fetch(API)'],
  ['add', '+  if (!token) return null'],
  ['add', '+  return fetch(API, { token })'],
  ['', ' }'],
];
const GHOST_WIDTHS = ['62%', '48%', '58%', '80%', '12%'];

const diffBlock = (ghost) =>
  `<div class="diff${ghost ? ' ghost' : ''}">` +
  DIFF.map(([kind, text], i) =>
    `<div class="dl ${kind}" style="--w:${GHOST_WIDTHS[i]}">${esc(text)}</div>`).join('') +
  (ghost ? '<div class="scan"></div>' : '') +
  '</div>';

const letters = (word) => [...word].map((ch) => `<span class="ch">${ch}</span>`).join('');

const TERM_X = 100;
const TERM_Y = 190;
const TERM_W = 1040;
const TERM_H = 700;
const TERM_ROWS = 24;
const TERM_COLS = 86;
const ROW_H = 25;
const BODY_TOP = TERM_Y + 46 + 22;
const CHAR_W = 19 * 0.6;
const AGENT_TOP = 420;

const reviewers = [
  { name: 'Codex CLI', color: 't', findings: '2 findings' },
  { name: 'Gemini CLI', color: 'a', findings: '1 finding' },
];

const laneColors = ['v', 't', 'a'];

function markup() {
  return `
  <div id="bg"></div>
  <canvas id="under" class="fx" width="1920" height="1080"></canvas>
  <div id="decor"></div>

  <svg width="0" height="0" style="position:absolute">
    <defs><linearGradient id="squiggle-grad" x1="0" x2="1">
      <stop offset="0" stop-color="#6a45ff"/><stop offset="1" stop-color="#e0469b"/>
    </linearGradient></defs>
  </svg>

  <!-- 1 · title -->
  <div id="wm1" class="wordmark" style="top:300px;font-size:236px">${letters('crbuddy')}<span class="cur"></span></div>
  <div id="tag1" class="abs sub" style="left:0;width:1920px;top:640px;text-align:center;font-size:52px;font-weight:600">
    Independent <em>multi-model</em> code review.
  </div>

  <!-- 2 · idea -->
  <div id="h2a" class="abs display" style="left:0;width:1920px;top:150px;text-align:center;font-size:90px">One model wrote it.</div>
  <div id="h2b" class="abs display" style="left:0;width:1920px;top:254px;text-align:center;font-size:90px">
    Let the others <span style="position:relative;display:inline-block"><em>review it.</em>
    <svg id="sq2" class="squiggle" viewBox="0 0 300 30" preserveAspectRatio="none" style="left:0;bottom:-26px;width:100%;height:26px">
      <path pathLength="1" d="M4 18 C 30 4, 50 4, 75 16 S 120 28, 150 15 S 200 2, 225 15 S 270 26, 296 12"/>
    </svg></span>
  </div>
  <div id="cA" class="card" style="left:205px;top:505px;width:470px">
    <div class="card-h"><div class="ico v">${icon('pencil')}</div>
      <div><div class="card-t">Claude Code</div><div class="card-s">wrote the change</div></div></div>
    ${diffBlock(false)}
  </div>
  ${reviewers.map((rev, i) => `
  <div id="cR${i}" class="card" style="left:${725 + i * 520}px;top:505px;width:470px">
    <div class="card-h"><div class="ico ${rev.color}">${icon('search')}</div>
      <div><div class="card-t">${rev.name}</div><div class="card-s" id="cRs${i}">reviewing</div></div></div>
    ${diffBlock(true)}
    <div class="find" id="cRf${i}">${icon('flag')}${rev.findings}</div>
  </div>`).join('')}

  <!-- terminal, shared by the setup, run and clipboard scenes -->
  <div id="term" class="term" style="left:${TERM_X}px;top:${TERM_Y}px;width:${TERM_W}px;height:${TERM_H}px">
    <div class="term-bar"><i></i><i></i><i></i>
      <div class="term-title">~/my-app</div>
      <div id="bellmark" class="bellmark">${icon('bell', 2.4)}</div>
      <div id="ff" class="ff">${icon('ff')}<span>12 minutes, sped up</span></div>
    </div>
    <div id="tbody" class="term-body"></div>
  </div>

  <!-- 3 · setup, right column -->
  <div id="s3h" class="right display" style="top:292px">Uses the CLIs<br><em>you already have.</em></div>
  <div id="s3p" class="right sub" style="top:450px">No API keys. No hosted service.</div>
  ${['Claude Code', 'Codex CLI', 'Gemini CLI'].map((name, i) => `
  <div id="b${i}" class="badge abs" style="left:${1190 + [0, 232, 450][i]}px;top:530px">
    <span class="ok">${icon('check', 3)}</span>${name}</div>`).join('')}

  <!-- 4 · run, right column -->
  <div id="s4h" class="right display" style="top:236px">In parallel.<br><em>Blind</em> to each other.</div>
  ${LANES.map((lane, i) => `
  <div id="lane${i}" class="lane" style="left:1190px;top:${412 + i * 122}px">
    <div class="ico ${laneColors[i]} mono">&gt;_</div>
    <div class="lane-m"><div class="lane-t">${lane.vendor}</div>
      <div class="lane-c">${lane.model}${lane.effort ? ` · ${lane.effort}` : ''}</div></div>
    <div class="lane-s">
      <svg id="lspin${i}" class="spin" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none"
        stroke="#e6e1f5" stroke-width="4"/><circle cx="18" cy="18" r="14" fill="none" stroke="#6a45ff"
        stroke-width="4" stroke-linecap="round" stroke-dasharray="26 88"/></svg>
      <div id="lok${i}" class="okbig">${icon('check', 3)}</div>
      <span id="ltime${i}"></span>
    </div>
  </div>`).join('')}
  <div id="blind" class="blind abs" style="left:1196px;top:792px">${icon('eyeoff')}No reviewer sees another's output, even same vendor.</div>

  <!-- 5 · clipboard, right column -->
  <div id="s5h" class="right display" style="top:236px">Back to your <em>agent</em><br>in one handoff.</div>
  <div id="agent" class="agent" style="left:1190px;top:${AGENT_TOP}px">
    <div class="agent-h"><span class="dot"></span>your coding agent</div>
    <div class="agent-in">
      <div id="ph" class="ph">Ask your agent anything…</div>
      <div id="pasted" class="pasted">${icon('clipboard')}Pasted text · ${REPORT.length} lines</div>
      <div id="preview" class="preview">${esc(REPORT.slice(0, 1).concat(REPORT.slice(5, 6), REPORT.slice(11, 12)).join('\n'))}</div>
      <div class="typed"><span id="typed"></span><span id="caret" class="caret"></span></div>
      <div id="send" class="send">${icon('up', 2.8)}</div>
    </div>
  </div>
  <div id="keys" class="keys" style="left:1398px;top:${AGENT_TOP + 330}px"><div class="key">Ctrl</div><div class="plus">+</div><div class="key">V</div></div>
  <div id="fly" class="flychip">${icon('clipboard')}Code review · 3 reviews</div>

  <!-- 6 · file -->
  <div id="s6h" class="abs display" style="left:136px;top:270px;font-size:80px;width:780px">One handoff.<br>Every review,<br><em>verbatim.</em></div>
  <div id="s6p" class="abs sub" style="left:140px;top:548px;font-size:29px;width:700px">
    Copy to clipboard or write to one markdown file for the agent or human making the fixes.</div>
  <div id="wrote" class="wrote" style="left:140px;top:668px"><span class="s-p">$</span> crb go <span class="s-d">…</span>
<span id="wroteLine">Wrote CODE-REVIEW-HANDOFF.md.</span></div>
  <div id="doc" class="doc" style="left:960px;top:118px">
    <div class="doc-h">${icon('file')}CODE-REVIEW-HANDOFF.md</div>
    <div class="doc-b">
      <div id="d0" class="md-h1">Code review</div>
      <div id="d1" class="md-p"><b>3 of 3 reviews completed.</b><br>
        Reviewed <code>${REVIEWED_RANGE}</code> - 35 file(s) changed.</div>
      ${[
        ['claude-opus - claude / opus, effort max', FINDINGS.claude],
        ['codex-gpt-6-sol - codex / gpt-6-sol, effort xhigh', FINDINGS.codex],
        ['security - gemini / gemini-3.1-pro-preview', FINDINGS.security],
      ].map(([heading, items], i) => `
      <div id="d${i + 2}" class="md-sec"><div class="md-h2">${heading}</div>
        ${items.map((item) => `<div class="md-li">${esc(item)}</div>`).join('')}</div>`).join('')}
    </div>
  </div>

  <!-- 7 · end card -->
  <div id="wm2" class="wordmark" style="top:238px;font-size:200px">${letters('crbuddy')}<span class="cur"></span></div>
  <div id="tag2" class="abs sub" style="left:0;width:1920px;top:520px;text-align:center;font-size:46px;font-weight:600">
    Independent <em>multi-model</em> code review.</div>
  <div id="row2" class="abs" style="left:0;width:1920px;top:640px;display:flex;justify-content:center;gap:24px">
    <div class="cmd"><span class="s-p">$</span>npm i -g crbuddy</div>
    <div class="url">github.com/cozuya/crbuddy</div>
  </div>
  <div id="fine2" class="abs fine" style="left:0;width:1920px;top:790px;text-align:center">
    Free &amp; open source · works with Claude Code, Codex CLI and Gemini CLI</div>

  <canvas id="over" class="fx" width="1920" height="1080"></canvas>
  `;
}

// --- setup -----------------------------------------------------------------

const $ = (id) => document.getElementById(id);
let els;
let wordmarks;
let decor;

function build(stage) {
  stage.innerHTML = markup();

  els = {};
  for (const node of stage.querySelectorAll('[id]')) els[node.id] = node;

  // Centre the wordmarks once the display font has real metrics.
  wordmarks = ['wm1', 'wm2'].map((id) => {
    const el = els[id];
    el.style.left = `${(1920 - el.offsetWidth) / 2}px`;
    const chars = [...el.querySelectorAll('.ch')];
    return {
      el,
      chars,
      cursor: el.querySelector('.cur'),
      ends: chars.map((ch) => ch.offsetLeft + ch.offsetWidth),
    };
  });

  const random = rng(42);
  const stripes = ['#22b573', '#e6465a', '#6a45ff', '#22b573', '#f0a020'];
  decor = [];
  for (let i = 0; i < 22; i++) {
    const node = document.createElement('div');
    node.className = 'chip-deco';
    const bars = 1 + Math.floor(random() * 2);
    node.innerHTML = Array.from({ length: bars }, () =>
      `<b style="width:${30 + Math.floor(random() * 70)}px"></b>`).join('');
    node.style.setProperty('--stripe', stripes[i % stripes.length]);
    els.decor.appendChild(node);
    decor.push({
      node,
      x: random() * 1920,
      y: random() * 1180,
      speed: 14 + random() * 22,
      sway: 10 + random() * 26,
      phase: random() * Math.PI * 2,
      scale: 0.75 + random() * 0.5,
      rot: (random() - 0.5) * 10,
      alpha: 0.3 + random() * 0.35,
    });
  }
}

// --- background ------------------------------------------------------------

function background(t) {
  const blob = (cx, cy, rx, ry, color, fx, fy, phase) => {
    const x = cx + Math.sin(t * fx + phase) * 140;
    const y = cy + Math.cos(t * fy + phase) * 90;
    return `radial-gradient(${rx}px ${ry}px at ${x.toFixed(1)}px ${y.toFixed(1)}px, ${color}, transparent 72%)`;
  };

  els.bg.style.background = [
    blob(380, 260, 900, 700, 'rgba(255, 186, 222, 0.85)', 0.23, 0.19, 0),
    blob(1560, 240, 1000, 760, 'rgba(176, 208, 255, 0.9)', 0.17, 0.21, 1.3),
    blob(1420, 900, 900, 700, 'rgba(186, 244, 222, 0.8)', 0.21, 0.15, 2.6),
    blob(360, 920, 900, 720, 'rgba(255, 218, 178, 0.75)', 0.15, 0.23, 4.1),
    blob(960, 540, 700, 500, 'rgba(214, 196, 255, 0.7)', 0.19, 0.17, 5.2),
    'linear-gradient(135deg, #e9e2ff, #f4e9ff 50%, #e3ecff)',
  ].join(', ');

  for (const d of decor) {
    const y = ((d.y - t * d.speed) % 1180 + 1180) % 1180 - 60;
    const x = d.x + Math.sin(t * 0.6 + d.phase) * d.sway;
    d.node.style.opacity = d.alpha.toFixed(3);
    d.node.style.transform =
      `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${d.scale.toFixed(3)}) rotate(${d.rot.toFixed(2)}deg)`;
  }
}

/** Speed streaks behind everything while the clock fast-forwards. */
function streaks(t) {
  const ctx = els.under.getContext('2d');
  ctx.clearRect(0, 0, 1920, 1080);

  const p = prog(t, cue.ffStart - 0.2, cue.ffEnd - cue.ffStart + 0.5);
  if (p <= 0 || p >= 1) return;

  const strength = Math.sin(Math.PI * p) ** 0.7;
  const random = rng(7);
  for (let i = 0; i < 70; i++) {
    const y = random() * 1080;
    const len = 120 + random() * 380;
    const speed = 2600 + random() * 3200;
    const x = 1920 + len - ((t * speed + random() * 4000) % (1920 + len * 2 + 400));
    const grad = ctx.createLinearGradient(x, 0, x + len, 0);
    const a = (0.25 + random() * 0.45) * strength;
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, len, 2 + random() * 3);
  }
}

// --- 1 · title -------------------------------------------------------------

function wordmark(w, t, times, tOut) {
  const out = tOut == null ? 0 : E.inCubic(prog(t, tOut, 0.35));

  let shown = 0;
  w.chars.forEach((ch, i) => {
    const p = prog(t, times[i], 0.45);
    if (t >= times[i]) shown = i + 1;
    if (t < times[i]) return tf(ch, { o: 0 });
    const a = E.outBackBig(p);
    tf(ch, { y: (1 - a) * 40 - out * 60, s: 0.4 + 0.6 * a, o: clamp01(p * 3) * (1 - out) });
  });

  const typingDone = times.at(-1) + 0.35;
  const blinkOn = t < typingDone || Math.floor((t - typingDone) / 0.53) % 2 === 0;
  const x = shown === 0 ? 0 : w.ends[shown - 1] + 10;
  const o = t < times[0] - 0.08 ? 0 : (blinkOn ? 1 : 0) * (1 - out);
  w.cursor.style.left = `${x}px`;
  tf(w.cursor, { y: -out * 60, o });
}

function title(t) {
  wordmark(wordmarks[0], t, cue.wordmark, cue.titleOut);
  inOut(els.tag1, t, cue.tagline, cue.titleOut + 0.05, { dy: 30, outDy: -60 });
}

// --- 2 · idea --------------------------------------------------------------

function idea(t) {
  const out = cue.ideaOut;
  inOut(els.h2a, t, cue.ideaH1, out, { dy: 50 });
  inOut(els.h2b, t, cue.ideaH2, out + 0.04, { dy: 50 });

  const sq = els.sq2.querySelector('path');
  sq.style.strokeDasharray = '1';
  sq.style.strokeDashoffset = (1 - E.outCubic(prog(t, cue.ideaH2 + 0.35, 0.55))).toFixed(4);

  inOut(els.cA, t, cue.author, out + 0.02, { dy: 90, s0: 0.8, dur: 0.65, outDy: 80 });
  els.cA.querySelectorAll('.dl').forEach((line, i) => {
    const p = prog(t, cue.diffLines[i], 0.25);
    line.style.opacity = p.toFixed(3);
    line.style.transform = `translateX(${((1 - E.outCubic(p)) * -16).toFixed(2)}px)`;
  });

  reviewers.forEach((_, i) => {
    const card = els[`cR${i}`];
    inOut(card, t, cue.reviewers[i], out + 0.06 + i * 0.04, { dy: 90, s0: 0.8, dur: 0.65, outDy: 80 });

    const found = t >= cue.findings[i];
    const scan = card.querySelector('.scan');
    const sweep = ((t - cue.reviewers[i]) * 0.9 + i * 0.4) % 1;
    scan.style.top = `${(-34 + sweep * 190).toFixed(1)}px`;
    scan.style.opacity = found ? '0' : '1';

    const status = els[`cRs${i}`];
    const dots = '.'.repeat(Math.floor(Math.max(0, t - cue.reviewers[i]) / 0.3) % 4);
    status.textContent = found ? 'reviewed' : `reviewing${dots}`;

    const fp = prog(t, cue.findings[i], 0.45);
    if (t < cue.findings[i]) tf(els[`cRf${i}`], { o: 0 });
    else tf(els[`cRf${i}`], { s: 0.5 + 0.5 * E.outBackBig(fp), o: clamp01(fp * 3) });
  });
}

// --- terminal --------------------------------------------------------------

function terminalLines(t) {
  const lines = [];
  const lastPrompt = () => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].prompt) return lines[i];
    return null;
  };

  for (const op of TL.ops) {
    if (op.t > t) break;
    switch (op.kind) {
      case 'clear':
        lines.length = 0;
        break;
      case 'prompt':
        lines.push({ prompt: true, spans: [['p', '$ ']], typing: null, entered: false });
        break;
      case 'type':
        lastPrompt().typing = op;
        break;
      case 'enter':
        lastPrompt().entered = true;
        break;
      case 'print': {
        const line = { id: op.id, spans: op.spans, dyn: op.dyn, label: op.label, t0: op.t };
        const at = op.before ? lines.findIndex((l) => l.id === op.before) : -1;
        if (at >= 0) lines.splice(at, 0, line);
        else lines.push(line);
        break;
      }
      case 'set': {
        const line = lines.find((l) => l.id === op.id);
        if (line) {
          line.spans = op.spans;
          line.dyn = null;
        }
        break;
      }
      case 'remove': {
        const at = lines.findIndex((l) => l.id === op.id);
        if (at >= 0) lines.splice(at, 1);
        break;
      }
    }
  }

  return lines;
}

function statusText(t) {
  const frame = SPINNER[Math.floor(t * 10) % SPINNER.length];
  const active = LANES.filter((_, i) => t < cue.laneDone[i]).map((lane) => lane.display);
  const waiting = active.length === 0 ? 'finishing up' : `waiting on ${active.join(', ')}`;
  const text = `${frame} ${formatElapsed(elapsedAt(cue, t))} - ${waiting}`;
  // progress.ts truncates rather than wraps.
  return text.length > TERM_COLS - 1 ? `${text.slice(0, TERM_COLS - 2)}…` : text;
}

function lineSpans(line, t) {
  if (line.dyn === 'status') return [['d', statusText(t)]];
  if (line.dyn === 'clack-spinner') {
    const age = t - line.t0;
    const frame = CLACK_SPINNER[Math.floor(age / 0.08) % CLACK_SPINNER.length];
    return [['m', frame], ['', `  ${line.label}${'.'.repeat(Math.floor(age / 0.25) % 4)}`]];
  }
  if (!line.prompt) return line.spans;

  const spans = [...line.spans];
  if (line.typing) {
    const count = line.typing.times.filter((at) => at <= t).length;
    spans.push(['', line.typing.text.slice(0, count)]);
  }
  return spans;
}

/** Split a styled line into terminal rows, wrapping at the column limit. */
function wrap(spans) {
  const rows = [[]];
  let col = 0;
  for (const [style, text] of spans) {
    let rest = text;
    while (rest.length > 0) {
      if (col === TERM_COLS) {
        rows.push([]);
        col = 0;
      }
      const take = rest.slice(0, TERM_COLS - col);
      rows.at(-1).push([style, take]);
      col += take.length;
      rest = rest.slice(take.length);
    }
  }
  return rows;
}

const spanHtml = ([style, text]) =>
  style ? `<span class="s-${style}">${esc(text)}</span>` : esc(text);

function terminal(t) {
  inOut(els.term, t, cue.setup, cue.file, {
    dx: -160, dy: 0, s0: 0.94, dur: 0.7, outDx: -260, outDy: 0, outDur: 0.45,
  });
  if (t < cue.setup || t > cue.file + 0.5) return null;

  const lines = terminalLines(t);
  const rows = [];
  lines.forEach((line, index) => {
    const wrapped = wrap(lineSpans(line, t));
    wrapped.forEach((row) => rows.push({ html: row.map(spanHtml).join(''), line, index }));
  });

  // The cursor sits after the text of an unfinished prompt line.
  const last = lines.at(-1);
  if (last?.prompt && !last.entered && rows.length > 0) {
    const typedAt = last.typing?.times.filter((at) => at <= t).at(-1);
    const typing = typedAt != null && t - typedAt < 0.45;
    const on = typing || Math.floor(t / 0.53) % 2 === 0;
    if (on) rows.at(-1).html += '<span class="cursor"></span>';
  }

  const visible = rows.slice(-TERM_ROWS);
  els.tbody.innerHTML = visible.map((row) => `<div class="row">${row.html || ' '}</div>`).join('');

  // Fast-forward badge and the bell.
  const ffIn = cue.ffStart - 0.1;
  const ffOut = cue.ffEnd + 0.15;
  if (t < ffIn || t > ffOut + 0.3) tf(els.ff, { o: 0 });
  else {
    const a = E.outBackBig(prog(t, ffIn, 0.4));
    const b = E.inCubic(prog(t, ffOut, 0.3));
    const pulse = 1 + 0.04 * Math.sin(t * 18);
    tf(els.ff, { s: (0.6 + 0.4 * a) * pulse * (1 - 0.3 * b), o: clamp01((t - ffIn) * 6) * (1 - b) });
  }

  const bellAge = t - cue.bell;
  if (bellAge < 0 || bellAge > 1.1) tf(els.bellmark, { o: 0 });
  else {
    const wiggle = Math.sin(bellAge * 38) * 22 * Math.exp(-bellAge * 4.5);
    tf(els.bellmark, { r: wiggle, s: 0.7 + 0.3 * E.outBackBig(prog(bellAge, 0, 0.3)), o: 1 - prog(bellAge, 0.8, 0.3) });
  }

  const copiedRow = visible.findIndex((row) => row.line.id === 'copied');
  return copiedRow >= 0 ? { x: TERM_X + 28 + 2 * CHAR_W, y: BODY_TOP + copiedRow * ROW_H } : null;
}

// --- 3 · setup, right column ------------------------------------------------

function setupRight(t) {
  inOut(els.s3h, t, cue.setupHead, cue.setupOut, { dx: 60, dy: 0 });
  inOut(els.s3p, t, cue.setupSub, cue.setupOut + 0.04, { dx: 60, dy: 0 });
  cue.badges.forEach((at, i) => {
    inOut(els[`b${i}`], t, at, cue.setupOut + 0.08 + i * 0.03, { dy: 26, s0: 0.4, ease: E.outBackBig, dur: 0.5 });
  });
}

// --- 4 · run, right column ----------------------------------------------------

function runRight(t) {
  const out = cue.clipScene;
  inOut(els.s4h, t, cue.runHead, out, { dx: 60, dy: 0 });

  LANES.forEach((lane, i) => {
    inOut(els[`lane${i}`], t, cue.laneStart[i], out + 0.04 + i * 0.04, { dx: 80, dy: 0, s0: 0.9 });

    const done = t >= cue.laneDone[i];
    const spinner = els[`lspin${i}`];
    spinner.style.display = done ? 'none' : 'block';
    spinner.style.transform = `rotate(${(t * 420) % 360}deg)`;

    const ok = els[`lok${i}`];
    ok.style.display = done ? 'grid' : 'none';
    if (done) {
      const p = prog(t, cue.laneDone[i], 0.4);
      ok.style.transform = `scale(${(0.3 + 0.7 * E.outBackBig(p)).toFixed(3)})`;
    }

    const shown = done ? lane.doneAt : Math.min(elapsedAt(cue, t), lane.doneAt);
    const time = els[`ltime${i}`];
    time.textContent = formatElapsed(shown);
    time.className = done ? 'done' : '';

    const glow = done ? Math.exp(-(t - cue.laneDone[i]) * 3) : 0;
    els[`lane${i}`].style.boxShadow =
      `0 20px 40px -22px rgba(50, 20, 120, 0.45), 0 0 0 ${(glow * 6).toFixed(2)}px rgba(34, 181, 115, ${(glow * 0.5).toFixed(3)})`;
  });

  inOut(els.blind, t, cue.laneStart.at(-1) + 0.35, out + 0.16, { dx: 40, dy: 0 });
}

// --- 5 · clipboard ----------------------------------------------------------------

function clipboard(t, copiedAt) {
  // After the lanes have fully left, so the two columns never overlap.
  const tIn = cue.clipScene + 0.5;
  inOut(els.s5h, t, tIn, cue.file, { dx: 60, dy: 0 });
  inOut(els.agent, t, tIn + 0.3, cue.file + 0.08, { dy: 50, s0: 0.9 });

  const pasted = t >= cue.paste;
  els.ph.style.display = pasted ? 'none' : 'block';
  if (!pasted) {
    tf(els.pasted, { o: 0 });
    tf(els.preview, { o: 0 });
    els.pasted.style.display = 'none';
    els.preview.style.display = 'none';
  } else {
    els.pasted.style.display = 'inline-flex';
    els.preview.style.display = 'block';
    const p = prog(t, cue.paste, 0.45);
    tf(els.pasted, { s: 0.6 + 0.4 * E.outBackBig(p), o: clamp01(p * 4) });
    tf(els.preview, { y: (1 - E.outCubic(prog(t, cue.paste + 0.08, 0.4))) * 12, o: prog(t, cue.paste + 0.08, 0.3) });
  }

  const count = cue.askTimes.filter((at) => at <= t).length;
  els.typed.textContent = cue.ask.slice(0, count);
  const lastKey = cue.askTimes.filter((at) => at <= t).at(-1);
  const caretOn = (lastKey != null && t - lastKey < 0.4) || Math.floor(t / 0.53) % 2 === 0;
  els.caret.style.opacity = caretOn && t < cue.send ? '1' : '0';

  const sendAge = t - cue.send;
  const pulse = sendAge >= 0 && sendAge < 0.5 ? 1 + 0.25 * Math.sin(Math.PI * sendAge / 0.5) : 1;
  els.send.style.transform = `scale(${pulse.toFixed(3)})`;
  els.send.style.background = sendAge >= 0 ? '#6a45ff' : '';

  // Ctrl+V: appear, press, release, leave.
  const kIn = cue.paste - 0.4;
  if (t < kIn || t > cue.paste + 0.9) tf(els.keys, { o: 0 });
  else {
    const a = E.outBackBig(prog(t, kIn, 0.3));
    const b = E.inCubic(prog(t, cue.paste + 0.55, 0.35));
    tf(els.keys, { y: (1 - a) * 30 - b * 20, s: 0.7 + 0.3 * a, o: clamp01((t - kIn) * 6) * (1 - b) });
  }
  const press = t >= cue.paste - 0.12 && t < cue.paste + 0.1;
  els.keys.querySelectorAll('.key').forEach((key) => {
    key.style.transform = press ? 'translateY(5px)' : 'none';
    key.style.boxShadow = press ? '0 1px 0 #d6cff0, 0 6px 14px -8px rgba(50,20,120,0.5)' : '';
  });

  // The copied report flies from the terminal into the agent's input.
  const start = copiedAt ?? { x: TERM_X + 28 + 2 * CHAR_W, y: BODY_TOP + (TERM_ROWS - 2) * ROW_H };
  if (t < cue.copied || t > cue.paste + 0.2) return tf(els.fly, { o: 0 });

  const pop = E.outBackBig(prog(t, cue.copied, 0.35));
  const travel = E.inOutCubic(prog(t, cue.copied + 0.4, cue.paste - cue.copied - 0.4));
  const end = { x: 1190 + 44, y: AGENT_TOP + 78 };
  const control = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 260 };
  const u = travel;
  const x = (1 - u) ** 2 * start.x + 2 * (1 - u) * u * control.x + u ** 2 * end.x;
  const y = (1 - u) ** 2 * (start.y - 70) + 2 * (1 - u) * u * control.y + u ** 2 * end.y;
  const shrink = 1 - 0.35 * E.inCubic(prog(t, cue.paste - 0.25, 0.25));
  const fade = 1 - prog(t, cue.paste, 0.2);
  tf(els.fly, { x, y, s: (0.5 + 0.5 * pop) * shrink, r: Math.sin(u * Math.PI) * -6, o: clamp01((t - cue.copied) * 8) * fade });
}

// --- 6 · file ----------------------------------------------------------------------

function file(t) {
  const out = cue.fileOut;
  inOut(els.s6h, t, cue.fileHead + 0.08, out + 0.03, { dy: 40 });
  inOut(els.s6p, t, cue.fileHead + 0.2, out + 0.06, { dy: 30 });
  inOut(els.wrote, t, cue.wrote - 0.3, out + 0.09, { dy: 30 });
  els.wroteLine.style.visibility = t >= cue.wrote ? 'visible' : 'hidden';

  inOut(els.doc, t, cue.doc, out + 0.05, { dx: 220, dy: 30, s0: 0.9, r: -1.5, dur: 0.7, outDx: 200, outDy: 0 });
  cue.docSections.forEach((at, i) => {
    const p = prog(t, at, 0.35);
    const el = els[`d${i}`];
    el.style.opacity = p.toFixed(3);
    el.style.transform = `translateY(${((1 - E.outCubic(p)) * 14).toFixed(2)}px)`;
  });
}

// --- 7 · end card -----------------------------------------------------------------

function endCard(t) {
  wordmark(wordmarks[1], t, cue.endLetters, null);
  inOut(els.tag2, t, cue.endTag, null, { dy: 30 });
  inOut(els.row2, t, cue.endRow, null, { dy: 40, s0: 0.85 });
  inOut(els.fine2, t, cue.endFine, null, { dy: 20 });
  confetti(t);
}

const CONFETTI = (() => {
  const random = rng(99);
  const colors = ['#6a45ff', '#e0469b', '#22b573', '#f0a020', '#19c2b0', '#ff7a59'];
  return Array.from({ length: 160 }, () => {
    const angle = -Math.PI / 2 + (random() - 0.5) * Math.PI * 1.25;
    const speed = 700 + random() * 1100;
    return {
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spin: (random() - 0.5) * 14,
      size: 9 + random() * 10,
      color: colors[Math.floor(random() * colors.length)],
      plus: random() < 0.3,
      delay: random() * 0.12,
      wobble: random() * Math.PI * 2,
    };
  });
})();

function confetti(t) {
  const ctx = els.over.getContext('2d');
  ctx.clearRect(0, 0, 1920, 1080);

  for (const c of CONFETTI) {
    const dt = t - cue.confetti - c.delay;
    if (dt < 0 || dt > 3.2) continue;

    const drag = 2.2;
    const k = (1 - Math.exp(-drag * dt)) / drag;
    const x = 960 + c.vx * k + Math.sin(dt * 5 + c.wobble) * 14;
    const y = 360 + c.vy * k + 380 * dt * dt;
    const alpha = 1 - clamp01((dt - 2.2) / 1.0);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(c.spin * dt);
    ctx.fillStyle = c.color;
    if (c.plus) {
      const s = c.size * 0.9;
      ctx.fillRect(-s / 2, -s / 6, s, s / 3);
      ctx.fillRect(-s / 6, -s / 2, s / 3, s);
    } else {
      ctx.scale(1, Math.abs(Math.cos(dt * 7 + c.wobble)) * 0.8 + 0.2);
      ctx.fillRect(-c.size / 2, -c.size / 4, c.size, c.size / 2);
    }
    ctx.restore();
  }
}

// --- entry points ----------------------------------------------------------------

export function render(t) {
  background(t);
  streaks(t);
  title(t);
  idea(t);
  const copiedAt = terminal(t);
  setupRight(t);
  runRight(t);
  clipboard(t, copiedAt);
  file(t);
  endCard(t);
}

export async function init(stage) {
  await document.fonts.load('800 100px Display');
  await document.fonts.load('500 20px Inter');
  await document.fonts.load('700 20px Inter');
  await document.fonts.load('400 20px Mono');
  await document.fonts.load('700 20px Mono');
  await document.fonts.load('400 20px MonoFallback');
  await document.fonts.ready;
  build(stage);
  render(0);
}
