// The sounds inside each beat (js/dsp/sounds.js) and the readings that rest on them
// (js/dsp/amplitude.js): milestone 8's stage after the timestamps, ported from the prototype in
// tools/prototype/coaxial/. Here the stage is tested on its own, without the pipeline. The
// ported helpers are held to what SciPy and NumPy give for the same input. The readings, their
// scatter, the gates and the lining up are held to made-up watches given straight as envelopes
// (tests/helpers/envelopes.js), whose truth is exact and which read in a fraction of a second.
// Simulated watches that go through the pipeline are in sounds-watches.test.js, and the real
// recordings in recordings.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { madeUpWatch } from './helpers/envelopes.js';
import { seededRandom } from '../js/audio/simulator.js';
import { seededRandom as fromMathutil, chiSquaredQuantile, chiSquaredBelow } from '../js/dsp/mathutil.js';
import {
  stackBeats, stretchMs, samplesBefore, toColumns, shiftedColumns, shiftedBandMeans, bandMeans, energyWeights, mixBands, smooth, findPeaks, findSounds,
  smoothForMatching, shiftOf,
} from '../js/dsp/sounds.js';
import {
  liftLimits, amplitudeOf, pairBeats, timestampGap, movedSounds, readBeats, readBeatsSteps, timedBeats, trendBeats, trendTimes, runningMedian, heldBack, measureSounds,
  TREND_BEATS,
} from '../js/dsp/amplitude.js';

/** @typedef {import('../js/dsp/sounds.js').Sound} Sound */

/**
 * @param {ArrayLike<number>} got
 * @param {number[]} want
 * @param {number} tolerance
 * @param {string} what
 */
function assertClose(got, want, tolerance, what) {
  assert.equal(got.length, want.length, `${what}: length`);
  want.forEach((v, i) => assert.ok(Math.abs(got[i] - v) <= tolerance, `${what}: value ${i} is ${got[i]}, expected ${v}`));
}

test('peaks are found as SciPy finds them: by prominence, the lower of two close ones left out, a flat top once, never at an end', () => {
  // Expected positions from scipy.signal.find_peaks(x, prominence=..., distance=...), SciPy 1.18.
  const close = [0, 1, 5, 2, 4, 1, 0, 0, 3, 0];
  assert.deepEqual(findPeaks(close, 0.5, 3), [2, 8], 'the peak 2 samples from a higher one is left out');
  assert.deepEqual(findPeaks(close, 0.5, 1), [2, 4, 8]);
  // The peak at 3 stands 1 over its valley but only 0.5 over the one towards higher ground, and
  // the one at 7 stands 0.1 over its valley.
  assert.deepEqual(findPeaks([0, 6, 4, 5, 4.5, 7, 0, 2, 1.9, 2.5, 0], 1, 1), [1, 5, 9]);
  assert.deepEqual(findPeaks([0, 1, 3, 3, 3, 1, 0, 2, 2, 0], 0.5, 1), [3, 7], 'a flat top counts once, at its middle');
  assert.deepEqual(findPeaks([5, 1, 2, 1, 6], 0.1, 1), [2], 'the ends are not peaks');
});

test('smoothing is NumPy\'s: a Hann window without its zero ends, the curve zero beyond its own ends', () => {
  // Expected values from np.convolve(e, w / w.sum(), mode='same') with w = np.hanning(k + 2)[1:-1].
  const e = Float64Array.from([0, 0, 1, 0, 0, 2, 4, 0]);
  assertClose(smooth(e, 3), [0, 0.25, 0.5, 0.25, 0.5, 2, 2.5, 1], 1e-12, 'over 3');
  assertClose(smooth(e, 4), [0, 0.138196601125, 0.361803398875, 0.361803398875, 0.414589803375, 1.27639320225, 2.17082039325, 1.72360679775], 1e-11, 'over 4');
  assertClose(smooth(e, 5), [1 / 12, 0.25, 1 / 3, 5 / 12, 11 / 12, 5 / 3, 11 / 6, 7 / 6], 1e-12, 'over 5');
  assert.deepEqual(Array.from(smooth(e, 1)), Array.from(e), 'over one sample, nothing changes');
});

test('each beat\'s stretch is read at its timestamp\'s fraction of a sample, and a beat too near either end is left out', () => {
  const ramp = Float32Array.from({ length: 100 }, (_, i) => i);
  const square = Float32Array.from({ length: 100 }, (_, i) => i * i);
  // 4 samples before and 2 after: the beat at 3 starts before the audio does, and the one at
  // 97.5 needs the sample after the last.
  const stack = stackBeats([ramp, square], [10.25, 3, 97.5, 50], 4, 2);
  assert.equal(stack.count, 2);
  assert.equal(stack.length, 7);
  assert.deepEqual(Array.from(stack.kept), [0, 3]);
  // The beats lie side by side: the first sample of each, then the second of each.
  assertClose(stack.bands[0], [6.25, 46, 7.25, 47, 8.25, 48, 9.25, 49, 10.25, 50, 11.25, 51, 12.25, 52], 1e-6, 'the ramp');
  // Between two samples the envelope is read off the straight line joining them.
  assert.ok(Math.abs(stack.bands[1][4 * 2] - (0.75 * 100 + 0.25 * 121)) < 1e-4, `the square at 10.25 reads ${stack.bands[1][4 * 2]}`);
  assertClose(stretchMs(4, 7, 12000), [-4 / 12, -3 / 12, -2 / 12, -1 / 12, 0, 1 / 12, 2 / 12], 1e-12, 'milliseconds from the timestamp');
  assert.equal(samplesBefore(stretchMs(4, 7, 12000), -0.2), 2);
});

/**
 * A stack of one band in which every beat is 1 for two samples and then 3 for three, with one
 * beat's fourth sample replaced by a click.
 * @param {number} beats
 * @returns {import('../js/dsp/sounds.js').BeatStack}
 */
function stackWithClick(beats) {
  const band = new Float32Array(beats * 5);
  for (let b = 0; b < beats; b++) [1, 1, 3, 3, 3].forEach((v, k) => (band[k * beats + b] = v));
  band[3 * beats + 7] = 1000;
  return { bands: [band], count: beats, length: 5, before: 2, kept: Int32Array.from({ length: beats }, (_, i) => i) };
}

test('the averaged beat leaves out the highest and lowest twentieth of the beats at each instant, so one click does not show', () => {
  // As scipy.stats.trim_mean(M, 0.05): int(0.05 n) beats go from each end, so 1 of 20 and none of 19.
  const twenty = bandMeans(toColumns(stackWithClick(20)), 2);
  assertClose(twenty.levels, [1], 1e-12, 'quiet level');
  assertClose(twenty.excess[0], [0, 0, 2, 2, 2], 1e-12, '20 beats');
  const nineteen = bandMeans(toColumns(stackWithClick(19)), 2);
  assertClose(nineteen.excess[0], [0, 0, 2, 2 + 997 / 19, 2], 1e-9, '19 beats: nothing is left out, and the click shows');
  // A resample draws beats with repeats: here the beat with the click, three times over in ten.
  const drawn = bandMeans(toColumns(stackWithClick(20)), 2, [7, 7, 7, 0, 1, 2, 3, 4, 5, 6]);
  assertClose(drawn.excess[0], [0, 0, 2, 2 + 3 * 997 / 10, 2], 1e-9, 'ten drawn beats');
  // Drawn twice in 39, the click is two of the 39 values and only one goes from each end.
  const twice = bandMeans(toColumns(stackWithClick(20)), 2, [7, 7, ...Array.from({ length: 37 }, (_, i) => (i % 19) + (i % 19 >= 7 ? 1 : 0))]);
  assertClose(twice.excess[0], [0, 0, 2, 2 + 997 / 37, 2], 1e-9, '39 drawn beats');
});

test('the values to leave out are found the same whether the beats were ranked beforehand or not', () => {
  // Three bands of 60 beats of noise, with clicks; averaged whole, as a resample draws them, and
  // as a block of twelve.
  const random = fromMathutil(7);
  const count = 60;
  const length = 40;
  const bands = [0, 1, 2].map(() => Float32Array.from({ length: count * length }, () => (random() < 0.02 ? 300 : 1) * (0.2 + random() * random() * 4)));
  const stack = { bands, count, length, before: 30, kept: Int32Array.from({ length: count }, (_, i) => i) };
  const ranked = toColumns(stack);
  assert.ok(ranked.order && ranked.order.length === 3);
  const unranked = { ...ranked, order: null };
  // The expected values the slow way: each instant's values sorted, the ends dropped.
  /** @param {number[]} beats */
  const bySorting = (beats) => bands.map((band) => {
    const cut = Math.floor(0.05 * beats.length);
    const m = Array.from({ length }, (_, k) => {
      const column = beats.map((i) => band[k * count + i]).sort((p, q) => p - q).slice(cut, beats.length - cut);
      return column.reduce((sum, v) => sum + v, 0) / column.length;
    });
    const quiet = m.slice(0, 10).sort((p, q) => p - q);
    const level = 0.5 * (quiet[4] + quiet[5]);
    return m.map((v) => v / level - 1);
  });
  const all = Array.from({ length: count }, (_, i) => i);
  const draw = Array.from({ length: count }, () => Math.floor(random() * count));
  const block = all.slice(20, 32);
  for (const [label, beats, given] of /** @type {[string, number[], number[]|undefined][]} */ ([['all', all, undefined], ['a draw', draw, draw], ['a block', block, block]])) {
    const want = bySorting(beats);
    for (const columns of [ranked, unranked]) {
      const got = bandMeans(columns, 10, given);
      want.forEach((w, b) => assertClose(got.excess[b], w, 1e-9, `${label}, band ${b}, ${columns.order ? 'ranked' : 'unranked'}`));
    }
  }
});

test('a beat read later has its sounds earlier in its stretch, and keeps its end values past either end', () => {
  // Two beats side by side: the first climbs from 0 to 50, the second from 106 to 111.
  const ramp = Float32Array.from({ length: 12 }, (_, at) => (at % 2 === 0 ? 10 * (at >> 1) : 106 + (at >> 1)));
  const stack = { bands: [ramp], count: 2, length: 6, before: 3, kept: Int32Array.from([0, 1]) };
  // At 1 kHz a sample is a millisecond. The first beat read 1.5 ms later, the second 2 ms earlier.
  const columns = shiftedColumns(stack, null, [1.5, -2], 1000);
  assert.equal(columns.order, null);
  const beat = (/** @type {number} */ i) => Array.from({ length: 6 }, (_, k) => columns.bands[0][k * 2 + i]);
  assertClose(beat(0), [15, 25, 35, 45, 50, 50], 1e-6, 'later');
  assertClose(beat(1), [106, 106, 106, 107, 108, 109], 1e-6, 'earlier');
  // Beats drawn, each with its own shift: the second beat twice, unshifted and half a sample late.
  const drawn = shiftedColumns(stack, [1, 1], [0, 0.5], 1000);
  assertClose(Array.from({ length: 6 }, (_, k) => drawn.bands[0][k * 2 + 1]), [106.5, 107.5, 108.5, 109.5, 110.5, 111], 1e-6, 'half a sample');
});

test('beats read later are averaged in one pass as they are in two, each beat read once however often it was drawn, and an average can be worked out at chosen instants only', () => {
  // Two bands of 50 beats of noise with clicks, 60 samples long, side by side.
  const random = fromMathutil(11);
  const count = 50;
  const length = 60;
  const bands = [0, 1].map(() => Float32Array.from({ length: count * length }, () => (random() < 0.02 ? 200 : 1) * (0.3 + 3 * random() * random())));
  const stack = { bands, count, length, before: 40, kept: Int32Array.from({ length: count }, (_, i) => i) };
  // At 1 kHz a sample is a millisecond: shifts within a sample, of a few samples, and past the
  // ends of the stretch, where a beat keeps its end value.
  for (const [label, reach] of /** @type {[string, number][]} */ ([['within a sample', 0.9], ['a few samples', 4.5], ['past the ends', 90]])) {
    const each = Float64Array.from({ length: count }, () => (random() - 0.5) * 2 * reach);
    const draw = Int32Array.from({ length: count }, () => Math.floor(random() * count));
    // Nineteen beats: fewer than twenty, so that none is left out at either end.
    const few = draw.subarray(0, 19);
    for (const [which, beats] of /** @type {[string, Int32Array|null][]} */ ([['all the beats', null], ['a draw', draw], ['nineteen drawn', few]])) {
      const shifts = beats ? Float64Array.from(beats, (i) => each[i]) : each;
      const two = bandMeans(shiftedColumns(stack, beats, shifts, 1000), 12);
      const one = shiftedBandMeans(stack, beats, shifts, 1000, 12);
      assertClose(one.levels, Array.from(two.levels), 1e-12, `${label}, ${which}: quiet levels`);
      two.excess.forEach((want, b) => assertClose(one.excess[b], Array.from(want), 1e-12, `${label}, ${which}: band ${b}`));
    }
  }
  // Only the quiet stretch and a few instants wanted: those come out the same, ranked or not.
  const only = new Uint8Array(length);
  only.fill(1, 0, 12);
  only.fill(1, 30, 37);
  const ranked = toColumns(stack);
  const block = Int32Array.from({ length: 14 }, (_, i) => 3 * i);
  for (const columns of [ranked, { ...ranked, order: null }]) {
    const full = bandMeans(columns, 12, block);
    const part = bandMeans(columns, 12, block, only);
    assertClose(part.levels, Array.from(full.levels), 0, 'quiet levels');
    for (let b = 0; b < 2; b++) {
      for (let k = 0; k < length; k++) assert.equal(part.excess[b][k], only[k] ? full.excess[b][k] : -1, `band ${b}, instant ${k}`);
    }
  }
});

test('the bands are added by their energy: each by its quiet level, so the averaged beat is the excess energy over all of them', () => {
  const weights = energyWeights(Float64Array.from([1, 6]), Float64Array.from([3, 6]));
  assertClose(weights, [0.25, 0.75], 1e-12, 'weights');
  // A band at 4 times its quiet level and one at 2 times: 0.25 * 3 + 0.75 * 1.
  assertClose(mixBands([Float64Array.from([0, 3]), Float64Array.from([0, 1])], weights), [0, 1.5], 1e-12, 'mixture');
});

/**
 * An averaged beat with a little noise and straight-sided sounds.
 * @param {[number, number, number][]} sounds each sound's start and loudest moment in
 *   milliseconds, and its level; it falls back to nothing as fast as it rose
 */
function drawnBeat(sounds) {
  const ms = stretchMs(480, 625, 12000);
  const random = seededRandom(1);
  const curve = Float64Array.from(ms, () => 0.04 * (random() - 0.5));
  for (const [from, top, level] of sounds) {
    for (let k = 0; k < ms.length; k++) {
      const rise = (ms[k] - from) / (top - from);
      if (rise > 0 && rise < 2) curve[k] += level * (rise <= 1 ? rise : 2 - rise);
    }
  }
  return { curve, ms, quiet: samplesBefore(ms, -14.3) };
}

test('a sound starts where its rising edge is half way up in energy, from zero for the first and from the valley before for the rest', () => {
  // An unlock rising from -7 to -6.5 ms, two louder sounds from -3.5 and from -2.5 ms that take
  // as long, and a lock that starts at -1.9 ms, while the third sound is still falling, and
  // takes 1.5 ms to reach its loudest.
  const { curve, ms, quiet } = drawnBeat([[-7, -6.5, 4], [-3.5, -3, 40], [-2.5, -2, 40], [-1.9, -0.4, 60]]);
  const { sounds, noise } = findSounds(curve, ms, quiet);
  assert.ok(noise > 0.004 && noise < 0.02, `the noise, smoothed, scatters by ${noise}`);
  assertClose(sounds.map((e) => e.peakMs), [-6.5, -3, -2, -0.4], 0.05, 'loudest');
  // Smoothing over 0.25 ms rounds the top of a rise that takes 0.5 ms, by about a twelfth, so
  // half way up comes about 0.02 ms before the middle of the straight side.
  assert.ok(Math.abs(sounds[0].onsetMs - -6.75) < 0.03, `unlock starts ${sounds[0].onsetMs}`);
  assert.ok(Math.abs(sounds[1].onsetMs - -3.25) < 0.03, `second sound starts ${sounds[1].onsetMs}`);
  assert.ok(Math.abs(sounds[2].onsetMs - -2.25) < 0.03, `third sound starts ${sounds[2].onsetMs}`);
  // The lock's valley is at -1.5 ms, where the third sound ends and the lock has reached 16.
  // Half way from there to 60 is 38, which it passes at -0.95 ms; half way from zero would be
  // 30, passed at -1.15 ms.
  assert.ok(Math.abs(sounds[3].onsetMs - -0.95) < 0.03, `lock starts ${sounds[3].onsetMs}`);
  assert.ok(Math.abs(sounds[1].level - 40) < 4 && Math.abs(sounds[1].levelDb - 10 * Math.log10(sounds[1].level / noise)) < 1e-9);
  // Two sounds that rise as one are one sound: with the third at its loudest where the lock
  // starts, nothing stands 2.5 dB over a valley between them.
  const merged = drawnBeat([[-7, -6.5, 4], [-3.5, -3, 40], [-1, -0.5, 12], [-0.5, 0, 30]]);
  assertClose(findSounds(merged.curve, merged.ms, merged.quiet).sounds.map((e) => e.peakMs), [-6.5, -3, 0], 0.05, 'loudest, merged');
});

test('nothing is found in the quiet stretch or below what it shows, and nothing in a stretch with no noise at all', () => {
  // A bump before the quiet stretch ends is not a sound, and it raises the bar: a sound must
  // stand 1.5 times over the quiet stretch's highest point, which the unlock at 5 does not.
  const withBump = drawnBeat([[-20, -19.5, 4], [-7, -6.5, 5], [-3.5, -3, 40]]);
  assertClose(findSounds(withBump.curve, withBump.ms, withBump.quiet).sounds.map((e) => e.peakMs), [-3], 0.05, 'with a bump in the quiet stretch');
  const without = drawnBeat([[-7, -6.5, 5], [-3.5, -3, 40]]);
  assertClose(findSounds(without.curve, without.ms, without.quiet).sounds.map((e) => e.peakMs), [-6.5, -3], 0.05, 'without');
  const silent = new Float64Array(625);
  assert.deepEqual(findSounds(silent, withBump.ms, withBump.quiet), { sounds: [], noise: 0 });
});

test('the amplitude formula undoes the balance\'s motion, and the believable times are those of 330 and 150 degrees', () => {
  // A balance swinging as A sin(2 pi f t) crosses its lift angle, centred on its rest position,
  // in t = asin(lift / 2A) / (pi f).
  for (const [bph, lift] of [[21600, 36], [28800, 50], [18000, 52]]) {
    const f = bph / 7200;
    /** @param {number} amplitude */
    const crossing = (amplitude) => (1e3 * Math.asin(lift / (2 * amplitude))) / (Math.PI * f);
    for (const amplitude of [150, 220, 285, 330]) assert.ok(Math.abs(amplitudeOf(lift, bph, crossing(amplitude)) - amplitude) < 1e-9);
    assertClose(liftLimits(bph, lift), [crossing(330), crossing(150)], 1e-12, `${bph} vph at ${lift} degrees`);
  }
  // The Omega 3861 at 36 degrees, as the prototype prints it.
  assertClose(liftLimits(21600, 36).map((v) => Math.round(v * 10) / 10), [5.8, 12.8], 1e-9, 'the Omega\'s limits');
});

/**
 * Sounds as `findSounds` would give them, from their start times and levels.
 * @param {[number, number][]} list each sound's onset in milliseconds and its level
 * @returns {Sound[]}
 */
const soundsAt = (list) => list.map(([onsetMs, level], index) => ({ index, onsetMs, peakMs: onsetMs + 0.2, level, levelDb: 10 * Math.log10(level) }));

test('the lock is chosen for both beats together: the loudest pair that comes the same time after the first sounds', () => {
  // A co-axial as the Omega sounds: the two beats' times from unlock to lock differ by 8%, and
  // the tock has two sounds between.
  const tick = soundsAt([[-6.96, 3], [-3.7, 100], [0, 30], [2.7, 2]]);
  const tock = soundsAt([[-6.46, 3], [-3.3, 2], [-2.3, 30], [0, 30], [2.6, 2]]);
  const { pair, why } = pairBeats(tick, tock, 21600, 36);
  assert.equal(why, null);
  assert.ok(pair);
  assert.deepEqual([pair.unlock[0], pair.unlock[1], pair.lock[0], pair.lock[1]], [tick[0], tock[0], tick[2], tock[3]]);
  assertClose(pair.liftMs, [6.96, 6.46], 1e-12, 'unlock to lock');

  assert.equal(pairBeats(tick.slice(0, 1), tock, 21600, 36).why, 'few-sounds');
  // Times from the first sound that differ by more than 1.18 between the beats are no pair.
  assert.equal(pairBeats(soundsAt([[-8, 3], [0, 30]]), soundsAt([[-6, 3], [0, 30]]), 21600, 36).why, 'no-pair');
});

test('a lever whose impulse is its loudest sound is paired on its drops, since the impulses come too soon to be the lock', () => {
  // Issue 24 of the investigation: 2.4 ms from the unlock is no believable lift at 28,800 vph
  // and 50 degrees (6.0 to 13.3 ms); the drops, 7.4 ms after, are, and are louder than the unlock.
  const beat = soundsAt([[-7.4, 5], [-5, 100], [0, 40]]);
  const { pair, why } = pairBeats(beat, beat, 28800, 50);
  assert.equal(why, null);
  assert.ok(pair && pair.lock[0] === beat[2] && pair.lock[1] === beat[2]);
  assertClose(pair ? pair.liftMs : [], [7.4, 7.4], 1e-12, 'unlock to lock');
});

test('a quieter believable pair is not taken when it is no louder than the first sounds, and nothing between the first sound and the lock is refused', () => {
  // Issue 24: the unlock is lost, so the first sound is the impulse and the drop comes 5 ms
  // after it, too soon. A fainter sound 9 ms after the impulse would be believable, but a lock
  // is louder than an unlock, and this one is not louder than the first sound.
  const lost = soundsAt([[-5, 30], [0, 100], [4, 10]]);
  const refused = pairBeats(lost, lost, 28800, 50);
  assert.equal(refused.why, 'lift-range');
  assertClose(refused.refusedLiftMs || [], [5, 5], 1e-12, 'the times refused');
  // The same sound louder than the first is taken as the lock, with the drop between.
  const louder = soundsAt([[-5, 30], [0, 100], [4, 40]]);
  assert.equal(pairBeats(louder, louder, 28800, 50).why, null);
  // Issue 25: at a lower amplitude the impulse-to-drop time is itself believable. Both
  // escapements make a sound between the unlock and the lock, so a beat with none has lost its
  // unlock, or its impulse cannot be heard; either way the first sound cannot be trusted.
  const two = soundsAt([[-7.4, 30], [0, 100]]);
  assert.equal(pairBeats(two, two, 28800, 50).why, 'no-middle-sound');
  const three = soundsAt([[-7.4, 5], [-5, 30], [0, 100]]);
  assert.equal(pairBeats(three, two, 28800, 50).why, 'no-middle-sound', 'in one beat is enough');
});

/**
 * Timestamps of ticks on even beat numbers and tocks on odd ones.
 * @param {number} count beats of each type
 * @param {number} gapMs how much later than midway the tocks fall
 * @param {number} K cycles averaged per timestamp
 * @returns {import('../js/dsp/estimate.js').BeatSeries[]}
 */
function regularBeats(count, gapMs, K = 1) {
  return [0, 1].map((j) => ({
    type: /** @type {0|1} */ (j),
    K,
    t: Float64Array.from({ length: count }, (_, i) => 0.5 + (2 * i + j) * 0.125 + j * gapMs * 1e-3),
    n: Float64Array.from({ length: count }, (_, i) => 2 * i + j),
    ok: new Uint8Array(count).fill(1),
    z: new Float64Array(count).fill(20),
    confidentFraction: 1,
    zMedian: 20,
  }));
}

test('the gap between the timestamps is the tocks\' distance from one line through both, by medians', () => {
  const beats = regularBeats(40, 0.4);
  // Two stray tocks, 3 ms late and 2 ms early, tilt the line a little, but a median does not
  // follow them: a mean of the 40 tocks would read 0.025 ms more.
  beats[1].t[5] += 0.003;
  beats[1].t[30] -= 0.002;
  const { gapMs, slope } = timestampGap([beats[0].t, beats[1].t], [beats[0].n, beats[1].n]);
  assert.ok(Math.abs(gapMs - 0.4) < 0.005, `gap ${gapMs}`);
  assert.ok(Math.abs(slope - 0.125) < 1e-5, `slope ${slope}`);
});

test('there is no reading from fewer than 10 confident timestamps of a beat type, or from timestamps that average several cycles', () => {
  /** @type {Float32Array[]} */
  const rows = [];
  const few = regularBeats(40, 0.4);
  few[1].ok.fill(0, 9);
  const a = measureSounds(rows, 12000, few, 28800, 50, (t) => t * 12000);
  assert.equal(a.why, 'few-beats');
  assert.deepEqual(a.counts, [40, 9]);
  // Issue 19: a timestamp that averages several cycles does not say where any one beat is.
  const b = measureSounds(rows, 12000, regularBeats(40, 0.4, 2), 28800, 50, (t) => t * 12000);
  assert.equal(b.why, 'averaged');
  assert.ok(b.beatErrorMs === null && b.amplitude === null && b.pair === null && b.beats === null);
  assertClose(b.liftLimitsMs, liftLimits(28800, 50), 1e-12, 'the limits it would have used');
});

test('there is no reading when the stretch around each beat cannot hold both the unlock and a quiet stretch before it, or from audio with no noise at all', () => {
  // Twelve beats of a perfectly even envelope.
  const flat = [new Float32Array(12000).fill(1)];
  const stack = stackBeats(flat, Array.from({ length: 12 }, (_, i) => 600 + 900 * i), 480, 144);
  assert.equal(stack.count, 12);
  const beats = { stack, times: Float64Array.from({ length: 12 }, (_, i) => 0.05 + 0.075 * i), residualMs: new Float64Array(12) };
  // At 9,000 vph and 52 degrees an unlock could come 44 ms before the lock, and the stretch
  // starts 40 ms before the timestamp. The app's slowest beat rate, 18,000 vph, leaves 8 ms of
  // quiet at the widest lift angle the settings take, 70 degrees.
  assert.equal(readBeats([beats, beats], 12000, 0, 9000, 52).why, 'short-stretch');
  assert.ok(-liftLimits(18000, 70)[1] - 1.5 > -40 + 8);
  const silent = readBeats([beats, beats], 12000, 0, 28800, 52);
  assert.equal(silent.why, 'few-sounds');
  assert.ok(silent.beats && silent.beats.every((b) => b.sounds.length === 0 && b.noise === 0));
});

test('the seeded generator the resamples draw from is the simulator\'s own, in a new home', () => {
  assert.equal(fromMathutil, seededRandom);
  const a = fromMathutil(1);
  const b = fromMathutil(1);
  const first = Array.from({ length: 5 }, () => a());
  assert.deepEqual(Array.from({ length: 5 }, () => b()), first, 'the same seed gives the same values');
  assert.ok(first.every((v) => v >= 0 && v < 1) && new Set(first).size === 5);
});

test('the chi-squared point a moving sound is judged by is SciPy\'s', () => {
  // scipy.stats.chi2.ppf(0.99, dof), SciPy 1.18.
  for (const [dof, want] of [[1, 6.6348966010212145], [2, 9.21034037197618], [3, 11.344866730144373], [4, 13.276704135987622], [5, 15.08627246938899], [10, 23.209251158954356], [29, 49.58788447289881], [100, 135.80672317102676]]) {
    assert.ok(Math.abs(chiSquaredQuantile(0.99, dof) - want) < 1e-9 * want, `${dof} degrees of freedom: ${chiSquaredQuantile(0.99, dof)}`);
  }
  assert.ok(Math.abs(chiSquaredQuantile(0.5, 3) - 2.3659738843753377) < 1e-9);
  assert.ok(Math.abs(chiSquaredQuantile(0.001, 2) - 0.002001000667167068) < 1e-12);
  // scipy.stats.chi2.cdf(x, dof), on both sides of where the series gives way to the continued fraction.
  for (const [x, dof, want] of [[0.5, 1, 0.5204998778130466], [3, 1, 0.9167354833364496], [2, 4, 0.2642411176571153], [13.2767, 4, 0.9899999820274282], [40, 29, 0.9160631015084817], [1e-3, 2, 0.0004998750208307296], [300, 100, 1]]) {
    assert.ok(Math.abs(chiSquaredBelow(x, dof) - want) < 1e-12, `below ${x} on ${dof}: ${chiSquaredBelow(x, dof)}`);
  }
  assert.equal(chiSquaredBelow(0, 3), 0);
});

test('a sound that comes later in a block is found that much later, and a louder sound nearby is not taken for it', () => {
  const whole = drawnBeat([[-7, -6.5, 4], [-3.5, -3, 40], [-0.5, 0, 30]]);
  const template = smoothForMatching(whole.curve, whole.ms);
  // The unlock's stretch of the template: from 0.5 ms before it starts to 0.5 ms after it is loudest.
  const [from, to] = [-7.25, -6];
  // The match is not scaled by how much sound the block has under the window, so even against
  // itself the template's best match need not be at no shift: here it is 0.02 ms early. Every
  // block carries the same offset, which goes out when the shifts are compared with each other
  // and when the beats' mean shift is added back.
  const own = shiftOf(template, template, whole.ms, from, to);
  assert.ok(own !== null && Math.abs(own) < 0.03, `against itself ${own}`);
  for (const late of [0.3, -0.45, 1.1]) {
    const block = drawnBeat([[-7 + late, -6.5 + late, 4], [-3.5, -3, 40], [-0.5, 0, 30]]);
    const shift = shiftOf(template, smoothForMatching(block.curve, block.ms), block.ms, from, to);
    assert.ok(shift !== null && Math.abs(shift - own - late) < 0.005, `${late} ms late, found ${shift}`);
  }
  // The unlock in place and a sound five times louder 1 ms after it: the louder one matches the
  // template more strongly, but the match nearest no shift is the unlock's own.
  const crowded = drawnBeat([[-7, -6.5, 4], [-6, -5.5, 20], [-3.5, -3, 40], [-0.5, 0, 30]]);
  const kept = shiftOf(template, smoothForMatching(crowded.curve, crowded.ms), crowded.ms, from, to);
  assert.ok(kept !== null && Math.abs(kept - own) < 0.005, `with a louder sound 1 ms later, found ${kept}`);
  // Nothing where the unlock should be: no match reaches half the template's own.
  const without = drawnBeat([[-3.5, -3, 40], [-0.5, 0, 30]]);
  assert.equal(shiftOf(template, smoothForMatching(without.curve, without.ms), without.ms, from, to), null);
  // A search that would leave the stretch is not made: 1.5 ms either way is looked through.
  assert.equal(shiftOf(template, template, whole.ms, -39, -38), null);
});

test('a sound counts as moving only when its block shifts differ by more than their own scatter allows', () => {
  const sd = (/** @type {number} */ v) => Float64Array.from([v, v, v, v]);
  /** @type {import('../js/dsp/amplitude.js').BlockShifts} */
  const tick = {
    mids: [5, 15, 25, 35],
    // An unlock that wanders within its scatter, and a lock that comes steadily later.
    shifts: [Float64Array.from([0.01, -0.02, 0, 0.015]), Float64Array.from([-0.2, -0.07, 0.06, 0.19])],
    scatter: [sd(0.02), sd(0.02)],
  };
  /** @type {import('../js/dsp/amplitude.js').BlockShifts} */
  const tock = {
    mids: [5, 15, 25, 35],
    // An unlock placed in one block only, and a lock whose shifts differ by 0.02 ms at a stated
    // scatter of a thousandth: the scatter is floored at 0.01 ms, so that is no change.
    shifts: [Float64Array.from([NaN, 0.3, NaN, NaN]), Float64Array.from([0, 0.02, NaN, NaN])],
    scatter: [sd(0.02), sd(0.001)],
  };
  const [[tickUnlock, tickLock], [tockUnlock, tockLock]] = movedSounds([tick, tock]);
  assert.equal(tickUnlock.moved, false);
  assert.equal(tickUnlock.dof, 3);
  // Their weighted mean is 0.00125, and the squared distances from it sum to 0.00071875, over 0.02 squared.
  assert.ok(Math.abs(tickUnlock.chi2 - 0.00071875 / 0.0004) < 1e-9, `chi-squared ${tickUnlock.chi2}`);
  assert.ok(Math.abs(tickUnlock.limit - chiSquaredQuantile(0.99, 3)) < 1e-12);
  assert.equal(tickLock.moved, true);
  assert.ok(tickLock.chi2 > 100);
  assert.deepEqual([tockUnlock.moved, tockUnlock.dof, Number.isNaN(tockUnlock.chi2), Number.isNaN(tockUnlock.limit)], [false, 0, true, true], 'placed in one block: not tested');
  assert.equal(tockLock.moved, false);
  assert.ok(Math.abs(tockLock.chi2 - 2) < 1e-9 && tockLock.dof === 1, `chi-squared ${tockLock.chi2} with the scatter floored`);
});

/**
 * Read a made-up watch at 50 degrees of lift.
 * @param {ReturnType<typeof madeUpWatch>} w
 * @param {import('../js/dsp/amplitude.js').ReadOptions} [options]
 */
const readMadeUp = (w, options) => measureSounds(w.rows, w.envelopeRate, w.beats, w.bph, 50, w.toPosition, options);

/** A steady made-up watch 0.4 ms out of beat, 20 s long, and its reading, made once. */
let steady = /** @type {{watch: ReturnType<typeof madeUpWatch>, reading: ReturnType<typeof readMadeUp>}|null} */ (null);
const steadyWatch = () => (steady ??= ((watch) => ({ watch, reading: readMadeUp(watch) }))(madeUpWatch({ seconds: 20 })));

test('a made-up watch 0.4 ms out of beat is read from its unlocks, with a scatter over 200 draws, and both readings may be shown', () => {
  const { watch, reading: s } = steadyWatch();
  assert.equal(s.why, null);
  assert.ok(s.unlockGapMs !== null && s.liftMs && s.amplitude !== null && s.scatter && s.lining);
  assert.ok(Math.abs(s.unlockGapMs - 0.4) < 0.02, `the tock's unlock ${s.unlockGapMs} ms from midway`);
  assert.ok(s.liftMs.every((v) => Math.abs(v - 7.4) < 0.03), `unlock to lock ${s.liftMs}`);
  assert.ok(Math.abs(s.amplitude - amplitudeOf(50, 28800, 7.4)) < 0.5, `amplitude ${s.amplitude}`);
  assert.deepEqual([s.showBeatError, s.showAmplitude, s.beatErrorHeld, s.amplitudeHeld], [true, true, null, null]);
  assert.deepEqual([s.failing, s.otherSound], [0, 0]);
  // Eighty beats of each type as alike as these give the beat error to a few thousandths.
  assert.ok(s.scatter.unlockGapMs > 0.002 && s.scatter.unlockGapMs < 0.02, `scatter ${s.scatter.unlockGapMs} ms`);
  assert.ok(s.scatter.amplitude < 0.2 && s.scatter.liftMs.every((v) => v < 0.01));
  // Nothing moves over its two blocks of 10 s, so the plain average stands.
  assert.equal(s.lining.state, 'steady');
  assert.equal(s.lining.blocks, 2);
  assert.ok(s.lining.moved && s.lining.moved.every((type) => type.every((m) => !m.moved && m.dof === 1)));
  // The same recording always gives the same reading: the draws are seeded.
  const again = readMadeUp(watch);
  assert.deepEqual([again.unlockGapMs, again.scatter, again.failing], [s.unlockGapMs, s.scatter, s.failing]);
  const other = readMadeUp(watch, { seed: 2 });
  assert.ok(other.scatter && other.unlockGapMs === s.unlockGapMs && other.scatter.unlockGapMs !== s.scatter.unlockGapMs, 'other draws, another scatter for the same reading');
  // Out of beat the other way, the gap changes sign.
  const back = readMadeUp(madeUpWatch({ seconds: 20, gapMs: -0.7, seed: 4 }));
  assert.ok(back.unlockGapMs !== null && Math.abs(back.unlockGapMs + 0.7) < 0.02 && back.beatErrorMs === -back.unlockGapMs, `the other way: ${back.unlockGapMs}`);
});

test('a reading taken a step at a time is the reading taken at once, and it says where its sounds are and why it may be held back', () => {
  const { watch, reading: s } = steadyWatch();
  const timed = timedBeats(watch.rows, watch.envelopeRate, watch.beats, watch.toPosition);
  assert.ok(timed.why === null);
  const onTrend = trendBeats(watch.rows, watch.envelopeRate, watch.beats, watch.toPosition);
  const steps = readBeatsSteps(timed.beats, watch.envelopeRate, timed.gapMs, watch.bph, 50, { onTrend });
  let taken = 0;
  let step = steps.next();
  while (!step.done) {
    taken++;
    step = steps.next();
  }
  // Twelve rankings, the plain average, 40 draws of each block of each beat type, 200 draws;
  // then the placement check's second reading: its rankings, its average and its blocks.
  assert.ok(taken > 400, `${taken} steps`);
  assert.deepEqual(step.value, s);
  assert.ok(s.placement && s.placement.differenceMs !== null, 'the placement check was made');
  // The places the readings rest on: for the tick and the tock, where the unlock and the lock start.
  assert.ok(s.places && s.liftMs && s.unlockGapMs !== null && s.timestampGapMs !== null);
  for (const j of [0, 1]) assert.equal(s.places[j][1] - s.places[j][0], s.liftMs[j]);
  assert.ok(Math.abs(s.timestampGapMs + s.places[1][0] - s.places[0][0] - s.unlockGapMs) < 1e-12);
  // What the pipeline knows of the watch can be applied to a reading after it is made.
  assert.deepEqual(heldBack(s, false, false), { beatError: null, amplitude: null });
  assert.deepEqual(heldBack(s, true, false), { beatError: 'irregular', amplitude: null });
  assert.deepEqual(heldBack(s, true, true), { beatError: 'irregular', amplitude: 'halfway' });
  assert.deepEqual(heldBack(s, false, true), { beatError: 'halfway', amplitude: 'halfway' });
  assert.deepEqual(heldBack({ ...s, failing: 0.06 }, true, true), { beatError: 'failing', amplitude: 'failing' });
  assert.deepEqual(heldBack({ ...s, failing: null, scatter: null }, false, false), { beatError: 'unchecked', amplitude: 'unchecked' });
  assert.deepEqual(heldBack({ ...s, amplitude: null }, true, true), { beatError: null, amplitude: null }, 'nothing was read, so nothing is held back');
  // The placement check's reasons come after the resamples' own, for each reading by itself.
  assert.ok(s.scatter && s.amplitude !== null);
  const placed = { unlockGapMs: s.unlockGapMs - 0.2, differenceMs: 0.2, resampledScatterMs: 0.01, amplitude: s.amplitude - 0.1, amplitudeDifference: 0.1, resampledAmplitudeScatter: 0.05, why: null };
  const widened = { ...s, scatter: { ...s.scatter, unlockGapMs: Math.hypot(0.01, 0.2), amplitude: Math.hypot(0.05, 0.1) }, placement: placed };
  assert.deepEqual(heldBack(widened, false, false), { beatError: 'placement', amplitude: null });
  assert.deepEqual(heldBack({ ...widened, placement: { ...placed, resampledScatterMs: 0.11 } }, false, false), { beatError: 'scatter', amplitude: null }, 'the resamples alone scatter too far');
  assert.deepEqual(heldBack(widened, true, false), { beatError: 'irregular', amplitude: null });
  // The amplitude's two readings 20 degrees apart: held back, in an irregular watch too.
  const apart = { ...s, scatter: { ...s.scatter, amplitude: Math.hypot(0.05, 20) }, placement: { ...placed, differenceMs: 0, amplitudeDifference: 20 } };
  assert.deepEqual(heldBack(apart, false, false), { beatError: null, amplitude: 'placement' });
  assert.deepEqual(heldBack(apart, true, false), { beatError: 'irregular', amplitude: 'placement' });
  assert.deepEqual(heldBack({ ...apart, placement: { ...apart.placement, resampledAmplitudeScatter: 6 } }, false, false), { beatError: null, amplitude: 'scatter' });
  const none = { unlockGapMs: null, differenceMs: null, resampledScatterMs: 0.01, amplitude: null, amplitudeDifference: null, resampledAmplitudeScatter: 0.05, why: /** @type {const} */ ('few-sounds') };
  assert.deepEqual(heldBack({ ...s, placement: none }, false, false), { beatError: 'unplaced', amplitude: 'unplaced' });
  // Too few timestamps, or timestamps that each average several cycles: nothing to stack.
  const few = timedBeats(watch.rows, watch.envelopeRate, watch.beats.map((b) => ({ ...b, ok: b.ok.map((_, i) => (i < 9 ? 1 : 0)) })), watch.toPosition);
  assert.deepEqual([few.why, 'counts' in few && few.counts], ['few-beats', [9, 9]]);
  const averaged = timedBeats(watch.rows, watch.envelopeRate, [watch.beats[0], { ...watch.beats[1], K: 4 }], watch.toPosition);
  assert.equal(averaged.why, 'averaged');
});

test('the median of the values around each one takes only the values there are at either end, as the prototype\'s does', () => {
  // NumPy's nanmedian over windows padded with NaN (running_median in the prototype).
  assertClose(runningMedian([5, 1, 9, 3, 7], 3), [3, 5, 3, 7, 5], 0, 'of three');
  assertClose(runningMedian([5, 1, 9, 3, 7, 2, 8], 5), [5, 4, 5, 3, 7, 5, 7], 0, 'of five');
  assertClose(runningMedian([4], TREND_BEATS), [4], 0, 'of one value');
});

test('every beat of a type is placed on the trend of its confident timestamps, as the prototype places it: a straight line and the median of 15 distances from it', () => {
  // The ticks of 24 cycles at 28,800 vph, two of them not confident, each timestamp off the
  // line by a fixed pattern of up to 0.3 ms. The times are the prototype's beat_times, on_trend.
  const k = Array.from({ length: 24 }, (_, i) => i);
  const all = k.map((i) => 0.5 + 0.125 * 2 * i + 1e-4 * Math.sin(1.7 * i) + 2e-4 * Math.cos(0.31 * i));
  const confident = k.filter((i) => i !== 4 && i !== 15);
  const placed = trendTimes(confident.map((i) => all[i]), confident.map((i) => 2 * i));
  // Every beat from the first to the last gets a time, the two without a timestamp too.
  assert.deepEqual(placed.n, k.map((i) => 2 * i));
  assertClose(placed.t, [
    0.5000366030817951, 0.7500175386178602, 0.9999610175369946, 1.249904496456129, 1.4999055962505738, 1.7499066960450187, 1.9999041722787267, 2.2498932968542413,
    2.499913618989091, 2.749918342344273, 2.999923065699455, 3.2499277890546376, 3.4999325124098197, 3.749937235765002, 3.9999564533631338, 4.249999499197797,
    4.5000425450324615, 4.750061133105781, 5.000079721179101, 5.250089454341641, 5.500099187504179, 5.750120794372857, 6.000142401241535, 6.250158566548848,
  ], 1e-12, 'trend times');

  // One timestamp in three 0.2 ms late does not move any beat: a median does not follow them.
  const regular = k.map((i) => 0.5 + 0.25 * i);
  const late = trendTimes(regular.map((t, i) => (i % 3 === 1 ? t + 2e-4 : t)), k.map((i) => 2 * i));
  assertClose(late.t, regular, 2e-6, 'with a third of the timestamps late');
  // A slow wander is followed: 0.2 ms either way over 160 cycles, seen for 80 of them. In the
  // middle the trend is within 0.003 ms of it. Over the first and last seven beats the window
  // is one-sided and the trend lags by up to 0.03 ms: a limit of the check, not of the reading.
  const cycles = Array.from({ length: 80 }, (_, i) => i);
  const wander = cycles.map((i) => 0.5 + 0.25 * i + 2e-4 * Math.sin((2 * Math.PI * i) / 160));
  const followed = trendTimes(wander, cycles.map((i) => 2 * i));
  const off = followed.t.map((t, i) => Math.abs(t - wander[i]) * 1e3);
  assert.ok(Math.max(...off.slice(7, -7)) < 0.003, `in the middle ${Math.max(...off.slice(7, -7))} ms`);
  assert.ok(Math.max(...off) < 0.03 && Math.max(...off) > 0.01, `at the ends ${Math.max(...off)} ms`);
});

test('the placement check reads the beat error and the amplitude a second time with every beat on the trend, changes neither reading and adds each difference to its stated scatter', () => {
  const { watch, reading: s } = steadyWatch();
  const without = readMadeUp(watch, { placementCheck: false });
  assert.ok(s.placement && s.scatter && without.scatter && s.unlockGapMs !== null && s.amplitude !== null && s.placement.unlockGapMs !== null && s.placement.differenceMs !== null);
  assert.ok(s.placement.amplitude !== null && s.placement.amplitudeDifference !== null);
  assert.equal(without.placement, null);
  // The readings, their draws and the draws' scatter are what they were without the check.
  assert.deepEqual([s.unlockGapMs, s.lockGapMs, s.liftMs, s.amplitude, s.failing, s.lining], [without.unlockGapMs, without.lockGapMs, without.liftMs, without.amplitude, without.failing, without.lining]);
  assert.deepEqual([s.scatter.liftMs, s.scatter.lockGapMs, s.placement.resampledScatterMs, s.placement.resampledAmplitudeScatter], [without.scatter.liftMs, without.scatter.lockGapMs, without.scatter.unlockGapMs, without.scatter.amplitude]);
  // This watch's timestamps are its beats' own times, and each beat falls anywhere within an
  // envelope sample, 0.08 ms. The trend leaves that out of each beat's place, which smears the
  // sounds a little: the two readings differ by 0.005 ms.
  assert.ok(Math.abs(s.placement.differenceMs) < 0.01, `difference ${s.placement.differenceMs} ms`);
  assert.equal(s.placement.differenceMs, s.unlockGapMs - s.placement.unlockGapMs);
  assert.equal(s.scatter.unlockGapMs, Math.hypot(without.scatter.unlockGapMs, s.placement.differenceMs));
  // The amplitude likewise: its two readings are 0.05 degrees apart.
  assert.ok(Math.abs(s.placement.amplitudeDifference) < 0.2, `amplitudes ${s.placement.amplitudeDifference} degrees apart`);
  assert.equal(s.placement.amplitudeDifference, s.amplitude - s.placement.amplitude);
  assert.equal(s.scatter.amplitude, Math.hypot(without.scatter.amplitude, s.placement.amplitudeDifference));
  // The trend's beats include those the pipeline was not confident of.
  const some = watch.beats.map((b) => ({ ...b, ok: b.ok.map((_, i) => (i % 4 === 1 ? 0 : 1)) }));
  const timed = timedBeats(watch.rows, watch.envelopeRate, some, watch.toPosition);
  const onTrend = trendBeats(watch.rows, watch.envelopeRate, some, watch.toPosition);
  assert.ok(timed.why === null && onTrend.why === null);
  assert.ok(onTrend.beats[0].stack.count > timed.beats[0].stack.count && onTrend.beats[0].stack.count >= 79, `${onTrend.beats[0].stack.count} beats on the trend, ${timed.beats[0].stack.count} timed`);
  assert.ok(Math.abs(onTrend.gapMs - timed.gapMs) < 0.01, `gap ${onTrend.gapMs} ms on the trend, ${timed.gapMs} ms timed`);
  assert.equal(trendBeats(watch.rows, watch.envelopeRate, watch.beats.map((b) => ({ ...b, ok: b.ok.map((_, i) => (i < 9 ? 1 : 0)) })), watch.toPosition).why, 'few-beats');
});

test('timestamps that are late for one tock in three move the beat error by more than twice what the resamples say, and the stated scatter then covers the shift; 1.2 ms late, both readings are wrong, their draws agree, and both are held back', () => {
  const { watch, reading: steadyReading } = steadyWatch();
  assert.ok(steadyReading.unlockGapMs !== null && steadyReading.amplitude !== null && steadyReading.placement && steadyReading.placement.unlockGapMs !== null);
  // What the beats on the trend read when no timestamp is late.
  const onTrend = steadyReading.placement.unlockGapMs;
  /** @param {number} lateMs */
  const withLateTocks = (lateMs) => watch.beats.map((b, j) => (j === 1 ? { ...b, t: b.t.map((t, i) => (i % 3 === 2 ? t + lateMs * 1e-3 : t)) } : b));
  // 0.2 ms late: those beats are read 0.2 ms later, so their unlock comes 0.2 ms early in the
  // average and its rising edge with it. The gap between the timestamps, a median, does not
  // move. Every draw of the beats has about a third of them late, so the draws agree.
  const s = measureSounds(watch.rows, watch.envelopeRate, withLateTocks(0.2), watch.bph, 50, watch.toPosition);
  assert.ok(s.unlockGapMs !== null && s.amplitude !== null && s.scatter && s.placement && s.placement.unlockGapMs !== null && s.placement.differenceMs !== null);
  const shift = s.unlockGapMs - steadyReading.unlockGapMs;
  assert.ok(shift < -0.03 && shift > -0.06, `moved by ${shift} ms`);
  assert.ok(Math.abs(shift) > 2.5 * s.placement.resampledScatterMs, `the resamples say +-${s.placement.resampledScatterMs} ms`);
  // The median of 15 distances, 5 of them late, is the eighth smallest of the other 10 and so a
  // little late itself: the second reading moves by 0.004 ms.
  assert.ok(Math.abs(s.placement.unlockGapMs - onTrend) < 0.006, `the second reading ${s.placement.unlockGapMs} ms, ${onTrend} ms with no timestamp late`);
  assert.ok(s.scatter.unlockGapMs >= Math.abs(shift) && s.scatter.unlockGapMs < 0.06, `stated +-${s.scatter.unlockGapMs} ms`);
  assert.deepEqual([s.showBeatError, s.beatErrorHeld, s.showAmplitude], [true, null, true]);
  assert.ok(Math.abs(s.amplitude - steadyReading.amplitude) < 0.1);

  // 1.2 ms late: the early copy of the unlock is taken for the unlock itself, the reading is on
  // the wrong side of zero and the draws agree on it to 0.01 ms. Only the check holds it back.
  const far = measureSounds(watch.rows, watch.envelopeRate, withLateTocks(1.2), watch.bph, 50, watch.toPosition);
  assert.ok(far.unlockGapMs !== null && far.amplitude !== null && far.scatter && far.placement && far.placement.unlockGapMs !== null);
  assert.ok(far.unlockGapMs < -0.7 && far.placement.resampledScatterMs < 0.02 && far.failing === 0, `read ${far.unlockGapMs} +-${far.placement.resampledScatterMs} ms`);
  assert.ok(Math.abs(far.placement.unlockGapMs - onTrend) < 0.006, `the second reading ${far.placement.unlockGapMs} ms`);
  assert.deepEqual([far.showBeatError, far.beatErrorHeld], [false, 'placement']);
  // The amplitude is read 20 degrees low from the same early copy, with draws that agree to
  // 0.1 degrees. On the trend it reads what the watch has, and the difference holds it back.
  assert.ok(far.amplitude < steadyReading.amplitude - 15 && far.placement.resampledAmplitudeScatter < 0.2, `amplitude ${far.amplitude} +-${far.placement.resampledAmplitudeScatter}`);
  assert.ok(far.placement.amplitude !== null && Math.abs(far.placement.amplitude - steadyReading.amplitude) < 0.5, `the second reading ${far.placement.amplitude} degrees`);
  assert.deepEqual([far.showAmplitude, far.amplitudeHeld], [false, 'placement']);

  // When the beats on the trend give no reading, neither reading can be checked.
  const timed = timedBeats(watch.rows, watch.envelopeRate, watch.beats, watch.toPosition);
  assert.ok(timed.why === null);
  const unchecked = readBeats(timed.beats, watch.envelopeRate, timed.gapMs, watch.bph, 50, { onTrend: { why: 'few-beats', counts: [9, 9] } });
  assert.ok(unchecked.placement && unchecked.scatter);
  assert.deepEqual([unchecked.placement.differenceMs, unchecked.placement.amplitudeDifference, unchecked.placement.why], [null, null, 'few-beats']);
  assert.deepEqual([unchecked.showBeatError, unchecked.beatErrorHeld, unchecked.showAmplitude, unchecked.amplitudeHeld], [false, 'unplaced', false, 'unplaced']);
  assert.deepEqual([unchecked.scatter.unlockGapMs, unchecked.scatter.amplitude], [steadyReading.placement.resampledScatterMs, steadyReading.placement.resampledAmplitudeScatter], 'and nothing is added to their scatter');
});

test('a reading with too few draws to judge it is never to be shown', () => {
  const { watch, reading } = steadyWatch();
  for (const resamples of [0, 4]) {
    const s = readMadeUp(watch, { resamples });
    assert.equal(s.unlockGapMs, reading.unlockGapMs, 'the reading itself is the same');
    assert.deepEqual([s.showBeatError, s.showAmplitude, s.beatErrorHeld, s.amplitudeHeld, s.scatter], [false, false, 'unchecked', 'unchecked', null], `${resamples} draws`);
  }
});

test('an irregular watch keeps its amplitude and loses its beat error; a beat found halfway between the tick and the tock holds both back', () => {
  const { watch, reading } = steadyWatch();
  const irregular = readMadeUp(watch, { irregular: true });
  assert.deepEqual([irregular.showBeatError, irregular.beatErrorHeld, irregular.showAmplitude, irregular.amplitudeHeld], [false, 'irregular', true, null]);
  assert.equal(irregular.amplitude, reading.amplitude);
  // With a beat halfway, the beat rate in use is half the watch's own: the tick and the tock
  // are the same kind of beat, and the amplitude formula has the wrong rate.
  const halfway = readMadeUp(watch, { halfway: true });
  assert.deepEqual([halfway.showBeatError, halfway.beatErrorHeld, halfway.showAmplitude, halfway.amplitudeHeld], [false, 'halfway', false, 'halfway']);
});

test('beats that fall at scattered times scatter the beat error past its gate; the amplitude is right and shown, and stated less precisely, since on the trend such beats are smeared', () => {
  // Each whole beat 0.6 ms off the grid (standard deviation), its timestamp with it. Drawn
  // again, the 80 beats of each type put the gap between them anywhere within 0.12 ms.
  const s = readMadeUp(madeUpWatch({ seconds: 20, beatJitterMs: 0.6 }));
  assert.ok(s.scatter && s.amplitude !== null);
  assert.ok(s.scatter.unlockGapMs > 0.1 && s.scatter.unlockGapMs < 0.2, `scatter ${s.scatter.unlockGapMs} ms`);
  assert.deepEqual([s.showBeatError, s.beatErrorHeld, s.showAmplitude, s.amplitudeHeld], [false, 'scatter', true, null]);
  // The amplitude's draws agree to 0.03 degrees and it is right. With every beat on the trend
  // the sounds of a watch like this are smeared, and the amplitude reads 2.6 degrees lower:
  // the placement check cannot tell beats that scatter from timestamps that do, so it states
  // this amplitude at +-2.6 degrees. That is its cost.
  assert.ok(s.placement && s.placement.amplitudeDifference !== null);
  assert.ok(Math.abs(s.amplitude - amplitudeOf(50, 28800, 7.4)) < 0.5 && s.placement.resampledAmplitudeScatter < 0.2, `amplitude ${s.amplitude} +- ${s.placement.resampledAmplitudeScatter}`);
  assert.ok(s.placement.amplitudeDifference > 1 && s.scatter.amplitude > 1 && s.scatter.amplitude < 4, `stated +- ${s.scatter.amplitude} degrees`);
});

test('an unlock that many draws of the beats lose holds both readings back, though the draws that find it agree', () => {
  // At 0.45 of the quiet level the unlock stands 10 dB over the noise of the average and 3% of
  // the draws lose it; at 0.4, 11.5% do, over the 5% allowed.
  const found = readMadeUp(madeUpWatch({ seconds: 20, unlock: 0.45 }));
  assert.ok(found.failing !== null && found.failing > 0 && found.failing <= 0.05, `failing ${found.failing}`);
  assert.deepEqual([found.showBeatError, found.showAmplitude], [true, true]);
  const lost = readMadeUp(madeUpWatch({ seconds: 20, unlock: 0.4 }));
  assert.ok(lost.failing !== null && lost.failing > 0.05 && lost.failing < 0.3 && lost.scatter, `failing ${lost.failing}`);
  assert.deepEqual([lost.showBeatError, lost.beatErrorHeld, lost.showAmplitude, lost.amplitudeHeld], [false, 'failing', false, 'failing']);
  assert.ok(lost.scatter.unlockGapMs < 0.1 && lost.scatter.amplitude < 5, 'the scatter alone would have passed');
  assert.ok(lost.unlockGapMs !== null && Math.abs(lost.unlockGapMs - 0.4) < 0.03);
  // Fainter still, the sounds of the whole average cannot be paired, and there is no reading.
  assert.equal(readMadeUp(madeUpWatch({ seconds: 20, unlock: 0.25 })).why, 'no-pair');
});

test('when the time from unlock to lock changes while the beats are taken, the plain average reads the amplitude 6 degrees low and shows it; lined up again on the unlock, it is right', () => {
  // The time grows from 6.9 to 7.9 ms over 30 s, as when the amplitude falls by about 36
  // degrees. The timestamps follow the lock, so the unlock moves a millisecond against them
  // and the plain average smears it: its rise starts early, and the time reads 0.18 ms long.
  const watch = madeUpWatch({ seconds: 30, liftMs: (t) => 6.9 + t / 30 });
  const truth = amplitudeOf(50, 28800, 0.5 * (watch.truth.liftMs[0] + watch.truth.liftMs[1]));
  assert.ok(Math.abs(watch.truth.liftMs[0] - 7.4) < 0.01);
  const s = readMadeUp(watch);
  assert.ok(s.lining && s.lining.moved && s.amplitude !== null && s.unlockGapMs !== null && s.scatter && s.liftMs);
  assert.equal(s.lining.state, 'lined');
  assert.equal(s.lining.blocks, 3);
  assert.deepEqual(s.lining.moved.map((type) => type.map((m) => m.moved)), [[true, false], [true, false]], 'the unlocks move, the locks do not');
  // The blocks' shifts follow the unlock: about a third of a millisecond earlier, then later.
  for (const type of s.lining.shifts) {
    assert.ok(type.shifts[0][0] > 0.2 && Math.abs(type.shifts[0][1]) < 0.1 && type.shifts[0][2] < -0.2, `unlock shifts ${Array.from(type.shifts[0])}`);
    // The lock's shifts are alike in every block; what they share is the match's own offset.
    assert.ok(type.shifts[1].every((v) => Math.abs(v - type.shifts[1][0]) < 0.01 && Math.abs(v) < 0.05), `lock shifts ${Array.from(type.shifts[1])}`);
  }
  assert.ok(Math.abs(s.amplitude - truth) < 1, `lined up: ${s.amplitude}, truly ${truth}`);
  assert.ok(s.liftMs.every((v) => Math.abs(v - 7.4) < 0.03), `unlock to lock ${s.liftMs}`);
  assert.ok(Math.abs(s.unlockGapMs - 0.4) < 0.03 && s.showBeatError && s.showAmplitude);
  // The earlier behaviour, kept as a setting: the plain average.
  const plain = readMadeUp(watch, { lineUp: 'never' });
  assert.ok(plain.amplitude !== null && plain.scatter && plain.lining === null);
  assert.ok(plain.amplitude < truth - 5 && plain.amplitude > truth - 8 && plain.showAmplitude && plain.scatter.amplitude < 2, `plain: ${plain.amplitude} +- ${plain.scatter.amplitude}, shown ${plain.showAmplitude}`);
  // Its unlock is smeared, so its beat error scatters twice as far.
  assert.ok(plain.scatter.unlockGapMs > 1.5 * s.scatter.unlockGapMs, `scatter ${plain.scatter.unlockGapMs} against ${s.scatter.unlockGapMs} ms`);
});

test('a stretch of 15 s has one block and nothing to line up on, so a changing amplitude is read low and shown: a limit', () => {
  // The same change as above in half the time. Since 27 November 2026 the real-time stage's
  // first reading, after a lock or after the stretch starts again, rests on 15 s of beats, so an
  // amplitude that moves this fast in those 15 s is read low and shown there too.
  const watch = madeUpWatch({ seconds: 15, liftMs: (t) => 6.9 + t / 15 });
  const truth = amplitudeOf(50, 28800, 0.5 * (watch.truth.liftMs[0] + watch.truth.liftMs[1]));
  const s = readMadeUp(watch);
  assert.ok(s.lining && s.lining.moved && s.amplitude !== null && s.scatter);
  assert.equal(s.lining.blocks, 1);
  assert.equal(s.lining.state, 'steady');
  assert.ok(s.lining.moved.every((type) => type.every((m) => !m.moved && Number.isNaN(m.chi2))), 'no sound could be tested');
  assert.ok(s.amplitude < truth - 5 && s.amplitude > truth - 8 && s.showAmplitude, `${s.amplitude} +- ${s.scatter.amplitude}, truly ${truth}, shown ${s.showAmplitude}`);
});
