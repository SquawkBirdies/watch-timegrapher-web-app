// The simulated watch built from the motion of its balance (tests/helpers/balance.js). The
// prototype in tools/prototype/coaxial/ is judged against its truth, so the truth is checked
// here against the geometry it was given. Its co-axial watch must also fool Swiss-lever mode
// the way the real Omega 3861 does, or it would not be a test of anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from './helpers/balance.js';
import { analyze } from '../js/dsp/offline.js';

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
