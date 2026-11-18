// The real-time pipeline, fed in small chunks as the microphone will feed it. The synthetic
// cases and their pass criteria are the prototype's, which the offline analysis was first held
// to; the pipeline runs the same stages, so they are checked here only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeWatch } from '../js/audio/simulator.js';
import { stream, join } from './helpers/stream.js';

/**
 * @param {number|null} actual @param {number} expected @param {number} tolerance @param {string} what
 */
function near(actual, expected, tolerance, what) {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${what}: got ${actual === null ? 'nothing' : actual.toFixed(3)}, expected ${expected} within ${tolerance}`);
}

/**
 * At the default 20 s averaging window, every reading once the window has filled spans about
 * 20 s and lies within three times its stated uncertainty of the true rate.
 * @param {ReturnType<typeof stream>} r
 * @param {number} rate the true rate
 */
function readingsWithinStatedUncertainty(r, rate) {
  const late = r.readings.filter((x) => x.rate !== null && x.t > 30);
  assert.ok(late.length > 10, 'readings after the window filled');
  for (const x of late) {
    const span = /** @type {[number, number]} */ (x.window)[1] - /** @type {[number, number]} */ (x.window)[0];
    assert.ok(span > 18 && span <= 20.5, `window ${span.toFixed(1)} s`);
    const sd = /** @type {number} */ (x.rateSd);
    assert.ok(Math.abs(/** @type {number} */ (x.rate) - rate) <= 3 * sd + 0.05, `${x.rate} ± ${sd} against ${rate}`);
  }
}

/** The clear 28,800 vph watch, streamed once for the two tests that use it. */
let clearRun = /** @type {ReturnType<typeof stream>|null} */ (null);
const clear = () => {
  if (!clearRun) {
    const w = synthesizeWatch({ bph: 28800, rate: 12, beatOffsetMs: 0.3, gain: 1.6, seconds: 50, seed: 1 });
    clearRun = stream(w.channels, w.sampleRate);
  }
  return clearRun;
};

test('clear ticks at 28,800 vph: +12 s/day, 0.30 ms beat error, locked within 10 s', () => {
  const r = clear();
  assert.equal(r.status[0].state, 'tracking');
  assert.equal(r.status[0].bph, 28800);
  assert.ok(r.status[0].t < 10, `locked at ${r.status[0].t.toFixed(1)} s`);
  assert.ok(r.status.every((s) => s.state === 'tracking'), 'lock never lost');
  assert.ok(r.last);
  near(r.last.rate, 12, 0.2, 'rate');
  near(r.last.beatErrorMs, 0.3, 0.05, 'beat error');
  assert.ok(r.beats.every((b) => b.cycles <= 2), 'timed beat by beat');
  readingsWithinStatedUncertainty(r, 12);
});

test('21,600 vph with a mains buzz almost in step with the watch: -8 s/day, 0.80 ms', () => {
  const w = synthesizeWatch({ bph: 21600, rate: -8, beatOffsetMs: -0.8, gain: 1.2, seconds: 50, seed: 2 });
  const r = stream(w.channels, w.sampleRate);
  assert.equal(r.status[0].bph, 21600);
  assert.ok(r.last);
  near(r.last.rate, -8, 0.2, 'rate');
  near(r.last.beatErrorMs, 0.8, 0.05, 'beat error');
  readingsWithinStatedUncertainty(r, -8);
});

test('faint ticks at 18,000 vph: +45 s/day, found by averaging beats over a longer history, with the readings window lengthened to match', () => {
  const w = synthesizeWatch({ bph: 18000, rate: 45, beatOffsetMs: 0, gain: 0.45, seconds: 100, seed: 3 });
  // The averaging window is left at its 20 s default: it must lengthen by itself.
  const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { historySeconds: 80 } });
  assert.ok(r.status.length > 0 && r.status.every((s) => s.state === 'tracking'), 'locked and stayed locked');
  assert.equal(r.status[0].bph, 18000, 'not mistaken for 36,000 vph');
  const last = r.last;
  assert.ok(last && last.signal && last.rate !== null);
  near(last.rate, 45, 0.3, 'rate');
  assert.ok(Math.max(...r.beats.map((b) => b.cycles)) >= 4, 'weak-signal averaging was needed');
  if (last.beatErrorMs !== null) near(last.beatErrorMs, 0, 0.1, 'beat error');
  // Twelve independent timestamps of K cycles of 0.4 s each, or as many as the lock has had
  // time for: the window never reaches back before the lock began.
  const K = Math.max(...last.signal.cycles.map((c) => c || 1));
  assert.ok(K >= 4, `averaging ${K} cycles`);
  const [from, to] = /** @type {[number, number]} */ (last.window);
  const span = to - from;
  const lockStart = r.pipeline.toSeconds(r.pipeline.lockedFrom);
  const wanted = Math.min(12 * K * 0.4, to - lockStart);
  assert.ok(span >= wanted - 2 * K * 0.4, `window ${span.toFixed(1)} s for ${K}-cycle averages, wanted ${wanted.toFixed(1)} s`);
  assert.ok(from >= lockStart - 0.5, 'not before the lock began');
  assert.ok(span > 20, 'longer than the 20 s setting');
  assert.ok(Math.abs(last.rate - 45) <= 3 * /** @type {number} */ (last.rateSd) + 0.1, `rate ${last.rate} ± ${last.rateSd}`);
});

test('noise and mains buzz alone never give a lock', () => {
  const w = synthesizeWatch({ bph: 21600, gain: 0, seconds: 120, seed: 4 });
  const r = stream(w.channels, w.sampleRate, { chunk: 1024 });
  assert.equal(r.status.length, 0);
  assert.equal(r.readings.length, 0);
  assert.equal(r.beats.length, 0);
});

for (const [bph, rate] of /** @type {[number, number][]} */ ([[18000, -10], [19800, 20], [21600, -20], [25200, -30], [28800, 30], [36000, 10]])) {
  test(`beat rate ${bph} vph is recognised: ${rate} s/day, 0.50 ms beat error`, () => {
    const w = synthesizeWatch({ bph, rate, beatOffsetMs: 0.5, gain: 1.4, seconds: 40, seed: bph });
    // The tolerances suit a 40 s window; the default 20 s window is tested above.
    const r = stream(w.channels, w.sampleRate, { chunk: 512, options: { averagingSeconds: 40 } });
    assert.equal(r.status[0].bph, bph);
    assert.ok(r.last);
    near(r.last.rate, rate, 0.2, 'rate');
    near(r.last.beatErrorMs, 0.5, 0.05, 'beat error');
  });
}

test('when the ticking stops the readings are blanked, and the lock returns with the watch', () => {
  const watch = { bph: 28800, rate: 5, beatOffsetMs: 0.2, gain: 1.6 };
  const audio = join([
    synthesizeWatch({ ...watch, seconds: 20, seed: 5 }),
    synthesizeWatch({ ...watch, gain: 0, seconds: 20, seed: 6 }),
    synthesizeWatch({ ...watch, seconds: 25, seed: 7 }),
  ]);
  const r = stream(audio, 48000, { chunk: 256 });
  const lost = r.status.find((s) => s.state === 'listening');
  assert.ok(lost, 'the lock was dropped');
  assert.ok(lost.t > 20 && lost.t < 30, `dropped at ${lost.t.toFixed(1)} s, within 10 s of the watch stopping`);
  const blank = r.readings.find((x) => x.t >= lost.t);
  assert.ok(blank && blank.rate === null && blank.beatErrorMs === null, 'readings blanked');
  assert.ok(!r.status.some((s) => s.state === 'tracking' && s.t > lost.t && s.t < 40), 'no lock on the silence');
  assert.ok(!r.beats.some((b) => b.t > lost.t && b.t < 40), 'no beats reported once the lock was dropped');
  const back = r.status.find((s) => s.state === 'tracking' && s.t > 40);
  assert.ok(back, 'locked again');
  assert.ok(back.t < 52, `locked again at ${back.t.toFixed(1)} s`);
  assert.ok(r.last);
  near(r.last.rate, 5, 0.5, 'rate after the watch returned');
});

test('a beat rate given by the user is used without searching the others', () => {
  // A quiet, evenly spaced 18,000 vph watch: the case most easily mistaken for 36,000 vph.
  const w = synthesizeWatch({ bph: 18000, rate: 5, beatOffsetMs: 0, gain: 0.7, seconds: 40, seed: 77 });
  const auto = stream(w.channels, w.sampleRate, { chunk: 1024 });
  const told = stream(w.channels, w.sampleRate, { chunk: 1024, options: { bph: 18000 } });
  for (const r of [auto, told]) {
    assert.ok(r.status.length > 0 && r.status.every((s) => s.state === 'tracking'), 'locked and stayed locked');
    assert.equal(r.status[0].bph, 18000);
    assert.ok(r.last);
    near(r.last.rate, 5, 0.3, 'rate');
  }
  assert.ok(told.status[0].t <= auto.status[0].t, 'the lock is not found later');
});

test('a wrong beat rate from the user never gives a wrong rate or beat error', () => {
  // An unrelated rate finds nothing to lock on.
  for (const told of [28800, 19800]) {
    for (const rate of [-10, 10]) {
      const w = synthesizeWatch({ bph: 21600, rate, beatOffsetMs: 0.5, gain: 1.4, seconds: 40, seed: 21600 });
      const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { bph: told } });
      assert.equal(r.status.length, 0, `21,600 vph watch, told ${told}`);
      assert.equal(r.readings.length, 0);
    }
  }
  // 18,000 and 36,000 vph are exact multiples, so a mix-up can still lock. The rate in seconds
  // per day is then still right, and no beat error is shown. Told 18,000 vph, a 36,000 vph watch
  // has its every other beat taken, so the tick and the tock found are both its ticks, and its
  // tocks fall halfway between them. It is run for 60 s: in 40 s it gives no reading at all, and
  // in 60 s, before the halfway beat was looked for, every reading showed about 0.005 ms.
  for (const [actual, told, seconds] of /** @type {[number, number, number][]} */ ([[18000, 36000, 40], [36000, 18000, 60]])) {
    for (const rate of [-10, 10]) {
      const w = synthesizeWatch({ bph: actual, rate, beatOffsetMs: 0.5, gain: 1.4, seconds, seed: actual });
      const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { bph: told } });
      const read = r.readings.filter((x) => x.rate !== null);
      if (actual === 36000) {
        assert.ok(read.length >= 10, `${actual} vph watch, told ${told}: ${read.length} readings`);
        assert.ok(read.some((x) => x.beatErrorDetail && x.beatErrorDetail.halfway), 'the beat halfway between was found');
      }
      for (const x of read) {
        near(x.rate, rate, 1, `${actual} vph watch, told ${told}: rate at ${x.t.toFixed(1)} s`);
        assert.equal(x.beatErrorMs, null, `${actual} vph watch, told ${told}: beat error at ${x.t.toFixed(1)} s`);
      }
    }
  }
});

test('the result does not depend on how the audio is cut into chunks', () => {
  const w = synthesizeWatch({ bph: 21600, rate: 3, beatOffsetMs: 0.4, gain: 1.4, seconds: 30, seed: 8 });
  const results = [128, 1000, 4096, 48000].map((chunk) => stream(w.channels, w.sampleRate, { chunk }));
  // The last 0 to 2047 samples wait for a full block, so compare everything reported.
  const first = results[0];
  for (const r of results.slice(1)) {
    assert.equal(r.beats.length, first.beats.length);
    assert.deepEqual(r.beats.map((b) => b.t), first.beats.map((b) => b.t));
    assert.deepEqual(r.last, first.last);
  }
});

test('the pipeline runs several times faster than real time', () => {
  // Timed on the run of the clear watch above.
  const r = clear();
  const speed = r.audioSeconds / r.elapsedSeconds;
  assert.ok(speed >= 3, `${speed.toFixed(1)} times real time`);
});
