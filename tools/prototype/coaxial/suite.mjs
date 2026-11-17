// Prototype check: the watches of the app's unit tests, for the co-axial prototype.
//
//   node tools/prototype/coaxial/suite.mjs <directory> [part of a watch name]
//
// Builds the 36 simulated watches the test files make as whole recordings, the same way and with
// the same seeds, and for each writes <name>.wav (the first channel, as the app takes it),
// <name>.beats.json (the app's whole-recording analysis in co-axial mode, as beats.mjs writes it)
// and <name>.truth.json. checks.py suite then runs the prototype on them and on the recordings in
// tests/fixtures. Two kinds are left out: the watches tests/interface.test.js makes as live
// streams (WatchStream), and the Voice Memos ETA recording tests/irregular.test.js re-times.
//
// The truth: these watches come from js/audio/simulator.js, which places each beat's sounds at
// fixed times around it. The tock's sounds all move by `beatOffsetMs`, so that is the true beat
// error whichever sound is timed. The time from a beat's first sound to its last loud one is set
// by its list of sounds, 7 ms for the default three; there is no balance behind it, so that time
// is the truth to check, not an amplitude.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { synthesizeWatch } from '../../../js/audio/simulator.js';
import { analyze } from '../../../js/dsp/offline.js';
import { encodeWav } from '../../../js/audio/wav.js';
import { basketCase } from '../../../tests/helpers/irregular.js';
import { join } from '../../../tests/helpers/stream.js';

const DEFAULT_SOUNDS = [{ dt: -0.007, amp: 0.25 }, { dt: -0.0045, amp: 0.45 }, { dt: 0, amp: 1.0 }];

/**
 * Time from a beat's first sound to its last sound that is at least half as loud as its loudest,
 * in milliseconds.
 * @param {{dt: number, amp: number}[]} sounds
 */
function liftOf(sounds) {
  const top = Math.max(...sounds.map((s) => s.amp));
  const loud = sounds.filter((s) => s.amp >= 0.5 * top);
  return 1e3 * (loud[loud.length - 1].dt - sounds[0].dt);
}

/**
 * @typedef {Object} Case
 * @property {string} name
 * @property {string} test where the watch comes from
 * @property {() => {sampleRate: number, channels: Float32Array[]}} make
 * @property {number|null} beatErrorMs true beat error, or null when the beats have no common first event
 * @property {number|null} liftMs true time from first to last loud sound, the same in both beats, or null
 * @property {'reading'|'refuse'|'none'} expect a reading, a refusal (the two beats share no first
 *   sound, so there is no unlock to time), or nothing at all (no watch)
 * @property {number} [bph] beat rate given to the analysis, as the test gives it
 * @property {number} [actualBph] the watch's own beat rate
 */

/**
 * A watch of the default simulator with the given options.
 * @param {string} name @param {string} test @param {import('../../../js/audio/simulator.js').WatchOptions} o
 * @param {Partial<Case>} [extra]
 * @returns {Case}
 */
function sim(name, test, o, extra = {}) {
  const tick = o.tickSounds || DEFAULT_SOUNDS;
  const tock = o.tockSounds || tick;
  const sameShape = liftOf(tick) === liftOf(tock) && tick[0].dt === tock[0].dt;
  return {
    name,
    test,
    make: () => synthesizeWatch(o),
    beatErrorMs: o.gain === 0 ? null : sameShape ? Math.abs(o.beatOffsetMs || 0) : null,
    liftMs: o.gain === 0 || !sameShape ? null : liftOf(tick),
    expect: o.gain === 0 ? 'none' : sameShape ? 'reading' : 'refuse',
    actualBph: o.bph,
    ...extra,
  };
}

const coaxialTick = [{ dt: -0.0037, amp: 1.0 }, { dt: 0, amp: 0.5 }];
const twoSoundTock = (/** @type {number} */ a, /** @type {number} */ b) => [{ dt: -0.0037, amp: a, decayMs: 0.4 }, { dt: 0, amp: b, decayMs: 0.5 }];
const blurred = [{ dt: -0.002, amp: 0.85, decayMs: 0.5 }, { dt: 0, amp: 1.0, decayMs: 0.5 }, { dt: 0.0022, amp: 0.8, decayMs: 0.5 }];

/** @type {Case[]} */
const cases = [
  sim('clear 28800', 'stream: clear ticks', { bph: 28800, rate: 12, beatOffsetMs: 0.3, gain: 1.6, seconds: 50, seed: 1 }),
  sim('mains buzz 21600', 'stream: mains buzz', { bph: 21600, rate: -8, beatOffsetMs: -0.8, gain: 1.2, seconds: 50, seed: 2 }),
  sim('faint 18000', 'stream: faint ticks', { bph: 18000, rate: 45, beatOffsetMs: 0, gain: 0.45, seconds: 100, seed: 3 }),
  sim('no ticks', 'stream: noise only', { bph: 21600, gain: 0, seconds: 120, seed: 4 }),
  ...[[18000, -10], [19800, 20], [21600, -20], [25200, -30], [28800, 30], [36000, 10]].map(([bph, rate]) =>
    sim(`beat rate ${bph}`, 'stream: beat rates', { bph, rate, beatOffsetMs: 0.5, gain: 1.4, seconds: 40, seed: bph })),
  {
    name: 'stops and starts',
    test: 'stream: ticking stops',
    make: () => {
      const w = { bph: 28800, rate: 5, beatOffsetMs: 0.2, gain: 1.6 };
      return { sampleRate: 48000, channels: join([synthesizeWatch({ ...w, seconds: 20, seed: 5 }), synthesizeWatch({ ...w, gain: 0, seconds: 20, seed: 6 }), synthesizeWatch({ ...w, seconds: 25, seed: 7 })]) };
    },
    beatErrorMs: 0.2,
    liftMs: 7,
    expect: 'reading',
    actualBph: 28800,
  },
  sim('told 18000', 'stream: beat rate given', { bph: 18000, rate: 5, beatOffsetMs: 0, gain: 0.7, seconds: 40, seed: 77 }, { bph: 18000 }),
  ...[[18000, 36000], [36000, 18000]].flatMap(([actual, told]) => [-10, 10].map((rate) =>
    sim(`${actual} told ${told}, ${rate > 0 ? '+' : ''}${rate}`, 'stream: wrong beat rate given', { bph: actual, rate, beatOffsetMs: 0.5, gain: 1.4, seconds: 40, seed: actual }, { bph: told }))),
  sim('chunking 21600', 'stream: chunk sizes', { bph: 21600, rate: 3, beatOffsetMs: 0.4, gain: 1.4, seconds: 30, seed: 8 }),
  sim('two-sound co-axial', 'escapement: co-axial mode', {
    bph: 21600, rate: 3, beatOffsetMs: 0, gain: 1.4, seconds: 40, seed: 41,
    tickSounds: [{ dt: -0.0037, amp: 1.0, decayMs: 0.5 }, { dt: 0, amp: 0.5, decayMs: 0.5 }],
    tockSounds: [{ dt: -0.0024, amp: 0.45, decayMs: 0.4 }, { dt: 0, amp: 0.55, decayMs: 0.5 }],
  }),
  sim('lever 28800', 'escapement: Swiss lever mode', { bph: 28800, rate: -6, beatOffsetMs: 0.4, gain: 1.4, seconds: 30, seed: 43 }),
  sim('faint 28800', 'irregular: faint regular watch', { bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 0.9, seconds: 30, seed: 91 }),
  sim('jitter 2 ms', 'irregular: scattered beats', { bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 40, seed: 1010, jitterMs: 2 }),
  sim('jitter 5 ms', 'irregular: scattered beats', { bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 50, seed: 91, jitterMs: 5 }),
  ...[1, 2, 3].map((seed) => ({
    name: `basket case ${seed}`,
    test: 'irregular: basket case',
    make: () => basketCase(seed),
    beatErrorMs: 2,
    liftMs: 7,
    expect: /** @type {'reading'} */ ('reading'),
    actualBph: 18000,
  })),
  sim('blurred three sounds', 'scatter: faint blurred beats', { bph: 21600, rate: 5, beatOffsetMs: 0.3, gain: 0.8, seconds: 60, seed: 74, tickSounds: blurred }),
  sim('jitter 0.5 ms', 'scatter: irregular, beat for beat', { bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 50, seed: 91, jitterMs: 0.5 }),
  sim('jitter 1 ms', 'scatter: irregular, beat for beat', { bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 50, seed: 91, jitterMs: 1 }),
  {
    name: 'tock changes its loudest sound',
    test: 'reference: carried timing reference',
    make: () => {
      const w = { bph: 21600, rate: 0, beatOffsetMs: 0, gain: 1.4, tickSounds: coaxialTick.map((s) => ({ ...s, decayMs: 0.5 })) };
      return { sampleRate: 48000, channels: join([synthesizeWatch({ ...w, seconds: 48, seed: 51, tockSounds: twoSoundTock(0.72, 0.56) }), synthesizeWatch({ ...w, seconds: 60, seed: 52, tockSounds: twoSoundTock(0.6, 0.66) })]) };
    },
    beatErrorMs: 0,
    liftMs: 3.7,
    expect: 'reading',
    actualBph: 21600,
  },
  sim('reference 28800', 'reference: timing reference', { bph: 28800, rate: 5, beatOffsetMs: 0.6, gain: 1.6, seconds: 30, seed: 61 }),
  sim('units 25200', 'units: readings', { bph: 25200, rate: -40, beatOffsetMs: 0.4, gain: 0.9, seconds: 24, seed: 21 }),
  sim('diagnostic 21600', 'diagnostic: speed test', { bph: 21600, rate: -5, beatOffsetMs: 0.4, gain: 1.4, seconds: 20, seed: 31 }),
  sim('window 18000', 'interface: averaging window', { bph: 18000, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 50, seed: 13 }),
  sim('interface 28800 60 s', 'interface: readings', { bph: 28800, rate: 6, beatOffsetMs: 0.4, gain: 1.6, seconds: 60, seed: 21 }),
  sim('interface 28800 25 s', 'interface: trace', { bph: 28800, rate: 0, beatOffsetMs: 0.3, gain: 1.6, seconds: 25, seed: 31 }),
  {
    name: 'live run with a gap',
    test: 'live: microphone cut off for 2 s',
    make: () => {
      const w = synthesizeWatch({ bph: 28800, rate: 12, beatOffsetMs: 0.3, gain: 1.6, seconds: 75, sampleRate: 48000, seed: 61 });
      const audio = w.channels[0].slice();
      audio.fill(0, 25 * 48000, 27 * 48000);
      return { sampleRate: 48000, channels: [audio] };
    },
    beatErrorMs: 0.3,
    liftMs: 7,
    expect: 'reading',
    actualBph: 28800,
  },
];

const [dir, match] = process.argv.slice(2);
if (!dir) {
  console.error('usage: suite.mjs <directory> [part of a watch name, to make only those]');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
for (const c of cases.filter((x) => !match || x.name.includes(match))) {
  // Signs are spelt out, so that the -10 and +10 s/day watches keep apart.
  const file = joinPath(dir, c.name.replace(/\+/g, 'plus').replace(/-/g, 'minus').replace(/[^a-z0-9]+/gi, '_'));
  const w = c.make();
  const channel = w.channels[0];
  writeFileSync(`${file}.wav`, Buffer.from(encodeWav([channel], w.sampleRate)));
  const truth = { name: c.name, test: c.test, beatErrorMs: c.beatErrorMs, liftMs: c.liftMs, expect: c.expect, toldBph: c.bph ?? null, actualBph: c.actualBph ?? null };
  writeFileSync(`${file}.truth.json`, JSON.stringify(truth));
  /** @type {string} */
  let note;
  try {
    const r = analyze([channel], w.sampleRate, { bph: c.bph, escapement: 'coaxial' });
    const beats = r.beats.map((b) => ({ type: b.type, K: b.K, t: Array.from(b.t), n: Array.from(b.n), ok: Array.from(b.ok) }));
    writeFileSync(`${file}.beats.json`, JSON.stringify({ sampleRate: w.sampleRate, bph: r.bph, rate: r.rate, irregular: r.irregular, beats }));
    note = `${r.bph} vph, ${r.rate === null ? 'no rate' : `${r.rate.toFixed(2)} s/day`}, beats timed ${beats.map((b) => `${b.ok.reduce((s, v) => s + v, 0)} (over ${b.K})`).join(' and ')}${r.irregular ? ', irregular' : ''}`;
  } catch (e) {
    note = `no beats: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(`${c.name.padEnd(32)} ${note}`);
}
