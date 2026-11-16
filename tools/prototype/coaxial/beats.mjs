// Prototype helper: write what the Python scripts in this folder need.
//
//   node tools/prototype/coaxial/beats.mjs wav <file.wav> <prefix> [bph] [startSeconds] [endSeconds]
//     runs the app's whole-recording analysis in co-axial mode on the file's first channel and
//     writes <prefix>.beats.json: the timestamp of every tick and tock
//
//   node tools/prototype/coaxial/beats.mjs stream <file.wav> <prefix> [bph]
//     feeds the first channel to the app's real-time pipeline in co-axial mode and writes
//     <prefix>.stream.json: the timestamps it reports, and beside each one where a Kalman beat
//     tracker (js/dsp/tracker.js, run again here over those timestamps) expected the beat
//     before it arrived (`pred`) and placed it afterwards (`post`)
//
//   node tools/prototype/coaxial/beats.mjs sim <coaxial|lever> <prefix> ['<json overrides>']
//     makes a simulated watch with known truth (tests/helpers/balance.js) and writes
//     <prefix>.wav, <prefix>.truth.json, <prefix>.beats.json and <prefix>.stream.json. In the
//     overrides, "amplitudeSwing": {"base": 285, "swing": 10, "period": 23} makes the amplitude
//     wander.

import { writeFileSync } from 'node:fs';
import { readWav } from '../../../tests/helpers/wav.js';
import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from '../../../tests/helpers/balance.js';
import { analyze } from '../../../js/dsp/offline.js';
import { Pipeline } from '../../../js/dsp/pipeline.js';
import { BeatTracker } from '../../../js/dsp/tracker.js';
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

/**
 * The beats the real-time pipeline reports for a recording, in co-axial mode, with a Kalman
 * tracker's view of each. The pipeline's own tracker only tells its matched filter where to
 * look. Here the same tracker class is run again over the reported timestamps, in seconds, with
 * the pipeline's drift settings, to get for every beat the time it was expected (before the
 * beat was seen) and the time the tracker settled on (after).
 * @param {Float32Array} channel
 * @param {number} sampleRate
 * @param {{bph?: number}} options
 */
function streamOf(channel, sampleRate, options) {
  const pipeline = new Pipeline(sampleRate, 1, { ...options, escapement: 'coaxial' });
  /** @type {import('../../../js/dsp/pipeline.js').Beat[]} */
  let beats = [];
  let bph = 0;
  let lockedAt = null;
  for (let i = 0; i < channel.length; i += 128) {
    for (const e of pipeline.push([channel.subarray(i, Math.min(channel.length, i + 128))])) {
      if (e.type === 'status' && e.bph) {
        bph = e.bph;
        if (lockedAt === null && e.state === 'tracking') lockedAt = e.t;
      }
      if (e.type === 'beats') {
        // A fresh analysis replaces the beats from its start onwards.
        const from = e.replaceFrom;
        if (from !== null) beats = beats.filter((b) => b.t < from);
        beats.push(...e.beats);
      }
    }
  }
  beats.sort((a, b) => a.n - b.n);
  const period = 3600 / bph;
  const confident = beats.filter((b) => b.ok);
  const firstTick = confident.find((b) => b.type === 0);
  const firstTock = confident.find((b) => b.type === 1);
  /** @type {Map<import('../../../js/dsp/pipeline.js').Beat, {pred: number, post: number}>} */
  const view = new Map();
  if (firstTick && firstTock) {
    const offset = firstTock.t - firstTick.t - (firstTock.n - firstTick.n) * period;
    const tracker = new BeatTracker({
      n: firstTick.n,
      phase: firstTick.t,
      period,
      offset,
      phaseSd: 2e-4,
      periodSd: 1e-4 * period,
      offsetSd: 5e-4,
      // The pipeline's settings (driftPpm 2), in seconds instead of envelope samples.
      periodDrift: 2e-6 * period * Math.sqrt(period),
      offsetDrift: 1e-6 * Math.sqrt(period),
      scatter: [1e-4, 1e-4],
      minScatter: 2e-5,
    });
    for (const b of confident) {
      if (b.n < firstTick.n) continue;
      const pred = tracker.expect(b.n, b.type).arrival;
      tracker.update(b.n, b.type, b.t);
      view.set(b, { pred, post: tracker.expect(b.n, b.type).arrival });
    }
  }
  return {
    sampleRate,
    bph,
    lockedAt,
    beats: [0, 1].map((type) => {
      const mine = beats.filter((b) => b.type === type);
      return {
        type,
        K: Math.max(1, ...mine.map((b) => b.cycles)),
        t: mine.map((b) => b.t),
        n: mine.map((b) => b.n),
        ok: mine.map((b) => (b.ok && view.has(b) ? 1 : 0)),
        pred: mine.map((b) => view.get(b)?.pred ?? null),
        post: mine.map((b) => view.get(b)?.post ?? null),
      };
    }),
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
} else if (mode === 'stream' && args.length >= 2) {
  const [path, prefix, bph] = args;
  const wav = readWav(path);
  const result = streamOf(wav.channels[0], wav.sampleRate, bph ? { bph: Number(bph) } : {});
  writeFileSync(`${prefix}.stream.json`, JSON.stringify(result));
  console.log(`${path}: real-time pipeline, ${result.bph} vph, tracking from ${show(result.lockedAt, 1)} s, ` +
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
  writeFileSync(`${prefix}.stream.json`, JSON.stringify(streamOf(watch.channels[0], watch.sampleRate, {})));
  console.log(`${prefix}: true beat error ${Math.abs(unlockGapMs).toFixed(3)} ms, true amplitude ${meanAmplitude.toFixed(1)}, ` +
    `unlock to lock ${liftMs.map((v) => v.toFixed(3)).join(' and ')} ms; the app reads ${result.bph} vph, ${show(result.rate, 2)} s/day, ` +
    `Swiss-lever beat error ${show(result.leverBeatErrorMs, 3)} ms`);
} else {
  console.error('usage: beats.mjs wav <file.wav> <prefix> [bph] [start] [end]\n       beats.mjs stream <file.wav> <prefix> [bph]\n       beats.mjs sim <coaxial|lever> <prefix> [json overrides]');
  process.exit(1);
}
