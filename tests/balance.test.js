// The simulated watch built from the motion of its balance (tests/helpers/balance.js). The
// prototype in tools/prototype/coaxial/ is judged against its truth, so the truth is checked
// here against the geometry it was given. Its co-axial watch must also fool Swiss-lever mode
// the way the real Omega 3861 does, or it would not be a test of anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from './helpers/balance.js';
import { analyze } from '../js/dsp/offline.js';
import { Cascade, bandpassSections } from '../js/dsp/biquad.js';

test('the simulated balance unlocks and locks when the geometry says it should', () => {
  const amplitude = 270;
  const rest = 1.7;
  const options = leverWatch({ seconds: 4, amplitude, restOffsetDeg: rest, unlockDeg: [25, 25], lockDeg: [26, 23], lockJitterMs: 0 });
  const { truth } = synthesizeBalanceWatch(options);
  // The balance's phase advances by pi every beat.
  const omega = Math.PI / (3600 / options.bph / (1 + /** @type {number} */ (options.rate) / 86400));
  /** @param {number} degrees time in milliseconds, from passing the rest position, at which the balance is this far from it */
  const at = (degrees) => (1e3 * Math.asin(degrees / amplitude)) / omega;
  // Even beats swing towards positive angles, odd beats the other way, so the rest offset
  // delays one beat's unlock and advances the other's.
  const evenUnlock = at(-25 - rest);
  const oddUnlock = at(rest - 25);
  assert.ok(Math.abs(truth.unlockGapMs - (oddUnlock - evenUnlock)) < 1e-6, `unlock gap ${truth.unlockGapMs}`);
  assert.ok(Math.abs(truth.unlockGapMs - 0.5) < 0.01, 'a rest position 1.7 degrees out is a beat error of half a millisecond here');
  assert.ok(Math.abs(truth.liftMs[0] - (at(26 - rest) - evenUnlock)) < 1e-6, `even lift ${truth.liftMs[0]}`);
  assert.ok(Math.abs(truth.liftMs[1] - (at(23 + rest) - oddUnlock)) < 1e-6, `odd lift ${truth.liftMs[1]}`);
  assert.equal(truth.meanAmplitude, amplitude);

  const inBeat = synthesizeBalanceWatch(leverWatch({ seconds: 4, lockJitterMs: 0 }));
  assert.ok(Math.abs(inBeat.truth.unlockGapMs) < 1e-9 && Math.abs(inBeat.truth.lockGapMs) < 1e-9, 'in beat, both gaps are zero');
});

/**
 * Standard deviation, about zero, of a list of numbers.
 * @param {number[]} v
 */
const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);

test('timing jitter moves each whole beat off the regular grid by about the asked scatter, and none leaves the watch as it was', () => {
  const base = leverWatch({ seconds: 40, seed: 3, lockJitterMs: 0 });
  const regular = synthesizeBalanceWatch(base);
  const zero = synthesizeBalanceWatch({ ...base, beatJitterMs: 0, amplitudeJitterDeg: 0 });
  assert.ok(regular.channels[0].every((x, i) => x === zero.channels[0][i]), 'no jitter, the same samples');

  const { truth } = synthesizeBalanceWatch({ ...base, beatJitterMs: 0.5 });
  const halfPeriod = 3600 / base.bph / (1 + /** @type {number} */ (base.rate) / 86400);
  const omega = Math.PI / halfPeriod;
  const amplitude = /** @type {number} */ (base.amplitude);
  // Without jitter, each unlock falls a fixed time before the balance passes its rest position
  // on the grid, so what is left over is the jitter itself.
  const unlockBefore = Math.asin(-25 / amplitude) / omega;
  const off = Array.from(truth.unlock, (t, k) => 1e3 * (t - (0.137 + k * halfPeriod) - unlockBefore));
  const scatter = rms(off);
  // 319 beats give the scatter to about 4%, so 20% is five times that. Seed 3 gives 0.479 ms.
  assert.ok(Math.abs(scatter - 0.5) < 0.1, `scatter of the unlocks ${scatter} ms`);
  // The whole beat moves: every lock follows its unlock by the regular lift time.
  const lift = (2 * Math.asin(25 / amplitude)) / omega;
  assert.ok(truth.unlock.every((t, k) => Math.abs(truth.lock[k] - t - lift) < 1e-12), 'each lock moves with its unlock');
});

test('amplitude jitter scatters each beat\'s amplitude by about the asked amount without moving the beat', () => {
  const base = leverWatch({ seconds: 40, seed: 4, lockJitterMs: 0 });
  const { truth } = synthesizeBalanceWatch({ ...base, amplitudeJitterDeg: 10 });
  const halfPeriod = 3600 / base.bph / (1 + /** @type {number} */ (base.rate) / 86400);
  const omega = Math.PI / halfPeriod;
  // With the unlock and the lock 25 degrees either side of the rest position, a beat's lift time
  // gives its amplitude, and the beat stays centred on the grid whatever the amplitude.
  const amplitudes = Array.from(truth.unlock, (t, k) => 25 / Math.sin((omega * (truth.lock[k] - t)) / 2));
  const mean = amplitudes.reduce((s, a) => s + a, 0) / amplitudes.length;
  const scatter = rms(amplitudes.map((a) => a - mean));
  // As above, 20% is five times the uncertainty of 319 beats' scatter, and 2 degrees about
  // three and a half times that of their mean. Seed 4 gives 9.72 and 270.62 degrees.
  assert.ok(Math.abs(scatter - 10) < 2, `scatter of the amplitudes ${scatter} degrees`);
  assert.ok(Math.abs(mean - 270) < 2, `mean amplitude ${mean}`);
  assert.ok(Math.abs(truth.meanAmplitude - mean) < 1e-6, 'the truth gives the amplitude the beats had');
  assert.ok(truth.unlock.every((t, k) => Math.abs((t + truth.lock[k]) / 2 - (0.137 + k * halfPeriod)) < 1e-12), 'each beat stays on the grid');
});

test('a sound given its own start in each band starts later in a band given a later delay, and the truth is unchanged', () => {
  // A loud sound in two bands; in one watch the upper band starts with the lower one, in the
  // other half a millisecond after it. Everything else, the noise included, is drawn the same.
  /**
   * @param {number} late
   * @returns {import('./helpers/balance.js').BeatSound[]}
   */
  const beat = (late) => [{ after: 'unlock', db: 40, riseMs: 0.12, decayMs: 0.5, band: [6000, 20000], arrival: [{ band: [6000, 10000] }, { band: [15000, 20000], delayMs: late }] }];
  const base = leverWatch({ seconds: 1, seed: 5, lockJitterMs: 0 });
  const together = synthesizeBalanceWatch({ ...base, sounds: [beat(0), beat(0)] });
  const apart = synthesizeBalanceWatch({ ...base, sounds: [beat(0.5), beat(0.5)] });
  assert.deepStrictEqual(apart.truth, together.truth, 'the events are where they were');
  const fs = together.sampleRate;
  const first = together.truth.unlock[0];
  /** @param {Float32Array} x @param {number} lo @param {number} hi */
  const filtered = (x, lo, hi) => {
    const y = new Float64Array(x.length);
    new Cascade(bandpassSections(fs, lo, hi)).process(x, y);
    return y;
  };
  /**
   * How much later a band's sound comes in the second watch than in the first, near the first
   * unlock: the lag at which the two, through the same filter, line up best. The filter's own
   * delay is the same for both and cancels.
   * @param {number} lo
   * @param {number} hi
   */
  const shiftMs = (lo, hi) => {
    const a = filtered(together.channels[0], lo, hi);
    const b = filtered(apart.channels[0], lo, hi);
    const from = Math.floor((first - 1e-3) * fs);
    const to = Math.floor((first + 4e-3) * fs);
    let best = 0;
    let bestSum = -Infinity;
    for (let lag = -48; lag <= 48; lag++) {
      let sum = 0;
      for (let i = from; i < to; i++) sum += a[i] * b[i + lag];
      if (sum > bestSum) [best, bestSum] = [lag, sum];
    }
    return (1e3 * best) / fs;
  };
  assert.ok(Math.abs(shiftMs(6500, 9500)) < 0.03, `lower band moved ${shiftMs(6500, 9500)} ms`);
  assert.ok(Math.abs(shiftMs(15500, 19500) - 0.5) < 0.03, `upper band moved ${shiftMs(15500, 19500)} ms`);
});

test('Swiss-lever mode reads a large beat error on a simulated co-axial watch that is exactly in beat', () => {
  const w = synthesizeBalanceWatch(coaxialWatch({ seconds: 30, seed: 7 }));
  assert.ok(Math.abs(w.truth.unlockGapMs) < 1e-9, 'the watch is in beat');
  const r = analyze(w.channels, w.sampleRate);
  assert.equal(r.bph, 21600);
  assert.ok(r.rate !== null && Math.abs(r.rate - 0.4) < 0.3, `rate ${r.rate}`);
  // The real Omega's Safari capture reads 3.4 ms the same way, and recordings.test.js holds the
  // app to that. This checks the simulated watch instead: that it poses the same problem.
  assert.ok(r.beatErrorDetail !== null && Math.abs(r.beatErrorDetail.offsetMs) > 3, `tick-tock offset ${r.beatErrorDetail && r.beatErrorDetail.offsetMs}`);
});
