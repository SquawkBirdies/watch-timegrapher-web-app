// The parts of the audio diagnostic that run outside the browser: the WAV writer, the measuring
// session the worker hosts, and the speed test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeWav } from '../js/audio/wav.js';
import { Session, benchmark } from '../js/dsp/session.js';
import { Pipeline } from '../js/dsp/pipeline.js';
import { synthesizeWatch } from '../js/audio/simulator.js';
import { readWav } from './helpers/wav.js';

test('saved captures are float WAV files holding only the format and the samples', () => {
  const left = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 0.5);
  const right = Float32Array.from({ length: 1000 }, (_, i) => (i % 13) / 13 - 0.5);
  const dir = mkdtempSync(join(tmpdir(), 'wav-'));
  try {
    const path = join(dir, 'capture.wav');
    writeFileSync(path, new Uint8Array(encodeWav([left, right], 44100)));
    const back = readWav(path);
    assert.equal(back.sampleRate, 44100);
    assert.equal(back.channels.length, 2);
    assert.deepEqual(back.channels[0], left);
    assert.deepEqual(back.channels[1], right);
    const bytes = readFileSync(path);
    const chunks = [];
    for (let at = 12; at + 8 <= bytes.length; ) {
      const size = bytes.readUInt32LE(at + 4);
      chunks.push(bytes.toString('latin1', at, at + 4));
      at += 8 + size + (size & 1);
    }
    assert.deepEqual(chunks, ['fmt ', 'fact', 'data'], 'no metadata chunks');
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8, 'RIFF size');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session reports the same events as the pipeline, plus its computing time', () => {
  const w = synthesizeWatch({ bph: 21600, rate: -5, beatOffsetMs: 0.4, gain: 1.4, seconds: 20, seed: 31 });
  const session = new Session(w.sampleRate, 2);
  const direct = new Pipeline(w.sampleRate, 2);
  const a = [];
  const b = [];
  for (let i = 0; i < w.channels[0].length; i += 4096) {
    const part = w.channels.map((c) => c.subarray(i, i + 4096));
    a.push(...session.push(part));
    b.push(...direct.push(part));
  }
  assert.deepEqual(a, b);
  const load = session.load();
  assert.ok(Math.abs(load.audioSeconds - 20) < 1e-6);
  assert.ok(load.busySeconds > 0 && load.longestSeconds > 0 && load.longestSeconds <= load.busySeconds);
  // No lift angle, so the stage that reads the sounds inside the beats is not there to cost anything.
  assert.equal(load.stage, null);
  assert.deepEqual(new Session(48000, 1, { liftAngle: 52 }).load().stage, { seconds: 0, readings: 0, lastSeconds: null, lastAudioSeconds: null, longestStepSeconds: 0 });
});

test('the speed test reads the simulated watch correctly and reports its speed, with the stage that reads the sounds inside the beats at work', () => {
  // 45 s: the stage starts its first reading 30 s after the lock, and takes its share of the
  // time from then on, as in the app.
  const r = benchmark({ seconds: 45 });
  assert.equal(r.channelCount, 1);
  assert.ok(Math.abs(r.audioSeconds - 45) < 0.1);
  assert.ok(r.stage && r.stage.seconds > 0 && r.stage.seconds < r.busySeconds, `the stage took ${r.stage?.seconds} s of ${r.busySeconds} s`);
  assert.ok(r.lockedAt !== null && r.lockedAt < 10, `locked at ${r.lockedAt}`);
  assert.ok(r.rate !== null && Math.abs(r.rate - 12) < 0.2, `rate ${r.rate}`);
  assert.ok(r.beatErrorMs !== null && Math.abs(r.beatErrorMs - 0.3) < 0.05, `beat error ${r.beatErrorMs}`);
  assert.ok(r.speed > 1, `${r.speed.toFixed(1)} times real time`);
});
