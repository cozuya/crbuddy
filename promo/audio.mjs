// Sound effects, synthesized sample by sample and written straight to a WAV.
// No music: every sound is a cue from timeline.js.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimeline, rng } from './timeline.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const SR = 48000;
const { sfx, duration } = buildTimeline();
const N = Math.ceil((duration + 0.5) * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);
const random = rng(1234);
const noise = () => random() * 2 - 1;

function place(t, buffer, gain = 1, pan = 0) {
  const start = Math.round(t * SR);
  const angle = ((pan + 1) * Math.PI) / 4;
  const gl = gain * Math.cos(angle) * Math.SQRT2;
  const gr = gain * Math.sin(angle) * Math.SQRT2;
  for (let i = 0; i < buffer.length; i++) {
    const j = start + i;
    if (j < 0 || j >= N) continue;
    L[j] += buffer[i] * gl;
    R[j] += buffer[i] * gr;
  }
}

/** RBJ biquad. Coefficients can be retuned per sample for sweeps. */
function biquad() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  return {
    set(type, freq, q) {
      const w = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
      const alpha = Math.sin(w) / (2 * q);
      const cos = Math.cos(w);
      const a0 = 1 + alpha;
      if (type === 'lp') {
        b0 = (1 - cos) / 2 / a0; b1 = (1 - cos) / a0; b2 = b0;
      } else if (type === 'hp') {
        b0 = (1 + cos) / 2 / a0; b1 = -(1 + cos) / a0; b2 = b0;
      } else {
        b0 = alpha / a0; b1 = 0; b2 = -alpha / a0;
      }
      a1 = (-2 * cos) / a0;
      a2 = (1 - alpha) / a0;
      return this;
    },
    run(x) {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    },
  };
}

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * SR));

// --- voices ----------------------------------------------------------------

function key(heavy = false) {
  const out = buffer(heavy ? 0.09 : 0.06);
  const hp = biquad().set('hp', 2500, 0.7);
  const bp = biquad().set('bp', 1100 + random() * 900, 1.2);
  const thock = (heavy ? 105 : 150) + random() * 70;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = noise();
    const click = hp.run(n) * Math.exp(-t / 0.0014);
    const body = bp.run(n) * Math.exp(-t / (heavy ? 0.01 : 0.006)) * 1.6;
    const low = Math.sin(2 * Math.PI * thock * t) * Math.exp(-t / (heavy ? 0.018 : 0.01)) * 0.7;
    out[i] = click + body + low;
    if (heavy && t > 0.045) out[i] += hp.run(noise()) * Math.exp(-(t - 0.045) / 0.0012) * 0.5;
  }
  return out;
}

function sweepTone(f0, f1, length, decay, attack = 0.003) {
  const out = buffer(length);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = f0 * (f1 / f0) ** Math.min(1, t / length);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * Math.min(1, t / attack) * Math.exp(-t / decay);
  }
  return out;
}

function pop(pitch = 1) {
  const out = sweepTone(480 * pitch, 900 * pitch, 0.14, 0.045);
  for (let i = 0; i < 200; i++) out[i] += noise() * Math.exp(-i / 60) * 0.25;
  return out;
}

function bellVoice(f0, length, partials) {
  const out = buffer(length);
  for (const [ratio, amp, decay] of partials) {
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      out[i] += Math.sin(2 * Math.PI * f0 * ratio * t) * amp * Math.min(1, t / 0.002) * Math.exp(-t / decay);
    }
  }
  return out;
}

const bell = () => bellVoice(1318.5, 1.6, [[1, 1, 0.55], [2, 0.3, 0.3], [2.76, 0.22, 0.2], [5.4, 0.08, 0.08]]);
const ding = (pitch = 1) => bellVoice(1760 * pitch, 0.6, [[1, 1, 0.16], [1.5, 0.35, 0.1], [3, 0.12, 0.05]]);

function tick(pitch = 1) {
  return sweepTone(2300 * pitch, 2100 * pitch, 0.04, 0.009, 0.0008);
}

function noiseSweep(length, f0, f1, q, shape = 1.5) {
  const out = buffer(length);
  const bp = biquad();
  for (let i = 0; i < out.length; i++) {
    const p = i / out.length;
    bp.set('bp', f0 * (f1 / f0) ** p, q);
    out[i] = bp.run(noise()) * Math.sin(Math.PI * p) ** shape * 2.2;
  }
  return out;
}

function copy() {
  const out = buffer(0.3);
  const a = sweepTone(1046.5, 1046.5, 0.12, 0.035, 0.002);
  const b = sweepTone(1568, 1568, 0.2, 0.06, 0.002);
  const offset = Math.round(0.075 * SR);
  a.forEach((v, i) => { out[i] += v; });
  b.forEach((v, i) => { if (i + offset < out.length) out[i + offset] += v; });
  return out;
}

function paste() {
  const out = buffer(0.25);
  const thup = sweepTone(260, 120, 0.12, 0.06, 0.002);
  const swish = noiseSweep(0.16, 900, 3200, 1.1, 1);
  thup.forEach((v, i) => { out[i] += v; });
  swish.forEach((v, i) => { out[i] += v * 0.5; });
  return out;
}

/** The clock racing: a rising filtered hiss and ticks that speed up. */
function whir(length) {
  const out = buffer(length + 0.3);
  const lp = biquad();
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const p = Math.min(1, t / length);
    const env = Math.min(1, t / 0.35) * Math.min(1, Math.max(0, (length + 0.3 - t) / 0.5));
    lp.set('lp', 300 * (3500 / 300) ** p, 0.8);
    phase += (2 * Math.PI * (160 * 4 ** p)) / SR;
    out[i] = (lp.run(noise()) * 0.8 + Math.sin(phase) * 0.12) * env;
  }
  // Ticks from 4 to 28 a second.
  let t = 0;
  while (t < length) {
    const rate = 4 + 24 * (t / length) ** 1.5;
    const click = tick(0.8);
    const start = Math.round(t * SR);
    click.forEach((v, i) => { if (start + i < out.length) out[start + i] += v * 0.35; });
    t += 1 / rate;
  }
  return out;
}

function chime() {
  const out = buffer(2.2);
  [1046.5, 1318.5, 1568, 2093].forEach((f, n) => {
    const note = bellVoice(f, 1.6, [[1, 1, 0.6], [2, 0.2, 0.25], [3, 0.06, 0.1]]);
    const start = Math.round(n * 0.075 * SR);
    note.forEach((v, i) => { if (start + i < out.length) out[start + i] += v * 0.8; });
  });
  return out;
}

// --- mix -----------------------------------------------------------------------

const VOICES = {
  key: (cue) => [key(), 0.42, -0.3 + random() * 0.2],
  enter: () => [key(true), 0.55, -0.25],
  pop: (cue) => [pop(cue.pitch), 0.34, 0.25],
  tick: (cue) => [tick(cue.pitch), 0.22, 0],
  ding: (cue) => [ding(cue.pitch), 0.16, 0.3],
  bell: () => [bell(), 0.3, -0.1],
  copy: () => [copy(), 0.28, 0],
  paste: () => [paste(), 0.4, 0.3],
  whoosh: () => [noiseSweep(0.5, 280, 2800, 0.9), 0.3, 0],
  swipe: () => [noiseSweep(0.3, 700, 4200, 1.0), 0.2, 0.3],
  whir: (cue) => [whir(cue.dur), 0.13, 0],
  chime: () => [chime(), 0.16, 0],
};

for (const cue of sfx) {
  const [voice, gain, pan] = VOICES[cue.kind](cue);
  place(cue.t, voice, gain * (cue.gain ?? 1), pan);
}

let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.1);
  R[i] = Math.tanh(R[i] * 1.1);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const scale = peak > 0 ? 0.78 / peak : 0;

const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * scale)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * scale)) * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

mkdirSync(path.join(root, 'out'), { recursive: true });
const file = path.join(root, 'out', 'audio.wav');
writeFileSync(file, Buffer.concat([header, data]));
console.log(`${file}  ${sfx.length} cues, ${(N / SR).toFixed(2)}s`);
