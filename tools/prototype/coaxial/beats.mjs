// Prototype helper: write what the Python scripts in this folder need.
//
//   node tools/prototype/coaxial/beats.mjs wav <file.wav> <prefix> [bph] [startSeconds] [endSeconds]
//     runs the app's whole-recording analysis in co-axial mode on the file's first channel and
//     writes <prefix>.beats.json: the timestamp of every tick and tock
//
//   node tools/prototype/coaxial/beats.mjs sim <coaxial|lever> <prefix> ['<json overrides>']
//     makes a simulated watch with known truth (tests/helpers/balance.js) and writes
//     <prefix>.wav, <prefix>.truth.json and <prefix>.beats.json. In the overrides,
//     "amplitudeSwing": {"base": 285, "swing": 10, "period": 23} makes the amplitude wander.

import { writeFileSync } from 'node:fs';
import { readWav } from '../../../tests/helpers/wav.js';
import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from '../../../tests/helpers/balance.js';
import { analyze } from '../../../js/dsp/offline.js';
import { encodeWav } from '../../../js/audio/wav.js';

/**
 * @param {Float32Array} channel
 * @param {number} sampleRate
 * @param {{bph?: number, startSeconds?: number, endSeconds?: number}} options
 */
function beatsOf(channel, sampleRate, options) {
  const coaxial = analyze([channel], sampleRate, { ...options, escapement: 'coaxial' });
  const lever = analyze([channel], sampleRate, options);
  return {
    sampleRate,
    envelopeRate: coaxial.envelopeRate,
    bph: coaxial.bph,
    rate: coaxial.rate,
    rateSd: coaxial.rateSd,
    irregular: coaxial.irregular,
    leverBeatErrorMs: lever.beatErrorMs,
    leverDetail: lever.beatErrorDetail,
    beats: coaxial.beats.map((b) => ({ type: b.type, K: b.K, t: Array.from(b.t), n: Array.from(b.n), ok: Array.from(b.ok) })),
  };
}

/** @param {number|null} v @param {number} digits */
const show = (v, digits) => (v === null ? 'none' : v.toFixed(digits));

const [mode, ...args] = process.argv.slice(2);
if (mode === 'wav' && args.length >= 2) {
  const [path, prefix, bph, start, end] = args;
  const wav = readWav(path);
  const result = beatsOf(wav.channels[0], wav.sampleRate, {
    bph: bph ? Number(bph) : undefined,
    startSeconds: start ? Number(start) : 0,
    endSeconds: end ? Number(end) : undefined,
  });
  writeFileSync(`${prefix}.beats.json`, JSON.stringify(result));
  console.log(`${path}: ${result.bph} vph, rate ${show(result.rate, 2)} s/day, Swiss-lever beat error ${show(result.leverBeatErrorMs, 3)} ms, ` +
    `beats timed ${result.beats.map((b) => `${b.ok.reduce((s, v) => s + v, 0)} (averaged over ${b.K})`).join(' and ')}`);
} else if (mode === 'sim' && args.length >= 2) {
  const [kind, prefix, json] = args;
  const over = json ? JSON.parse(json) : {};
  if (over.amplitudeSwing) {
    const { base, swing, period } = over.amplitudeSwing;
    over.amplitude = (/** @type {number} */ t) => base + swing * Math.sin((2 * Math.PI * t) / period);
    delete over.amplitudeSwing;
  }
  const options = kind === 'lever' ? leverWatch(over) : coaxialWatch(over);
  const watch = synthesizeBalanceWatch(options);
  writeFileSync(`${prefix}.wav`, Buffer.from(encodeWav(watch.channels, watch.sampleRate)));
  const { unlockGapMs, lockGapMs, liftMs, meanAmplitude } = watch.truth;
  writeFileSync(`${prefix}.truth.json`, JSON.stringify({ unlockGapMs, lockGapMs, liftMs, meanAmplitude, bph: options.bph, rate: options.rate }));
  const result = beatsOf(watch.channels[0], watch.sampleRate, {});
  writeFileSync(`${prefix}.beats.json`, JSON.stringify(result));
  console.log(`${prefix}: true beat error ${Math.abs(unlockGapMs).toFixed(3)} ms, true amplitude ${meanAmplitude.toFixed(1)}, ` +
    `unlock to lock ${liftMs.map((v) => v.toFixed(3)).join(' and ')} ms; the app reads ${result.bph} vph, ${show(result.rate, 2)} s/day, ` +
    `Swiss-lever beat error ${show(result.leverBeatErrorMs, 3)} ms`);
} else {
  console.error('usage: beats.mjs wav <file.wav> <prefix> [bph] [start] [end]\n       beats.mjs sim <coaxial|lever> <prefix> [json overrides]');
  process.exit(1);
}
