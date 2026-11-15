// The null case: a minute of a quiet room recorded through Safari on the iPhone, with no watch
// near the phone. The pipeline must not find ticking in it, whatever the settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { readWav } from './helpers/wav.js';
import { analyze } from '../js/dsp/offline.js';
import { stream } from './helpers/stream.js';
import { BEAT_RATES } from '../js/store.js';

const wav = readWav(fileURLToPath(new URL('./fixtures/no-watch-safari.wav', import.meta.url)));

/**
 * Stream the recording and check that nothing was reported but listening.
 * @param {import('../js/dsp/pipeline.js').PipelineOptions} options
 * @param {string} label
 */
function assertNoLock(options, label) {
  const r = stream(wav.channels, wav.sampleRate, { chunk: 1024, options });
  assert.deepEqual(r.status.map((s) => `${s.state}@${s.t.toFixed(1)}`), [], `${label}: no lock`);
  assert.equal(r.beats.length, 0, `${label}: no beats`);
  assert.ok(r.readings.every((x) => x.rate === null && x.beatErrorMs === null), `${label}: no readings`);
}

test('no watch: the recording is the minute of room noise it should be', () => {
  assert.equal(wav.sampleRate, 48000);
  assert.equal(wav.channels.length, 1);
  assert.equal(wav.channels[0].length, 60 * 48000);
});

test('no watch, in real time: never locks with the beat rate detected', () => {
  assertNoLock({}, 'automatic, 60 Hz mains');
  assertNoLock({ humHz: 50 }, 'automatic, 50 Hz mains');
  assertNoLock({ escapement: 'coaxial' }, 'automatic, co-axial');
});

test('no watch, in real time: never locks with any beat rate given', () => {
  for (const bph of BEAT_RATES) assertNoLock({ bph }, `${bph} vph given`);
});

test('no watch, whole recording: no lock and almost no confident timestamps', () => {
  const r = analyze(wav.channels, wav.sampleRate);
  assert.equal(r.locked, false);
  assert.equal(r.rate, null);
  assert.equal(r.beatErrorMs, null);
  // Chance alone puts about 1% of noise peaks above the 99th-percentile threshold.
  for (const b of r.beats) {
    const confident = b.ok.reduce((s, v) => s + v, 0);
    assert.ok(confident <= 0.03 * b.ok.length + 1, `${confident} of ${b.ok.length} timestamps confident`);
  }
});
