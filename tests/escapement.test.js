// The escapement setting. A co-axial escapement's tick and tock are different sounds, so the
// gap between them is not the beat error. The simulated watch below copies the pattern found in
// the Omega 3861: one beat opens with a loud click that the other lacks, and a sound both beats
// share comes 3.7 ms after it. The watch is exactly in beat.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeWatch } from '../js/audio/simulator.js';
import { analyze } from '../js/dsp/offline.js';
import { stream } from './helpers/stream.js';

const coaxial = {
  bph: 21600,
  rate: 3,
  beatOffsetMs: 0,
  gain: 1.4,
  seconds: 40,
  seed: 41,
  tickSounds: [
    { dt: -0.0037, amp: 1.0, decayMs: 0.5 },
    { dt: 0, amp: 0.5, decayMs: 0.5 },
  ],
  tockSounds: [
    { dt: -0.0024, amp: 0.45, decayMs: 0.4 },
    { dt: 0, amp: 0.55, decayMs: 0.5 },
  ],
};

test('Swiss-lever mode misreads a co-axial watch, which is why the setting exists', () => {
  // If a later version learns to measure this correctly, this test should change.
  const w = synthesizeWatch(coaxial);
  const r = analyze(w.channels, w.sampleRate);
  assert.ok(r.beatErrorMs !== null && r.beatErrorMs > 3, `beat error ${r.beatErrorMs}`);
});

test('co-axial mode measures the rate from both beats and shows no beat error', () => {
  // In real time only: each of the pipeline's analyses is a whole-recording analysis of its
  // window, and the next test checks the setting reaches a whole-recording analysis.
  const w = synthesizeWatch(coaxial);
  const live = stream(w.channels, w.sampleRate, { chunk: 1024, options: { escapement: 'coaxial' } });
  assert.equal(live.status[0].bph, 21600);
  assert.ok(live.readings.length > 0 && live.readings.every((x) => x.beatErrorMs === null && x.beatOffsetMs === null), 'no beat error at any time');
  assert.ok(live.last && live.last.fits.every((f) => f !== null), 'ticks and tocks both timed');
  assert.ok(live.last.rate !== null && Math.abs(live.last.rate - 3) < 0.2, `live rate ${live.last.rate}`);
});

test('co-axial mode on a Swiss-lever watch still gives the right rate', () => {
  const w = synthesizeWatch({ bph: 28800, rate: -6, beatOffsetMs: 0.4, gain: 1.4, seconds: 30, seed: 43 });
  const r = analyze(w.channels, w.sampleRate, { escapement: 'coaxial' });
  assert.equal(r.beatErrorMs, null);
  assert.ok(r.rate !== null && Math.abs(r.rate + 6) < 0.2, `rate ${r.rate}`);
});
