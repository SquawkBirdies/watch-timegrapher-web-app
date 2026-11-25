// The real recordings, as permanent regression tests. Expected values for the first two come
// from the Python prototype (tools/prototype); those watches lay dial-down with the crown
// against the phone. In the third the phone was held over the dial of the Omega, in a different
// room. Each recording is analysed whole, and then fed to the real-time pipeline in small chunks.
// The last tests use the Safari captures of the same two watches, saved by the audio diagnostic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { readWav } from './helpers/wav.js';
import { analyze } from '../js/dsp/offline.js';
import { DEFAULT_BANDS } from '../js/dsp/filterbank.js';
import { medianZ } from '../js/dsp/timing.js';
import { stream } from './helpers/stream.js';
import { readiness, takeReading } from '../js/ui/positions.js';

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

/**
 * A Safari capture as the app hears it. Safari delivered the iPhone's mono microphone as two
 * channels with the second one silent, and the app analyses only the first.
 * @param {string} name
 */
function safariCapture(name) {
  const wav = readWav(fixture(name));
  assert.equal(wav.channels.length, 2);
  assert.ok(wav.channels[1].every((v) => v === 0), 'the second channel is silent');
  return { sampleRate: wav.sampleRate, channels: [wav.channels[0]] };
}

/**
 * What a run of a regular watch must never show: the irregular-watch path, its wider search,
 * or an early look for a change in regularity.
 * @param {ReturnType<typeof stream>} r
 */
function regularThroughout(r) {
  assert.ok(r.readings.every((x) => !x.irregular), 'never irregular');
  assert.equal(r.pipeline.maxLag, Math.floor(4e-3 * r.pipeline.fe), 'the usual search width');
  assert.equal(r.pipeline.changeChecks, 0, 'no early look for a change in regularity');
}

// The expected rates below are the pipeline's own, cross-checked with a simple timing of each
// beat's loudest moment above 5 kHz that shares no code with it: +1.64 s/day for the ETA and
// +0.49 s/day for the Omega.

test('ETA 2836-2, Safari capture, in real time: locks within 10 s, about +1.7 s/day and 0.3 ms, every beat timed on its own', () => {
  const cap = safariCapture('eta-2836-2-safari.wav');
  const r = stream(cap.channels, cap.sampleRate, { chunk: 4096 });
  assert.equal(r.status[0].state, 'tracking');
  assert.equal(r.status[0].bph, 28800);
  assert.ok(r.status[0].t < 10, `locked after ${r.status[0].t.toFixed(1)} s`);
  assert.ok(r.status.every((s) => s.state === 'tracking'), 'lock never lost');
  assert.ok(r.beats.every((b) => b.cycles === 1), 'every beat timed on its own');
  const last = r.last;
  assert.ok(last && last.rate !== null && last.beatErrorMs !== null && last.jitterMs !== null && last.signal);
  assert.ok(Math.abs(last.rate - 1.7) <= 0.3, `rate ${last.rate.toFixed(2)}`);
  const errors = r.readings.filter((x) => x.beatErrorMs !== null).map((x) => /** @type {number} */ (x.beatErrorMs));
  assert.ok(errors.length > 10 && errors.every((e) => Math.abs(e - 0.3) <= 0.08), `beat error ${Math.min(...errors).toFixed(2)} to ${Math.max(...errors).toFixed(2)} ms`);
  // Far clearer than the Voice Memos recording of the same watch, whose ticks and tocks stand
  // 14 and 19 noise spreads above the noise, with 0.074 ms of scatter.
  assert.ok(last.jitterMs < 0.06, `scatter ${last.jitterMs.toFixed(3)} ms`);
  assert.ok(last.signal.z.every((z) => z !== null && z > 60), `ticks and tocks ${last.signal.z.map((z) => z?.toFixed(0))} noise spreads above the noise`);
  regularThroughout(r);
});

test('Omega 3861, Safari capture, in real time and co-axial: locks within 10 s, every tick and tock timed on its own, about +0.4 s/day, no beat error', () => {
  const cap = safariCapture('omega-3861-safari.wav');
  // Its 20 s readings wander smoothly between -0.2 and +1.6 s/day over the minute, far more
  // than their stated +-0.09, so the watch's own rate moves; a 40 s window, as for the other
  // Omega recordings.
  const r = stream(cap.channels, cap.sampleRate, { chunk: 4096, options: { escapement: 'coaxial', averagingSeconds: 40 } });
  assert.equal(r.status[0].bph, 21600);
  assert.ok(r.status[0].t < 10, `locked after ${r.status[0].t.toFixed(1)} s`);
  assert.ok(r.status.every((s) => s.state === 'tracking'), 'lock never lost');
  // In the Voice Memos recordings the Omega's beats had to be averaged over several cycles.
  assert.ok(r.beats.every((b) => b.cycles === 1), 'every beat timed on its own');
  for (const type of [0, 1]) {
    const confident = r.beats.filter((b) => b.type === type && b.ok).length;
    assert.ok(confident > 150, `type ${type}: ${confident} confident timestamps`);
  }
  assert.ok(r.readings.length > 0 && r.readings.every((x) => x.beatErrorMs === null), 'no beat error at any time');
  assert.ok(r.last && r.last.rate !== null && Math.abs(r.last.rate - 0.4) <= 0.5, `rate ${r.last?.rate}`);
  regularThroughout(r);
  // In the six-position log a reading of this watch, the milestone 7 check's, can be saved only
  // once the lock has lasted the whole 40 s window set here, though the 20 s default would have
  // been full 20 s earlier; the saved reading records the 40 s.
  const locked = r.readings.filter((x) => x.window !== null);
  assert.ok(locked.every((x) => x.windowSeconds === 40), 'the window set, not lengthened');
  const first = locked.findIndex((x) => readiness(true, x, 40).ready);
  assert.ok(first > 0 && locked[first].t >= 40 && locked[first].t < 41, `first ready at ${locked[first]?.t.toFixed(1)} s`);
  assert.ok(locked.slice(first).every((x) => readiness(true, x, 40).ready), 'ready from then on');
  const saved = takeReading(r.last, { bph: 21600, escapement: 'coaxial', source: 'omega-3861-safari.wav', now: new Date() });
  assert.ok(saved && saved.windowSeconds === 40 && saved.beatErrorGap === 'coaxial');
});

test('Omega 3861, Safari capture, first 30 s: the bands above 14.5 kHz make its beats clearer, and Swiss-lever mode misreads it', () => {
  const cap = safariCapture('omega-3861-safari.wav');
  // Half the capture shows both as clearly as the whole minute, in a third of the time.
  const window = { startSeconds: 0, endSeconds: 30 };
  const all = analyze(cap.channels, cap.sampleRate, window);
  const lower = analyze(cap.channels, cap.sampleRate, { ...window, bands: DEFAULT_BANDS.filter(([lo]) => lo < 14500) });
  assert.equal(all.bph, 21600);
  // The two top bands were added because Safari captures carry tick sound up to 22.5 kHz. With
  // them the beats stand 2.3 and 2.2 times higher above the noise, and scatter about half as much.
  for (const type of [0, 1]) {
    const gain = medianZ(all.beats[type]) / medianZ(lower.beats[type]);
    assert.ok(gain > 1.5, `type ${type}: ${gain.toFixed(2)} times clearer`);
  }
  assert.ok(all.jitterMs !== null && lower.jitterMs !== null && all.jitterMs < 0.7 * lower.jitterMs, `scatter ${all.jitterMs?.toFixed(3)} ms with them, ${lower.jitterMs?.toFixed(3)} ms without`);
  // The co-axial tick and tock are different sounds, and in Swiss-lever mode the gap between
  // them reads as a steady 3.4 ms beat error that does not describe the watch. The simple
  // independent timing finds the same 3.4 ms. This is why the escapement setting exists; if a
  // later version learns to measure this correctly, this check should change.
  assert.ok(all.beatErrorMs !== null && all.beatErrorMs > 3, `beat error ${all.beatErrorMs}`);
});
