// Stage 10 of the pipeline, second half: the unlock and the lock of each beat, and the two
// readings that rest on them.
//
//   beat error = how far the tock's unlock falls from midway between the ticks' unlocks
//   amplitude  = lift angle / (2 sin(pi f t)), t the mean time from unlock to lock, f = bph / 7200
//
// The timestamps of stage 7 follow each beat's loudest sound. In a co-axial escapement that is a
// different event in the two beats, so the gap between the timestamps is not the beat error; in
// any escapement the unlock is the event a timing machine measures from. js/dsp/sounds.js finds
// the sounds in each averaged beat; here the first is taken as the unlock, the lock is chosen
// for both beats together, and the readings follow.
//
// A port of tools/prototype/coaxial/events.py (`lift_limits`, `pair_beats`, `amplitude` and the
// plain average of `measure`). This first step gives the plain average's reading with no
// measure of its scatter: lining the beats up again, the resamples and the gates that decide
// whether a reading may be shown come next.

import { median } from './mathutil.js';
import { STRETCH_BEFORE_S, STRETCH_AFTER_S, stackBeats, stretchMs, samplesBefore, bandMeans, energyWeights, mixBands, findSounds } from './sounds.js';

/**
 * @typedef {import('./sounds.js').Sound} Sound
 * @typedef {import('./sounds.js').BeatStack} BeatStack
 * @typedef {import('./estimate.js').BeatSeries} BeatSeries
 */

/** Fewest confident timestamps, and fewest beats inside the audio, of each beat type to average. */
export const MIN_BEATS = 10;
/** The two beats' times from unlock to lock agree within this ratio. */
export const MAX_LIFT_RATIO = 1.18;
/** Smallest believable amplitude, in degrees. */
export const MIN_AMPLITUDE = 150;
/**
 * Largest believable amplitude, in degrees. Above it Witschi's fault table expects the balance
 * to knock against its banking.
 */
export const MAX_AMPLITUDE = 330;
/** The quiet stretch ends this long before the longest believable time from unlock to lock, in milliseconds. */
export const QUIET_MARGIN_MS = 1.5;
/** Shortest quiet stretch, in milliseconds, from which a beat's background can be judged. */
export const MIN_QUIET_MS = 2;

/**
 * Why there is no reading.
 * - `few-beats`: fewer than MIN_BEATS confident timestamps of a beat type, or beats inside the audio
 * - `averaged`: a beat type's timestamps each average several cycles, so no single beat's place is known
 * - `short-stretch`: at this beat rate and lift angle the unlock could lie before the stretch read
 * - `few-sounds`: fewer than two sounds in a beat
 * - `no-pair`: no two sounds come the same time after the first in both beats
 * - `lift-range`: the time from the first sound to the lock is not believable for a watch
 * - `no-middle-sound`: nothing lies between the first sound and the lock, so the first may be the impulse
 * @typedef {'few-beats'|'averaged'|'short-stretch'|'few-sounds'|'no-pair'|'lift-range'|'no-middle-sound'} NoReading
 */

/**
 * The unlock and the lock chosen in each beat type.
 * @typedef {Object} Pair
 * @property {[Sound, Sound]} unlock the tick's and the tock's
 * @property {[Sound, Sound]} lock the tick's and the tock's
 * @property {[number, number]} liftMs time from unlock to lock in the tick and in the tock
 */

/**
 * One beat type's averaged beat and the sounds found in it.
 * @typedef {Object} AveragedBeat
 * @property {Float64Array} curve the bands' excess energy over the quiet stretch, in units of its level
 * @property {Sound[]} sounds in order of time
 * @property {number} noise scatter of the smoothed curve in the quiet stretch
 */

/**
 * What the sounds inside the beats give. Every reading is null when `why` says there is none.
 * @typedef {Object} SoundsReading
 * @property {number} liftAngle lift angle the reading was made with, in degrees
 * @property {[number, number]} liftLimitsMs shortest and longest believable time from unlock to lock
 * @property {[number, number]} counts beats averaged of each type; when there were too few, the
 *   confident timestamps or the beats inside the audio
 * @property {NoReading|null} why
 * @property {number|null} timestampGapMs how much later than midway between the ticks' timestamps the tocks' fall
 * @property {number} quietUntilMs where the quiet stretch before the beat ends, in milliseconds from the timestamp
 * @property {Float64Array|null} ms time of each sample of the averaged beats, in milliseconds from the timestamp
 * @property {Float64Array|null} weights the bands' weights
 * @property {[AveragedBeat, AveragedBeat]|null} beats the averaged tick and tock
 * @property {Pair|null} pair
 * @property {[number, number]|null} refusedLiftMs with `lift-range`, the times that were refused
 * @property {number|null} unlockGapMs how much later than midway between the ticks' unlocks the
 *   tocks' unlocks fall; its size is the beat error
 * @property {number|null} beatErrorMs
 * @property {number|null} lockGapMs the same gap between the locks
 * @property {[number, number]|null} liftMs time from unlock to lock in the tick and in the tock
 * @property {number|null} amplitude in degrees, from the mean of the two times
 * @property {[number, number]|null} amplitudes from the tick's time alone and from the tock's
 * @property {number|null} unlockDb the weaker unlock's level over the quiet stretch's scatter, in decibels
 */

/**
 * Shortest and longest believable time from unlock to lock, in milliseconds: the times the
 * balance takes to cross the lift angle at MAX_AMPLITUDE and at MIN_AMPLITUDE.
 * @param {number} bph beat rate in beats per hour
 * @param {number} liftAngle in degrees
 * @returns {[number, number]}
 */
export function liftLimits(bph, liftAngle) {
  const f = bph / 7200;
  return [(1e3 * Math.asin(liftAngle / (2 * MAX_AMPLITUDE))) / (Math.PI * f), (1e3 * Math.asin(liftAngle / (2 * MIN_AMPLITUDE))) / (Math.PI * f)];
}

/**
 * Amplitude of a balance that takes `liftMs` to cross its lift angle about its rest position.
 * @param {number} liftAngle in degrees
 * @param {number} bph beat rate in beats per hour
 * @param {number} liftMs time from unlock to lock in milliseconds
 * @returns {number} degrees
 */
export function amplitudeOf(liftAngle, bph, liftMs) {
  return liftAngle / (2 * Math.sin(Math.PI * (bph / 7200) * liftMs * 1e-3));
}

/**
 * Choose the unlock and the lock of each beat. The unlock is a beat's first sound. The lock is
 * chosen for both beats together: among the later sounds, the pair whose times from the unlock
 * agree within MAX_LIFT_RATIO and whose quieter member, against its own beat's loudest sound,
 * is loudest.
 * @param {Sound[]} tick the sounds of the averaged tick, in order of time
 * @param {Sound[]} tock and of the tock
 * @param {number} bph
 * @param {number} liftAngle
 * @returns {{pair: Pair|null, why: NoReading|null, refusedLiftMs: [number, number]|null}}
 */
export function pairBeats(tick, tock, bph, liftAngle) {
  /** @param {NoReading} why @param {[number, number]|null} [refusedLiftMs] */
  const none = (why, refusedLiftMs = null) => ({ pair: null, why, refusedLiftMs });
  if (tick.length < 2 || tock.length < 2) return none('few-sounds');
  const [lo, hi] = liftLimits(bph, liftAngle);
  /** @param {number} t */
  const believable = (t) => lo <= t && t <= hi;
  const [f0, f1] = [tick[0], tock[0]];
  const top0 = Math.max(...tick.map((e) => e.level));
  const top1 = Math.max(...tock.map((e) => e.level));
  /** @typedef {{score: number, a: Sound, b: Sound, t0: number, t1: number}} Candidate */
  let best = /** @type {Candidate|null} */ (null);
  let bestBelievable = /** @type {Candidate|null} */ (null);
  for (const a of tick.slice(1)) {
    for (const b of tock.slice(1)) {
      const t0 = a.onsetMs - f0.onsetMs;
      const t1 = b.onsetMs - f1.onsetMs;
      if (Math.max(t0, t1) / Math.min(t0, t1) > MAX_LIFT_RATIO) continue;
      const score = Math.min(a.level / top0, b.level / top1);
      if (!best || score > best.score) best = { score, a, b, t0, t1 };
      if (believable(t0) && believable(t1) && (!bestBelievable || score > bestBelievable.score)) bestBelievable = { score, a, b, t0, t1 };
    }
  }
  if (!best) return none('no-pair');
  let chosen = best;
  if (!(believable(best.t0) && believable(best.t1))) {
    // A lever whose impulse is louder than its drop in both beats pairs its impulses first, too
    // soon after the unlock to be the lock; its drops are the believable pair. But when the
    // unlock is lost, the first sound found is the impulse, the drop comes too soon after it,
    // and a quieter sound after the drop can be believable: taken as the lock, it gave
    // amplitudes 48 degrees low on simulated watches. A lock is louder than an unlock, by 12 to
    // 18 dB in both Safari captures, so a quieter pair is taken only when both its sounds are
    // louder than their beat's first sound, which leaves those watches without a reading.
    if (!bestBelievable || !(bestBelievable.a.level > f0.level && bestBelievable.b.level > f1.level)) return none('lift-range', [best.t0, best.t1]);
    chosen = bestBelievable;
  }
  const { a, b, t0, t1 } = chosen;
  // Both escapements make a sound between the unlock and the lock in each beat: the lever its
  // impulse, the co-axial its impulse in one beat and a sound 4.2 ms after the unlock in the
  // other. That sound is louder than the unlock, so when the unlock is heard it is heard too.
  // When the unlock is lost, the first sound found is the impulse and nothing lies between it
  // and the lock; timed from it, the lift comes out short, and simulated levers showed
  // amplitudes 44 to 109 degrees high.
  const between0 = tick.some((e) => f0.onsetMs < e.onsetMs && e.onsetMs < a.onsetMs);
  const between1 = tock.some((e) => f1.onsetMs < e.onsetMs && e.onsetMs < b.onsetMs);
  if (!between0 || !between1) return none('no-middle-sound');
  return { pair: { unlock: [f0, f1], lock: [a, b], liftMs: [t0, t1] }, why: null, refusedLiftMs: null };
}

/**
 * A reading with nothing in it yet.
 * @param {number} bph
 * @param {number} liftAngle
 * @param {[number, number]} counts
 * @param {NoReading|null} why
 * @returns {SoundsReading}
 */
function noReading(bph, liftAngle, counts, why) {
  const limits = liftLimits(bph, liftAngle);
  return {
    liftAngle,
    liftLimitsMs: limits,
    counts,
    why,
    timestampGapMs: null,
    quietUntilMs: -(limits[1] + QUIET_MARGIN_MS),
    ms: null,
    weights: null,
    beats: null,
    pair: null,
    refusedLiftMs: null,
    unlockGapMs: null,
    beatErrorMs: null,
    lockGapMs: null,
    liftMs: null,
    amplitude: null,
    amplitudes: null,
    unlockDb: null,
  };
}

/**
 * How much later than midway between the ticks' timestamps the tocks' fall, in milliseconds:
 * one line is fitted through both types' timestamps against beat number, and the gap is the
 * median of the tocks' distances from it less the ticks'.
 * @param {[ArrayLike<number>, ArrayLike<number>]} t each type's timestamps in seconds
 * @param {[ArrayLike<number>, ArrayLike<number>]} n and their beat numbers
 * @returns {{gapMs: number, slope: number}} the gap, and the line's slope in seconds a beat
 */
export function timestampGap(t, n) {
  let count = 0;
  let nMean = 0;
  let tMean = 0;
  for (const j of [0, 1]) {
    for (let i = 0; i < t[j].length; i++) {
      nMean += n[j][i];
      tMean += t[j][i];
      count++;
    }
  }
  nMean /= count;
  tMean /= count;
  let snn = 0;
  let snt = 0;
  for (const j of [0, 1]) {
    for (let i = 0; i < t[j].length; i++) {
      snn += (n[j][i] - nMean) * (n[j][i] - nMean);
      snt += (n[j][i] - nMean) * (t[j][i] - tMean);
    }
  }
  const slope = snt / snn;
  /** @param {0|1} j */
  const level = (j) => median(Array.from(t[j], (v, i) => v - slope * n[j][i]));
  return { gapMs: (level(1) - level(0)) * 1e3, slope };
}

/**
 * The readings of the ticks' and the tocks' stacked beats: each averaged, the bands mixed by
 * their energy, the sounds found and paired.
 * @param {[BeatStack, BeatStack]} stacks the ticks' and the tocks'
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {number} timestampGapMs from `timestampGap`
 * @param {number} bph
 * @param {number} liftAngle
 * @returns {SoundsReading}
 */
export function readStacks(stacks, envelopeRate, timestampGapMs, bph, liftAngle) {
  const out = noReading(bph, liftAngle, [stacks[0].count, stacks[1].count], null);
  out.timestampGapMs = timestampGapMs;
  if (Math.min(stacks[0].count, stacks[1].count) < MIN_BEATS) return { ...out, why: 'few-beats' };
  const ms = stretchMs(stacks[0].before, stacks[0].length, envelopeRate);
  // The quiet stretch must end before the earliest moment an unlock could come.
  const quiet = samplesBefore(ms, out.quietUntilMs);
  if (quiet < Math.ceil(MIN_QUIET_MS * 1e-3 * envelopeRate)) return { ...out, why: 'short-stretch' };
  const means = [bandMeans(stacks[0], quiet), bandMeans(stacks[1], quiet)];
  const weights = energyWeights(means[0].levels, means[1].levels);
  const beats = /** @type {[AveragedBeat, AveragedBeat]} */ (means.map((m) => {
    const curve = mixBands(m.excess, weights);
    return { curve, ...findSounds(curve, ms, quiet) };
  }));
  out.ms = ms;
  out.weights = weights;
  out.beats = beats;
  const { pair, why, refusedLiftMs } = pairBeats(beats[0].sounds, beats[1].sounds, bph, liftAngle);
  if (!pair) return { ...out, why, refusedLiftMs };
  out.pair = pair;
  out.unlockGapMs = timestampGapMs + pair.unlock[1].onsetMs - pair.unlock[0].onsetMs;
  out.beatErrorMs = Math.abs(out.unlockGapMs);
  out.lockGapMs = timestampGapMs + pair.lock[1].onsetMs - pair.lock[0].onsetMs;
  out.liftMs = pair.liftMs;
  out.amplitude = amplitudeOf(liftAngle, bph, 0.5 * (pair.liftMs[0] + pair.liftMs[1]));
  out.amplitudes = [amplitudeOf(liftAngle, bph, pair.liftMs[0]), amplitudeOf(liftAngle, bph, pair.liftMs[1])];
  out.unlockDb = Math.min(pair.unlock[0].levelDb, pair.unlock[1].levelDb);
  return out;
}

/**
 * The sounds' readings for a stretch of audio whose beats have been timed: the whole-recording
 * entry. Only beats the pipeline timed alone are read. When a beat type's timestamps each
 * average several cycles there is no reading: placing such beats on the trend of their
 * timestamps read simulated watches 0.04 ms high on average and 1.6 times their stated scatter.
 * @param {Float32Array[]} rows the envelope of each band the sounds are read from, before
 *   Cleanup (`soundRows` in js/dsp/sounds.js): clipping and equal weights hid the Omega's unlock
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {BeatSeries[]} beats the ticks' and the tocks' timestamps
 * @param {number} bph beat rate in beats per hour
 * @param {number} liftAngle lift angle in degrees
 * @param {(seconds: number) => number} toPosition where a time lies in `rows`, in samples and
 *   fractions of one
 * @returns {SoundsReading}
 */
export function measureSounds(rows, envelopeRate, beats, bph, liftAngle, toPosition) {
  /** @type {[number[], number[]]} */
  const t = [[], []];
  /** @type {[number[], number[]]} */
  const n = [[], []];
  for (const j of [0, 1]) {
    const b = beats[j];
    for (let i = 0; b && i < b.t.length; i++) {
      if (!b.ok[i]) continue;
      t[j].push(b.t[i]);
      n[j].push(b.n[i]);
    }
  }
  const before = Math.floor(STRETCH_BEFORE_S * envelopeRate);
  const after = Math.floor(STRETCH_AFTER_S * envelopeRate);
  if (Math.min(t[0].length, t[1].length) < MIN_BEATS) return noReading(bph, liftAngle, [t[0].length, t[1].length], 'few-beats');
  if (beats[0].K > 1 || beats[1].K > 1) return noReading(bph, liftAngle, [t[0].length, t[1].length], 'averaged');
  const { gapMs } = timestampGap(t, n);
  const stacks = /** @type {[BeatStack, BeatStack]} */ ([0, 1].map((j) => stackBeats(rows, t[j].map(toPosition), before, after)));
  return readStacks(stacks, envelopeRate, gapMs, bph, liftAngle);
}
