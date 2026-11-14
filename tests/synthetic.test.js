// Synthetic watches with known rate and beat error. Any error here is the pipeline's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeWatch } from '../js/audio/simulator.js';
import { analyze } from '../js/dsp/offline.js';

/**
 * @param {number} actual @param {number} expected @param {number} tolerance @param {string} what
 */
function near(actual, expected, tolerance, what) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: got ${actual.toFixed(3)}, expected ${expected} within ${tolerance}`);
}

test('clear ticks at 28,800 vph: +12 s/day, 0.30 ms beat error', () => {
  const w = synthesizeWatch({ bph: 28800, rate: 12, beatOffsetMs: 0.3, gain: 1.6, seconds: 50, seed: 1 });
  const r = analyze(w.channels, w.sampleRate);
  assert.equal(r.bph, 28800);
  assert.ok(r.rate !== null && r.beatErrorMs !== null);
  near(r.rate, 12, 0.2, 'rate');
  near(r.beatErrorMs, 0.3, 0.05, 'beat error');
  assert.ok(r.beats.every((b) => b.K <= 2), 'timed beat by beat');
});

test('21,600 vph with a mains buzz almost in step with the watch: -8 s/day, 0.80 ms', () => {
  const w = synthesizeWatch({ bph: 21600, rate: -8, beatOffsetMs: -0.8, gain: 1.2, seconds: 50, seed: 2 });
  const r = analyze(w.channels, w.sampleRate);
  assert.equal(r.bph, 21600);
  assert.ok(r.rate !== null && r.beatErrorMs !== null);
  near(r.rate, -8, 0.2, 'rate');
  near(r.beatErrorMs, 0.8, 0.05, 'beat error');
});

test('faint ticks at 18,000 vph: +45 s/day, found by averaging beats', () => {
  const w = synthesizeWatch({ bph: 18000, rate: 45, beatOffsetMs: 0, gain: 0.45, seconds: 60, seed: 3 });
  const r = analyze(w.channels, w.sampleRate);
  assert.equal(r.bph, 18000, 'not mistaken for 36,000 vph');
  assert.ok(r.rate !== null);
  near(r.rate, 45, 0.3, 'rate');
  assert.ok(Math.max(...r.beats.map((b) => b.K)) >= 4, 'weak-signal averaging was needed');
  if (r.beatErrorMs !== null) near(r.beatErrorMs, 0, 0.1, 'beat error');
});

test('noise and mains buzz alone give no lock', () => {
  const w = synthesizeWatch({ bph: 21600, gain: 0, seconds: 40, seed: 4 });
  const r = analyze(w.channels, w.sampleRate);
  assert.equal(r.locked, false);
  assert.equal(r.rate, null);
  assert.equal(r.beatErrorMs, null);
});
