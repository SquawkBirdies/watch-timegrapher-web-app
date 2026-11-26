// The sounds inside each beat, read from simulated watches that go through the whole pipeline:
// audio built from the motion of a balance (tests/helpers/balance.js), whose unlocks, locks and
// amplitude are known, timed by the app's own analysis and then read by milestone 8's stage
// (js/dsp/sounds.js and js/dsp/amplitude.js). The stage on its own, without the pipeline, is
// tested in sounds.test.js, and the real recordings in recordings.test.js.
//
// Each watch is analysed once, and this file takes about four minutes: 55 watches of 20 to 60 s.
// The beat rate is given: the stage reads the beats the pipeline timed, however their rate was
// found, and a detected rate gives the same timestamps in about twice the time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from './helpers/balance.js';
import { analyze } from '../js/dsp/offline.js';

/**
 * @typedef {import('./helpers/balance.js').BalanceWatchOptions} BalanceWatchOptions
 * @typedef {import('./helpers/balance.js').BeatSound} BeatSound
 * @typedef {{name: string, group: string, liftAngle: number, make: () => BalanceWatchOptions}} Watch
 */

/**
 * @typedef {Object} Simulated
 * @property {Watch} watch
 * @property {import('../js/dsp/amplitude.js').SoundsReading} sounds what the stage read
 * @property {boolean} irregular whether the pipeline found the watch irregular
 * @property {number} meanAmplitude the true amplitude, averaged over the beats
 * @property {number} unlockGapMs the true gap between the unlocks, in the pipeline's naming of the beats
 * @property {[number, number]} liftMs the true times from unlock to lock, in that naming
 */

/** @type {Map<string, Simulated>} */
const runs = new Map();

/**
 * A simulated watch and what the stage read from it, made once.
 * @param {Watch} watch
 * @returns {Simulated}
 */
function simulated(watch) {
  let run = runs.get(watch.name);
  if (!run) {
    const options = watch.make();
    const made = synthesizeBalanceWatch(options);
    const analysis = analyze(made.channels, made.sampleRate, { bph: options.bph, liftAngle: watch.liftAngle });
    assert.ok(analysis.sounds);
    // The pipeline calls whichever beat comes first in its first cycle the tick. The truth
    // counts beats from the first one made, so its even beats may be either.
    const first = analysis.beats[0].t[analysis.beats[0].ok.indexOf(1)];
    let nearest = 0;
    made.truth.lock.forEach((t, k) => {
      if (Math.abs(t - first) < Math.abs(made.truth.lock[nearest] - first)) nearest = k;
    });
    const even = nearest % 2 === 0;
    const [a, b] = made.truth.liftMs;
    run = {
      watch,
      sounds: analysis.sounds,
      irregular: analysis.irregular,
      meanAmplitude: made.truth.meanAmplitude,
      unlockGapMs: even ? made.truth.unlockGapMs : -made.truth.unlockGapMs,
      liftMs: even ? [a, b] : [b, a],
    };
    runs.set(watch.name, run);
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
  assert.ok(Math.abs(s.amplitude - run.meanAmplitude) <= within.degrees, `amplitude ${s.amplitude.toFixed(2)}, truly ${run.meanAmplitude.toFixed(2)}`);
}

/**
 * The simulated lever's three sounds with the impulse and the unlock at other levels, and
 * optionally a fourth sound after the drop, as a rebound might make.
 * @param {{impulseDb?: number, unlockDb?: number, afterDrop?: {delayMs: number, db: number}}} [levels]
 * @returns {[BeatSound[], BeatSound[]]}
 */
function leverSounds({ impulseDb = 18, unlockDb = 12, afterDrop } = {}) {
  /** @type {BeatSound[]} */
  const beat = [
    { after: 'unlock', db: unlockDb, riseMs: 0.12, decayMs: 0.5, band: [7000, 22000] },
    { after: 'unlock', delayMs: 2.4, delayJitterMs: 0.08, db: impulseDb, riseMs: 0.1, decayMs: 0.5, band: [5000, 22000] },
    { after: 'lock', db: 25, riseMs: 0.08, decayMs: 0.7, band: [5000, 22000] },
  ];
  if (afterDrop) beat.push({ after: 'lock', delayMs: afterDrop.delayMs, delayJitterMs: 0.1, db: afterDrop.db, riseMs: 0.12, decayMs: 0.5, band: [5000, 22000] });
  return [beat, beat];
}

// The 46 watches the prototype was judged on (`checks.py sims` in tools/prototype/coaxial/), with
// the same settings and seeds: co-axials on the Omega 3861's pattern, their unlock 5 dB over the
// background unless said, 60 s long unless said, read at 36 degrees of lift; and four levers of
// 40 s, read at 50.
/** @type {Watch[]} */
const FORTY_SIX = [];
/** @param {string} group @param {number} seed @param {Parameters<typeof coaxialWatch>[0]} overrides */
const coaxial = (group, seed, overrides) => FORTY_SIX.push({ name: `${group}, seed ${seed}`, group, liftAngle: 36, make: () => coaxialWatch({ ...overrides, seed }) });
for (let seed = 1; seed <= 8; seed++) coaxial('co-axial in beat', seed, {});
for (const [restOffsetDeg, label] of /** @type {[number, string][]} */ ([[1.35, '0.5 ms'], [2.7, '1.0 ms'], [-2.7, '1.0 ms the other way'], [5.4, '2.0 ms']])) {
  for (const seed of [11, 12]) coaxial(`co-axial beat error ${label}`, seed, { restOffsetDeg });
}
for (const amplitude of [200, 240, 310]) for (const seed of [21, 22]) coaxial(`co-axial amplitude ${amplitude}`, seed, { amplitude });
for (const seed of [31, 32]) coaxial('co-axial amplitude wandering', seed, { amplitude: (t) => 285 + 10 * Math.sin((2 * Math.PI * t) / 23) });
for (const unlockDb of [4, 3, 2, 0]) for (const seed of [41, 42, 43]) coaxial(`co-axial unlock ${unlockDb} dB`, seed, { unlockDb });
for (const seconds of [30, 20]) for (const seed of [51, 52, 53]) coaxial(`co-axial ${seconds} s`, seed, { seconds });
for (const [restOffsetDeg, label] of /** @type {[number, string][]} */ ([[0, '0'], [1.7, '0.5']])) {
  for (const seed of [61, 62]) {
    const group = `lever beat error ${label} ms`;
    FORTY_SIX.push({ name: `${group}, seed ${seed}`, group, liftAngle: 50, make: () => leverWatch({ restOffsetDeg, seed }) });
  }
}

/** @param {string} name */
const ofTheFortySix = (name) => {
  const watch = FORTY_SIX.find((w) => w.name === name);
  assert.ok(watch, name);
  return simulated(watch);
};

/** All 46, read. */
const fortySix = () => FORTY_SIX.map(simulated);

/**
 * A lever outside the 46.
 * @param {string} name
 * @param {() => BalanceWatchOptions} make
 */
const lever = (name, make) => simulated({ name, group: name, liftAngle: 50, make });

// What a single watch's reading is held to. A lever's unlock stands 22 dB over the noise of the
// average, and these read within 0.02 ms and 0.3 degrees. A co-axial's stands 11 dB over it, as
// the Omega's does, and the prototype's shown readings of such watches were within 0.08 ms and
// 2 degrees.
const LEVER = { ms: 0.03, degrees: 0.5 };
const COAXIAL = { ms: 0.08, degrees: 2 };

test('a simulated Swiss lever 0.5 ms out of beat reads its beat error from the unlocks, with its sign, and its amplitude, and both may be shown', () => {
  const run = ofTheFortySix('lever beat error 0.5 ms, seed 61');
  assert.ok(Math.abs(Math.abs(run.unlockGapMs) - 0.5) < 0.01 && run.meanAmplitude === 270);
  assertReadsTruth(run, LEVER);
  const s = run.sounds;
  assert.ok(s.beats && s.beats.every((b) => b.sounds.length === 3), 'unlock, impulse and drop in each beat');
  // 40 s at 28,800 vph is 160 beats of each type; the first and last have no whole stretch.
  assert.ok(s.counts.every((c) => c >= 155 && c <= 160), `beats averaged ${s.counts}`);
  // A lever's two beats sound alike, so its timestamps are as far apart as its unlocks.
  assert.ok(s.timestampGapMs !== null && s.unlockGapMs !== null && Math.abs(s.timestampGapMs - s.unlockGapMs) < 0.02);
  assert.ok(s.unlockDb !== null && s.unlockDb > 18, `unlock ${s.unlockDb} dB over the noise of the average`);
  // Drawn again 200 times, its beats give the same reading within a hundredth of a millisecond.
  assert.ok(s.scatter && s.scatter.unlockGapMs > 0.003 && s.scatter.unlockGapMs < 0.02 && s.scatter.amplitude < 0.5, `scatter ${s.scatter?.unlockGapMs} ms and ${s.scatter?.amplitude} degrees`);
  assert.deepEqual([s.showBeatError, s.showAmplitude, s.failing], [true, true, 0]);
  assert.ok(s.lining && s.lining.state === 'steady', 'nothing moves, so the plain average stands');
});

test('a simulated Swiss lever in beat at 220 degrees reads no beat error and that amplitude', () => {
  const run = lever('lever in beat at 220', () => leverWatch({ amplitude: 220, seed: 62 }));
  assert.ok(Math.abs(run.unlockGapMs) < 1e-9);
  assertReadsTruth(run, LEVER);
  assert.ok(run.sounds.showBeatError && run.sounds.showAmplitude);
});

test('a simulated co-axial 0.5 ms out of beat reads 0.5 ms from its unlocks, where its timestamps are 3.6 ms apart', () => {
  const run = ofTheFortySix('co-axial beat error 0.5 ms, seed 11');
  assert.ok(Math.abs(Math.abs(run.unlockGapMs) - 0.5) < 0.01);
  assertReadsTruth(run, COAXIAL);
  const s = run.sounds;
  // The timestamps follow each beat's loudest sound, the impulse in one beat and the lock in
  // the other: Swiss-lever mode's beat error, which does not describe the watch.
  assert.ok(s.timestampGapMs !== null && Math.abs(s.timestampGapMs) > 3, `timestamps ${s.timestampGapMs} ms apart`);
  // The two beats cross different arcs, 37.45 and 34.55 degrees, so their times differ by 8%.
  assert.ok(s.liftMs && Math.abs(Math.max(...s.liftMs) / Math.min(...s.liftMs) - 1.083) < 0.02, `unlock to lock ${s.liftMs}`);
  assert.ok(s.amplitudes && Math.abs(s.amplitudes[0] - s.amplitudes[1]) > 15, 'one beat alone would read the amplitude 20 degrees off the other');
  // Its unlock is faint, so its scatter is three times a lever's.
  assert.ok(s.scatter && s.scatter.unlockGapMs > 0.015 && s.scatter.unlockGapMs < 0.06, `scatter ${s.scatter?.unlockGapMs} ms`);
  assert.ok(s.showBeatError && s.showAmplitude);
});

test('the same co-axial 1.0 ms out of beat the other way reads the opposite sign', () => {
  const one = ofTheFortySix('co-axial beat error 0.5 ms, seed 11');
  const other = ofTheFortySix('co-axial beat error 1.0 ms the other way, seed 11');
  assert.ok(Math.abs(Math.abs(other.unlockGapMs) - 1.0) < 0.01 && Math.sign(other.unlockGapMs) === -Math.sign(one.unlockGapMs));
  assertReadsTruth(other, COAXIAL);
  assert.ok(one.sounds.unlockGapMs !== null && other.sounds.unlockGapMs !== null);
  assert.equal(Math.sign(other.sounds.unlockGapMs), -Math.sign(one.sounds.unlockGapMs));
});

test('a simulated lever whose impulse is 9 dB louder than its drop is still read from its unlock to its drop', () => {
  // Issue 24 of the investigation: paired on its loudest later sounds alone, this watch gave no
  // reading, its impulses coming 2.4 ms after the unlock.
  const run = lever('lever impulse 9 dB over the drop', () => leverWatch({ sounds: leverSounds({ impulseDb: 34 }), seconds: 60, restOffsetDeg: 1.7, seed: 1 }));
  assertReadsTruth(run, LEVER);
  const s = run.sounds;
  assert.ok(s.pair && s.beats && s.showBeatError && s.showAmplitude);
  for (const j of [0, 1]) {
    const loudest = s.beats[j].sounds.reduce((a, b) => (b.level > a.level ? b : a));
    assert.ok(loudest !== s.pair.lock[j] && loudest.onsetMs < s.pair.lock[j].onsetMs, 'the loudest sound is the impulse, before the lock');
  }
});

test('a simulated lever whose unlock is too faint to find gives no reading, rather than one timed from its impulse', () => {
  // Issue 25: at 220 degrees the time from the impulse to the drop is itself believable, and
  // read as the lift it gave an amplitude 79 degrees high.
  const lost = lever('lever unlock lost at 220', () => leverWatch({ sounds: leverSounds({ unlockDb: -10 }), amplitude: 220, restOffsetDeg: 1.7, seed: 1 }));
  assert.equal(lost.sounds.why, 'no-middle-sound');
  assert.ok(lost.sounds.beats && lost.sounds.beats.every((b) => b.sounds.length === 2), 'impulse and drop are all that is heard');
  assert.ok(lost.sounds.amplitude === null && lost.sounds.beatErrorMs === null && !lost.sounds.showAmplitude && !lost.sounds.showBeatError);
  // Issue 24: with a sound 4 ms after the drop, quieter than the impulse, the drop comes too
  // soon after the first sound and the later sound is not taken for the lock.
  const rebound = lever('lever unlock lost, sound after the drop', () => leverWatch({ sounds: leverSounds({ unlockDb: -10, afterDrop: { delayMs: 4, db: 15 } }), restOffsetDeg: 1.7, seed: 1 }));
  assert.equal(rebound.sounds.why, 'lift-range');
  assert.ok(rebound.sounds.refusedLiftMs && rebound.sounds.refusedLiftMs.every((t) => Math.abs(t - 5) < 0.1), `refused ${rebound.sounds.refusedLiftMs}`);
});

test('a simulated lever whose impulse cannot be heard gives no reading either: the cost of refusing a beat with nothing between', () => {
  const run = lever('lever impulse missing', () => leverWatch({ sounds: leverSounds({ impulseDb: -10 }), restOffsetDeg: 1.7, seed: 1 }));
  assert.equal(run.sounds.why, 'no-middle-sound');
});

// The four checks Lawrence set on 25 November for the 46 simulated watches. A fixed limit of
// 0.1 ms on every shown reading would fail: the gates limit a reading's scatter, not its error,
// and a co-axial in beat (seed 3) is shown 0.14 ms off at a stated +-0.07 ms.

/**
 * The beat errors the gates let through, each with its error and its stated scatter.
 * @returns {{name: string, error: number, scatter: number}[]}
 */
function shownBeatErrors() {
  return fortySix().filter((run) => run.sounds.showBeatError).map((run) => {
    const s = run.sounds;
    assert.ok(s.unlockGapMs !== null && s.scatter);
    return { name: run.watch.name, error: s.unlockGapMs - run.unlockGapMs, scatter: s.scatter.unlockGapMs };
  });
}

test('every beat error shown for the 46 simulated watches lies within three times its own stated scatter of the truth, and within 0.15 ms', () => {
  const shown = shownBeatErrors();
  for (const r of shown) {
    // The worst of them: 2.4 times (a co-axial in beat, seed 5, and one 2.0 ms out, seed 12).
    assert.ok(Math.abs(r.error) <= 3 * r.scatter, `${r.name}: ${r.error.toFixed(3)} ms off at a stated +-${r.scatter.toFixed(3)}`);
    // An outer bound against a gross fault. The worst: 0.137 ms (a co-axial in beat, seed 3).
    assert.ok(Math.abs(r.error) <= 0.15, `${r.name}: ${r.error.toFixed(3)} ms off`);
  }
  // Every sign is right: no reading out of beat lies on the wrong side of zero.
  for (const run of fortySix()) {
    const s = run.sounds;
    if (s.showBeatError && s.unlockGapMs !== null && Math.abs(run.unlockGapMs) > 0.2) assert.equal(Math.sign(s.unlockGapMs), Math.sign(run.unlockGapMs), run.watch.name);
  }
});

test('over the 46 the beat errors shown are off by about as much as their stated scatter says', () => {
  const shown = shownBeatErrors();
  const rms = Math.sqrt(shown.reduce((sum, r) => sum + (r.error / r.scatter) ** 2, 0) / shown.length);
  // 1 would be a scatter stated exactly; this stage's draws give 1.06, the prototype's 1.22 on
  // the same envelopes. Thirty-one readings give the figure to about 13%, so a scatter stated
  // a third too narrow or too wide would fall outside.
  assert.ok(rms >= 0.7 && rms <= 1.5, `errors ${rms.toFixed(2)} times the stated scatter, rms`);
});

test('31 of the 46 beat errors are shown, as the prototype shows on the same envelopes: none with the unlock 2 dB over the background or fainter, none from 20 s', () => {
  const all = fortySix();
  const shown = all.filter((run) => run.sounds.showBeatError);
  assert.ok(shown.length >= 29 && shown.length <= 33, `${shown.length} shown`);
  // The 24 co-axials of 60 s with the unlock at its 5 dB, and the 4 levers.
  const clear = all.filter((run) => !/unlock \d dB|\d0 s/.test(run.watch.group));
  assert.equal(clear.length, 28);
  for (const run of clear) assert.ok(run.sounds.showBeatError && run.sounds.showAmplitude, `${run.watch.name}: held back for ${run.sounds.beatErrorHeld ?? run.sounds.why}`);
  // Too faint, or too short: nothing may be shown, whatever was read.
  const hard = all.filter((run) => /unlock [20] dB|20 s/.test(run.watch.group));
  assert.equal(hard.length, 9);
  for (const run of hard) {
    const s = run.sounds;
    assert.ok(!s.showBeatError && !s.showAmplitude, `${run.watch.name} shown`);
    assert.ok(s.why !== null || s.beatErrorHeld === 'failing', `${run.watch.name}: ${s.why ?? s.beatErrorHeld}`);
  }
  // One of them took another sound for an unlock and read 3 ms: 95% of its draws disagree.
  const wrong = ofTheFortySix('co-axial unlock 0 dB, seed 42').sounds;
  assert.ok(wrong.unlockGapMs !== null && Math.abs(wrong.unlockGapMs) > 2.5 && wrong.failing !== null && wrong.failing > 0.9 && !wrong.showBeatError);
});

test('every amplitude shown for the 46 lies within 2 degrees of the truth, and the two whose amplitude wanders are lined up again', () => {
  const shown = fortySix().filter((run) => run.sounds.showAmplitude);
  assert.ok(shown.length >= 29 && shown.length <= 33, `${shown.length} shown`);
  for (const run of shown) {
    const s = run.sounds;
    assert.ok(s.amplitude !== null && s.scatter);
    // The worst: 1.6 degrees (a co-axial in beat, seed 3).
    assert.ok(Math.abs(s.amplitude - run.meanAmplitude) <= 2, `${run.watch.name}: ${s.amplitude.toFixed(1)}, truly ${run.meanAmplitude.toFixed(1)}`);
    assert.ok(s.scatter.amplitude < 2, `${run.watch.name}: +-${s.scatter.amplitude.toFixed(1)}`);
  }
  // A swing of 10 degrees either way every 23 s moves the unlock against the timestamps.
  for (const seed of [31, 32]) {
    const s = ofTheFortySix(`co-axial amplitude wandering, seed ${seed}`).sounds;
    assert.ok(s.lining && s.lining.state === 'lined' && s.lining.moved && s.lining.moved.some((type) => type.some((m) => m.moved)), `seed ${seed}: ${s.lining?.state}`);
  }
});

test('a simulated lever the pipeline finds irregular keeps its amplitude, and its beat error is held back though its draws agree', () => {
  // Each beat 0.5 ms off the regular grid (standard deviation): issue 11 of the investigation.
  const run = lever('lever with 0.5 ms of beat jitter', () => leverWatch({ restOffsetDeg: 1.7, beatJitterMs: 0.5, seed: 72 }));
  const s = run.sounds;
  assert.equal(run.irregular, true);
  assert.ok(s.amplitude !== null && s.scatter && s.unlockGapMs !== null);
  assert.deepEqual([s.showBeatError, s.beatErrorHeld, s.showAmplitude, s.amplitudeHeld], [false, 'irregular', true, null]);
  // The gap between unlocks was read, and its scatter alone would have passed the gate.
  assert.ok(s.scatter.unlockGapMs < 0.1, `scatter ${s.scatter.unlockGapMs} ms`);
  assert.ok(Math.abs(s.amplitude - 270) <= 0.5 && s.scatter.amplitude < 0.5, `amplitude ${s.amplitude} +- ${s.scatter.amplitude}`);
});

test('a simulated lever whose amplitude falls from 290 to 250 degrees in 40 s is lined up again and read right', () => {
  const run = lever('lever falling from 290 to 250 degrees', () => leverWatch({ restOffsetDeg: 1.7, amplitude: (t) => 290 - Math.min(t, 40), seed: 81 }));
  const s = run.sounds;
  assert.ok(s.lining && s.lining.moved);
  assert.equal(s.lining.state, 'lined');
  // The timestamps follow the drop, so it is the unlocks that move against them.
  assert.ok(s.lining.moved.every((type) => type[0].moved), 'both unlocks move');
  // The plain average of this watch reads 264.6 degrees, 5.4 low, and shows it.
  assertReadsTruth(run, { ms: 0.03, degrees: 1 });
  assert.ok(s.showBeatError && s.showAmplitude);
});

test('a simulated lever swinging by 30 degrees either way every 40 s, too fast for 10 s blocks to follow, shows nothing', () => {
  const run = lever('lever swinging every 40 s', () => leverWatch({ restOffsetDeg: 1.7, seconds: 60, amplitude: (t) => 270 + 30 * Math.sin((2 * Math.PI * t) / 40), seed: 82 }));
  const s = run.sounds;
  // Its unlock is smeared within every block, so nothing is found to line up on, and the plain
  // average reads the amplitude 10 degrees high. A quarter of the draws take another sound.
  assert.ok(s.amplitude !== null && s.failing !== null && s.otherSound !== null);
  assert.ok(s.amplitude - run.meanAmplitude > 5, `amplitude ${s.amplitude}, truly ${run.meanAmplitude}`);
  assert.ok(s.failing > 0.1 && s.otherSound > 0.1, `failing ${s.failing}, another sound in ${s.otherSound}`);
  assert.deepEqual([s.showBeatError, s.beatErrorHeld, s.showAmplitude, s.amplitudeHeld], [false, 'failing', false, 'failing']);
});
