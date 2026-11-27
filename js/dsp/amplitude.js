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
// A noisy timestamp smears the averaged sounds, and when the unlock helps the earlier stages
// time the beat it also lines the unlock's noise up. The beat error then moves one way, by an
// amount the resamples cannot see: they draw the beats with their timestamps, so they see the
// scatter and not the shift. Both readings are therefore made a second time with every beat
// placed on the trend of its type's timestamps, and the difference between the two readings of
// each is added to its stated scatter (the placement check).
//
// A port of tools/prototype/coaxial/events.py (`lift_limits`, `pair_beats`, `amplitude`,
// `block_shifts`, `moved`, `reliable`, `beat_shifts`, `running_median`, `beat_times` and
// `measure`).

import { median, medianInPlace, mean, std, seededRandom, chiSquaredQuantile } from './mathutil.js';
import {
  STRETCH_BEFORE_S, STRETCH_AFTER_S, stackBeats, stretchMs, samplesBefore, rankBand, shiftedBandMeans, bandMeans, energyWeights, mixBands,
  findSounds, smoothForMatching, shiftOf, MAX_SHIFT_MS, MATCH_SMOOTH_MS,
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
 * Timestamps whose distances from their straight line are averaged, by their median, for the
 * trend that the placement check puts every beat on.
 */
export const TREND_BEATS = 15;

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
 * - `unplaced`: with every beat placed on the trend of its timestamps the sounds were not
 *   found, so neither reading could be checked
 * - `placement`: the resamples agree, but the reading moves too far when every beat is placed
 *   on the trend of its timestamps
 * - `one-block`: the beats span less than two blocks, so nothing could show whether a sound
 *   moves, and a moving one would not be lined up; only the amplitude is held for this, since
 *   its scatter does not cover what that does to it, while the beat error's scatter doubles.
 *   A made-up watch whose amplitude fell 36 degrees over 15 s read 6 degrees low at a scatter
 *   under 2 (decided by Lawrence Fan on 27 November 2026, when the first reading in real time
 *   came down to 15 s of beats)
 * @typedef {'unchecked'|'failing'|'irregular'|'halfway'|'scatter'|'unplaced'|'placement'|'one-block'} Held
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
 * The ticks and the tocks stacked for reading, with the gap between the two types' timestamps;
 * or why there are none, with each type's confident timestamps counted.
 * @typedef {{beats: [TypeBeats, TypeBeats], gapMs: number, why: null} | {why: 'few-beats'|'averaged', counts: [number, number]}} StackedBeats
 */

/**
 * What the placement check came to: the beat error and the amplitude read a second time, with
 * every beat on the trend of its type's timestamps.
 * @typedef {Object} Placement
 * @property {number|null} unlockGapMs the second reading of the gap between the unlocks; null
 *   when it found no sounds
 * @property {number|null} differenceMs the reading less the second reading; null with it
 * @property {number} resampledScatterMs the beat error's scatter over the resamples alone,
 *   before the difference was added to it
 * @property {number|null} amplitude the second reading of the amplitude, in degrees; null when
 *   it found no sounds
 * @property {number|null} amplitudeDifference the amplitude less its second reading; null with it
 * @property {number} resampledAmplitudeScatter the amplitude's scatter over the resamples
 *   alone, before the difference was added to it
 * @property {NoReading|null} why why the second reading found no sounds
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
 * @property {boolean} [placementCheck] false leaves the placement check out, as before it was
 *   added; `measureSounds` and the real-time stage make it otherwise
 * @property {StackedBeats|null} [onTrend] the same beats placed on the trend of their timestamps
 *   (`trendBeats`): given, the beat error and the amplitude are read a second time from them
 *   once the resamples have given them a scatter, and each difference is added to its scatter
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
 * @property {Pair|null} pair the unlock and the lock chosen in the plain average
 * @property {[[number, number], [number, number]]|null} places for the tick and the tock, where
 *   the unlock and the lock start, in milliseconds from the timestamp: the places the readings
 *   rest on, which are the lined-up ones when the beats were lined up again
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
 *   than MIN_RESAMPLES_KEPT did. After the placement check, `unlockGapMs` and `amplitude` also
 *   hold the difference between their two readings, added as the root of the sum of squares
 * @property {Placement|null} placement what the placement check came to; null when it was not made
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
 * A reading with nothing in it yet, or one that was not made.
 * @param {number} bph
 * @param {number} liftAngle
 * @param {[number, number]} counts each type's beats
 * @param {NoReading|null} why
 * @returns {SoundsReading}
 */
export function noReading(bph, liftAngle, counts, why) {
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
    places: null,
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
    placement: null,
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
 * @param {[[boolean, boolean], [boolean, boolean]]|null} [wanted] for the tick and the tock,
 *   whether the unlock's shifts are wanted and whether the lock's are; all four when absent. A
 *   shift not wanted is not a number, and only the parts of each block's averaged beat that the
 *   wanted ones are matched in are worked out: a resample of lined-up beats needs the shifts of
 *   the sounds it lines up and no others
 * @returns {Generator<void, [BlockShifts, BlockShifts], void>} pausing after each of those draws
 */
function* blockShifts(m, drawn, starts, resamples, draw, wanted = null) {
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
  // The instants of each type's averaged beat that a match reads: the quiet stretch, which gives
  // each band its level, and around each wanted sound as far as it is looked for, with the
  // samples the smoothing reaches into.
  const dt = m.ms[1] - m.ms[0];
  const reach = Math.round(MAX_SHIFT_MS / dt) + Math.max(1, Math.round(MATCH_SMOOTH_MS / dt));
  const only = [0, 1].map((j) => {
    const mask = new Uint8Array(m.ms.length);
    mask.fill(1, 0, m.quiet);
    for (const k of [0, 1]) {
      if (wanted && !wanted[j][k]) continue;
      const from = Math.max(0, samplesBefore(m.ms, m.windows[j][k][0]) - reach);
      const to = Math.min(mask.length, samplesBefore(m.ms, m.windows[j][k][1]) + reach);
      if (to > from) mask.fill(1, from, to);
    }
    return mask;
  });
  /** @param {0|1} j @param {ArrayLike<number>} beats */
  const curveOf = (j, beats) => smoothForMatching(mixBands(bandMeans(m.columns[j], m.quiet, beats, only[j]).excess, m.weights), m.ms);
  /** @param {0|1} j @param {0|1} k */
  const want = (j, k) => !wanted || wanted[j][k];
  /** @type {BlockShifts[]} */
  const out = [];
  for (const type of /** @type {(0|1)[]} */ ([0, 1])) {
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
      if (!want(type, 0) && !want(type, 1)) {
        for (const k of [0, 1]) {
          shifts[k].push(NaN);
          scatter[k].push(NaN);
        }
        continue;
      }
      const curve = curveOf(type, beats);
      for (const k of /** @type {(0|1)[]} */ ([0, 1])) shifts[k].push(want(type, k) ? shiftOf(m.templates[type], curve, m.ms, m.windows[type][k][0], m.windows[type][k][1]) ?? NaN : NaN);
      if (!resamples) continue;
      /** @type {[number[], number[]]} */
      const got = [[], []];
      for (let r = 0; r < resamples; r++) {
        const again = curveOf(type, draw(beats.length).map((i) => beats[i]));
        for (const k of /** @type {(0|1)[]} */ ([0, 1])) {
          const v = want(type, k) ? shiftOf(m.templates[type], again, m.ms, m.windows[type][k][0], m.windows[type][k][1]) : null;
          if (v !== null) got[k].push(v);
        }
        yield;
      }
      for (const k of [0, 1]) scatter[k].push(got[k].length >= BLOCK_PLACED * resamples ? std(got[k]) : NaN);
    }
    out.push({ mids, shifts: [Float64Array.from(shifts[0]), Float64Array.from(shifts[1])], scatter: resamples ? [Float64Array.from(scatter[0]), Float64Array.from(scatter[1])] : null });
  }
  return [out[0], out[1]];
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
 * Why each reading is not to be shown, from its resamples and from what the earlier stages
 * know of the watch. The first reason that applies is the one given: sounds that are often not
 * found leave nothing to say about the watch, and what the pipeline knows of the watch comes
 * before the scatter of a reading it would not show anyway.
 * The placement check comes last: a reading whose resamples already scatter too far is held
 * for that, one that could not be checked is held for that, and one that the resamples support
 * is held when the difference between its two readings takes its scatter over the limit.
 * @param {Pick<SoundsReading, 'amplitude'|'failing'|'scatter'|'placement'> & {lining?: SoundsReading['lining']}} reading
 *   one with its resamples counted; without `lining`, or with it null, the blocks are not judged
 * @param {boolean} irregular the pipeline found the watch's beats falling at scattered times
 * @param {boolean} halfway the pipeline found a beat halfway between the tick and the tock
 * @returns {{beatError: Held|null, amplitude: Held|null}} null for a reading to show, and for
 *   one that was never made
 */
export function heldBack(reading, irregular, halfway) {
  if (reading.amplitude === null) return { beatError: null, amplitude: null };
  if (reading.failing === null) return { beatError: 'unchecked', amplitude: 'unchecked' };
  const failing = reading.failing > MAX_FAILING;
  if (!reading.scatter) return failing ? { beatError: 'failing', amplitude: 'failing' } : { beatError: 'unchecked', amplitude: 'unchecked' };
  const placed = reading.placement;
  const resampled = placed ? placed.resampledScatterMs : reading.scatter.unlockGapMs;
  /** @type {Held|null} */
  let beatError = null;
  if (failing) beatError = 'failing';
  else if (irregular) beatError = 'irregular';
  else if (halfway) beatError = 'halfway';
  else if (resampled > MAX_BEAT_ERROR_SCATTER_MS) beatError = 'scatter';
  else if (placed && placed.differenceMs === null) beatError = 'unplaced';
  else if (reading.scatter.unlockGapMs > MAX_BEAT_ERROR_SCATTER_MS) beatError = 'placement';
  const resampledAmplitude = placed ? placed.resampledAmplitudeScatter : reading.scatter.amplitude;
  /** @type {Held|null} */
  let amplitude = null;
  if (failing) amplitude = 'failing';
  else if (halfway) amplitude = 'halfway';
  else if (resampledAmplitude > MAX_AMPLITUDE_SCATTER) amplitude = 'scatter';
  else if (placed && placed.amplitudeDifference === null) amplitude = 'unplaced';
  else if (reading.scatter.amplitude > MAX_AMPLITUDE_SCATTER) amplitude = 'placement';
  else if (reading.lining && reading.lining.blocks < 2) amplitude = 'one-block';
  return { beatError, amplitude };
}

/**
 * The readings of the ticks' and the tocks' stacked beats, with their scatter and whether they
 * may be shown: `readBeats`, as steps that can be taken a few at a time. A reading with its 200
 * draws takes from half a second to several seconds of computing, and the real-time pipeline
 * has audio to keep up with meanwhile. Each step is a piece of the work a few milliseconds
 * long. The draws come in the same order however the steps are spread, so the result is the
 * same.
 * @param {[TypeBeats, TypeBeats]} beats the ticks and the tocks; they must not change until the
 *   last step is taken
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {number} timestampGapMs from `timestampGap`
 * @param {number} bph
 * @param {number} liftAngle
 * @param {ReadOptions} [options]
 * @returns {Generator<void, SoundsReading, void>}
 */
export function* readBeatsSteps(beats, envelopeRate, timestampGapMs, bph, liftAngle, options = {}) {
  const { resamples = RESAMPLES, lineUp = 'moved', seed = 1, irregular = false, halfway = false, each, onTrend = null } = options;
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
  // Each instant's beats are ranked once, for every average of these beats that follows.
  /** @type {BeatColumns[]} */
  const ranked = [];
  for (const stack of stacks) {
    /** @type {Uint16Array[]} */
    const order = [];
    for (let b = 0; b < stack.bands.length; b++) {
      order.push(rankBand(stack, b));
      yield;
    }
    ranked.push({ bands: stack.bands, count: stack.count, length: stack.length, order });
  }
  const columns = /** @type {[BeatColumns, BeatColumns]} */ ([ranked[0], ranked[1]]);

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
  yield;

  /** @param {0|1} j @param {Int32Array|null} d the averaged beat of the beats drawn, or of all */
  const curveOf = (j, d) => mixBands(bandMeans(columns[j], quiet, d ?? undefined).excess, weights);
  /** @param {Pair} p @returns {Places} */
  const placesOf = (p) => ({
    at: [[p.unlock[0].onsetMs, p.lock[0].onsetMs], [p.unlock[1].onsetMs, p.lock[1].onsetMs]],
    unlockDb: Math.min(p.unlock[0].levelDb, p.unlock[1].levelDb),
  });
  /**
   * Where a draw of the beats puts the sounds, or why it finds none.
   * @type {(d0: Int32Array|null, d1: Int32Array|null) => Generator<void, Places | NoReading, void>}
   */
  let read = function* (d0, d1) {
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
    const blocks = yield* blockShifts(matching, [null, null], null, BLOCK_RESAMPLES, draw);
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
    /** @type {[[boolean, boolean], [boolean, boolean]]} */
    const lined = [[linedUp(0, 0), linedUp(0, 1)], [linedUp(1, 0), linedUp(1, 1)]];
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
      read = function* (d0, d1) {
        const d = [d0, d1];
        let use = shifts;
        if (d0 && d1) {
          // The whole procedure again on the beats drawn: their shifts in the whole set's
          // blocks, and the drawn beats lined up on them. A wrong shift moves a lined-up sound
          // one way and the mean shift added back the other, so drawing the shifts alone, with
          // the beats left as the whole set lined them up, would overstate the scatter.
          const again = beatShifts(withoutLeftOut(yield* blockShifts(matching, [d0, d1], starts, 0, draw, lined)), [Array.from(d0, (i) => matching.times[0][i]), Array.from(d1, (i) => matching.times[1][i])], moved);
          if (!again) return 'lined-few-blocks';
          use = again;
          yield;
        }
        /** @type {[[number, number], [number, number]]} */
        const at = [[0, 0], [0, 0]];
        let unlockDb = Infinity;
        for (const j of /** @type {(0|1)[]} */ ([0, 1])) {
          /** @type {Float64Array|null} */
          let unshifted = null;
          for (const k of /** @type {(0|1)[]} */ ([0, 1])) {
            let curve;
            if (linedUp(j, k)) {
              curve = mixBands(shiftedBandMeans(stacks[j], d[j], use[j][k], envelopeRate, quiet).excess, weights);
              yield;
            } else {
              curve = unshifted ??= curveOf(j, d[j]);
            }
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
      const linedPlaces = yield* read(null, null);
      if (typeof linedPlaces === 'string') return { ...out, why: linedPlaces };
      whole = linedPlaces;
    }
  }

  const reading = readingsOf(whole, timestampGapMs);
  out.places = whole.at;
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
    const places = yield* read(d0, d1);
    yield;
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
  if (found >= MIN_RESAMPLES_KEPT) out.scatter = { unlockGapMs: std(kept.unlockGapMs), lockGapMs: std(kept.lockGapMs), liftMs: [std(kept.tick), std(kept.tock)], amplitude: std(kept.amplitude) };

  if (onTrend && out.scatter) {
    // The placement check: the same reading with every beat on the trend of its timestamps,
    // from the same envelopes and with no resamples. The trend is not used for the readings
    // themselves: it smears a watch whose beats really scatter, by 0.12 ms with 0.3 ms of
    // jitter. The draws carry on from the reading's own, so one seed still gives one result.
    const second = onTrend.why === null ? yield* readBeatsSteps(onTrend.beats, envelopeRate, onTrend.gapMs, bph, liftAngle, { resamples: 0, lineUp, draw }) : null;
    const resampledScatterMs = out.scatter.unlockGapMs;
    const resampledAmplitudeScatter = out.scatter.amplitude;
    if (second && second.unlockGapMs !== null && second.amplitude !== null) {
      const differenceMs = reading.unlockGapMs - second.unlockGapMs;
      // The amplitude too (decided on 26 November): timestamps that are wrong for many beats
      // of one type can put another sound where the unlock is looked for, and the draws then
      // agree on a time from unlock to lock that is not the watch's.
      const amplitudeDifference = out.amplitude - second.amplitude;
      out.placement = { unlockGapMs: second.unlockGapMs, differenceMs, resampledScatterMs, amplitude: second.amplitude, amplitudeDifference, resampledAmplitudeScatter, why: null };
      out.scatter = { ...out.scatter, unlockGapMs: Math.hypot(resampledScatterMs, differenceMs), amplitude: Math.hypot(resampledAmplitudeScatter, amplitudeDifference) };
    } else {
      // No sounds on the trend: neither reading can be checked, and both are held back.
      out.placement = { unlockGapMs: null, differenceMs: null, resampledScatterMs, amplitude: null, amplitudeDifference: null, resampledAmplitudeScatter, why: second ? second.why : onTrend.why };
    }
  }
  const held = heldBack(out, irregular, halfway);
  out.beatErrorHeld = held.beatError;
  out.amplitudeHeld = held.amplitude;
  out.showBeatError = out.beatErrorHeld === null;
  out.showAmplitude = out.amplitudeHeld === null;
  return out;
}

/**
 * The readings of the ticks' and the tocks' stacked beats, with their scatter and whether they
 * may be shown, in one call.
 * @param {[TypeBeats, TypeBeats]} beats the ticks and the tocks
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {number} timestampGapMs from `timestampGap`
 * @param {number} bph
 * @param {number} liftAngle
 * @param {ReadOptions} [options]
 * @returns {SoundsReading}
 */
export function readBeats(beats, envelopeRate, timestampGapMs, bph, liftAngle, options = {}) {
  const steps = readBeatsSteps(beats, envelopeRate, timestampGapMs, bph, liftAngle, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * The median of the `k` values centred on each value (`k` odd). Near either end the window
 * holds only the values there are, so an end is not pulled towards zero, nor left with its own
 * value's noise.
 * @param {ArrayLike<number>} values
 * @param {number} k
 * @returns {Float64Array}
 */
export function runningMedian(values, k) {
  const half = (k - 1) / 2;
  const out = new Float64Array(values.length);
  const window = new Float64Array(k);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length, i + half + 1);
    for (let m = from; m < to; m++) window[m - from] = values[m];
    out[i] = medianInPlace(window, to - from);
  }
  return out;
}

/**
 * Every beat of one type placed on the trend of its confident timestamps: a straight line
 * through them against beat number, and the median of each TREND_BEATS timestamps' distances
 * from it, read off between them. Beats the earlier stages were not confident of are placed too,
 * and every beat's own timing noise is left out of its place.
 * @param {ArrayLike<number>} t the type's confident timestamps in seconds, in order
 * @param {ArrayLike<number>} n their beat numbers, every second whole number
 * @returns {{t: number[], n: number[]}} a time for every beat of the type from the first
 *   confident one to the last
 */
export function trendTimes(t, n) {
  const count = t.length;
  let nMean = 0;
  let tMean = 0;
  for (let i = 0; i < count; i++) {
    nMean += n[i];
    tMean += t[i];
  }
  nMean /= count;
  tMean /= count;
  let snn = 0;
  let snt = 0;
  for (let i = 0; i < count; i++) {
    snn += (n[i] - nMean) * (n[i] - nMean);
    snt += (n[i] - nMean) * (t[i] - tMean);
  }
  const slope = snt / snn;
  const numbers = Array.from(n);
  // Taken from the means, so that the line's place does not rest on the product of a slope and
  // a beat number of thousands.
  const line = (/** @type {number} */ at) => tMean + slope * (at - nMean);
  const trend = Array.from(runningMedian(Float64Array.from(t, (v, i) => v - line(n[i])), TREND_BEATS));
  /** @type {{t: number[], n: number[]}} */
  const out = { t: [], n: [] };
  const first = Math.ceil(Math.min(...numbers));
  const last = Math.floor(Math.max(...numbers));
  for (let at = first; at <= last; at += 2) {
    out.n.push(at);
    out.t.push(line(at) + interpolate(at, numbers, trend));
  }
  return out;
}

/**
 * Each type's confident timestamps and their beat numbers.
 * @param {Pick<BeatSeries, 't'|'n'|'ok'>[]} beats the ticks' and the tocks' timestamps
 * @returns {{t: [number[], number[]], n: [number[], number[]]}}
 */
function confident(beats) {
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
  return { t, n };
}

/**
 * Beats at given times stacked for reading, with the gap between the two types' times.
 * @param {Float32Array[]} rows
 * @param {number} envelopeRate
 * @param {[number[], number[]]} t each type's times in seconds
 * @param {[number[], number[]]} n and their beat numbers
 * @param {(seconds: number) => number} toPosition
 * @returns {{beats: [TypeBeats, TypeBeats], gapMs: number, why: null}}
 */
function stackedAt(rows, envelopeRate, t, n, toPosition) {
  const before = Math.floor(STRETCH_BEFORE_S * envelopeRate);
  const after = Math.floor(STRETCH_AFTER_S * envelopeRate);
  const { gapMs, slope } = timestampGap(t, n);
  const stacked = /** @type {[TypeBeats, TypeBeats]} */ ([0, 1].map((j) => {
    const stack = stackBeats(rows, t[j].map(toPosition), before, after);
    return {
      stack,
      times: Float64Array.from(stack.kept, (i) => t[j][i]),
      residualMs: Float64Array.from(stack.kept, (i) => (t[j][i] - slope * n[j][i]) * 1e3),
    };
  }));
  return { beats: stacked, gapMs, why: null };
}

/**
 * The timed beats of a stretch of envelope, stacked for reading. Only beats the pipeline timed
 * alone are read. When a beat type's timestamps each average several cycles there is nothing to
 * stack: placing such beats on the trend of their timestamps read simulated watches 0.04 ms
 * high on average and 1.6 times their stated scatter.
 * @param {Float32Array[]} rows the envelope of each band the sounds are read from, before
 *   Cleanup (`soundRows` in js/dsp/sounds.js): clipping and equal weights hid the Omega's unlock
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {Pick<BeatSeries, 'K'|'t'|'n'|'ok'>[]} beats the ticks' and the tocks' timestamps
 * @param {(seconds: number) => number} toPosition where a time lies in `rows`, in samples and
 *   fractions of one
 * @returns {StackedBeats} the stacked beats, copied out of `rows`, and the gap between the two
 *   types' timestamps; or why there are none, with each type's confident timestamps counted
 */
export function timedBeats(rows, envelopeRate, beats, toPosition) {
  const { t, n } = confident(beats);
  if (Math.min(t[0].length, t[1].length) < MIN_BEATS) return { why: 'few-beats', counts: [t[0].length, t[1].length] };
  if (beats[0].K > 1 || beats[1].K > 1) return { why: 'averaged', counts: [t[0].length, t[1].length] };
  return stackedAt(rows, envelopeRate, t, n, toPosition);
}

/**
 * The same stretch's beats stacked with every beat on the trend of its type's confident
 * timestamps (`trendTimes`), for the placement check. The gap between the two types is the gap
 * between their trends.
 * @param {Float32Array[]} rows as for `timedBeats`
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {Pick<BeatSeries, 't'|'n'|'ok'>[]} beats the ticks' and the tocks' timestamps
 * @param {(seconds: number) => number} toPosition as for `timedBeats`
 * @returns {StackedBeats}
 */
export function trendBeats(rows, envelopeRate, beats, toPosition) {
  const { t, n } = confident(beats);
  if (Math.min(t[0].length, t[1].length) < MIN_BEATS) return { why: 'few-beats', counts: [t[0].length, t[1].length] };
  const placed = [trendTimes(t[0], n[0]), trendTimes(t[1], n[1])];
  return stackedAt(rows, envelopeRate, [placed[0].t, placed[1].t], [placed[0].n, placed[1].n], toPosition);
}

/**
 * The sounds' readings for a stretch of audio whose beats have been timed: the whole-recording
 * entry. The placement check is made unless `placementCheck` is false.
 * @param {Float32Array[]} rows the envelope of each band the sounds are read from, as for
 *   `timedBeats`
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
  const timed = timedBeats(rows, envelopeRate, beats, toPosition);
  if (timed.why !== null) return noReading(bph, liftAngle, timed.counts, timed.why);
  const placed = options.placementCheck === false ? null : trendBeats(rows, envelopeRate, beats, toPosition);
  return readBeats(timed.beats, envelopeRate, timed.gapMs, bph, liftAngle, { ...options, onTrend: placed });
}
