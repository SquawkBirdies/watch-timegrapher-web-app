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
// A reading is shown only when resampling the beats supports it. The beats of each type are
// drawn again with their timestamps, 200 times, and the whole procedure repeated on each draw:
// the readings' scatter over the draws is their stated uncertainty, and a reading whose draws
// often fail to find the sounds, or scatter too far, is held back.
//
// An average of beats is biased when the amplitude changes while they are taken: the timestamps
// follow each beat's loudest sound, and the other sounds' places move against it with the time
// from unlock to lock, which smears them. So the beats are cut into 10 s blocks, each sound is
// matched in each block, and a sound whose blocks show it moving has its beats lined up again
// on it before they are averaged.
//
// A port of tools/prototype/coaxial/events.py (`lift_limits`, `pair_beats`, `amplitude`,
// `block_shifts`, `moved`, `reliable`, `beat_shifts` and `measure`).

import { median, mean, std, seededRandom, chiSquaredQuantile } from './mathutil.js';
import {
  STRETCH_BEFORE_S, STRETCH_AFTER_S, stackBeats, stretchMs, samplesBefore, toColumns, shiftedColumns, bandMeans, energyWeights, mixBands,
  findSounds, smoothForMatching, shiftOf,
} from './sounds.js';

/**
 * @typedef {import('./sounds.js').Sound} Sound
 * @typedef {import('./sounds.js').BeatStack} BeatStack
 * @typedef {import('./sounds.js').BeatColumns} BeatColumns
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

/** Times the beats are drawn again for a reading's scatter. */
export const RESAMPLES = 200;
/** Largest share of the resamples in which the sounds are not found, for a reading to be shown. */
export const MAX_FAILING = 0.05;
/** Largest scatter of the beat error over the resamples, in milliseconds, for it to be shown. */
export const MAX_BEAT_ERROR_SCATTER_MS = 0.1;
/** Largest scatter of the amplitude over the resamples, in degrees, for it to be shown. */
export const MAX_AMPLITUDE_SCATTER = 5;
/**
 * A resample that places a sound further than this from where all the beats put it, in
 * milliseconds, has found another sound, usually a bump of noise 2 to 7 ms before the unlock.
 * Its reading is not a measure of the same sounds, so it counts as failing, not as scatter.
 */
export const OTHER_SOUND_MS = 0.5;
/** Fewest resamples that found the sounds for a scatter to be worked out at all. */
export const MIN_RESAMPLES_KEPT = 6;

/** Length of the blocks whose sounds are matched against the whole stretch's, in seconds. */
export const BLOCK_SECONDS = 10;
/** Fewest beats of each type in a block. */
export const BLOCK_MIN_BEATS = 10;
/** Times each block's beats are drawn again for the scatter of its shifts. */
export const BLOCK_RESAMPLES = 40;
/** A block's shift needs at least this share of its resamples to have placed the sound. */
export const BLOCK_PLACED = 0.8;
/** The chance that a sound which does not move is lined up all the same. */
export const MOVED_P = 0.01;
/**
 * Floor on the scatter of a block's shift, in milliseconds, so that a loud sound's tiny one
 * cannot turn a hundredth of a millisecond into a change.
 */
export const MIN_SHIFT_SCATTER_MS = 0.01;
/**
 * A block's shift that scatters by more than this over the block's own resamples, in
 * milliseconds, is left out of the line the beats are shifted along: some of its resamples
 * took another sound, and the shift itself may have. One such shift moved a whole reading by
 * 0.13 ms.
 */
export const MAX_SHIFT_SCATTER_MS = 0.3;
/** How far a lined-up sound may lie from where the plain average put it, in milliseconds. */
export const LINED_NEAR_MS = 1;

/**
 * Why there is no reading.
 * - `few-beats`: fewer than MIN_BEATS confident timestamps of a beat type, or beats inside the audio
 * - `averaged`: a beat type's timestamps each average several cycles, so no single beat's place is known
 * - `short-stretch`: at this beat rate and lift angle the unlock could lie before the stretch read
 * - `few-sounds`: fewer than two sounds in a beat
 * - `no-pair`: no two sounds come the same time after the first in both beats
 * - `lift-range`: the time from the first sound to the lock is not believable for a watch
 * - `no-middle-sound`: nothing lies between the first sound and the lock, so the first may be the impulse
 * - `lined-few-blocks`: lined up, a sound was placed in fewer than two blocks (only in a resample)
 * - `lined-lost`: no sound was found in the lined-up average
 * - `lined-far`: the lined-up sound lies more than LINED_NEAR_MS from the plain average's
 * @typedef {'few-beats'|'averaged'|'short-stretch'|'few-sounds'|'no-pair'|'lift-range'|'no-middle-sound'|'lined-few-blocks'|'lined-lost'|'lined-far'} NoReading
 */

/**
 * Why a reading that was made is not to be shown.
 * - `unchecked`: too few resamples were asked for to judge it
 * - `failing`: more than MAX_FAILING of the resamples did not find the sounds
 * - `irregular`: the watch's beats fall at scattered times, so the gap between its unlocks is
 *   not one beat error; only the beat error is held for this
 * - `halfway`: a beat lies halfway between the tick and the tock, so the beat rate in use is
 *   half the watch's own: the tick and the tock are the same kind of beat, and the amplitude
 *   formula has the wrong rate
 * - `scatter`: the resamples that found the sounds scatter too far
 * @typedef {'unchecked'|'failing'|'irregular'|'halfway'|'scatter'} Held
 */

/**
 * Whether one sound's place moves over the blocks. If it does not, its shifts scatter about
 * their weighted mean as their own scatter says, and the sum of their squared distances from
 * it, each over its scatter, follows a chi-squared distribution.
 * @typedef {Object} MovedTest
 * @property {boolean} moved true when the sum is beyond the point chance passes with MOVED_P
 * @property {number} chi2 the sum; NaN when the sound was placed in fewer than two blocks
 * @property {number} dof blocks it was placed in, less one
 * @property {number} limit the point it was held to; NaN when not tested
 */

/**
 * What lining the beats up again came to.
 * @typedef {Object} LiningUp
 * @property {'steady'|'few-blocks'|'lined'} state `steady`: no sound moves, so the plain average
 *   stands; `few-blocks`: a sound to line up was placed in fewer than two blocks, so the plain
 *   average stands; `lined`: the readings are from beats lined up again
 * @property {number} blocks blocks the stretch was cut into
 * @property {[BlockShifts, BlockShifts]} shifts the tick's and the tock's shifts in each block,
 *   as measured
 * @property {number} leftOut block shifts left out for scattering, of the sounds lined up
 * @property {[[MovedTest, MovedTest], [MovedTest, MovedTest]]|null} moved for the tick and the
 *   tock, the unlock's test and the lock's; null when every sound is lined up untested
 */

/**
 * One beat type's shifts, block by block.
 * @typedef {Object} BlockShifts
 * @property {number[]} mids middle time of each block, in seconds
 * @property {[Float64Array, Float64Array]} shifts how much later than in the whole stretch the
 *   unlock and the lock come in each block, in milliseconds; NaN where not placed
 * @property {[Float64Array, Float64Array]|null} scatter each shift's scatter over the block's
 *   resamples; NaN where too few of them placed the sound; null when none were drawn
 */

/**
 * One beat type's stacked beats, as the readings need them.
 * @typedef {Object} TypeBeats
 * @property {BeatStack} stack each beat's stretch of envelope
 * @property {Float64Array} times each stacked beat's timestamp in seconds
 * @property {Float64Array} residualMs each stacked beat's timestamp less the line through both
 *   types' timestamps, in milliseconds
 */

/**
 * Where a reading puts the sounds: for the tick and the tock, the unlock's and the lock's
 * start in milliseconds from the timestamp.
 * @typedef {{at: [[number, number], [number, number]], unlockDb: number}} Places
 */

/**
 * How the sounds are read.
 * @typedef {Object} ReadOptions
 * @property {number} [resamples] times the beats are drawn again; RESAMPLES when absent, and 0
 *   for a reading with no scatter, which is never to be shown
 * @property {'moved'|'always'|'never'} [lineUp] which sounds have their beats lined up again:
 *   those whose blocks show them moving (the default), every sound, or none. Always lining up
 *   widened the scatter by half on quiet watches whose sounds do not move
 * @property {number} [seed] seed of the draws; 1 when absent
 * @property {boolean} [irregular] true when the pipeline found the watch's beats falling at
 *   scattered times: the beat error is then held back and the amplitude kept
 * @property {boolean} [halfway] true when the pipeline found a beat halfway between the tick
 *   and the tock: both readings are then held back
 * @property {(n: number) => Int32Array} [draw] gives n beats drawn from n, in place of the
 *   seeded draws
 * @property {(outcome: NoReading | 'other-sound' | {unlockGapMs: number, lockGapMs: number, liftMs: [number, number], places: Places}) => void} [each]
 *   called with each resample's outcome
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
 * @property {LiningUp|null} lining what lining up came to; null when it was not tried
 * @property {number|null} failing share of the resamples that did not find the sounds; null without resamples
 * @property {number|null} otherSound share of the resamples that found another sound, which is part of `failing`
 * @property {{unlockGapMs: number, lockGapMs: number, liftMs: [number, number], amplitude: number}|null} scatter
 *   each reading's standard deviation over the resamples that found the sounds; null when fewer
 *   than MIN_RESAMPLES_KEPT did
 * @property {boolean} showBeatError true when the resamples support the beat error
 * @property {boolean} showAmplitude true when they support the amplitude
 * @property {Held|null} beatErrorHeld why the beat error is not to be shown, when there is one
 * @property {Held|null} amplitudeHeld and the amplitude
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
    lining: null,
    failing: null,
    otherSound: null,
    scatter: null,
    showBeatError: false,
    showAmplitude: false,
    beatErrorHeld: null,
    amplitudeHeld: null,
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
 * Linear interpolation of y over rising x, held level beyond the first and last points.
 * @param {number} at
 * @param {number[]} x
 * @param {number[]} y
 * @returns {number}
 */
function interpolate(at, x, y) {
  const last = x.length - 1;
  if (at <= x[0]) return y[0];
  if (at >= x[last]) return y[last];
  let i = 0;
  while (at > x[i + 1]) i++;
  return y[i] + ((y[i + 1] - y[i]) * (at - x[i])) / (x[i + 1] - x[i]);
}

/**
 * What the block shifts are measured on and against.
 * @typedef {Object} Matching
 * @property {[BeatColumns, BeatColumns]} columns every stacked beat of each type
 * @property {[Float64Array, Float64Array]} times and its timestamp in seconds
 * @property {Float64Array} ms time of each sample of a stretch
 * @property {number} quiet samples of the quiet stretch
 * @property {Float64Array} weights the bands' weights
 * @property {[Float64Array, Float64Array]} templates each type's whole averaged beat, smoothed for matching
 * @property {[[number, number][], [number, number][]]} windows for each type, the stretch of
 *   its template that holds the unlock and the one that holds the lock: from 0.5 ms before the
 *   sound starts to 0.5 ms after it is loudest
 */

/**
 * How far each beat type's unlock and lock have moved, block by block, against the whole
 * stretch's averaged beat.
 * @param {Matching} m
 * @param {[Int32Array|null, Int32Array|null]} drawn the beats in play of each type, any of them
 *   more than once; all the beats when null
 * @param {number[]|null} starts where the blocks begin. When null they run every BLOCK_SECONDS
 *   from the first beat, and a block with too few beats is passed over. When given, such a
 *   block keeps its place with shifts that are not numbers. A resample is given the whole
 *   stretch's blocks: left to make its own, one that drew none of the first or last few beats
 *   made one block fewer, and 17% of the resamples of 20 s stretches then had nothing to line
 *   up on
 * @param {number} resamples times each block's beats are drawn again for its shifts' scatter
 * @param {(n: number) => Int32Array} draw
 * @returns {[BlockShifts, BlockShifts]}
 */
function blockShifts(m, drawn, starts, resamples, draw) {
  const given = starts !== null;
  const members = [0, 1].map((j) => drawn[j] ?? Int32Array.from({ length: m.columns[j].count }, (_, i) => i));
  if (!starts) {
    let first = Infinity;
    let last = -Infinity;
    for (const j of [0, 1]) {
      for (const i of members[j]) {
        first = Math.min(first, m.times[j][i]);
        last = Math.max(last, m.times[j][i]);
      }
    }
    starts = [];
    for (let a = first; a + BLOCK_SECONDS <= last + 0.5; a += BLOCK_SECONDS) starts.push(a);
  }
  const inBlock = starts.map((a) => [0, 1].map((j) => members[j].filter((i) => m.times[j][i] >= a && m.times[j][i] < a + BLOCK_SECONDS)));
  /** @param {0|1} j @param {ArrayLike<number>} beats */
  const curveOf = (j, beats) => smoothForMatching(mixBands(bandMeans(m.columns[j], m.quiet, beats).excess, m.weights), m.ms);
  return /** @type {[BlockShifts, BlockShifts]} */ ([0, 1].map((j) => {
    const type = /** @type {0|1} */ (j);
    /** @type {number[]} */
    const mids = [];
    /** @type {[number[], number[]]} */
    const shifts = [[], []];
    /** @type {[number[], number[]]} */
    const scatter = [[], []];
    for (let b = 0; b < starts.length; b++) {
      if (Math.min(inBlock[b][0].length, inBlock[b][1].length) < BLOCK_MIN_BEATS) {
        if (!given) continue;
        mids.push(starts[b] + 0.5 * BLOCK_SECONDS);
        for (const k of [0, 1]) {
          shifts[k].push(NaN);
          scatter[k].push(NaN);
        }
        continue;
      }
      const beats = inBlock[b][type];
      mids.push(starts[b] + 0.5 * BLOCK_SECONDS);
      const curve = curveOf(type, beats);
      for (const k of [0, 1]) shifts[k].push(shiftOf(m.templates[type], curve, m.ms, m.windows[type][k][0], m.windows[type][k][1]) ?? NaN);
      if (!resamples) continue;
      /** @type {[number[], number[]]} */
      const got = [[], []];
      for (let r = 0; r < resamples; r++) {
        const again = curveOf(type, draw(beats.length).map((i) => beats[i]));
        for (const k of [0, 1]) {
          const v = shiftOf(m.templates[type], again, m.ms, m.windows[type][k][0], m.windows[type][k][1]);
          if (v !== null) got[k].push(v);
        }
      }
      for (const k of [0, 1]) scatter[k].push(got[k].length >= BLOCK_PLACED * resamples ? std(got[k]) : NaN);
    }
    return { mids, shifts: [Float64Array.from(shifts[0]), Float64Array.from(shifts[1])], scatter: resamples ? [Float64Array.from(scatter[0]), Float64Array.from(scatter[1])] : null };
  }));
}

/**
 * Which sounds move against the beats' timestamps, from each block's shift and its scatter.
 * @param {[BlockShifts, BlockShifts]} blocks with their scatter
 * @returns {[[MovedTest, MovedTest], [MovedTest, MovedTest]]}
 */
export function movedSounds(blocks) {
  return /** @type {[[MovedTest, MovedTest], [MovedTest, MovedTest]]} */ (blocks.map((b) => [0, 1].map((k) => {
    const s = b.shifts[k];
    const sd = b.scatter ? b.scatter[k] : new Float64Array(s.length).fill(NaN);
    let n = 0;
    let sw = 0;
    let sws = 0;
    for (let i = 0; i < s.length; i++) {
      if (Number.isNaN(s[i]) || Number.isNaN(sd[i])) continue;
      const w = 1 / Math.max(sd[i], MIN_SHIFT_SCATTER_MS) ** 2;
      n++;
      sw += w;
      sws += w * s[i];
    }
    if (n < 2) return { moved: false, chi2: NaN, dof: Math.max(n - 1, 0), limit: NaN };
    const centre = sws / sw;
    let chi2 = 0;
    for (let i = 0; i < s.length; i++) {
      if (Number.isNaN(s[i]) || Number.isNaN(sd[i])) continue;
      chi2 += (s[i] - centre) ** 2 / Math.max(sd[i], MIN_SHIFT_SCATTER_MS) ** 2;
    }
    const limit = chiSquaredQuantile(1 - MOVED_P, n - 1);
    return { moved: chi2 > limit, chi2, dof: n - 1, limit };
  })));
}

/**
 * Each beat's unlock and lock shift, read off a line through the blocks' shifts and held level
 * beyond the first and last block. A sound that does not move keeps a shift of zero, so it
 * stays where the plain average puts it.
 * @param {[BlockShifts, BlockShifts]} blocks
 * @param {[ArrayLike<number>, ArrayLike<number>]} times each beat's timestamp in seconds
 * @param {[[MovedTest, MovedTest], [MovedTest, MovedTest]]|null} moved the sounds to line up;
 *   every sound when null
 * @returns {[[Float64Array, Float64Array], [Float64Array, Float64Array]]|null} null when a sound
 *   to line up was placed in fewer than two blocks
 */
function beatShifts(blocks, times, moved) {
  /** @type {[Float64Array, Float64Array][]} */
  const out = [];
  for (const j of [0, 1]) {
    /** @type {Float64Array[]} */
    const per = [];
    for (const k of [0, 1]) {
      const shifts = new Float64Array(times[j].length);
      if (!moved || moved[j][k].moved) {
        const s = blocks[j].shifts[k];
        /** @type {number[]} */
        const x = [];
        /** @type {number[]} */
        const y = [];
        for (let b = 0; b < s.length; b++) {
          if (Number.isNaN(s[b])) continue;
          x.push(blocks[j].mids[b]);
          y.push(s[b]);
        }
        if (x.length < 2) return null;
        for (let i = 0; i < shifts.length; i++) shifts[i] = interpolate(times[j][i], x, y);
      }
      per.push(shifts);
    }
    out.push([per[0], per[1]]);
  }
  return [out[0], out[1]];
}

/**
 * The readings that a set of places gives.
 * @param {Places} places
 * @param {number} gapMs the gap between the timestamps
 * @returns {{unlockGapMs: number, lockGapMs: number, liftMs: [number, number]}}
 */
function readingsOf(places, gapMs) {
  const [[f0, l0], [f1, l1]] = places.at;
  return { unlockGapMs: gapMs + f1 - f0, lockGapMs: gapMs + l1 - l0, liftMs: [l0 - f0, l1 - f1] };
}

/**
 * The readings of the ticks' and the tocks' stacked beats, with their scatter and whether they
 * may be shown.
 * @param {[TypeBeats, TypeBeats]} beats the ticks and the tocks
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {number} timestampGapMs from `timestampGap`
 * @param {number} bph
 * @param {number} liftAngle
 * @param {ReadOptions} [options]
 * @returns {SoundsReading}
 */
export function readBeats(beats, envelopeRate, timestampGapMs, bph, liftAngle, options = {}) {
  const { resamples = RESAMPLES, lineUp = 'moved', seed = 1, irregular = false, halfway = false, each } = options;
  const stacks = [beats[0].stack, beats[1].stack];
  const out = noReading(bph, liftAngle, [stacks[0].count, stacks[1].count], null);
  out.timestampGapMs = timestampGapMs;
  if (Math.min(stacks[0].count, stacks[1].count) < MIN_BEATS) return { ...out, why: 'few-beats' };
  const ms = stretchMs(stacks[0].before, stacks[0].length, envelopeRate);
  // The quiet stretch must end before the earliest moment an unlock could come.
  const quiet = samplesBefore(ms, out.quietUntilMs);
  if (quiet < Math.ceil(MIN_QUIET_MS * 1e-3 * envelopeRate)) return { ...out, why: 'short-stretch' };
  const [shortest, longest] = out.liftLimitsMs;
  const random = seededRandom(seed);
  const draw = options.draw ?? ((/** @type {number} */ n) => Int32Array.from({ length: n }, () => Math.floor(random() * n)));
  const columns = /** @type {[BeatColumns, BeatColumns]} */ ([toColumns(stacks[0]), toColumns(stacks[1])]);

  // The plain average of all the beats: its mixture of bands and its choice of unlock and lock
  // stand for everything that follows.
  const means = [bandMeans(columns[0], quiet), bandMeans(columns[1], quiet)];
  const weights = energyWeights(means[0].levels, means[1].levels);
  const averaged = /** @type {[AveragedBeat, AveragedBeat]} */ (means.map((m) => {
    const curve = mixBands(m.excess, weights);
    return { curve, ...findSounds(curve, ms, quiet) };
  }));
  out.ms = ms;
  out.weights = weights;
  out.beats = averaged;
  const { pair, why, refusedLiftMs } = pairBeats(averaged[0].sounds, averaged[1].sounds, bph, liftAngle);
  if (!pair) return { ...out, why, refusedLiftMs };
  out.pair = pair;

  /** @param {0|1} j @param {Int32Array|null} d the averaged beat of the beats drawn, or of all */
  const curveOf = (j, d) => mixBands(bandMeans(columns[j], quiet, d ?? undefined).excess, weights);
  /** @param {Pair} p @returns {Places} */
  const placesOf = (p) => ({
    at: [[p.unlock[0].onsetMs, p.lock[0].onsetMs], [p.unlock[1].onsetMs, p.lock[1].onsetMs]],
    unlockDb: Math.min(p.unlock[0].levelDb, p.unlock[1].levelDb),
  });
  /**
   * Where a draw of the beats puts the sounds, or why it finds none.
   * @type {(d0: Int32Array|null, d1: Int32Array|null) => Places | NoReading}
   */
  let read = (d0, d1) => {
    const found = pairBeats(findSounds(curveOf(0, d0), ms, quiet).sounds, findSounds(curveOf(1, d1), ms, quiet).sounds, bph, liftAngle);
    return found.pair ? placesOf(found.pair) : /** @type {NoReading} */ (found.why);
  };
  let whole = placesOf(pair);

  if (lineUp !== 'never') {
    /** @type {Matching} */
    const matching = {
      columns,
      times: [beats[0].times, beats[1].times],
      ms,
      quiet,
      weights,
      templates: [smoothForMatching(averaged[0].curve, ms), smoothForMatching(averaged[1].curve, ms)],
      windows: [
        [[pair.unlock[0].onsetMs - 0.5, pair.unlock[0].peakMs + 0.5], [pair.lock[0].onsetMs - 0.5, pair.lock[0].peakMs + 0.5]],
        [[pair.unlock[1].onsetMs - 0.5, pair.unlock[1].peakMs + 0.5], [pair.lock[1].onsetMs - 0.5, pair.lock[1].peakMs + 0.5]],
      ],
    };
    // Each block's beats are drawn again for the scatter of its shifts: the test for a moving
    // sound rests on it, and so does leaving out a shift that took another sound.
    const blocks = blockShifts(matching, [null, null], null, BLOCK_RESAMPLES, draw);
    const measured = /** @type {[BlockShifts, BlockShifts]} */ (blocks.map((b) => ({ ...b, shifts: [b.shifts[0].slice(), b.shifts[1].slice()] })));
    const starts = blocks[0].mids.map((mid) => mid - 0.5 * BLOCK_SECONDS);
    const moved = lineUp === 'moved' ? movedSounds(blocks) : null;
    // The whole set decides which sounds are lined up and which block shifts are left out, and
    // every resample is held to both: its own blocks have no resamples to judge them by.
    const leftOut = blocks.map((b) => [0, 1].map((k) => Array.from(b.scatter ? b.scatter[k] : [], (sd) => !(sd <= MAX_SHIFT_SCATTER_MS))));
    /** @param {[BlockShifts, BlockShifts]} b */
    const withoutLeftOut = (b) => {
      for (const j of [0, 1]) {
        for (const k of [0, 1]) {
          leftOut[j][k].forEach((drop, i) => {
            if (drop) b[j].shifts[k][i] = NaN;
          });
        }
      }
      return b;
    };
    /** @param {0|1} j @param {0|1} k whether this sound's beats are lined up again */
    const linedUp = (j, k) => !moved || moved[j][k].moved;
    const shifts = beatShifts(withoutLeftOut(blocks), matching.times, moved);
    /** @type {LiningUp} */
    const lining = { state: 'lined', blocks: starts.length, shifts: measured, leftOut: 0, moved };
    for (const j of [0, 1]) for (const k of [0, 1]) if (linedUp(/** @type {0|1} */ (j), /** @type {0|1} */ (k))) lining.leftOut += leftOut[j][k].filter(Boolean).length;
    out.lining = lining;
    if (moved && !moved.some((type) => type.some((sound) => sound.moved))) {
      lining.state = 'steady';
    } else if (!shifts) {
      lining.state = 'few-blocks';
    } else {
      // Where the plain average put each sound; the lined-up sound is looked for near it.
      const near = whole.at;
      read = (d0, d1) => {
        const d = [d0, d1];
        let use = shifts;
        if (d0 && d1) {
          // The whole procedure again on the beats drawn: their shifts in the whole set's
          // blocks, and the drawn beats lined up on them. A wrong shift moves a lined-up sound
          // one way and the mean shift added back the other, so drawing the shifts alone, with
          // the beats left as the whole set lined them up, would overstate the scatter.
          const again = beatShifts(withoutLeftOut(blockShifts(matching, [d0, d1], starts, 0, draw)), [Array.from(d0, (i) => matching.times[0][i]), Array.from(d1, (i) => matching.times[1][i])], moved);
          if (!again) return 'lined-few-blocks';
          use = again;
        }
        /** @type {[[number, number], [number, number]]} */
        const at = [[0, 0], [0, 0]];
        let unlockDb = Infinity;
        for (const j of /** @type {(0|1)[]} */ ([0, 1])) {
          /** @type {Float64Array|null} */
          let unshifted = null;
          for (const k of /** @type {(0|1)[]} */ ([0, 1])) {
            let curve;
            if (linedUp(j, k)) curve = mixBands(bandMeans(shiftedColumns(stacks[j], d[j], use[j][k], envelopeRate), quiet).excess, weights);
            else curve = unshifted ??= curveOf(j, d[j]);
            const { sounds } = findSounds(curve, ms, quiet);
            if (!sounds.length) return 'lined-lost';
            let nearest = sounds[0];
            for (const e of sounds) if (Math.abs(e.onsetMs - near[j][k]) < Math.abs(nearest.onsetMs - near[j][k])) nearest = e;
            if (Math.abs(nearest.onsetMs - near[j][k]) > LINED_NEAR_MS) return 'lined-far';
            // The beats were read later by their shifts, so the sound's own time is later by
            // their mean.
            at[j][k] = nearest.onsetMs + mean(use[j][k]);
            if (k === 0) unlockDb = Math.min(unlockDb, nearest.levelDb);
          }
        }
        if (!at.every(([unlock, lock]) => shortest <= lock - unlock && lock - unlock <= longest)) return 'lift-range';
        return { at, unlockDb };
      };
      const lined = read(null, null);
      if (typeof lined === 'string') return { ...out, why: lined };
      whole = lined;
    }
  }

  const reading = readingsOf(whole, timestampGapMs);
  out.unlockGapMs = reading.unlockGapMs;
  out.beatErrorMs = Math.abs(reading.unlockGapMs);
  out.lockGapMs = reading.lockGapMs;
  out.liftMs = reading.liftMs;
  out.amplitude = amplitudeOf(liftAngle, bph, 0.5 * (reading.liftMs[0] + reading.liftMs[1]));
  out.amplitudes = [amplitudeOf(liftAngle, bph, reading.liftMs[0]), amplitudeOf(liftAngle, bph, reading.liftMs[1])];
  out.unlockDb = whole.unlockDb;
  out.beatErrorHeld = out.amplitudeHeld = 'unchecked';
  if (resamples <= 0) return out;

  // Each beat is drawn with its timestamp, so the gap between the two types' timestamps is
  // drawn too. On a regular watch that gap is known to a hundredth of a millisecond; on an
  // irregular one it is most of the uncertainty, and without it such watches were stated 3 to
  // 18 times more precisely than they are.
  /** @type {{unlockGapMs: number[], lockGapMs: number[], tick: number[], tock: number[], amplitude: number[]}} */
  const kept = { unlockGapMs: [], lockGapMs: [], tick: [], tock: [], amplitude: [] };
  let other = 0;
  for (let r = 0; r < resamples; r++) {
    const d0 = draw(stacks[0].count);
    const d1 = draw(stacks[1].count);
    const places = read(d0, d1);
    if (typeof places === 'string') {
      if (each) each(places);
      continue;
    }
    if (places.at.some((type, j) => type.some((v, k) => Math.abs(v - whole.at[j][k]) > OTHER_SOUND_MS))) {
      other++;
      if (each) each('other-sound');
      continue;
    }
    const gapMs = median(Array.from(d1, (i) => beats[1].residualMs[i])) - median(Array.from(d0, (i) => beats[0].residualMs[i]));
    const drawn = readingsOf(places, gapMs);
    kept.unlockGapMs.push(drawn.unlockGapMs);
    kept.lockGapMs.push(drawn.lockGapMs);
    kept.tick.push(drawn.liftMs[0]);
    kept.tock.push(drawn.liftMs[1]);
    kept.amplitude.push(amplitudeOf(liftAngle, bph, 0.5 * (drawn.liftMs[0] + drawn.liftMs[1])));
    if (each) each({ ...drawn, places });
  }
  const found = kept.unlockGapMs.length;
  // Counted, not 1 less the share kept: 1 - 95 / 100 is a hair over 0.05, which once put a
  // reading exactly at the limit over it.
  out.failing = (resamples - found) / resamples;
  out.otherSound = other / resamples;
  if (found < MIN_RESAMPLES_KEPT) {
    if (out.failing > MAX_FAILING) out.beatErrorHeld = out.amplitudeHeld = 'failing';
    return out;
  }
  out.scatter = { unlockGapMs: std(kept.unlockGapMs), lockGapMs: std(kept.lockGapMs), liftMs: [std(kept.tick), std(kept.tock)], amplitude: std(kept.amplitude) };
  // The first reason that applies is the one given: sounds that are often not found leave
  // nothing to say about the watch, and what the pipeline knows of the watch comes before the
  // scatter of a reading it would not show anyway.
  const failing = out.failing > MAX_FAILING;
  out.beatErrorHeld = failing ? 'failing' : irregular ? 'irregular' : halfway ? 'halfway' : out.scatter.unlockGapMs > MAX_BEAT_ERROR_SCATTER_MS ? 'scatter' : null;
  out.amplitudeHeld = failing ? 'failing' : halfway ? 'halfway' : out.scatter.amplitude > MAX_AMPLITUDE_SCATTER ? 'scatter' : null;
  out.showBeatError = out.beatErrorHeld === null;
  out.showAmplitude = out.amplitudeHeld === null;
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
 * @param {ReadOptions} [options]
 * @returns {SoundsReading}
 */
export function measureSounds(rows, envelopeRate, beats, bph, liftAngle, toPosition, options = {}) {
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
  const { gapMs, slope } = timestampGap(t, n);
  const stacked = /** @type {[TypeBeats, TypeBeats]} */ ([0, 1].map((j) => {
    const stack = stackBeats(rows, t[j].map(toPosition), before, after);
    return {
      stack,
      times: Float64Array.from(stack.kept, (i) => t[j][i]),
      residualMs: Float64Array.from(stack.kept, (i) => (t[j][i] - slope * n[j][i]) * 1e3),
    };
  }));
  return readBeats(stacked, envelopeRate, gapMs, bph, liftAngle, options);
}
