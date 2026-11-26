// The sounds inside each beat (js/dsp/sounds.js) and the readings that rest on them
// (js/dsp/amplitude.js): milestone 8's stage after the timestamps, ported from the prototype in
// tools/prototype/coaxial/. The ported helpers are held to what SciPy and NumPy give for the
// same input. The readings are held to simulated watches built from the motion of their balance
// (tests/helpers/balance.js), whose unlocks, locks and amplitude are known. The real recordings
// are in recordings.test.js.
//
// This first step reads the plain average of the beats, with no measure of its scatter and no
// gate, so only watches that the plain average reads well are held to the truth here. A
// simulated co-axial exactly in beat, whose unlock is as faint as the Omega's, reads 0.01 to
// 0.14 ms over eight seeds; whether such a reading may be shown is for the resamples to say.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from './helpers/balance.js';
import { seededRandom } from '../js/audio/simulator.js';
import { analyze } from '../js/dsp/offline.js';
import { stackBeats, stretchMs, samplesBefore, bandMeans, energyWeights, mixBands, smooth, findPeaks, findSounds } from '../js/dsp/sounds.js';
import { liftLimits, amplitudeOf, pairBeats, timestampGap, readStacks, measureSounds } from '../js/dsp/amplitude.js';

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
  assertClose(stack.bands[0], [6.25, 7.25, 8.25, 9.25, 10.25, 11.25, 12.25, 46, 47, 48, 49, 50, 51, 52], 1e-6, 'the ramp');
  // Between two samples the envelope is read off the straight line joining them.
  assert.ok(Math.abs(stack.bands[1][4] - (0.75 * 100 + 0.25 * 121)) < 1e-4, `the square at 10.25 reads ${stack.bands[1][4]}`);
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
  for (let b = 0; b < beats; b++) band.set([1, 1, 3, 3, 3], b * 5);
  band[7 * 5 + 3] = 1000;
  return { bands: [band], count: beats, length: 5, before: 2, kept: Int32Array.from({ length: beats }, (_, i) => i) };
}

test('the averaged beat leaves out the highest and lowest twentieth of the beats at each instant, so one click does not show', () => {
  // As scipy.stats.trim_mean(M, 0.05): int(0.05 n) beats go from each end, so 1 of 20 and none of 19.
  const twenty = bandMeans(stackWithClick(20), 2);
  assertClose(twenty.levels, [1], 1e-12, 'quiet level');
  assertClose(twenty.excess[0], [0, 0, 2, 2, 2], 1e-12, '20 beats');
  const nineteen = bandMeans(stackWithClick(19), 2);
  assertClose(nineteen.excess[0], [0, 0, 2, 2 + 997 / 19, 2], 1e-9, '19 beats: nothing is left out, and the click shows');
  // A resample draws beats with repeats: here the beat with the click, three times over in ten.
  const drawn = bandMeans(stackWithClick(20), 2, [7, 7, 7, 0, 1, 2, 3, 4, 5, 6]);
  assertClose(drawn.excess[0], [0, 0, 2, 2 + 3 * 997 / 10, 2], 1e-9, 'ten drawn beats');
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
  // At 9,000 vph and 52 degrees an unlock could come 44 ms before the lock, and the stretch
  // starts 40 ms before the timestamp. The app's slowest beat rate, 18,000 vph, leaves 8 ms of
  // quiet at the widest lift angle the settings take, 70 degrees.
  assert.equal(readStacks([stack, stack], 12000, 0, 9000, 52).why, 'short-stretch');
  assert.ok(-liftLimits(18000, 70)[1] - 1.5 > -40 + 8);
  const silent = readStacks([stack, stack], 12000, 0, 28800, 52);
  assert.equal(silent.why, 'few-sounds');
  assert.ok(silent.beats && silent.beats.every((b) => b.sounds.length === 0 && b.noise === 0));
});

// Simulated watches, each analysed once. The beat rate is given: the stage reads the beats the
// pipeline timed, however their rate was found, and a detected rate gives the same timestamps
// in about twice the time.

/**
 * @typedef {Object} Simulated
 * @property {import('./helpers/balance.js').BalanceTruth} truth
 * @property {import('../js/dsp/amplitude.js').SoundsReading} sounds what the stage read
 * @property {number} unlockGapMs the true gap between the unlocks, in the pipeline's naming of the beats
 * @property {[number, number]} liftMs the true times from unlock to lock, in that naming
 */

/** @type {Map<string, Simulated>} */
const runs = new Map();

/**
 * A simulated watch and what the stage read from it, made once.
 * @param {string} name
 * @param {() => import('./helpers/balance.js').BalanceWatchOptions} make
 * @param {number} liftAngle
 * @returns {Simulated}
 */
function simulated(name, make, liftAngle) {
  let run = runs.get(name);
  if (!run) {
    const options = make();
    const watch = synthesizeBalanceWatch(options);
    const analysis = analyze(watch.channels, watch.sampleRate, { bph: options.bph, liftAngle });
    assert.ok(analysis.sounds);
    // The pipeline calls whichever beat comes first in its first cycle the tick. The truth
    // counts beats from the first one made, so its even beats may be either.
    const first = analysis.beats[0].t[analysis.beats[0].ok.indexOf(1)];
    let nearest = 0;
    watch.truth.lock.forEach((t, k) => {
      if (Math.abs(t - first) < Math.abs(watch.truth.lock[nearest] - first)) nearest = k;
    });
    const even = nearest % 2 === 0;
    const [a, b] = watch.truth.liftMs;
    run = { truth: watch.truth, sounds: analysis.sounds, unlockGapMs: even ? watch.truth.unlockGapMs : -watch.truth.unlockGapMs, liftMs: even ? [a, b] : [b, a] };
    runs.set(name, run);
  }
  return run;
}

/**
 * Hold a reading to the truth.
 * @param {Simulated} run
 * @param {{ms: number, degrees: number}} within how far the beat error and each time from unlock
 *   to lock may be from the truth, and how far the amplitude
 */
function assertReadsTruth(run, within) {
  const s = run.sounds;
  assert.equal(s.why, null);
  assert.ok(s.unlockGapMs !== null && s.beatErrorMs !== null && s.liftMs && s.amplitude !== null);
  assert.ok(Math.abs(s.unlockGapMs - run.unlockGapMs) <= within.ms, `the tock's unlock ${s.unlockGapMs.toFixed(3)} ms from midway, truly ${run.unlockGapMs.toFixed(3)}`);
  assert.equal(s.beatErrorMs, Math.abs(s.unlockGapMs));
  for (const j of [0, 1]) assert.ok(Math.abs(s.liftMs[j] - run.liftMs[j]) <= within.ms, `unlock to lock ${s.liftMs[j].toFixed(3)} ms, truly ${run.liftMs[j].toFixed(3)}`);
  assert.ok(Math.abs(s.amplitude - run.truth.meanAmplitude) <= within.degrees, `amplitude ${s.amplitude.toFixed(2)}, truly ${run.truth.meanAmplitude.toFixed(2)}`);
}

/**
 * The simulated lever's three sounds with the impulse and the unlock at other levels, and
 * optionally a fourth sound after the drop, as a rebound might make.
 * @param {{impulseDb?: number, unlockDb?: number, afterDrop?: {delayMs: number, db: number}}} [levels]
 * @returns {[import('./helpers/balance.js').BeatSound[], import('./helpers/balance.js').BeatSound[]]}
 */
function leverSounds({ impulseDb = 18, unlockDb = 12, afterDrop } = {}) {
  /** @type {import('./helpers/balance.js').BeatSound[]} */
  const beat = [
    { after: 'unlock', db: unlockDb, riseMs: 0.12, decayMs: 0.5, band: [7000, 22000] },
    { after: 'unlock', delayMs: 2.4, delayJitterMs: 0.08, db: impulseDb, riseMs: 0.1, decayMs: 0.5, band: [5000, 22000] },
    { after: 'lock', db: 25, riseMs: 0.08, decayMs: 0.7, band: [5000, 22000] },
  ];
  if (afterDrop) beat.push({ after: 'lock', delayMs: afterDrop.delayMs, delayJitterMs: 0.1, db: afterDrop.db, riseMs: 0.12, decayMs: 0.5, band: [5000, 22000] });
  return [beat, beat];
}

// What the plain average may be held to. A lever's unlock stands 22 dB over the noise of the
// average, and these watches read within 0.02 ms and 0.3 degrees. A co-axial's stands 11 dB
// over it, as the Omega's does, and the prototype's shown readings of such watches were within
// 0.08 ms and 2 degrees.
const LEVER = { ms: 0.03, degrees: 0.5 };
const COAXIAL = { ms: 0.08, degrees: 2 };

test('a simulated Swiss lever 0.5 ms out of beat reads its beat error from the unlocks, with its sign, and its amplitude', () => {
  const run = simulated('lever 0.5 ms', () => leverWatch({ restOffsetDeg: 1.7, seed: 61 }), 50);
  assert.ok(Math.abs(Math.abs(run.truth.unlockGapMs) - 0.5) < 0.01 && run.truth.meanAmplitude === 270);
  assertReadsTruth(run, LEVER);
  const s = run.sounds;
  assert.ok(s.beats && s.beats.every((b) => b.sounds.length === 3), 'unlock, impulse and drop in each beat');
  // 40 s at 28,800 vph is 160 beats of each type; the first and last have no whole stretch.
  assert.ok(s.counts.every((c) => c >= 155 && c <= 160), `beats averaged ${s.counts}`);
  // A lever's two beats sound alike, so its timestamps are as far apart as its unlocks.
  assert.ok(s.timestampGapMs !== null && s.unlockGapMs !== null && Math.abs(s.timestampGapMs - s.unlockGapMs) < 0.02);
  assert.ok(s.unlockDb !== null && s.unlockDb > 18, `unlock ${s.unlockDb} dB over the noise of the average`);
});

test('a simulated Swiss lever in beat at 220 degrees reads no beat error and that amplitude', () => {
  const run = simulated('lever in beat at 220', () => leverWatch({ amplitude: 220, seed: 62 }), 50);
  assert.ok(Math.abs(run.truth.unlockGapMs) < 1e-9);
  assertReadsTruth(run, LEVER);
});

test('a simulated co-axial 0.5 ms out of beat reads 0.5 ms from its unlocks, where its timestamps are 3.6 ms apart', () => {
  const run = simulated('co-axial 0.5 ms', () => coaxialWatch({ restOffsetDeg: 1.35, seed: 11 }), 36);
  assert.ok(Math.abs(Math.abs(run.truth.unlockGapMs) - 0.5) < 0.01);
  assertReadsTruth(run, COAXIAL);
  const s = run.sounds;
  // The timestamps follow each beat's loudest sound, the impulse in one beat and the lock in
  // the other: Swiss-lever mode's beat error, which does not describe the watch.
  assert.ok(s.timestampGapMs !== null && Math.abs(s.timestampGapMs) > 3, `timestamps ${s.timestampGapMs} ms apart`);
  // The two beats cross different arcs, 37.45 and 34.55 degrees, so their times differ by 8%.
  assert.ok(s.liftMs && Math.abs(Math.max(...s.liftMs) / Math.min(...s.liftMs) - 1.083) < 0.02, `unlock to lock ${s.liftMs}`);
  assert.ok(s.amplitudes && Math.abs(s.amplitudes[0] - s.amplitudes[1]) > 15, 'one beat alone would read the amplitude 20 degrees off the other');
});

test('the same co-axial 1.0 ms out of beat the other way reads the opposite sign', () => {
  const one = simulated('co-axial 0.5 ms', () => coaxialWatch({ restOffsetDeg: 1.35, seed: 11 }), 36);
  const other = simulated('co-axial 1.0 ms the other way', () => coaxialWatch({ restOffsetDeg: -2.7, seed: 11 }), 36);
  assert.ok(Math.abs(Math.abs(other.truth.unlockGapMs) - 1.0) < 0.01 && Math.sign(other.truth.unlockGapMs) === -Math.sign(one.truth.unlockGapMs));
  assertReadsTruth(other, COAXIAL);
  assert.ok(one.sounds.unlockGapMs !== null && other.sounds.unlockGapMs !== null);
  assert.equal(Math.sign(other.sounds.unlockGapMs), -Math.sign(one.sounds.unlockGapMs));
});

test('a simulated lever whose impulse is 9 dB louder than its drop is still read from its unlock to its drop', () => {
  // Issue 24 of the investigation: paired on its loudest later sounds alone, this watch gave no
  // reading, its impulses coming 2.4 ms after the unlock.
  const run = simulated('lever impulse 9 dB over the drop', () => leverWatch({ sounds: leverSounds({ impulseDb: 34 }), seconds: 60, restOffsetDeg: 1.7, seed: 1 }), 50);
  assertReadsTruth(run, LEVER);
  const s = run.sounds;
  assert.ok(s.pair && s.beats);
  for (const j of [0, 1]) {
    const loudest = s.beats[j].sounds.reduce((a, b) => (b.level > a.level ? b : a));
    assert.ok(loudest !== s.pair.lock[j] && loudest.onsetMs < s.pair.lock[j].onsetMs, 'the loudest sound is the impulse, before the lock');
  }
});

test('a simulated lever whose unlock is too faint to find gives no reading, rather than one timed from its impulse', () => {
  // Issue 25: at 220 degrees the time from the impulse to the drop is itself believable, and
  // read as the lift it gave an amplitude 79 degrees high.
  const lost = simulated('lever unlock lost at 220', () => leverWatch({ sounds: leverSounds({ unlockDb: -10 }), amplitude: 220, restOffsetDeg: 1.7, seed: 1 }), 50);
  assert.equal(lost.sounds.why, 'no-middle-sound');
  assert.ok(lost.sounds.beats && lost.sounds.beats.every((b) => b.sounds.length === 2), 'impulse and drop are all that is heard');
  assert.ok(lost.sounds.amplitude === null && lost.sounds.beatErrorMs === null);
  // Issue 24: with a sound 4 ms after the drop, quieter than the impulse, the drop comes too
  // soon after the first sound and the later sound is not taken for the lock.
  const rebound = simulated('lever unlock lost, sound after the drop', () => leverWatch({ sounds: leverSounds({ unlockDb: -10, afterDrop: { delayMs: 4, db: 15 } }), restOffsetDeg: 1.7, seed: 1 }), 50);
  assert.equal(rebound.sounds.why, 'lift-range');
  assert.ok(rebound.sounds.refusedLiftMs && rebound.sounds.refusedLiftMs.every((t) => Math.abs(t - 5) < 0.1), `refused ${rebound.sounds.refusedLiftMs}`);
});

test('a simulated lever whose impulse cannot be heard gives no reading either: the cost of refusing a beat with nothing between', () => {
  const run = simulated('lever impulse missing', () => leverWatch({ sounds: leverSounds({ impulseDb: -10 }), restOffsetDeg: 1.7, seed: 1 }), 50);
  assert.equal(run.sounds.why, 'no-middle-sound');
});
