// Scattered timestamps. A beat made of several sounds gives a correlation curve with several
// peaks, and when the beat is faint the highest is not always the same one. A confident peak
// near where the beat is expected is preferred to a higher one elsewhere. That chooses among the
// positions one beat could have and never mixes beats, so a watch that really runs irregularly
// must still show its irregularity in full.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { synthesizeWatch } from '../js/audio/simulator.js';
import { pickPeak, pickPeakNear, runningMedian, NEAR_FRACTION } from '../js/dsp/timing.js';
import { stream, traceScatter, againstTruth } from './helpers/stream.js';
import { readWav } from './helpers/wav.js';

/** The timing as it was before: always the highest peak. */
const BEFORE = { preferNear: false };

/**
 * A correlation curve with rounded peaks at the given lags.
 * @param {[number, number][]} peaks lag and height of each
 * @returns {{c: Float64Array, lags: Int32Array}}
 */
function curve(peaks) {
  const lags = Int32Array.from({ length: 97 }, (_, i) => i - 48);
  const c = Float64Array.from(lags, (lag) => peaks.reduce((sum, [at, height]) => sum + height * Math.exp(-((lag - at) ** 2) / 8), 0));
  return { c, lags };
}

test('a peak near the expected lag is preferred only if it is confident and not much lower', () => {
  // The highest peak is 30 lags (2.5 ms) from where the beat is expected.
  const near = (/** @type {number} */ height) => curve([[30, 1], [1, height]]);
  const take = (/** @type {{c: Float64Array, lags: Int32Array}} */ k, expected = 0, threshold = 0.3) => pickPeakNear(k.c, k.lags, expected, 12, threshold);

  const preferred = take(near(0.8));
  assert.ok(Math.abs(preferred.lag - 1) < 0.1 && Math.abs(preferred.value - 0.8) < 0.01, `takes the nearer peak: lag ${preferred.lag}`);
  const weak = take(near(NEAR_FRACTION - 0.1));
  assert.ok(Math.abs(weak.lag - 30) < 0.1, `a much lower peak is not taken: lag ${weak.lag}`);
  const drowned = take(near(0.8), 0, 0.9);
  assert.ok(Math.abs(drowned.lag - 30) < 0.1, `nor one below the noise threshold: lag ${drowned.lag}`);
  // The highest peak itself is within reach of the expected lag: nothing to decide.
  const k = near(0.8);
  assert.deepEqual(take(k, 25), pickPeak(k.c, k.lags));
  // No peak near the expected lag, only the slope of the one further off.
  const slope = curve([[16, 1]]);
  assert.ok(Math.abs(take(slope, 0).lag - 16) < 0.1, 'a slope is not a peak');
});

test('the running median uses what there is at the ends', () => {
  assert.deepEqual(Array.from(runningMedian(Float64Array.from([5, 1, 9, 2, 8, 3, 7]), 3)), [3, 5, 2, 8, 3, 7, 5]);
});

test('faint beats of three sounds: most of the stray timestamps return to the line', () => {
  // Three sounds about 2 ms apart of similar loudness, as a blurred tick has.
  const sounds = [
    { dt: -0.002, amp: 0.85, decayMs: 0.5 },
    { dt: 0, amp: 1.0, decayMs: 0.5 },
    { dt: 0.0022, amp: 0.8, decayMs: 0.5 },
  ];
  const w = synthesizeWatch({ bph: 21600, rate: 5, beatOffsetMs: 0.3, gain: 0.8, seconds: 60, seed: 74, tickSounds: sounds });
  const far = (/** @type {import('../js/dsp/timing.js').TimingOptions} */ timing) => {
    const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { timing } });
    assert.ok(r.status.length > 0 && r.status.every((s) => s.state === 'tracking'), 'locked and stayed locked');
    const lines = /** @type {(0|1)[]} */ ([0, 1]).map((type) => traceScatter(r.beats, 21600, type));
    const last = /** @type {NonNullable<typeof r.last>} */ (r.last);
    return { stray: lines[0].far + lines[1].far, count: lines[0].count + lines[1].count, rate: /** @type {number} */ (last.rate), beatError: last.beatErrorMs };
  };
  const before = far(BEFORE);
  const after = far({});
  // Before: 48 of 243 confident timestamps lay more than 1 ms off their line. After: 10 of 245.
  assert.ok(before.stray / before.count > 0.12, `before: ${before.stray} of ${before.count} stray`);
  assert.ok(after.stray / after.count < 0.07, `after: ${after.stray} of ${after.count} stray`);
  assert.ok(after.stray < 0.5 * before.stray);
  assert.ok(Math.abs(after.rate - 5) < 0.5, `rate ${after.rate}`);
  assert.ok(after.beatError !== null && Math.abs(after.beatError - 0.3) < 0.08, `beat error ${after.beatError}`);
});

test('Omega 3861, second recording: the ticks keep to their line', () => {
  const wav = readWav(fileURLToPath(new URL('./fixtures/omega-3861-b.wav', import.meta.url)));
  const ticks = (/** @type {import('../js/dsp/timing.js').TimingOptions} */ timing) => {
    const r = stream(wav.channels, wav.sampleRate, { chunk: 1024, options: { escapement: 'coaxial', timing } });
    assert.ok(r.status.length > 3 && r.status.every((s) => s.state === 'tracking'));
    const lines = /** @type {(0|1)[]} */ ([0, 1]).map((type) => traceScatter(r.beats, 21600, type));
    // The tick is the beat type timed with less averaging when the lock begins.
    const tick = lines[0].cycles[0] <= lines[1].cycles[0] ? lines[0] : lines[1];
    return { tick, tock: tick === lines[0] ? lines[1] : lines[0], rate: /** @type {number} */ (/** @type {NonNullable<typeof r.last>} */ (r.last).rate) };
  };
  const before = ticks(BEFORE);
  const after = ticks({});
  // Before: 19 of 93 confident ticks lay more than 1 ms off the line. After: 6 of 93.
  assert.ok(before.tick.far / before.tick.count > 0.15, `before: ${before.tick.far} of ${before.tick.count} ticks stray`);
  assert.ok(after.tick.far / after.tick.count < 0.09, `after: ${after.tick.far} of ${after.tick.count} ticks stray`);
  assert.ok(after.tick.spreadMs < 0.85 * before.tick.spreadMs, `tick scatter ${before.tick.spreadMs.toFixed(3)} ms before, ${after.tick.spreadMs.toFixed(3)} ms after`);
  // The same averaging as before: the dots are as many as they were.
  assert.deepEqual(after.tick.cycles, before.tick.cycles);
  assert.equal(after.tick.count, before.tick.count);
  // The tocks were already tight and stay so; the rate reading does not move.
  assert.equal(after.tock.far, 0);
  assert.ok(after.tock.spreadMs < 0.12, `tock scatter ${after.tock.spreadMs.toFixed(3)} ms`);
  assert.ok(Math.abs(after.rate - before.rate) < 0.1, `rate ${before.rate} before, ${after.rate} after`);
});

test('a clear watch that runs irregularly still shows it, beat for beat', () => {
  // Every beat is displaced at random, with a standard deviation of 0.5 ms and then 1 ms. The
  // timestamps are compared with when each beat really fell.
  for (const jitterMs of [0.5, 1]) {
    const w = synthesizeWatch({ bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 50, seed: 91, jitterMs });
    const run = (/** @type {import('../js/dsp/timing.js').TimingOptions} */ timing) => {
      const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { timing } });
      assert.ok(r.status.length > 0 && r.status.every((s) => s.state === 'tracking'), `${jitterMs} ms: locked and stayed locked`);
      return /** @type {(0|1)[]} */ ([0, 1]).map((type) => ({ truth: againstTruth(r.beats, w.beatTimes, w.truePeriod, type), line: traceScatter(r.beats, 28800, type) }));
    };
    const before = run(BEFORE);
    const after = run({});
    for (const type of [0, 1]) {
      const a = after[type];
      const b = before[type];
      assert.deepEqual(a.line.cycles, [1], `${jitterMs} ms, type ${type}: every beat timed on its own`);
      assert.ok(a.truth.count > 150, `${jitterMs} ms, type ${type}: ${a.truth.count} timestamps compared`);
      // The trace shows the irregularity in full: each beat's displacement, not an average.
      assert.ok(a.truth.follows > 0.85 && a.truth.follows < 1.1, `${jitterMs} ms, type ${type}: follows the true displacements by ${a.truth.follows.toFixed(2)}`);
      assert.ok(a.line.sdMs > 0.8 * jitterMs, `${jitterMs} ms, type ${type}: trace scatter ${a.line.sdMs.toFixed(2)} ms`);
      // And the timestamps are no further from the truth than before.
      assert.ok(a.truth.errorMs <= b.truth.errorMs + 0.02, `${jitterMs} ms, type ${type}: error ${b.truth.errorMs.toFixed(3)} ms before, ${a.truth.errorMs.toFixed(3)} ms after`);
    }
  }
});
