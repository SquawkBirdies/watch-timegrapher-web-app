// Milestone 5: what the screen shows. The pipeline's extra events for the interface, the model
// that turns events into trace points and words, the simulator that runs without end, the
// recording decoder and the pacing of sources. Drawing itself is checked in a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Pipeline } from '../js/dsp/pipeline.js';
import { synthesizeWatch, WatchStream } from '../js/audio/simulator.js';
import { encodeWav, decodeWav } from '../js/audio/wav.js';
import { RecordingSource } from '../js/audio/file-source.js';
import { Player } from '../js/audio/player.js';
import { Measurement, traceRange, ticks, formatRate, formatMs, formatBph, signalLevel, averagingNote, guidance, stateText, irregularWarning } from '../js/ui/model.js';
import { clean, DEFAULTS } from '../js/store.js';
import { stream } from './helpers/stream.js';

/**
 * @typedef {import('../js/dsp/pipeline.js').PipelineEvent} PipelineEvent
 * @typedef {import('../js/dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 */

/**
 * Feed a pipeline from a source in fixed chunks, collecting every event.
 * @param {Pipeline} pipeline
 * @param {(frames: number) => Float32Array[]} next
 * @param {number} seconds
 * @param {number} [chunk]
 * @returns {PipelineEvent[]}
 */
function run(pipeline, next, seconds, chunk = 4096) {
  /** @type {PipelineEvent[]} */
  const events = [];
  const total = Math.round(seconds * pipeline.sampleRate);
  for (let done = 0; done < total; done += chunk) events.push(...pipeline.push(next(Math.min(chunk, total - done))));
  return events;
}

// ---- Pipeline events for the interface -------------------------------------------------------

test('the default averaging window is 20 s, and each reading lies within its stated uncertainty', () => {
  const cases = [
    { bph: 28800, rate: 12, beatOffsetMs: 0.3, seed: 11 },
    { bph: 21600, rate: -25, beatOffsetMs: 0.6, seed: 12 },
    { bph: 18000, rate: 4, beatOffsetMs: 0.2, seed: 13 },
  ];
  for (const c of cases) {
    const w = synthesizeWatch({ ...c, gain: 1.6, seconds: 50 });
    const r = stream(w.channels, w.sampleRate, { chunk: 2048 });
    const late = r.readings.filter((x) => x.rate !== null && x.t > 30);
    assert.ok(late.length > 10, `${c.bph}: readings after the window filled`);
    for (const x of late) {
      const span = /** @type {[number, number]} */ (x.window)[1] - /** @type {[number, number]} */ (x.window)[0];
      assert.ok(span > 18 && span <= 20.5, `${c.bph}: window ${span.toFixed(1)} s`);
      const sd = /** @type {number} */ (x.rateSd);
      assert.ok(Math.abs(/** @type {number} */ (x.rate) - c.rate) <= 3 * sd + 0.05, `${c.bph}: ${x.rate} ± ${sd} against ${c.rate}`);
    }
  }
});

test('faint ticks lengthen the averaging window so each reading rests on enough timestamps', () => {
  const w = synthesizeWatch({ bph: 18000, rate: 45, gain: 0.45, seconds: 100, seed: 3 });
  const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { historySeconds: 80 } });
  const last = /** @type {ReadingsEvent} */ (r.last);
  assert.ok(last && last.signal && last.rate !== null);
  const K = Math.max(...last.signal.cycles.map((c) => c || 1));
  assert.ok(K >= 4, `averaging ${K} cycles`);
  const [from, to] = /** @type {[number, number]} */ (last.window);
  const span = to - from;
  // Twelve independent timestamps of K cycles of 0.4 s each, or as many as the lock has had
  // time for: the window never reaches back before the lock began.
  const lockStart = r.pipeline.toSeconds(r.pipeline.lockedFrom);
  const wanted = Math.min(12 * K * 0.4, to - lockStart);
  assert.ok(span >= wanted - 2 * K * 0.4, `window ${span.toFixed(1)} s for ${K}-cycle averages, wanted ${wanted.toFixed(1)} s`);
  assert.ok(from >= lockStart - 0.5, 'not before the lock began');
  assert.ok(span > 20, 'longer than the 20 s setting');
  assert.ok(Math.abs(last.rate - 45) <= 3 * /** @type {number} */ (last.rateSd) + 0.1, `rate ${last.rate} ± ${last.rateSd}`);
});

test('the averaging window and the escapement can change while measuring', () => {
  const w = synthesizeWatch({ bph: 28800, rate: 6, beatOffsetMs: 0.4, gain: 1.6, seconds: 60, seed: 21 });
  const pipeline = new Pipeline(w.sampleRate, 2);
  let at = 0;
  const next = (/** @type {number} */ n) => {
    const out = w.channels.map((c) => c.subarray(at, at + n));
    at += n;
    return out;
  };
  const before = /** @type {ReadingsEvent[]} */ (run(pipeline, next, 30).filter((e) => e.type === 'readings'));
  const a = before[before.length - 1];
  assert.ok(a.beatErrorMs !== null && Math.abs(a.beatErrorMs - 0.4) < 0.05);
  pipeline.setOptions({ averagingSeconds: 10, escapement: 'coaxial' });
  const after = /** @type {ReadingsEvent[]} */ (run(pipeline, next, 5).filter((e) => e.type === 'readings'));
  const b = after[after.length - 1];
  const span = /** @type {[number, number]} */ (b.window)[1] - /** @type {[number, number]} */ (b.window)[0];
  assert.ok(span > 8.5 && span <= 10.5, `window ${span.toFixed(1)} s after the change`);
  assert.equal(b.beatErrorMs, null, 'co-axial hides the beat error');
  assert.ok(b.rate !== null && Math.abs(b.rate - 6) < 0.5);
  pipeline.setOptions({ averagingSeconds: 60 });
  const longer = /** @type {ReadingsEvent[]} */ (run(pipeline, next, 25).filter((e) => e.type === 'readings'));
  const c = longer[longer.length - 1];
  const spanC = /** @type {[number, number]} */ (c.window)[1] - /** @type {[number, number]} */ (c.window)[0];
  assert.ok(spanC > 45, `a 60 s window reaches back past the 40 s history: ${spanC.toFixed(1)} s`);
});

test('a lock sends the averaged tick and tock, each peaking at its timestamp', () => {
  const w = synthesizeWatch({ bph: 28800, rate: 0, beatOffsetMs: 0.3, gain: 1.6, seconds: 25, seed: 31 });
  const r = new Pipeline(w.sampleRate, 2).push(w.channels);
  const waves = /** @type {import('../js/dsp/pipeline.js').WaveformEvent[]} */ (r.filter((e) => e.type === 'waveform'));
  assert.ok(waves.length >= 1, 'a waveform event');
  const wave = waves[waves.length - 1];
  assert.deepEqual(wave.beats.map((b) => b.type), [0, 1]);
  assert.ok(wave.cycles > 20, `${wave.cycles} cycles averaged`);
  assert.ok(Math.abs(wave.from + 0.012) < 1e-3 && Math.abs(wave.to - 0.012) < 1e-3);
  for (const b of wave.beats) {
    assert.equal(b.values.length, Math.round((wave.to - wave.from) * wave.rate) + 1);
    let peak = 0;
    for (let i = 1; i < b.values.length; i++) if (b.values[i] > b.values[peak]) peak = i;
    const ms = (wave.from + peak / wave.rate) * 1000;
    assert.ok(Math.abs(ms) < 1, `beat ${b.type} peaks at ${ms.toFixed(2)} ms`);
  }
  const readings = /** @type {ReadingsEvent[]} */ (r.filter((e) => e.type === 'readings'));
  const s = readings[readings.length - 1].signal;
  assert.ok(s && s.z[0] !== null && s.z[1] !== null && /** @type {number} */ (s.z[0]) > 8, 'both beat types have a confidence');
});

// ---- The simulator ---------------------------------------------------------------------------

test('the endless simulator gives the same audio whatever the chunk sizes', () => {
  for (const jitterMs of [0, 3]) {
    const a = new WatchStream({ bph: 21600, rate: 5, beatOffsetMs: 0.5, gain: 1.5, seed: 7, jitterMs });
    const b = new WatchStream({ bph: 21600, rate: 5, beatOffsetMs: 0.5, gain: 1.5, seed: 7, jitterMs });
    const whole = a.next(60000)[0];
    const parts = [];
    for (const n of [1, 999, 12000, 30000, 17000]) parts.push(...b.next(n)[0]);
    assert.equal(parts.length, whole.length);
    for (let i = 0; i < whole.length; i++) assert.equal(parts[i], whole[i], `${jitterMs} ms: sample ${i}`);
  }
});

test('beat variability set while the simulator runs brings the irregular-beat warning within seconds, and taking it away clears it', () => {
  for (const bph of [28800, 18000]) {
    const sim = new WatchStream({ bph, rate: 8, beatOffsetMs: 0.4, gain: 2, seed: 3 });
    const pipeline = new Pipeline(sim.sampleRate, 1);
    const readingsOf = (/** @type {PipelineEvent[]} */ events) => /** @type {ReadingsEvent[]} */ (events.filter((e) => e.type === 'readings' && e.rate !== null));
    const label = `${bph} vph`;
    const steady = readingsOf(run(pipeline, (n) => sim.next(n), 20));
    assert.ok(steady.length > 5 && steady.every((x) => !x.irregular), `${label}: a steady watch, no warning`);
    assert.equal(irregularWarning(steady[steady.length - 1]), null);
    // Each beat now falls early or late at random, by 2 ms (one standard deviation). The
    // pipeline notices the scatter in the beats it tracks and re-analyses the latest 8 s at once.
    sim.jitterMs = 2;
    const events = run(pipeline, (n) => sim.next(n), 40);
    assert.ok(!events.some((e) => e.type === 'status' && e.state === 'listening'), `${label}: stayed locked`);
    const wild = readingsOf(events);
    const first = wild.find((x) => x.irregular);
    assert.ok(first && first.t < 20 + 12, `${label}: warning at ${first ? first.t.toFixed(0) : '-'} s, 20 s being the change`);
    const after = wild.filter((x) => x.t >= /** @type {ReadingsEvent} */ (first).t);
    assert.ok(after.every((x) => x.irregular && x.beatErrorMs === null), `${label}: irregular from then on, with no beat error`);
    // The readings after the warning rest only on beats since the change.
    const z = after.map((x) => (/** @type {number} */ (x.rate) - 8) / /** @type {number} */ (x.rateSd));
    assert.ok(z.every((v) => Math.abs(v) < 3), `${label}: rate within 3 stated uncertainties of +8 s/day (worst ${Math.max(...z.map(Math.abs)).toFixed(1)})`);
    const last = wild[wild.length - 1];
    assert.ok(last.jitterMs !== null && last.jitterMs > 1.5 && last.jitterMs < 2.6, `${label}: scatter reading ${last.jitterMs}`);
    assert.match(/** @type {string} */ (irregularWarning(last)), new RegExp(`^Beats wander by ${last.jitterMs.toFixed(1)} ms `));
    sim.jitterMs = 0;
    const calm = readingsOf(run(pipeline, (n) => sim.next(n), 40));
    const cleared = calm.find((x) => !x.irregular);
    assert.ok(cleared && cleared.t < 60 + 12, `${label}: warning cleared at ${cleared ? cleared.t.toFixed(0) : '-'} s, 60 s being the change`);
    const end = calm[calm.length - 1];
    assert.ok(!end.irregular && end.beatErrorMs !== null && Math.abs(end.beatErrorMs - 0.4) < 0.05, `${label}: steady again, beat error ${end.beatErrorMs}`);
    assert.equal(pipeline.changesFound, 2, `${label}: two changes found`);
  }
});

test('a short burst of scatter on a steady watch brings no warning and no extra analysis', () => {
  const sim = new WatchStream({ bph: 28800, rate: 8, beatOffsetMs: 0.4, gain: 2, seed: 3 });
  const pipeline = new Pipeline(sim.sampleRate, 1);
  run(pipeline, (n) => sim.next(n), 20);
  sim.jitterMs = 2;
  const burst = run(pipeline, (n) => sim.next(n), 3);
  sim.jitterMs = 0;
  const events = burst.concat(run(pipeline, (n) => sim.next(n), 37));
  assert.ok(!events.some((e) => e.type === 'readings' && e.irregular), 'no warning');
  assert.equal(pipeline.changeChecks, 0, 'no early analysis');
});

test('the endless simulator is measured right, and a turn of the regulator shows', () => {
  const sim = new WatchStream({ bph: 28800, rate: 15, beatOffsetMs: 0.35, gain: 2, seed: 9 });
  const pipeline = new Pipeline(sim.sampleRate, 1);
  const first = /** @type {ReadingsEvent[]} */ (run(pipeline, (n) => sim.next(n), 35).filter((e) => e.type === 'readings'));
  const a = first[first.length - 1];
  assert.ok(a.rate !== null && Math.abs(a.rate - 15) < 0.3, `rate ${a.rate}`);
  assert.ok(a.beatErrorMs !== null && Math.abs(a.beatErrorMs - 0.35) < 0.05, `beat error ${a.beatErrorMs}`);
  sim.rate = -5;
  const events = run(pipeline, (n) => sim.next(n), 45);
  const after = /** @type {ReadingsEvent[]} */ (events.filter((e) => e.type === 'readings' && e.rate !== null));
  const b = after[after.length - 1];
  assert.ok(b.rate !== null && Math.abs(b.rate + 5) < 0.5, `rate after the change ${b.rate}`);
});

// ---- Recordings and pacing -------------------------------------------------------------------

test('WAV files are decoded at their own sample rate, in 16-bit, 24-bit and float', () => {
  const samples = [0, 0.5, -0.5, 0.25, -1, 0.999];
  const floatWav = decodeWav(encodeWav([Float32Array.from(samples)], 44100));
  assert.ok(floatWav);
  assert.equal(floatWav.sampleRate, 44100);
  assert.deepEqual(Array.from(floatWav.channels[0]), Array.from(Float32Array.from(samples)));
  for (const bits of [16, 24]) {
    const bytes = bits / 8;
    const buffer = new ArrayBuffer(44 + samples.length * bytes * 2);
    const v = new DataView(buffer);
    const ascii = (/** @type {number} */ at, /** @type {string} */ s) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
    ascii(0, 'RIFF');
    v.setUint32(4, buffer.byteLength - 8, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, 32000, true);
    v.setUint32(28, 32000 * 2 * bytes, true);
    v.setUint16(32, 2 * bytes, true);
    v.setUint16(34, bits, true);
    ascii(36, 'data');
    v.setUint32(40, samples.length * bytes * 2, true);
    samples.forEach((x, i) => {
      for (let c = 0; c < 2; c++) {
        const at = 44 + (i * 2 + c) * bytes;
        const value = c === 0 ? x : -x;
        if (bits === 16) v.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
        else {
          const n = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608)));
          v.setUint8(at, n & 0xff);
          v.setUint8(at + 1, (n >> 8) & 0xff);
          v.setInt8(at + 2, n >> 16);
        }
      }
    });
    const w = decodeWav(buffer);
    assert.ok(w, `${bits}-bit`);
    assert.equal(w.sampleRate, 32000);
    assert.equal(w.channels.length, 2);
    for (let i = 0; i < samples.length; i++) {
      assert.ok(Math.abs(w.channels[0][i] - samples[i]) < 2 / 2 ** bits * 2, `${bits}-bit sample ${i}`);
      assert.ok(Math.abs(w.channels[1][i] + samples[i]) < 2 / 2 ** bits * 2, `${bits}-bit right sample ${i}`);
    }
  }
  assert.equal(decodeWav(new TextEncoder().encode('not audio at all').buffer), null);
});

test('a paced replay delivers the whole recording once, in order, and waits for a busy receiver', async () => {
  const fs = 8000;
  const n = 4000;
  const recording = { sampleRate: fs, channels: [Float32Array.from({ length: n }, (_, i) => i)], duration: n / fs };
  /** @type {number[]} */
  const got = [];
  let busy = false;
  let ends = 0;
  let waitedWhileBusy = true;
  await new Promise((resolve) => {
    const player = new Player(new RecordingSource(recording), {
      speed: 4,
      onChunk: (channels) => {
        if (busy) waitedWhileBusy = false;
        got.push(...channels[0]);
        // Pretend the receiver needs a moment after the first chunk.
        if (got.length > 0 && got.length < n / 2 && !busy) {
          busy = true;
          setTimeout(() => (busy = false), 60);
        }
      },
      onEnd: () => {
        ends++;
        resolve(undefined);
      },
      busy: () => busy,
    });
    player.start();
  });
  assert.equal(ends, 1);
  assert.equal(got.length, n);
  for (let i = 0; i < n; i++) assert.equal(got[i], i);
  assert.ok(waitedWhileBusy, 'nothing was delivered while the receiver was busy');
});

// ---- The model behind the screen -------------------------------------------------------------

/**
 * @param {number} n @param {number} t @param {0|1} type @param {boolean} [ok]
 * @returns {import('../js/dsp/pipeline.js').Beat}
 */
const beat = (n, t, type, ok = true) => ({ n, t, type, ok, confidence: ok ? 20 : 2, cycles: 1 });

test('the trace climbs for a gaining watch, and the tick-tock gap is the beat offset', () => {
  const m = new Measurement();
  m.start();
  const period = 3600 / 28800;
  const gain = 10 / 86400; // +10 s/day
  /** @type {import('../js/dsp/pipeline.js').Beat[]} */
  const beats = [];
  for (let n = 0; n < 80; n++) beats.push(beat(n, 1 + n * period * (1 - gain) + (n % 2 ? 0.0004 : 0), /** @type {0|1} */ (n % 2)));
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 28800, cyclesAveraged: [1, 1], t: 8 });
  m.apply({ type: 'beats', beats, replaceFrom: 1 });
  const pts = m.points();
  assert.equal(pts.length, 80);
  assert.equal(pts[0].y, 0, 'the first tick is the reference');
  const last = pts[78];
  assert.ok(Math.abs(last.y - 78 * period * gain * 1000) < 1e-9, 'climbs by the gain');
  assert.ok(Math.abs(pts[1].y - (period * gain * 1000 - 0.4)) < 1e-9, 'tocks sit 0.4 ms lower');
});

test('re-timed beats replace the old ones, and a new lock continues where the trace stopped', () => {
  const m = new Measurement();
  m.start();
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 21600, cyclesAveraged: [1, 1], t: 8 });
  m.apply({ type: 'beats', beats: [beat(0, 1, 0), beat(1, 1.1667, 1), beat(2, 1.3334, 0), beat(3, 1.5, 1)], replaceFrom: 1 });
  m.apply({ type: 'beats', beats: [beat(2, 1.3333, 0), beat(3, 1.5001, 1), beat(4, 1.6667, 0)], replaceFrom: 1.3 });
  assert.deepEqual(m.points().map((p) => p.t), [1, 1.1667, 1.3333, 1.5001, 1.6667]);
  const before = /** @type {import('../js/ui/model.js').TracePoint} */ (m.lastPoint());
  m.apply({ type: 'status', state: 'listening', reason: 'lost', bph: null, cyclesAveraged: null, t: 12 });
  assert.equal(m.readings, null);
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 21600, cyclesAveraged: [1, 1], t: 20 });
  m.apply({ type: 'beats', beats: [beat(0, 15, 0), beat(1, 15.1667, 1)], replaceFrom: 15 });
  const pts = m.points();
  assert.equal(pts.length, 7);
  assert.equal(pts[5].y, before.y, 'the new stretch starts where the old one ended');
  assert.equal(m.lockedAt, 8);
});

test('the vertical range ignores stray points and never shrinks below 1 ms', () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({ t: i, y: 0.001 * i, type: /** @type {0|1} */ (0), ok: true, cycles: 1 }));
  pts.push({ t: 300, y: 50, type: 0, ok: true, cycles: 1 });
  const [lo, hi] = traceRange(pts);
  assert.ok(hi - lo >= 1 && hi < 5, `range ${lo}..${hi}`);
  assert.deepEqual(traceRange([]), [-0.5, 0.5]);
  assert.deepEqual(ticks(0, 30, 3), [0, 10, 20, 30]);
  assert.deepEqual(ticks(-0.6, 0.6, 4), [-0.5, 0, 0.5]);
  assert.deepEqual(ticks(0, 0.6, 3), [0, 0.2, 0.4, 0.6], 'no rounding errors such as 0.6000000000000001');
});

test('numbers are shown with a sign, a true minus and sensible precision', () => {
  assert.equal(formatRate(6.43), '+6.4');
  assert.equal(formatRate(-2.07), '−2.1');
  assert.equal(formatRate(0.02), '0.0');
  assert.equal(formatRate(-123.4), '−123');
  assert.equal(formatRate(null), '—');
  assert.equal(formatMs(0.425), '0.42');
  assert.equal(formatMs(null), '—');
  assert.equal(formatBph(28800), '28,800');
});

test('the signal meter judges the better-timed beat type and names the fainter one', () => {
  /** @param {(number|null)[]} z @param {(number|null)[]} cycles @returns {ReadingsEvent} */
  const readings = (z, cycles) => ({ type: 'readings', t: 30, window: [10, 30], signal: { z, cycles }, fits: [null, null], rate: 1, rateSd: 0.1, jitterMs: 0.05, beatErrorMs: null, beatOffsetMs: null, beatErrorDetail: null });
  const clear = signalLevel(readings([40, 30], [1, 1]));
  assert.equal(clear && clear.level, 'clear');
  const mixed = signalLevel(readings([10, 14], [1, 2]));
  assert.ok(mixed && mixed.level === 'usable' && mixed.type === 0 && mixed.fainter && mixed.fainter.cycles === 2);
  const faint = signalLevel(readings([null, 5], [null, 8]));
  assert.ok(faint && faint.level === 'faint' && faint.cycles === 8 && faint.fraction < 0.1);
  assert.equal(signalLevel(readings([null, null], [null, null])), null);
  assert.equal(averagingNote(readings([10, 14], [1, 2])), 'Tock dots average 2 cycles.');
  assert.equal(averagingNote(readings([5, 5], [4, 4])), 'Each dot averages 4 cycles.');
  assert.equal(averagingNote(readings([40, 30], [1, 1])), '');
  assert.equal(irregularWarning(null), null);
  assert.equal(irregularWarning({ ...readings([40, 30], [1, 1]), irregular: false }), null);
  const warning = irregularWarning({ ...readings([40, 30], [1, 1]), irregular: true, jitterMs: 2.04 });
  assert.match(/** @type {string} */ (warning), /^Beats wander by 2\.0 ms from one to the next/);
  assert.match(/** @type {string} */ (warning), /beat error cannot be measured/);

  const m = new Measurement();
  assert.equal(guidance(m, { running: false, finished: false }), 'Choose a source below and press Start.');
  m.start();
  assert.match(guidance(m, { running: true, finished: false }), /^Listening/);
  assert.equal(stateText(m, { running: true, finished: false }), 'No lock · listening');
  assert.equal(guidance(m, { running: false, finished: true }), 'No steady beat was found in this recording.');
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 21600, cyclesAveraged: [null, 8], t: 50 });
  m.apply(readings([null, 5], [null, 8]));
  assert.match(guidance(m, { running: true, finished: false }), /each dot averages 8 cycles \(2\.7 s\)/);
  assert.equal(stateText(m, { running: false, finished: true }), 'End of recording');
});

test('stored settings are checked, and anything invalid falls back to the default', () => {
  assert.deepEqual(clean({}), DEFAULTS);
  assert.deepEqual(clean({ bph: '36000', escapement: 'coaxial', liftAngle: '50', humHz: '50', averagingSeconds: '60' }), {
    bph: 36000,
    escapement: 'coaxial',
    liftAngle: 50,
    humHz: 50,
    averagingSeconds: 60,
  });
  assert.deepEqual(clean({ bph: 12345, escapement: 'tourbillon', liftAngle: 5, humHz: 55, averagingSeconds: 15 }), DEFAULTS);
});
