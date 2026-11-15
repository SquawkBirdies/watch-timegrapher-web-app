// Scattered timestamps. A beat made of several sounds gives a correlation curve with several
// peaks, and when the beat is faint the highest is not always the same one. Two measures keep
// the trace together: a confident peak near where the beat is expected is preferred to a higher
// one elsewhere, and beats that still scatter are averaged over more cycles, up to twice as
// many. Neither may hide the irregular running of a watch that can be heard clearly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { synthesizeWatch } from '../js/audio/simulator.js';
import { pickPeak, pickPeakNear, runningMedian, NEAR_FRACTION } from '../js/dsp/timing.js';
import { stream, traceScatter } from './helpers/stream.js';
import { readWav } from './helpers/wav.js';

/** The timing as it was before the two measures. */
const BEFORE = { preferNear: false, maxSpreadMs: Infinity };

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
  // Before: about one confident tick in five lay more than 1 ms off the line.
  assert.ok(before.tick.far / before.tick.count > 0.15, `before: ${before.tick.far} of ${before.tick.count} ticks stray`);
  assert.deepEqual(before.tick.cycles, [2]);
  assert.ok(after.tick.far / after.tick.count < 0.05, `after: ${after.tick.far} of ${after.tick.count} ticks stray`);
  assert.ok(after.tick.spreadMs < 0.3 && after.tick.spreadMs < 0.65 * before.tick.spreadMs, `tick scatter ${before.tick.spreadMs.toFixed(3)} ms before, ${after.tick.spreadMs.toFixed(3)} ms after`);
  // The ticks are averaged over more cycles, but no more than twice as many.
  assert.ok(after.tick.cycles.every((k) => k <= 4) && after.tick.cycles.includes(4), `ticks average ${after.tick.cycles} cycles`);
  // The tocks were already tight and stay so; the rate reading does not move.
  assert.equal(after.tock.far, 0);
  assert.ok(after.tock.spreadMs < 0.12, `tock scatter ${after.tock.spreadMs.toFixed(3)} ms`);
  assert.ok(Math.abs(after.rate - before.rate) < 0.1, `rate ${before.rate} before, ${after.rate} after`);
});

test('a clear watch that runs irregularly still shows it', () => {
  // Every beat is displaced at random, with a standard deviation of 0.4 ms.
  const w = synthesizeWatch({ bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 50, seed: 91, jitterMs: 0.4 });
  const r = stream(w.channels, w.sampleRate, { chunk: 1024 });
  assert.ok(r.status.length > 0 && r.status.every((s) => s.state === 'tracking'));
  let beyond = 0;
  for (const type of /** @type {(0|1)[]} */ ([0, 1])) {
    const line = traceScatter(r.beats, 28800, type);
    assert.deepEqual(line.cycles, [1], `type ${type}: every beat is timed on its own`);
    assert.ok(line.sdMs > 0.3 && line.sdMs < 0.55, `type ${type}: scatter ${line.sdMs.toFixed(3)} ms`);
    beyond += line.far;
  }
  // About one beat in a hundred is displaced by more than 1 ms, and stays where it fell.
  assert.ok(beyond >= 3, `${beyond} beats more than 1 ms off the line`);
  const last = /** @type {NonNullable<typeof r.last>} */ (r.last);
  assert.ok(last.jitterMs !== null && last.jitterMs > 0.3 && last.jitterMs < 0.55, `scatter reading ${last.jitterMs}`);
});

test('the same irregular watch heard faintly: more averaging, by at most double', () => {
  const w = synthesizeWatch({ bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 0.9, seconds: 50, seed: 91, jitterMs: 0.4 });
  const run = (/** @type {import('../js/dsp/timing.js').TimingOptions} */ timing) => {
    const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { timing } });
    assert.ok(r.status.length > 0 && r.status.every((s) => s.state === 'tracking'));
    return /** @type {(0|1)[]} */ ([0, 1]).map((type) => traceScatter(r.beats, 28800, type));
  };
  const before = run({ maxSpreadMs: Infinity });
  const after = run({});
  for (const type of [0, 1]) {
    const least = Math.max(...before[type].cycles);
    const most = Math.max(...after[type].cycles);
    assert.ok(most > least && most <= 2 * least, `type ${type}: ${least} cycles before, ${most} after`);
  }
});
