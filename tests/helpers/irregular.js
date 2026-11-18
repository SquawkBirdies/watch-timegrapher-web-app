// Test helper: watches that run irregularly, with the truth about every beat.

import { synthesizeWatch, seededRandom, gaussianFrom } from '../../js/audio/simulator.js';
import { robustLine } from '../../js/dsp/mathutil.js';

/**
 * @typedef {ReturnType<typeof synthesizeWatch> & {bph: number, rate: number, smooth: Float64Array}} IrregularWatch
 *   `smooth` holds where each beat would fall without its own scatter and stray displacements:
 *   the part of the timing that a rate reading measures
 */

/**
 * A "basket case": a watch that runs so badly its trace is a snow storm, like the one in the
 * collector guide on reading timegrapher results, heard clearly. Every beat falls up to several milliseconds
 * early or late; the rate itself wanders; one beat in thirty is knocked far out of place; the
 * beats vary in loudness; the movement rattles between them; and the tock is 2 ms off the
 * midpoint between ticks, so the true beat error is 2 ms, not the 0.0 ms a confused
 * timegrapher can show.
 * @param {number} seed
 * @param {{seconds?: number, gain?: number}} [options] `gain` is how loud the beats are, 1.6 as the
 *   tests use it; the co-axial prototype's check makes it louder
 * @returns {IrregularWatch}
 */
export function basketCase(seed, options = {}) {
  const { seconds = 60, gain = 1.6 } = options;
  const bph = 18000;
  const rate = 60;
  const walkStep = gaussianFrom(seededRandom(seed * 7919 + 1));
  const stray = seededRandom(seed * 7919 + 2);
  const loud = gaussianFrom(seededRandom(seed * 7919 + 3));
  let walk = 0;
  /** @type {number[]} */
  const walks = [];
  const w = synthesizeWatch({
    bph,
    rate,
    seconds,
    seed,
    gain,
    // Beat-to-beat scatter, 2 ms standard deviation.
    jitterMs: 2,
    beatOffsetMs: 2,
    displacement: () => {
      // The rate wanders: each beat's period is off by a random 0.1 ms, and the errors add up.
      walk += walkStep() * 1e-4;
      walks.push(walk);
      // A stray beat, up to 8 ms out.
      return walk + (stray() < 1 / 30 ? (2 * stray() - 1) * 8e-3 : 0);
    },
    loudness: () => Math.exp(0.25 * loud()),
    rattle: { perSecond: 6, gain: 1 },
  });
  const smooth = Float64Array.from(walks, (x, k) => 0.137 + k * w.truePeriod + x);
  return { ...w, bph, rate, smooth };
}

/**
 * The rate of the smooth part of a watch's timing between two times, in seconds per day: what
 * a rate reading over that stretch should show, apart from the uncertainty the watch's scatter
 * leaves.
 * @param {IrregularWatch} watch
 * @param {number} from
 * @param {number} to
 */
export function smoothRate(watch, from, to) {
  /** @type {number[]} */
  const n = [];
  /** @type {number[]} */
  const t = [];
  watch.smooth.forEach((x, k) => {
    if (x >= from && x <= to) {
      n.push(k);
      t.push(x);
    }
  });
  const nMean = n.reduce((s, v) => s + v, 0) / n.length;
  const tMean = t.reduce((s, v) => s + v, 0) / t.length;
  let sxx = 0;
  let sxy = 0;
  n.forEach((v, i) => {
    sxx += (v - nMean) ** 2;
    sxy += (v - nMean) * (t[i] - tMean);
  });
  return 86400 * (3600 / watch.bph / (sxy / sxx) - 1);
}

/**
 * Move every beat of a real recording by a known amount. Each beat, with 40 ms either side of
 * it, moves as a block; the audio in between is stretched or squeezed to fit.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number[]} times where the beats are in the recording, in seconds
 * @param {number[]} shifts how far to move each, in seconds
 * @returns {Float32Array[]}
 */
export function retime(channels, sampleRate, times, shifts) {
  const hold = 0.04;
  const out = channels.map((c) => new Float32Array(c.length));
  let k = 0;
  for (let i = 0; i < out[0].length; i++) {
    const t = i / sampleRate;
    while (k + 1 < times.length && times[k + 1] + shifts[k + 1] - hold <= t) k++;
    const blockEnd = times[k] + shifts[k] + hold;
    let shift;
    if (t < times[0] + shifts[0] - hold) shift = shifts[0];
    else if (t <= blockEnd || k + 1 >= times.length) shift = shifts[k];
    else {
      const nextStart = times[k + 1] + shifts[k + 1] - hold;
      shift = shifts[k] + ((t - blockEnd) / (nextStart - blockEnd)) * (shifts[k + 1] - shifts[k]);
    }
    const x = (t - shift) * sampleRate;
    const i0 = Math.floor(x);
    const frac = x - i0;
    for (let c = 0; c < out.length; c++) {
      const src = channels[c];
      out[c][i] = i0 >= 0 && i0 + 1 < src.length ? src[i0] * (1 - frac) + src[i0 + 1] * frac : 0;
    }
  }
  return out;
}

/**
 * Beat times of a regular recording, from the timestamps of an analysis: a straight line
 * through each beat type, with a common period.
 * @param {import('../../js/dsp/offline.js').BeatSeries[]} series
 * @param {number} seconds length of the recording
 * @returns {number[]} every beat, ticks and tocks alternating
 */
export function regularBeats(series, seconds) {
  const lines = series.map((s) => {
    /** @type {number[]} */
    const n = [];
    /** @type {number[]} */
    const t = [];
    for (let i = 0; i < s.t.length; i++) {
      if (s.ok[i]) {
        n.push(s.n[i]);
        t.push(s.t[i]);
      }
    }
    return robustLine(n, t);
  });
  const period = (lines[0].b + lines[1].b) / 2;
  /** @type {number[]} */
  const times = [];
  for (let n = 0; ; n++) {
    const t = lines[n % 2].a + period * n;
    if (t > seconds - 0.2) break;
    if (t > 0.2) times.push(t);
  }
  return times;
}
