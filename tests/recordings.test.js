// The real recordings, as permanent regression tests. Expected values for the first two come
// from the Python prototype (tools/prototype); those watches lay dial-down with the crown
// against the phone. In the third the phone was held over the dial of the Omega, in a different
// room. Each recording is analysed whole, and then fed to the real-time pipeline in small chunks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { readWav } from './helpers/wav.js';
import { analyze } from '../js/dsp/offline.js';
import { stream } from './helpers/stream.js';

/** @param {string} name */
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** The ETA recording and its whole-recording analysis, made once for the two tests that use it. */
let eta = /** @type {{wav: ReturnType<typeof readWav>, whole: ReturnType<typeof analyze>}|null} */ (null);
const etaWhole = () => {
  if (!eta) {
    const wav = readWav(fixture('eta-2836-2.wav'));
    // The first 2 s and everything after 54 s contain handling noise.
    eta = { wav, whole: analyze(wav.channels, wav.sampleRate, { startSeconds: 2, endSeconds: 54 }) };
  }
  return eta;
};

test('ETA 2836-2: 28,800 vph, about +6.5 s/day, about 0.43 ms beat error, every beat timed', () => {
  const r = etaWhole().whole;
  assert.equal(r.bph, 28800);
  assert.ok(r.rate !== null && r.beatErrorMs !== null);
  assert.ok(Math.abs(r.rate - 6.5) <= 0.5, `rate ${r.rate.toFixed(2)}`);
  assert.ok(Math.abs(r.beatErrorMs - 0.43) <= 0.1, `beat error ${r.beatErrorMs.toFixed(3)}`);
  assert.ok(r.beats.every((b) => b.K <= 2), 'timed beat by beat');
  assert.ok(r.jitterMs !== null && r.jitterMs < 0.2, `scatter ${r.jitterMs}`);
});

test('Omega 3861: 21,600 vph, about +0.2 s/day, needs averaging, no beat error reported', () => {
  const wav = readWav(fixture('omega-3861.wav'));
  const r = analyze(wav.channels, wav.sampleRate, { startSeconds: 2, endSeconds: 60 });
  assert.equal(r.bph, 21600);
  assert.ok(r.rate !== null);
  assert.ok(Math.abs(r.rate - 0.2) <= 0.5, `rate ${r.rate.toFixed(2)}`);
  assert.ok(Math.max(...r.beats.map((b) => b.K)) >= 4, 'weak-signal averaging was needed');
  assert.equal(r.beatErrorMs, null, 'one beat is too faint for a beat error');
});

test('Omega 3861, second recording: 21,600 vph, about -2.1 s/day, ticks too blurred for a beat error', () => {
  const wav = readWav(fixture('omega-3861-b.wav'));
  const r = analyze(wav.channels, wav.sampleRate, { startSeconds: 2, endSeconds: 73 });
  assert.equal(r.bph, 21600);
  assert.ok(r.rate !== null);
  assert.ok(Math.abs(r.rate + 2.1) <= 0.5, `rate ${r.rate.toFixed(2)}`);
  assert.ok(r.fits.every((f) => f !== null), 'ticks and tocks are both audible in this recording');
  assert.equal(r.beatErrorMs, null, 'the tick timestamps scatter too much for a beat error');
});

test('ETA 2836-2 in real time: same readings as the whole-recording analysis', () => {
  const { wav, whole } = etaWhole();
  const from = 2 * wav.sampleRate;
  const to = 54 * wav.sampleRate;
  const r = stream(wav.channels, wav.sampleRate, { from, to, options: { historySeconds: 60, averagingSeconds: 60 } });
  assert.equal(r.status[0].state, 'tracking');
  assert.equal(r.status[0].bph, 28800);
  assert.ok(r.status[0].t < 12, `locked after ${r.status[0].t.toFixed(1)} s`);
  assert.ok(r.status.every((s) => s.state === 'tracking'), 'lock never lost');
  assert.ok(r.last && r.last.rate !== null && r.last.beatErrorMs !== null && r.last.jitterMs !== null);
  assert.ok(Math.abs(r.last.rate - 6.5) <= 0.5, `rate ${r.last.rate.toFixed(2)}`);
  assert.ok(Math.abs(r.last.beatErrorMs - 0.43) <= 0.1, `beat error ${r.last.beatErrorMs.toFixed(3)}`);
  assert.ok(r.beats.every((b) => b.cycles <= 2), 'timed beat by beat');
  assert.ok(r.last.jitterMs < 0.2, `scatter ${r.last.jitterMs}`);
  assert.ok(whole.rate !== null && whole.beatErrorMs !== null);
  assert.ok(Math.abs(r.last.rate - whole.rate) <= 0.15, `real time ${r.last.rate.toFixed(2)}, whole ${whole.rate.toFixed(2)}`);
  assert.ok(Math.abs(r.last.beatErrorMs - whole.beatErrorMs) <= 0.03, `real time ${r.last.beatErrorMs.toFixed(3)}, whole ${whole.beatErrorMs.toFixed(3)}`);
});

test('Omega 3861 in real time: locks on the faint ticks, about +0.2 s/day, no beat error', () => {
  const wav = readWav(fixture('omega-3861.wav'));
  // A 40 s window, as these checks were set for: shorter windows follow the watch's own rate
  // changes, which over this recording span about 1 s/day.
  const r = stream(wav.channels, wav.sampleRate, { from: 2 * wav.sampleRate, to: 60 * wav.sampleRate, options: { averagingSeconds: 40 } });
  assert.ok(r.status.length > 0 && r.status.every((s) => s.state === 'tracking'), 'locked and stayed locked');
  assert.equal(r.status[0].bph, 21600);
  assert.ok(r.last && r.last.rate !== null);
  assert.ok(Math.abs(r.last.rate - 0.2) <= 0.5, `rate ${r.last.rate.toFixed(2)}`);
  assert.ok(Math.max(...r.beats.map((b) => b.cycles)) >= 4, 'weak-signal averaging was needed');
  assert.equal(r.last.beatErrorMs, null);
});

test('Omega 3861, second recording, in real time: locks within 20 s, about -2.1 s/day', () => {
  const wav = readWav(fixture('omega-3861-b.wav'));
  const r = stream(wav.channels, wav.sampleRate, { from: 2 * wav.sampleRate, to: 73 * wav.sampleRate, options: { averagingSeconds: 40 } });
  assert.equal(r.status[0].bph, 21600);
  assert.ok(r.status[0].t < 20, `locked after ${r.status[0].t.toFixed(1)} s`);
  assert.ok(r.status.every((s) => s.state === 'tracking'), 'lock never lost');
  assert.ok(r.last && r.last.rate !== null);
  assert.ok(Math.abs(r.last.rate + 2.1) <= 0.5, `rate ${r.last.rate.toFixed(2)}`);
  assert.equal(r.last.beatErrorMs, null);
});
