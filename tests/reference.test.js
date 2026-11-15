// The timing reference. A beat's timestamp is the moment one point of its sound arrives, and
// each analysis picks that point afresh as the loudest part of the averaged beat. When a beat is
// made of two sounds of similar loudness, as a co-axial escapement's can be, the loudest part
// can change from one analysis to the next. The real-time pipeline carries each beat type's
// reference point over from one analysis to the next, so that the trace has no step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { synthesizeWatch } from '../js/audio/simulator.js';
import { analyze } from '../js/dsp/offline.js';
import { summarize } from '../js/dsp/estimate.js';
import { stream, join, traceLine } from './helpers/stream.js';
import { readWav } from './helpers/wav.js';

const fixture = (/** @type {string} */ name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('a tock keeps its timing reference when another of its sounds becomes the loudest', () => {
  // The tock is two sounds 3.7 ms apart. After 48 s the second becomes the louder one, by a
  // margin small enough that each beat is still timed on the same sound. Without the carried
  // reference, the analysis at 60 s moved the tock's timestamps by 3.6 ms.
  const tick = [
    { dt: -0.0037, amp: 1.0, decayMs: 0.5 },
    { dt: 0, amp: 0.5, decayMs: 0.5 },
  ];
  const tock = (/** @type {number} */ first, /** @type {number} */ second) => [
    { dt: -0.0037, amp: first, decayMs: 0.4 },
    { dt: 0, amp: second, decayMs: 0.5 },
  ];
  const watch = { bph: 21600, rate: 0, beatOffsetMs: 0, gain: 1.4, tickSounds: tick };
  // 48 s is a whole number of tick-tock cycles, so the beats continue across the join.
  const audio = join([
    synthesizeWatch({ ...watch, seconds: 48, seed: 51, tockSounds: tock(0.72, 0.56) }),
    synthesizeWatch({ ...watch, seconds: 60, seed: 52, tockSounds: tock(0.6, 0.66) }),
  ]);
  // The furthest any analysis's own reference lay from the one carried, in seconds.
  let carried = 0;
  const r = stream(audio, 48000, {
    chunk: 1024,
    options: { escapement: 'coaxial' },
    each: (pipeline) => {
      if (pipeline.lock) carried = Math.max(carried, ...pipeline.lock.types.map((ty) => Math.abs(ty.adjust) / pipeline.fe));
    },
  });
  assert.ok(r.status.length > 5 && r.status.every((s) => s.state === 'tracking'), 'locked, with several repeat analyses');
  // The case is a real one: at some point the loudest part was the other sound.
  assert.ok(carried > 0.003 && carried < 0.0045, `reference carried over ${(carried * 1000).toFixed(2)} ms`);
  for (const type of /** @type {(0|1)[]} */ ([0, 1])) {
    const line = traceLine(r.beats, 21600, type);
    assert.ok(line.count > 250, `type ${type}: ${line.count} confident beats`);
    assert.ok(line.step < 0.5, `type ${type}: largest step ${line.step.toFixed(2)} ms`);
    assert.ok(Math.abs(line.slope) < 0.3, `type ${type}: trace slope ${line.slope.toFixed(2)} s/day`);
  }
  const late = r.readings.filter((x) => x.rate !== null && x.t > 30);
  assert.ok(late.every((x) => Math.abs(/** @type {number} */ (x.rate)) < 0.5), 'rate readings stay within 0.5 s/day of the truth');
});

test('Omega 3861, second recording: the tock trace has no step', () => {
  // Without the carried reference, the analysis at 64 s moved the tock's timestamps by 3.8 ms,
  // and the trace through the tocks sloped at +3.9 s/day instead of about -2.
  const wav = readWav(fixture('omega-3861-b.wav'));
  const r = stream(wav.channels, wav.sampleRate, { chunk: 1024, options: { escapement: 'coaxial' } });
  assert.ok(r.status.length > 3 && r.status.every((s) => s.state === 'tracking'));
  const lines = /** @type {(0|1)[]} */ ([0, 1]).map((type) => traceLine(r.beats, 21600, type));
  // The tock is the fainter beat here: its timestamps average several cycles.
  const tock = lines[0].cycles > lines[1].cycles ? lines[0] : lines[1];
  const tick = tock === lines[0] ? lines[1] : lines[0];
  assert.ok(tock.cycles >= 4 && tock.count > 25, `${tock.count} confident tocks averaging up to ${tock.cycles} cycles`);
  assert.ok(tock.step < 1, `largest step in the tock trace ${tock.step.toFixed(2)} ms`);
  assert.ok(Math.abs(tock.slope - tick.slope) < 1, `tock trace ${tock.slope.toFixed(2)} s/day, tick trace ${tick.slope.toFixed(2)} s/day`);
});

test('the beat error does not depend on where the timing references are', () => {
  const w = synthesizeWatch({ bph: 28800, rate: 5, beatOffsetMs: 0.6, gain: 1.6, seconds: 30, seed: 61 });
  const a = analyze(w.channels, w.sampleRate);
  const plain = summarize(a.beats, 3600 / a.bph, a.template, a.clusters, a.envelopeRate);
  assert.ok(plain.beatErrorMs !== null && Math.abs(plain.beatErrorMs - 0.6) < 0.02, `beat error ${plain.beatErrorMs}`);
  // The same beats with the tocks timed 3 ms later and the ticks 1 ms earlier.
  const moved = a.beats.map((b, j) => ({ ...b, t: b.t.map((t) => t + (j === 1 ? 0.003 : -0.001)) }));
  const carried = summarize(moved, 3600 / a.bph, a.template, a.clusters, a.envelopeRate, 'lever', 0.004);
  assert.ok(carried.beatErrorMs !== null && Math.abs(carried.beatErrorMs - plain.beatErrorMs) < 1e-6, `beat error ${carried.beatErrorMs} against ${plain.beatErrorMs}`);
  assert.ok(carried.rate !== null && plain.rate !== null && Math.abs(carried.rate - plain.rate) < 1e-6, `rate ${carried.rate} against ${plain.rate}`);
});
