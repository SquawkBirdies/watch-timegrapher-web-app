// The real recordings, as permanent regression tests. Expected values for the first two come
// from the Python prototype (tools/prototype); those watches lay dial-down with the crown
// against the phone. In the third the phone was held over the dial of the Omega, in a different
// room. Each recording is analysed whole, and then fed to the real-time pipeline in small chunks.
// The last tests use the Safari captures of the same two watches, saved by the audio diagnostic.
// The whole-recording analyses also read the sounds inside each beat (milestone 8): the Safari
// captures give a beat error from the unlocks and an amplitude, the Voice Memos recordings none.
// The Omega's capture is read so in real time too; the ETA's 30 s are too short for that.
// Each capture is also run from a later start, to see that the same beat is named the tick
// whichever beat the lock begins on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { readWav } from './helpers/wav.js';
import { analyze } from '../js/dsp/offline.js';
import { DEFAULT_BANDS } from '../js/dsp/filterbank.js';
import { medianZ } from '../js/dsp/timing.js';
import { stream } from './helpers/stream.js';
import { readiness, takeReading, describeReading } from '../js/ui/positions.js';
import { soundsReadout } from '../js/ui/model.js';

/** @param {string} name */
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** The ETA recording and its whole-recording analysis, made once for the two tests that use it. */
let eta = /** @type {{wav: ReturnType<typeof readWav>, whole: ReturnType<typeof analyze>}|null} */ (null);
const etaWhole = () => {
  if (!eta) {
    const wav = readWav(fixture('eta-2836-2.wav'));
    // The first 2 s and everything after 54 s contain handling noise.
    eta = { wav, whole: analyze(wav.channels, wav.sampleRate, { startSeconds: 2, endSeconds: 54, liftAngle: 50 }) };
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
  // Its ticks' timestamps each average two cycles, so the sounds inside its beats are not read.
  assert.deepEqual(r.beats.map((b) => b.K), [2, 1]);
  assert.ok(r.sounds && r.sounds.why === 'averaged' && r.sounds.beatErrorMs === null && r.sounds.amplitude === null && !r.sounds.showBeatError && !r.sounds.showAmplitude);
  // A lever's tick is the beat followed by the longer gap between the timed beats: the first
  // series when the second falls late of midway.
  assert.ok(r.beatOffsetMs !== null && r.tick === (r.beatOffsetMs > 0 ? 0 : 1), `tick ${r.tick}, offset ${r.beatOffsetMs}`);
});

test('Omega 3861: 21,600 vph, about +0.2 s/day, needs averaging, no beat error reported', () => {
  const wav = readWav(fixture('omega-3861.wav'));
  const r = analyze(wav.channels, wav.sampleRate, { startSeconds: 2, endSeconds: 60, liftAngle: 36 });
  assert.equal(r.bph, 21600);
  assert.ok(r.rate !== null);
  assert.ok(Math.abs(r.rate - 0.2) <= 0.5, `rate ${r.rate.toFixed(2)}`);
  assert.ok(Math.max(...r.beats.map((b) => b.K)) >= 4, 'weak-signal averaging was needed');
  assert.equal(r.beatErrorMs, null, 'one beat is too faint for a beat error');
  assert.ok(r.sounds && r.sounds.why === 'averaged', 'and no single beat can be placed to read its sounds');
  assert.equal(r.tick, null, 'so nothing names its tick');
});

test('Omega 3861, second recording: 21,600 vph, about -2.1 s/day, ticks too blurred for a beat error', () => {
  const wav = readWav(fixture('omega-3861-b.wav'));
  const r = analyze(wav.channels, wav.sampleRate, { startSeconds: 2, endSeconds: 73, liftAngle: 36 });
  assert.equal(r.bph, 21600);
  assert.ok(r.rate !== null);
  assert.ok(Math.abs(r.rate + 2.1) <= 0.5, `rate ${r.rate.toFixed(2)}`);
  assert.ok(r.fits.every((f) => f !== null), 'ticks and tocks are both audible in this recording');
  assert.equal(r.beatErrorMs, null, 'the tick timestamps scatter too much for a beat error');
  assert.ok(r.sounds && r.sounds.why === 'averaged', 'and each timestamp averages several cycles, so the sounds inside the beats are not read');
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
 * How many of one run's ticks are another run's ticks, for two runs of one recording begun at
 * different moments: each of the first run's named ticks is matched by time to the nearest
 * confident beat of the second.
 * @param {ReturnType<typeof stream>} a
 * @param {number} startA seconds into the recording at which run `a` began
 * @param {ReturnType<typeof stream>} b
 * @param {number} startB
 * @returns {{same: number, other: number}} ticks of `a` that are ticks of `b`, and tocks of `b`
 */
function ticksInCommon(a, startA, b, startB) {
  const tickOf = (/** @type {ReturnType<typeof stream>} */ r) => (r.last ? r.last.tick : null);
  const others = b.beats.filter((x) => x.ok && x.cycles === 1);
  let same = 0;
  let other = 0;
  for (const x of a.beats) {
    if (!x.ok || x.cycles !== 1 || x.type !== tickOf(a)) continue;
    const t = x.t + startA - startB;
    const nearest = others.reduce((best, y) => (Math.abs(y.t - t) < Math.abs(best.t - t) ? y : best), others[0]);
    // The two runs time a beat within a fraction of a millisecond of each other; beats are
    // more than 100 ms apart.
    if (Math.abs(nearest.t - t) > 0.02) continue;
    if (nearest.type === tickOf(b)) same++;
    else other++;
  }
  return { same, other };
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

/** The ETA's Safari capture through the real-time pipeline, streamed once for the tests that use it. */
let etaLive = /** @type {ReturnType<typeof stream>|null} */ (null);
const etaSafariLive = () => {
  if (!etaLive) {
    const cap = safariCapture('eta-2836-2-safari.wav');
    etaLive = stream(cap.channels, cap.sampleRate, { chunk: 4096 });
  }
  return etaLive;
};

test('ETA 2836-2, Safari capture, in real time: locks within 10 s, about +1.7 s/day and 0.3 ms, every beat timed on its own', () => {
  const r = etaSafariLive();
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

test('ETA 2836-2, Safari capture: the tick is named with the first reading of the lock, and a run begun 1.9 s later, which numbers its beats the other way round, names the same beat', () => {
  const r = etaSafariLive();
  const locked = r.readings.filter((x) => x.window !== null);
  assert.ok(locked[0].tick !== null && locked.every((x) => x.tick === locked[0].tick), 'named at the lock, and kept');
  // The tocks fall 0.31 ms late of midway between the ticks, 40 times the offset's uncertainty.
  const detail = /** @type {NonNullable<typeof locked[0]['beatErrorDetail']>} */ (/** @type {typeof locked[0]} */ (r.last).beatErrorDetail);
  const signed = (/** @type {typeof locked[0]} */ x) => (x.tick === 0 ? 1 : -1) * /** @type {number} */ (x.beatOffsetMs);
  assert.ok(locked.every((x) => x.beatOffsetMs !== null && Math.abs(signed(x) - 0.31) <= 0.08), 'the same sign in every reading');
  assert.ok(detail.offsetSdMs < 0.02, `offset +-${detail.offsetSdMs.toFixed(3)} ms`);
  // Begun 1.913 s later, a time that is not a whole number of beats: the lock begins on the
  // other beat, so the pipeline's two types are the other way round, and until 26 November 2026
  // the tick and the tock were too.
  const cap = safariCapture('eta-2836-2-safari.wav');
  const start = 1.913;
  const later = stream(cap.channels, cap.sampleRate, { chunk: 4096, from: Math.round(start * cap.sampleRate) });
  assert.ok(later.last && later.last.tick !== null && r.last && later.last.tick !== r.last.tick, `types ${r.last?.tick} and ${later.last?.tick}`);
  const common = ticksInCommon(later, start, r, 0);
  assert.ok(common.same > 90 && common.other === 0, `${common.same} of its ticks are the first run's ticks, ${common.other} its tocks`);
});

/**
 * The Omega's Safari capture through the real-time pipeline, streamed once for the two tests
 * that use it: co-axial, and with the sounds inside its beats read at 36 degrees of lift.
 */
let omegaLive = /** @type {ReturnType<typeof stream>|null} */ (null);
const omegaSafariLive = () => {
  if (!omegaLive) {
    const cap = safariCapture('omega-3861-safari.wav');
    // Its 20 s readings wander smoothly between -0.2 and +1.6 s/day over the minute, far more
    // than their stated +-0.09, so the watch's own rate moves; a 40 s window, as for the other
    // Omega recordings. Each reading of the sounds is finished in the audio block it starts in,
    // so that the test does not depend on the computer's speed, and one is started every 10 s:
    // four in this capture, of one to three seconds' computing each.
    omegaLive = stream(cap.channels, cap.sampleRate, { chunk: 4096, options: { escapement: 'coaxial', averagingSeconds: 40, liftAngle: 36, sounds: { share: Infinity, fillingSeconds: 10 } } });
  }
  return omegaLive;
};

test('Omega 3861, Safari capture, in real time and co-axial: locks within 10 s, every tick and tock timed on its own, about +0.4 s/day, no beat error from its timestamps', () => {
  const r = omegaSafariLive();
  assert.equal(r.status[0].bph, 21600);
  assert.ok(r.status[0].t < 10, `locked after ${r.status[0].t.toFixed(1)} s`);
  assert.ok(r.status.every((s) => s.state === 'tracking'), 'lock never lost');
  // In the Voice Memos recordings the Omega's beats had to be averaged over several cycles.
  assert.ok(r.beats.every((b) => b.cycles === 1), 'every beat timed on its own');
  for (const type of [0, 1]) {
    const confident = r.beats.filter((b) => b.type === type && b.ok).length;
    assert.ok(confident > 150, `type ${type}: ${confident} confident timestamps`);
  }
  assert.ok(r.readings.length > 0 && r.readings.every((x) => x.beatErrorMs === null), 'none from the gap between the timed beats at any time');
  assert.ok(r.last && r.last.rate !== null && Math.abs(r.last.rate - 0.4) <= 0.5, `rate ${r.last?.rate}`);
  regularThroughout(r);
  // In the six-position log a reading of this watch, the milestone 7 check's, can be saved only
  // once the lock has lasted the whole 40 s window set here since it appeared, though the 20 s
  // default would have been full 20 s earlier; the saved reading records the 40 s.
  const lock = r.status[0].t;
  const locked = r.readings.filter((x) => x.window !== null);
  assert.ok(locked.every((x) => x.windowSeconds === 40), 'the window set, not lengthened');
  const first = locked.findIndex((x) => readiness(true, x, 40, lock).ready);
  assert.ok(first > 0 && locked[first].t >= lock + 39.99 && locked[first].t < lock + 41, `locked at ${lock.toFixed(1)} s, first ready at ${locked[first]?.t.toFixed(1)} s`);
  assert.ok(locked.slice(first).every((x) => readiness(true, x, 40, lock).ready), 'ready from then on');
  // Saved at the end, the position keeps the beat error from the unlocks and the amplitude with
  // their scatter and the lift angle: a co-axial has both, where until 26 November 2026 the log
  // said "not shown: co-axial".
  const saved = takeReading(r.last, { bph: 21600, escapement: 'coaxial', source: 'omega-3861-safari.wav', now: new Date() });
  assert.ok(saved && saved.windowSeconds === 40 && saved.beatErrorMs !== null && saved.beatErrorSd !== null && saved.amplitude !== null && saved.amplitudeSd !== null);
  assert.deepEqual([saved.beatErrorGap, saved.amplitudeGap, saved.liftAngle], [null, null, 36]);
  assert.ok(Math.abs(saved.beatErrorMs - 0.34) <= 0.05 && Math.abs(saved.amplitude - 288) <= 1.5, `saved ${saved.beatErrorMs.toFixed(3)} ms and ${saved.amplitude.toFixed(1)} degrees`);
  assert.match(describeReading(saved).main, / · 0\.3\d ms · 28[789]°$/);
  assert.match(describeReading(saved).detail, /^Over a 40 s window · \d+ beats · beat error ±0\.0\d ms · amplitude ±\d\.\d° at 36° lift$/);
  // Saved the moment Save is ready, it keeps what the pipeline's first reading of the sounds
  // came to: both shown, or both held back with the reason.
  const early = takeReading(locked[first], { bph: 21600, escapement: 'coaxial', source: 'omega-3861-safari.wav', now: new Date() });
  assert.ok(early && ((early.beatErrorMs !== null && early.amplitude !== null) || (early.beatErrorGap === 'failing' && early.amplitudeGap === 'failing')), `${early?.beatErrorGap}, ${early?.amplitudeGap}`);
});

test('Omega 3861, Safari capture, in real time: nothing from the sounds inside its beats until 15 s after the lock, and its readings from 15 and 25 s of beats held back for the unlocks they lose; from 45 s of beats 0.31 +- 0.05 ms and 288 +- 1 degrees, both shown', () => {
  const r = omegaSafariLive();
  const lock = r.status[0].t;
  const locked = r.readings.filter((x) => x.window !== null);
  assert.ok(locked.every((x) => x.sounds !== null && x.sounds.liftAngle === 36));
  const early = locked.filter((x) => x.t < lock + 14.5);
  assert.ok(early.length > 12 && early.every((x) => x.sounds && x.sounds.detail === null && x.sounds.amplitude === null && x.sounds.beatErrorMs === null && x.sounds.amplitudeWhy === 'waiting' && x.sounds.beatErrorWhy === 'waiting'), 'a dash for both, for want of beats');
  // One reading as soon as both beat types have 15 s of beats since the lock, then one every 10 s.
  const windows = [...new Set(locked.map((x) => (x.sounds && x.sounds.window ? x.sounds.window[1] : null)).filter((v) => v !== null))];
  assert.equal(windows.length, 4, 'four readings');
  const of = (/** @type {number} */ i) => /** @type {NonNullable<typeof locked[0]['sounds']>} */ (/** @type {typeof locked[0]} */ (locked.find((x) => x.sounds && x.sounds.window && x.sounds.window[1] === windows[i])).sounds);
  const first = /** @type {typeof locked[0]} */ (locked.find((x) => x.sounds && x.sounds.detail !== null));
  assert.ok(first.t > lock + 14.5 && first.t < lock + 16.5, `locked at ${lock.toFixed(1)} s, first reading at ${first.t.toFixed(1)} s`);
  for (let i = 0; i < 4; i++) {
    const s = of(i);
    assert.ok(s.window && s.detail && s.detail.why === null && s.detail.amplitude !== null && s.detail.beatOffsetMs !== null && s.detail.failing !== null);
    // Only beats heard since the lock appeared, 15, 25, 35 and 45 s of them.
    assert.ok(s.window[0] >= lock && s.window[0] < lock + 0.4 && Math.abs(s.window[1] - s.window[0] - (15 + 10 * i)) < 1.5, `beats from ${s.window[0].toFixed(1)} to ${s.window[1].toFixed(1)} s`);
    // Both locks move against the timestamps, as in the whole capture, and are lined up again
    // once there are two 10 s blocks of beats to compare: not in 15 s.
    assert.equal(s.detail.lining, i === 0 ? 'steady' : 'lined');
    // The first two readings are held back: 72% and 22% of their draws lose the faint unlock.
    // That is why the first reading waited for 30 s of beats until 27 November 2026; it now
    // waits 15 s, which shows the Omega nothing sooner and nothing worse.
    if (i < 2) {
      assert.ok(s.amplitudeWhy === 'failing' && s.beatErrorWhy === 'failing' && s.detail.failing > 0.2, `reading ${i}: ${s.amplitudeWhy}, ${s.detail.failing} of the draws lost the unlock`);
      continue;
    }
    // What was read is the watch's: 0.31 to 0.34 ms and 288 to 290 degrees.
    assert.ok(Math.abs(Math.abs(s.detail.beatOffsetMs) - 0.33) <= 0.04 && Math.abs(s.detail.amplitude - 289) <= 2, `read ${s.detail.beatOffsetMs.toFixed(3)} ms and ${s.detail.amplitude.toFixed(1)} degrees`);
    // The placement check: with every beat on the trend of its timestamps the beat error reads
    // 0.025 ms away with 35 s of beats and 0.009 ms away with 45 s. That is added to the stated
    // scatter, which covers it.
    assert.ok(s.detail.placementMs !== null && s.detail.beatErrorSd !== null && Math.abs(s.detail.placementMs) <= (i === 2 ? 0.04 : 0.02) && s.detail.beatErrorSd >= Math.abs(s.detail.placementMs), `reading ${i}: the two readings differ by ${s.detail.placementMs}`);
    // And the amplitude's two readings differ by less than a degree.
    assert.ok(s.detail.amplitudePlacement !== null && Math.abs(s.detail.amplitudePlacement) <= 1, `reading ${i}: amplitudes ${s.detail.amplitudePlacement} degrees apart`);
    // A reading is shown, or held back because too many of its draws lost the faint unlock:
    // with 30 to 45 s of beats 1 to 7% of them do, against the 5% allowed, and one beat more
    // or less in the reading decides which.
    assert.ok((s.amplitude !== null && s.beatErrorMs !== null) || (s.amplitudeWhy === 'failing' && s.beatErrorWhy === 'failing' && s.amplitude === null && s.beatErrorMs === null && s.detail.failing > 0.05), `reading ${i}: ${s.amplitudeWhy}`);
  }
  // With 45 s of beats 1% of the draws lose the sounds, and both readings are shown. The whole
  // capture, 60 s from its start with its beats timed all at once, reads 0.34 +- 0.04 ms and
  // 288 +- 1 degrees.
  const s = of(3);
  assert.ok(s.amplitude !== null && s.amplitudeSd !== null && s.beatErrorMs !== null && s.beatErrorSd !== null && s.liftMs && s.liftSd && s.detail && s.detail.failing !== null && s.detail.unlockDb !== null);
  assert.deepEqual([s.amplitudeWhy, s.beatErrorWhy], [null, null]);
  assert.ok(Math.abs(s.beatErrorMs - 0.34) <= 0.05, `beat error ${s.beatErrorMs.toFixed(3)} ms`);
  assert.ok(Math.abs(s.amplitude - 288) <= 1.5, `amplitude ${s.amplitude.toFixed(1)}`);
  assert.ok(s.beatErrorSd >= 0.03 && s.beatErrorSd <= 0.07 && s.amplitudeSd >= 0.6 && s.amplitudeSd <= 1.8, `+-${s.beatErrorSd.toFixed(3)} ms and +-${s.amplitudeSd.toFixed(2)} degrees`);
  assert.ok(s.detail.failing <= 0.02 && s.detail.unlockDb > 9, `failing ${s.detail.failing}, unlock ${s.detail.unlockDb.toFixed(1)} dB`);
  const longer = s.liftMs[0] > s.liftMs[1] ? 0 : 1;
  assert.ok(Math.abs(s.liftMs[longer] - 6.94) <= 0.04 && Math.abs(s.liftMs[1 - longer] - 6.32) <= 0.04, `unlock to lock ${s.liftMs.map((v) => v.toFixed(3))} ms`);
  // The marks on the averaged beat are the same sounds: the last waveform event carries them.
  const wave = r.waveforms[r.waveforms.length - 1];
  assert.ok(wave.marks && wave.marks.every((m, j) => Math.abs(m.lockMs - m.unlockMs - /** @type {[number, number]} */ (s.liftMs)[j]) < 1e-9), 'marks from unlock to lock');
  const firstShown = /** @type {typeof locked[0]} */ (locked.find((x) => x.sounds && x.sounds.amplitude !== null));
  assert.ok(r.waveforms.filter((w) => w.t < firstShown.t - 1.1).every((w) => w.marks === null), 'and none before a reading is shown');
  // The stage did its four readings and nothing else changed: the checks of the test above
  // were made on this same run.
  const load = /** @type {NonNullable<typeof r.pipeline.sounds>} */ (r.pipeline.sounds).load();
  assert.equal(load.readings, 4);
  // On the screen at the end: whole degrees and hundredths of a millisecond, each with its
  // scatter and the 45 s of beats it rests on.
  const shown = soundsReadout(true, r.last, 36);
  assert.match(shown.amplitude, /^28[789]$/);
  assert.match(shown.amplitudeNote, /^±[01]\.\d° over 45 s$/);
  assert.match(shown.beatError, /^0\.3[0-9]$/);
  assert.match(shown.beatErrorNote, /^±0\.0[3-7] over 45 s$/);
  // Until the first reading: a dash for each, and why; then, while the readings are held
  // back, the reason for that.
  assert.deepEqual(soundsReadout(true, early[early.length - 1], 36), { amplitude: '—', amplitudeNote: 'needs 15 s of beats', beatError: '—', beatErrorNote: 'needs 15 s of beats' });
  assert.deepEqual(soundsReadout(true, first, 36), { amplitude: '—', amplitudeNote: 'sounds not clear enough', beatError: '—', beatErrorNote: 'sounds not clear enough' });
});

test('Omega 3861, Safari capture, as a co-axial: no tick is named until an amplitude is shown, then the beat with the longer time from unlock to lock; a run begun 3.8 s later numbers its beats the other way round and names the same beat', () => {
  const r = omegaSafariLive();
  const locked = r.readings.filter((x) => x.window !== null);
  const firstShown = locked.findIndex((x) => x.sounds && x.sounds.amplitude !== null);
  assert.ok(firstShown > 25, 'an amplitude was shown, 30 s or more after the lock');
  // The gap between a co-axial's timed beats, 3.4 ms here, would name a tick at once, and can
  // name the wrong beat with confidence: it is not used.
  assert.ok(locked.slice(0, firstShown).every((x) => x.tick === null), 'no names before');
  const named = /** @type {NonNullable<typeof locked[0]['sounds']>} */ (locked[firstShown].sounds);
  assert.ok(named.liftMs && named.liftSd);
  const longer = named.liftMs[0] > named.liftMs[1] ? 0 : 1;
  // 6.9 against 6.3 ms, each to about 0.04 ms: some ten times their combined scatter.
  assert.ok(Math.abs(named.liftMs[0] - named.liftMs[1]) > 6 * Math.hypot(...named.liftSd), `${named.liftMs.map((v) => v.toFixed(2))} +- ${named.liftSd.map((v) => v.toFixed(2))} ms`);
  assert.ok(locked.slice(firstShown).every((x) => x.tick === longer), 'named with the first amplitude shown, and kept when a later reading is held back');
  // Begun 3.826 s later, the lock begins on the other beat. Each of this run's readings of the
  // sounds is finished in the block it starts in, one every 5 s; its first two are held back.
  const cap = safariCapture('omega-3861-safari.wav');
  const start = 3.826;
  const later = stream(cap.channels, cap.sampleRate, { chunk: 4096, from: Math.round(start * cap.sampleRate), options: { escapement: 'coaxial', liftAngle: 36, sounds: { share: Infinity } } });
  assert.ok(later.last && later.last.tick !== null && r.last && later.last.tick !== r.last.tick, `types ${r.last?.tick} and ${later.last?.tick}`);
  const lifts = /** @type {[number, number]} */ (/** @type {NonNullable<typeof locked[0]['sounds']>} */ (later.last.sounds).liftMs);
  assert.ok(lifts[later.last.tick] > lifts[1 - later.last.tick], 'its tick has the longer time too');
  const common = ticksInCommon(later, start, r, 0);
  assert.ok(common.same > 140 && common.other === 0, `${common.same} of its ticks are the first run's ticks, ${common.other} its tocks`);
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

// The sounds inside each beat, with the beats lined up again where a sound moves, 200 draws for
// the scatter, and the gates. Expected values are the prototype's on envelopes made as the app
// makes them (`analyze.py --app`, measured on 26 November): 0.340 +- 0.044 ms and 287.6 +- 1.2
// degrees for the Omega, 0.273 +- 0.026 ms and 265.7 +- 0.5 degrees for the ETA. Given each beat
// where the prototype puts it and the prototype's own draws, this stage gives every one of the
// 200 resampled readings within 2e-8 ms of the prototype's. It puts each beat at its
// timestamp's own place in the envelope instead, 0.375 of an envelope sample earlier, and
// makes its own draws, which moves the readings by up to 0.004 ms and 0.1 degrees and their
// scatter by a few thousandths of a millisecond; hence 0.01 ms and 1 degree. No timing machine
// has read either watch.

test('Omega 3861, Safari capture, whole: 0.34 +- 0.04 ms from its unlocks and 288 +- 1 degrees at 36 degrees of lift, both shown, where its timestamps are 3.6 ms apart', () => {
  const cap = safariCapture('omega-3861-safari.wav');
  const r = analyze(cap.channels, cap.sampleRate, { escapement: 'coaxial', liftAngle: 36 });
  assert.equal(r.bph, 21600);
  assert.equal(r.beatErrorMs, null, 'co-axial mode shows no beat error from the timestamps');
  const s = r.sounds;
  assert.ok(s && s.why === null && s.beatErrorMs !== null && s.unlockGapMs !== null && s.liftMs && s.amplitude !== null && s.amplitudes && s.timestampGapMs !== null && s.unlockDb !== null);
  assert.ok(s.scatter && s.lining && s.lining.moved && s.failing !== null);
  assert.deepEqual(r.beats.map((b) => b.K), [1, 1]);
  assert.deepEqual(s.counts, [178, 178]);
  assert.ok(Math.abs(s.beatErrorMs - 0.34) <= 0.01, `beat error ${s.beatErrorMs.toFixed(3)} ms`);
  assert.ok(Math.abs(s.amplitude - 288) <= 1, `amplitude ${s.amplitude.toFixed(1)}`);
  // The gap between the timestamps, which Swiss-lever mode reads as the beat error.
  assert.ok(Math.abs(Math.abs(s.timestampGapMs) - 3.58) <= 0.02, `timestamps ${s.timestampGapMs.toFixed(3)} ms apart`);
  // A co-axial's two beats take different times from unlock to lock, 6.96 and 6.33 ms here, so
  // one beat alone would read 275 or 302 degrees. Whichever the pipeline named the tick, the
  // beat error is measured from the beat with the longer time to the other.
  const longer = s.liftMs[0] > s.liftMs[1] ? 0 : 1;
  assert.ok(Math.abs(s.liftMs[longer] - 6.96) <= 0.02 && Math.abs(s.liftMs[1 - longer] - 6.33) <= 0.02, `unlock to lock ${s.liftMs.map((v) => v.toFixed(3))} ms`);
  assert.ok(Math.abs(s.amplitudes[longer] - 275) <= 1.5 && Math.abs(s.amplitudes[1 - longer] - 302) <= 1.5, `each beat alone ${s.amplitudes.map((v) => v.toFixed(1))}`);
  assert.ok((longer === 0 ? 1 : -1) * s.unlockGapMs > 0, 'the other beat\'s unlock comes later than midway');
  // And the beat with the longer time is named the tick.
  assert.equal(r.tick, longer);
  // The unlock is the faintest sound used: 10.6 dB over the noise of the average.
  assert.ok(s.unlockDb > 9 && s.unlockDb < 13, `unlock ${s.unlockDb.toFixed(1)} dB`);
  // Its beats drawn again 200 times: the scatter is the reading's stated uncertainty.
  assert.ok(s.scatter.unlockGapMs >= 0.03 && s.scatter.unlockGapMs <= 0.06, `beat error +-${s.scatter.unlockGapMs.toFixed(3)} ms`);
  assert.ok(s.scatter.amplitude >= 0.7 && s.scatter.amplitude <= 1.7, `amplitude +-${s.scatter.amplitude.toFixed(2)}`);
  // The placement check: with every beat on the trend of its timestamps the beat error reads
  // 0.357 ms, 0.014 ms from the reading, which takes its scatter from 0.043 to 0.045 ms.
  assert.ok(s.placement && s.placement.unlockGapMs !== null && s.placement.differenceMs !== null);
  assert.ok(Math.abs(s.placement.differenceMs) <= 0.025 && s.scatter.unlockGapMs - s.placement.resampledScatterMs < 0.005, `the two readings differ by ${s.placement.differenceMs.toFixed(3)} ms`);
  // The amplitude on the trend is 288.1 degrees, 0.45 from the reading: +-1.15 becomes +-1.24.
  assert.ok(s.placement.amplitudeDifference !== null && Math.abs(s.placement.amplitudeDifference) <= 1 && s.scatter.amplitude - s.placement.resampledAmplitudeScatter < 0.3, `amplitudes ${s.placement.amplitudeDifference} degrees apart`);
  assert.ok(s.failing <= 0.02, `${s.failing} of the draws did not find the sounds`);
  assert.deepEqual([s.showBeatError, s.showAmplitude, s.beatErrorHeld, s.amplitudeHeld], [true, true, null, null]);
  // Over its five blocks of 10 s both locks move against the timestamps and both unlocks stay,
  // so the beats are lined up again on the locks. The plain average reads the same beat error
  // and the amplitude 0.1 degrees higher.
  assert.equal(s.lining.state, 'lined');
  assert.equal(s.lining.blocks, 5);
  assert.deepEqual(s.lining.moved.map((type) => type.map((m) => m.moved)), [[false, true], [false, true]]);
});

test('ETA 2836-2, Safari capture, whole: 0.27 +- 0.03 ms from its unlocks and 266 +- 1 degrees at 50 degrees of lift, both shown, both beats alike', () => {
  const cap = safariCapture('eta-2836-2-safari.wav');
  const r = analyze(cap.channels, cap.sampleRate, { liftAngle: 50 });
  assert.equal(r.bph, 28800);
  const s = r.sounds;
  assert.ok(s && s.why === null && s.beatErrorMs !== null && s.liftMs && s.amplitude !== null && s.timestampGapMs !== null && s.unlockDb !== null);
  assert.ok(s.scatter && s.lining && s.lining.moved && s.failing !== null);
  assert.deepEqual(s.counts, [118, 118]);
  assert.ok(Math.abs(s.beatErrorMs - 0.273) <= 0.01, `beat error ${s.beatErrorMs.toFixed(3)} ms`);
  assert.ok(Math.abs(s.amplitude - 266) <= 1, `amplitude ${s.amplitude.toFixed(1)}`);
  // The gap between the timestamps of the loudest sounds, which was the Swiss-lever beat error
  // until 26 November 2026, is 0.31 ms. It names the tick: the beat followed by the longer gap.
  assert.ok(r.beatErrorMs !== null && Math.abs(r.beatErrorMs - 0.31) <= 0.02, `from the timestamps ${r.beatErrorMs}`);
  assert.ok(r.beatOffsetMs !== null && r.tick === (r.beatOffsetMs > 0 ? 0 : 1));
  // A lever's two beats take the same time from unlock to lock: 7.49 and 7.50 ms.
  assert.ok(s.liftMs.every((v) => Math.abs(v - 7.495) <= 0.02), `unlock to lock ${s.liftMs.map((v) => v.toFixed(3))} ms`);
  assert.ok(s.unlockDb > 20, `unlock ${s.unlockDb.toFixed(1)} dB`);
  assert.ok(s.scatter.unlockGapMs >= 0.015 && s.scatter.unlockGapMs <= 0.04, `beat error +-${s.scatter.unlockGapMs.toFixed(3)} ms`);
  assert.ok(s.scatter.amplitude <= 1, `amplitude +-${s.scatter.amplitude.toFixed(2)}`);
  // The placement check: on the trend of its timestamps the beat error reads 0.270 ms, 0.005 ms
  // from the reading, and its scatter stays at 0.03 ms.
  assert.ok(s.placement && s.placement.differenceMs !== null && Math.abs(s.placement.differenceMs) <= 0.015 && s.scatter.unlockGapMs - s.placement.resampledScatterMs < 0.003, `the two readings differ by ${s.placement && s.placement.differenceMs}`);
  // Its amplitude on the trend is 265.7 degrees, 0.2 from the reading: +-0.51 becomes +-0.55.
  assert.ok(s.placement.amplitudeDifference !== null && Math.abs(s.placement.amplitudeDifference) <= 0.6 && s.scatter.amplitude - s.placement.resampledAmplitudeScatter < 0.2, `amplitudes ${s.placement.amplitudeDifference} degrees apart`);
  assert.deepEqual([s.showBeatError, s.showAmplitude, s.failing], [true, true, 0]);
  // Nothing moves over its two blocks of 10 s, so the plain average stands. Its 10 s stretches
  // read apart from one another all the same (issue 1 of the co-axial investigation, open).
  assert.equal(s.lining.state, 'steady');
  assert.equal(s.lining.blocks, 2);
});
