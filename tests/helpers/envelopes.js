// Test helper: a made-up watch given straight as band envelopes and beat timestamps, as the
// stage that reads the sounds inside each beat receives them (js/dsp/sounds.js and
// js/dsp/amplitude.js). No audio and no pipeline: every beat is an unlock, an impulse and a lock
// drawn into noise, and its timestamp marks its lock, so the truth is known exactly and a
// reading takes a fraction of a second. It tests the stage's own arithmetic: its gates, its
// lining up, its draws. Whether it reads a watch's sound is for the simulated watches in
// tests/helpers/balance.js, which go through the pipeline, and for the recordings.

import { seededRandom, gaussianFrom } from '../../js/audio/simulator.js';

/** Envelope sample rate of the made-up watch, in hertz: the app's. */
export const ENVELOPE_RATE = 12000;

/**
 * @typedef {Object} MadeUpOptions
 * @property {number} [seconds] length; 30 when absent
 * @property {number} [bph] beat rate; 28,800 when absent
 * @property {number} [gapMs] how much later than midway between the ticks the tocks fall, which
 *   is the true beat error, since both beats are made alike; 0.4 when absent
 * @property {(time: number) => number} [liftMs] the time from unlock to lock of a beat at a
 *   given time, in milliseconds; a steady 7.4 when absent. A time that changes is an amplitude
 *   that changes: the timestamps follow the lock, so the unlock moves against them
 * @property {number} [unlock] the unlock's loudest level against a band's quiet level; 6 when
 *   absent, against 30 for the impulse and 60 for the lock
 * @property {number} [beatJitterMs] standard deviation of each whole beat's time from the
 *   regular grid, its timestamp with it, as in an irregular watch; 0 when absent
 * @property {number} [seed]
 */

/**
 * @param {MadeUpOptions} [options]
 * @returns {{rows: Float32Array[], envelopeRate: number, bph: number, beats: import('../../js/dsp/estimate.js').BeatSeries[], toPosition: (seconds: number) => number, truth: {gapMs: number, liftMs: [number, number]}}}
 *   six envelope rows, the ticks' and the tocks' timestamps, where a time lies in the rows, and
 *   the truth: the gap between the unlocks and each beat type's mean time from unlock to lock
 */
export function madeUpWatch(options = {}) {
  const { seconds = 30, bph = 28800, gapMs = 0.4, liftMs = () => 7.4, unlock = 6, beatJitterMs = 0, seed = 1 } = options;
  const fe = ENVELOPE_RATE;
  const n = Math.floor(seconds * fe);
  const random = seededRandom(seed);
  const jitter = gaussianFrom(seededRandom(seed + 0x2545f491));
  // Each band's quiet level, so that the bands do not count alike, under noise that is the mean
  // of two squared values, about as an envelope sample's is.
  const quiet = [1, 0.5, 0.3, 0.2, 0.3, 0.6];
  const rows = quiet.map((level) => Float32Array.from({ length: n }, () => (-level * (Math.log(1 - random()) + Math.log(1 - random()))) / 2));
  const period = 3600 / bph;
  /** @type {[number[], number[]]} */
  const times = [[], []];
  /** @type {[number[], number[]]} */
  const numbers = [[], []];
  /** @type {[number[], number[]]} */
  const lifts = [[], []];
  for (let k = 0; ; k++) {
    const j = k % 2;
    const grid = 0.1 + k * period + j * gapMs * 1e-3;
    if (grid > seconds - 0.05) break;
    // Each beat falls anywhere within an envelope sample, so that no sound keeps one place
    // against the samples: drawn at one place, a rise this quick would be read a hundredth of a
    // millisecond off, differently in the ticks and the tocks.
    const lock = grid + (random() - 0.5) / fe + beatJitterMs * 1e-3 * (beatJitterMs > 0 ? jitter() : 0);
    const lift = liftMs(grid) * 1e-3;
    lifts[j].push(lift * 1e3);
    for (const [start, level] of [[lock - lift, unlock], [lock - lift / 3, 30], [lock, 60]]) {
      const first = Math.ceil(start * fe);
      for (let i = Math.max(first, 0); i < first + 48 && i < n; i++) {
        const x = (i / fe - start) * 1e3;
        const v = level * (1 - Math.exp(-x / 0.1)) * Math.exp(-x / 0.5);
        for (let b = 0; b < rows.length; b++) rows[b][i] += quiet[b] * v;
      }
    }
    // The timestamp marks the lock, the loudest sound, 0.2 ms after it starts.
    times[j].push(lock + 0.0002);
    numbers[j].push(k);
  }
  const beats = /** @type {import('../../js/dsp/estimate.js').BeatSeries[]} */ ([0, 1].map((j) => ({
    type: j,
    K: 1,
    t: Float64Array.from(times[j]),
    n: Float64Array.from(numbers[j]),
    ok: new Uint8Array(times[j].length).fill(1),
    z: new Float64Array(times[j].length).fill(30),
    confidentFraction: 1,
    zMedian: 30,
  })));
  /** @param {number[]} v */
  const mean = (v) => v.reduce((sum, x) => sum + x, 0) / v.length;
  return { rows, envelopeRate: fe, bph, beats, toPosition: (t) => t * fe, truth: { gapMs, liftMs: [mean(lifts[0]), mean(lifts[1])] } };
}
