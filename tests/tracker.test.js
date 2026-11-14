// The Kalman beat tracker on simulated beat times, where the truth is known.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BeatTracker } from '../js/dsp/tracker.js';
import { seededRandom, gaussianFrom } from '../js/audio/simulator.js';

/**
 * Simulated beat times in seconds: a period that wanders slowly, tocks displaced by `offset`,
 * and beat-to-beat scatter.
 * @param {{beats: number, period: number, offset: number, wander: number, scatter: number, seed: number}} o
 */
function simulate(o) {
  const g = gaussianFrom(seededRandom(o.seed));
  let phase = 0;
  let period = o.period;
  const times = [];
  const periods = [];
  for (let n = 0; n < o.beats; n++) {
    times.push(phase + (n % 2 ? o.offset : 0) + o.scatter * g());
    periods.push(period);
    phase += period;
    period += o.wander * g();
  }
  return { times, periods };
}

/** @param {number} period @param {number} [scatter] */
const start = (period, scatter = 80e-6) => new BeatTracker({ n: 0, phase: 0, period, offset: 0, phaseSd: 1e-3, periodSd: period * 3e-4, offsetSd: 2e-3, periodDrift: 5e-8, offsetDrift: 1e-7, scatter: [scatter, scatter] });

test('tracker follows a wandering rate and finds the tick-tock offset', () => {
  const nominal = 0.125;
  const truth = simulate({ beats: 2400, period: nominal / (1 + 6.4 / 86400), offset: 0.42e-3, wander: 4e-8, scatter: 80e-6, seed: 11 });
  const tracker = start(nominal);
  let rejected = 0;
  /** @type {number[]} */
  const rateErrors = [];
  truth.times.forEach((t, n) => {
    if (!tracker.update(n, /** @type {0|1} */ (n % 2), t).accepted) rejected++;
    if (n > 1200) rateErrors.push(86400 * (nominal / tracker.period - nominal / truth.periods[n]));
  });
  const rms = Math.sqrt(rateErrors.reduce((s, v) => s + v * v, 0) / rateErrors.length);
  assert.ok(rms < 0.5, `rate error ${rms.toFixed(2)} s/day rms`);
  assert.ok(Math.abs(tracker.offset - 0.42e-3) < 0.02e-3, `offset ${(tracker.offset * 1e3).toFixed(3)} ms`);
  assert.ok(rejected / truth.times.length < 0.02, `${rejected} good beats rejected`);
  const consistency = tracker.consistency.reduce((s, v) => s + v, 0) / tracker.consistency.length;
  assert.ok(consistency > 0.6 && consistency < 1.6, `innovations match their expected size: ${consistency.toFixed(2)}`);
});

test('tracker ignores outliers and coasts through missed beats', () => {
  const nominal = 1 / 6;
  const truth = simulate({ beats: 1800, period: nominal, offset: -0.3e-3, wander: 2e-8, scatter: 60e-6, seed: 12 });
  const uniform = seededRandom(13);
  const tracker = start(nominal, 60e-6);
  let outliers = 0;
  let outliersRejected = 0;
  truth.times.forEach((t, n) => {
    const u = uniform();
    if (u < 0.2) return; // missed beat
    if (n > 200 && u > 0.95) {
      outliers++;
      const wrong = t + (uniform() < 0.5 ? -1 : 1) * (1e-3 + 2e-3 * uniform());
      if (!tracker.update(n, /** @type {0|1} */ (n % 2), wrong).accepted) outliersRejected++;
      return;
    }
    tracker.update(n, /** @type {0|1} */ (n % 2), t);
  });
  assert.ok(outliersRejected / outliers > 0.95, `${outliersRejected} of ${outliers} outliers rejected`);
  const last = truth.times.length - 1;
  const expected = tracker.expect(last + 1, 0).arrival;
  const actual = truth.times[last] + truth.periods[last] - (last % 2 ? -0.3e-3 : 0);
  assert.ok(Math.abs(expected - actual) < 0.2e-3, `next beat predicted within ${((expected - actual) * 1e3).toFixed(3)} ms`);
});

test('with one beat type the tracker leaves the offset alone', () => {
  const nominal = 1 / 6;
  const truth = simulate({ beats: 1200, period: nominal * (1 + 20e-6), offset: 0, wander: 1e-8, scatter: 50e-6, seed: 14 });
  const tracker = new BeatTracker({ n: 0, phase: 0, period: nominal, offset: 1.5e-3, phaseSd: 1e-3, periodSd: nominal * 3e-4, offsetSd: 0, periodDrift: 5e-8, scatter: [50e-6, 50e-6] });
  // Timestamps averaged over four cycles: one every eight beats, all on the tick line.
  for (let n = 3; n + 4 < truth.times.length; n += 8) {
    const t = (truth.times[n - 3] + truth.times[n - 1] + truth.times[n + 1] + truth.times[n + 3]) / 4;
    tracker.update(n, 0, t);
  }
  assert.equal(tracker.offset, 1.5e-3);
  assert.ok(Math.abs(tracker.period / nominal - 1 - 20e-6) < 3e-6, `period error ${((tracker.period / nominal - 1) * 1e6).toFixed(1)} ppm`);
});
