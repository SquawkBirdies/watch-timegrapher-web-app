// A watch that runs badly does not keep its beats on a regular grid: each one falls a little
// early or late, by an amount that changes from beat to beat. The stages before this one assume
// a regular grid. Folding the audio at the beat period blurs the template when the beats are
// scattered, and averaging several cycles mixes beats that fell at different times.
//
// This stage looks at the beats that can be timed one at a time. If they are scattered, it
// stops averaging and times every beat on its own:
//
//   1. The template is rebuilt from beats that are each lined up on their own measured
//      position, the ticks and the tocks separately. This is repeated a few times, because a
//      sharper template times the beats better.
//   2. The beat is looked for further from its expected position, as far as the measured
//      scatter calls for.
//   3. Every timestamp is one beat. Beats too faint to be timed alone are left out rather than
//      averaged with their neighbours.
//
// A regular watch never reaches this stage, so nothing changes for it.
//
// Once a watch is known to be irregular, the repeat analyses do not fold the audio at all. A
// fold needs the beat period to within a few parts in a hundred thousand, and scattered beats
// do not give it away that precisely. The beats timed so far say where each beat is, so the
// next template is built from them directly.

import { buildTemplate, buildBeatTemplate, templateShift, shiftTemplate } from './template.js';
import { trackBeats, singleBeatScatter, runningMedian, LAG_MS } from './timing.js';
import { robustLine, median } from './mathutil.js';

/**
 * Scatter of single beats, in milliseconds, above which a beat type counts as scattered. A
 * regular watch keeps its single beats within about 0.1 ms; a faint beat of two sounds of
 * similar loudness, like the co-axial Omega's tock, scattered by up to 0.32 ms in short windows.
 */
export const SCATTER_LIMIT_MS = 0.5;
/** Fewest confident single beats of one type for its scatter to be judged. */
export const MIN_SINGLE_BEATS = 8;
/** Smallest share of confident single beats of one type for its scatter to be judged. */
export const MIN_SINGLE_SHARE = 0.2;
/** Smallest share of confident single beats for a beat type to be timed beat by beat. */
export const MIN_TIMED_SHARE = 0.1;
/** Widest search either side of the expected position, in milliseconds. */
export const MAX_LAG_MS = 16;
/** Rounds of lining up the beats and rebuilding the template, starting from a folded template. */
export const ALIGNMENT_ROUNDS = 3;
/** The same when starting from beats that are already timed. */
export const CONTINUED_ROUNDS = 2;

const PRE_SECONDS = 0.008;
const POST_SECONDS = 0.012;

/**
 * @typedef {Object} ScatterVerdict
 * @property {boolean} irregular true when the beats fall at scattered times
 * @property {(number|null)[]} scatterMs scatter of the single beats of each cluster, in
 *   milliseconds, null when it could not be judged
 */

/**
 * Decide whether a watch's beats fall at scattered times.
 *
 * Irregular running moves ticks and tocks alike, while a beat whose sound is wide or made of
 * several sounds scatters only its own timestamps: the second Omega recording's tick scattered
 * by up to 1.4 ms in short windows while its tock kept within 0.32 ms. So a first verdict
 * (`both`) needs both beat types above the limit. With `averaged`, a beat type too faint to be
 * timed alone may be judged from its averaged timestamps instead: K beats that scatter by s give
 * averages that scatter by about s/√K, so their scatter times √K stands for the single beats'.
 *
 * Without `both`, every beat type that can be judged must be above the limit, and at least one
 * must be judged: once a watch is known to be irregular, a beat type that can no longer be
 * judged does not undo the verdict.
 * @param {import('./timing.js').BeatTrack[]} singles one K = 1 track per cluster
 * @param {number} envelopeRate
 * @param {{both?: boolean, averaged?: import('./timing.js').BeatTrack[]}} [options]
 * @returns {ScatterVerdict}
 */
export function judgeScatter(singles, envelopeRate, options = {}) {
  const { both = false, averaged } = options;
  const scatterMs = singles.map((tr, j) => {
    const s = singleBeatScatter(tr, envelopeRate);
    if (s.count >= MIN_SINGLE_BEATS && s.fraction >= MIN_SINGLE_SHARE && Number.isFinite(s.ms)) return s.ms;
    const avg = averaged ? averaged[j] : null;
    if (!avg || avg.K <= 1) return null;
    const a = singleBeatScatter(avg, envelopeRate);
    return a.count >= MIN_SINGLE_BEATS && Number.isFinite(a.ms) ? a.ms * Math.sqrt(avg.K) : null;
  });
  const judged = /** @type {number[]} */ (scatterMs.filter((v) => v !== null));
  const enough = both ? judged.length === singles.length : judged.length > 0;
  return { irregular: enough && judged.every((v) => v > SCATTER_LIMIT_MS), scatterMs };
}

/**
 * A shift for every cycle from the shifts that are known: a cycle without one takes the trend
 * of its neighbours.
 * @param {number[]} at cycles with a known shift, ascending
 * @param {number[]} values their shifts
 * @param {number} cycles
 * @returns {Float64Array}
 */
function fillShifts(at, values, cycles) {
  const shifts = new Float64Array(cycles);
  if (at.length < 5) return shifts;
  const trend = runningMedian(Float64Array.from(values), 9);
  let g = 0;
  for (let i = 0; i < cycles; i++) {
    while (g + 1 < at.length && Math.abs(at[g + 1] - i) <= Math.abs(at[g] - i)) g++;
    shifts[i] = at[g] === i ? values[g] : trend[g];
  }
  return shifts;
}

/**
 * The shift of every cycle for one beat type: a beat that can be timed alone is lined up on its
 * own position, any other on the trend of those that can.
 * @param {import('./timing.js').BeatTrack} track a K = 1 track
 * @param {number} cycles
 * @returns {Float64Array}
 */
export function beatShifts(track, cycles) {
  /** @type {number[]} */
  const at = [];
  /** @type {number[]} */
  const values = [];
  for (let i = 0; i < Math.min(cycles, track.lag.length); i++) {
    if (track.value[i] > track.threshold) {
      at.push(i);
      values.push(track.lag[i]);
    }
  }
  return fillShifts(at, values, cycles);
}

/** The scatter of the more scattered beat type, in milliseconds; 0 when none can be measured. */
function worstScatter(/** @type {import('./timing.js').BeatTrack[]} */ singles, /** @type {number} */ fe) {
  let worst = 0;
  for (const tr of singles) {
    const s = singleBeatScatter(tr, fe);
    if (Number.isFinite(s.ms)) worst = Math.max(worst, s.ms);
  }
  return worst;
}

/**
 * How far either side of its expected position a beat must be looked for, in milliseconds.
 * @param {number} scatterMs
 * @param {number} period two-beat period in samples
 * @param {number} fe
 */
function reachFor(scatterMs, period, fe) {
  // No further than a sixteenth of the cycle: the noise level is measured between the beats.
  const widest = Math.min(MAX_LAG_MS, (1000 * period) / fe / 16);
  // Three standard deviations hold all but a few beats in a thousand. Every extra millisecond
  // is another chance for noise to beat a faint beat, so the search goes no wider than needed.
  return Math.max(LAG_MS, Math.min(widest, 2 * Math.ceil((3 * scatterMs + 1) / 2)));
}

/**
 * @typedef {Object} Aligned
 * @property {number} period two-beat period in envelope samples
 * @property {[number, number]} clusters position of each beat in the cycle
 * @property {Float32Array[]} template a folded template with each beat replaced by its sharp shape
 * @property {import('./timing.js').BeatTrack[]} tracks single-beat tracks of the two clusters
 * @property {number} lagMs how far either side of the expected position the beats were looked for
 * @property {(number|null)[]} scatterMs scatter of the single beats of each cluster
 */

/**
 * @typedef {Object} TimedBeat
 * @property {number} q where the beat was found, in envelope samples from the start of the rows
 * @property {number} n beat number; ticks and tocks alternate
 */

/**
 * What the last analysis of the same watch found, when it found the watch irregular.
 * @typedef {Object} KnownIrregular
 * @property {number} lagMs the search width it used
 * @property {TimedBeat[]} beats the beats timed one at a time since, within the rows
 */

/**
 * Rounds of building each beat type's template from lined-up beats and timing the beats with it.
 * @param {Float32Array[]} rows
 * @param {number} fe
 * @param {number} period
 * @param {[number, number]} clusters
 * @param {Float64Array[]} shifts the shift of every cycle for each beat type, to start from
 * @param {number} lagMs search width to start with
 * @param {number} rounds
 * @param {import('./timing.js').TimingOptions} timing
 * @returns {{singles: import('./timing.js').BeatTrack[], lagMs: number}}
 */
function sharpen(rows, fe, period, clusters, shifts, lagMs, rounds, timing) {
  const length = rows[0].length;
  const cycles = Math.max(0, Math.floor(length / period) - 1);
  const pre = Math.floor(PRE_SECONDS * fe);
  const post = Math.floor(POST_SECONDS * fe);
  /** @type {import('./timing.js').BeatTrack[]} */
  let singles = [];
  let used = lagMs;
  for (let round = 0; round < rounds; round++) {
    used = lagMs;
    const reach = Math.floor(used * 1e-3 * fe);
    singles = clusters.map((c, j) => {
      const even = buildBeatTemplate(rows, period, c, shifts[j], length, pre + reach, post + reach, 0);
      const odd = buildBeatTemplate(rows, period, c, shifts[j], length, pre + reach, post + reach, 1);
      // Each half is used to time the cycles of the other. Nothing else ties the two to the
      // same point of the beat, so they are brought together by their shapes.
      const gap = templateShift(even, odd, c, pre, post, reach);
      const pair = /** @type {[Float32Array[], Float32Array[]]} */ ([shiftTemplate(even, -gap / 2), shiftTemplate(odd, gap / 2)]);
      // An irregular watch gives no reason to expect a beat near its neighbours' trend.
      return trackBeats(rows, fe, period, pair, c, { ...timing, steps: [1], lagMs: used, preferNear: false });
    });
    shifts = singles.map((tr) => beatShifts(tr, cycles));
    // Look as far as the scatter measured so far calls for. A window that is too narrow hides
    // part of the scatter, so the window can grow again in the next round.
    lagMs = Math.max(lagMs, reachFor(worstScatter(singles, fe), period, fe));
  }
  return { singles, lagMs: used };
}

/**
 * The folded template with each beat that is timed replaced by its sharp shape. A beat type of
 * which too few beats can be timed alone is switched off: averaging it would not be valid.
 * @param {Float32Array[]} rows
 * @param {number} fe
 * @param {number} period
 * @param {[number, number]} clusters
 * @param {Float32Array[]} background a template folded at `period`
 * @param {import('./timing.js').BeatTrack[]} singles
 * @param {number} lagMs
 * @returns {Float32Array[]}
 */
function sharpTemplate(rows, fe, period, clusters, background, singles, lagMs) {
  const length = rows[0].length;
  const cycles = Math.max(0, Math.floor(length / period) - 1);
  const before = Math.floor(PRE_SECONDS * fe) + Math.floor(lagMs * 1e-3 * fe);
  const after = Math.floor(POST_SECONDS * fe) + Math.floor(lagMs * 1e-3 * fe);
  const template = background.map((t) => Float32Array.from(t));
  const nb = template[0].length;
  singles.forEach((tr, j) => {
    if (tr.confidentFraction < MIN_TIMED_SHARE) {
      tr.threshold = Infinity;
      tr.confidentFraction = 0;
      return;
    }
    const sharp = buildBeatTemplate(rows, period, clusters[j], beatShifts(tr, cycles), length, before, after);
    for (let r = 0; r < template.length; r++) {
      for (let g = -before; g <= after; g++) {
        const at = (((clusters[j] + g) % nb) + nb) % nb;
        template[r][at] = sharp[r][at];
      }
    }
  });
  return template;
}

/**
 * Time the beats of an irregular watch one at a time, starting from the folded template.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} envelopeRate
 * @param {number} period two-beat period in envelope samples
 * @param {{template: Float32Array[], clusters: [number, number], split: [Float32Array[], Float32Array[]], tracks: import('./timing.js').BeatTrack[]}} folded
 *   the result of the stages that assume a regular grid
 * @param {import('./timing.js').TimingOptions} [timing]
 * @returns {Aligned | null} null when the watch is not judged irregular, or when lining up the
 *   beats did not help
 */
export function alignBeats(rows, envelopeRate, period, folded, timing = {}) {
  const fe = envelopeRate;
  const { clusters, split } = folded;
  const cycles = Math.max(0, Math.floor(rows[0].length / period) - 1);
  // The single beats are judged as they fall: preferring a peak near the trend of its
  // neighbours would pull scattered beats towards it and hide the scatter being looked for.
  const first = clusters.map((c) => trackBeats(rows, fe, period, split, c, { ...timing, steps: [1], preferNear: false }));
  if (!judgeScatter(first, fe, { averaged: folded.tracks }).irregular) return null;

  const start = reachFor(worstScatter(first, fe), period, fe);
  const { singles, lagMs } = sharpen(rows, fe, period, clusters, first.map((tr) => beatShifts(tr, cycles)), start, ALIGNMENT_ROUNDS, timing);

  // Lining up on noise would time fewer beats than the folded template did.
  if (singles[0].confidentFraction + singles[1].confidentFraction < 0.8 * (first[0].confidentFraction + first[1].confidentFraction)) return null;
  // The verdict must hold for single beats of both types timed with the sharper template too.
  // A wide sound alone, or a template folded over a window that is half silence, can make a
  // regular watch's beats look scattered.
  const verdict = judgeScatter(singles, fe, { both: true });
  if (!verdict.irregular) return null;
  const template = sharpTemplate(rows, fe, period, clusters, folded.template, singles, lagMs);
  return { period, clusters, template, tracks: singles, lagMs, scatterMs: verdict.scatterMs };
}

/**
 * Time the beats of a watch already known to be irregular, starting from the beats timed since
 * the last analysis instead of from a fold.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} envelopeRate
 * @param {KnownIrregular} known
 * @param {import('./timing.js').TimingOptions} [timing]
 * @returns {Aligned | null} null when too few beats are known, when they no longer lead to a
 *   template that times the beats, or when the beats no longer show the watch to be irregular
 */
export function continueBeats(rows, envelopeRate, known, timing = {}) {
  const fe = envelopeRate;
  const length = rows[0].length;
  /** @type {TimedBeat[][]} */
  const groups = [[], []];
  for (const b of known.beats) groups[((b.n % 2) + 2) % 2].push(b);
  if (groups.every((g) => g.length < MIN_SINGLE_BEATS)) return null;

  // One beat period for both types, from straight lines through their positions.
  let slope = 0;
  let weight = 0;
  for (const g of groups) {
    if (g.length < MIN_SINGLE_BEATS) continue;
    const fit = robustLine(g.map((b) => b.n), g.map((b) => b.q));
    slope += fit.b * g.length;
    weight += g.length;
  }
  const beat = slope / weight;
  const period = 2 * beat;
  if (!(beat > 0)) return null;
  const cycles = Math.max(0, Math.floor(length / period) - 1);
  // Each type's place in the cycle, and the beat number it has in the first cycle.
  // A type with hardly a beat timed is looked for midway between the beats of the other.
  const offsets = groups.map((g) => (g.length >= 3 ? median(g.map((b) => b.q - beat * b.n)) : NaN));
  const placed = groups.map((g, parity) => {
    const a = Number.isFinite(offsets[parity]) ? offsets[parity] : offsets[1 - parity];
    let n0 = Math.ceil(-a / beat);
    if ((((n0 - parity) % 2) + 2) % 2 !== 0) n0 += 1;
    return { g, n0, at: a + beat * n0 };
  });
  placed.sort((x, y) => x.at - y.at);
  const clusters = /** @type {[number, number]} */ (placed.map((x) => Math.round(x.at)));
  const shifts = placed.map((x, j) => {
    /** @type {number[]} */
    const at = [];
    /** @type {number[]} */
    const values = [];
    for (const b of x.g.slice().sort((u, v) => u.n - v.n)) {
      const k = (b.n - x.n0) / 2;
      if (k < 0 || k >= cycles || at[at.length - 1] === k) continue;
      at.push(k);
      values.push(b.q - (k * period + clusters[j]));
    }
    return fillShifts(at, values, cycles);
  });

  const { singles, lagMs } = sharpen(rows, fe, period, clusters, shifts, known.lagMs, CONTINUED_ROUNDS, timing);
  // The new template must time about as many beats as were handed in.
  const handed = known.beats.length / Math.max(1, 2 * cycles);
  if (0.5 * (singles[0].confidentFraction + singles[1].confidentFraction) < 0.6 * Math.min(1, handed)) return null;
  const verdict = judgeScatter(singles, fe);
  if (!verdict.irregular) return null;
  const template = sharpTemplate(rows, fe, period, clusters, buildTemplate(rows, period), singles, lagMs);
  return { period, clusters, template, tracks: singles, lagMs, scatterMs: verdict.scatterMs };
}
