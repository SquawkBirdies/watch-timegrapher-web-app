// Watches that run irregularly. Each beat of such a watch falls a little early or late, by an
// amount that changes from beat to beat, and the trace must show that in full: every timestamp
// one beat, where that beat really fell. Averaging several cycles would smooth the trace and
// make a badly running watch look better than it is; so would readings that claim more
// precision than the watch's own scatter allows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { synthesizeWatch, seededRandom, gaussianFrom } from '../js/audio/simulator.js';
import { analyze } from '../js/dsp/offline.js';
import { judgeScatter, SCATTER_LIMIT_MS } from '../js/dsp/irregular.js';
import { stream, traceScatter, againstTruth } from './helpers/stream.js';
import { basketCase, smoothRate, retime, regularBeats } from './helpers/irregular.js';
import { readWav } from './helpers/wav.js';

/** The pipeline as it was before: a watch with scattered beats is timed like a faint one. */
const BEFORE = { followScatter: false };
const fixture = (/** @type {string} */ name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const FE = 12000;

/**
 * A track whose confident timestamps scatter by `ms`.
 * @param {number} ms
 * @param {number} [confident] how many of 200 timestamps stand above the noise
 * @param {number} [K] cycles averaged per timestamp
 * @returns {import('../js/dsp/timing.js').BeatTrack}
 */
function fakeTrack(ms, confident = 200, K = 1) {
  const g = gaussianFrom(seededRandom(Math.round(ms * 1000) + confident + K));
  const lag = Float64Array.from({ length: 200 }, () => (g() * ms * FE) / 1000);
  const value = Float64Array.from({ length: 200 }, (_, i) => (i < confident ? 10 : 0));
  return { K, lag, value, threshold: 1, noiseMean: 0, noiseSd: 1, z: value, confidentFraction: confident / 200 };
}

/** @param {import('../js/dsp/pipeline.js').StatusEvent[]} status */
const lockLost = (status) => status.some((s, i) => s.state === 'listening' && status.slice(0, i).some((p) => p.state === 'tracking'));

/** The first basket-case watch's run as the pipeline now times it, kept for the second test
 *  that uses it. @type {{w: ReturnType<typeof basketCase>, r: ReturnType<typeof stream>}|null} */
let firstBasket = null;
/** @param {number} seed */
const basket = (seed) => {
  if (seed === 1 && firstBasket) return firstBasket;
  const w = basketCase(seed);
  const run = { w, r: stream(w.channels, w.sampleRate, { chunk: 1024 }) };
  if (seed === 1) firstBasket = run;
  return run;
};

test('a watch counts as irregular only when both beat types scatter', () => {
  const judge = (/** @type {import('../js/dsp/timing.js').BeatTrack[]} */ singles, /** @type {import('../js/dsp/timing.js').BeatTrack[]} */ averaged) => judgeScatter(singles, FE, { both: true, averaged }).irregular;
  const none = [fakeTrack(0, 0, 4), fakeTrack(0, 0, 4)];
  // Both scatter: irregular running moves ticks and tocks alike.
  assert.equal(judge([fakeTrack(1), fakeTrack(1)], none), true);
  // A regular watch keeps its single beats within about 0.1 ms.
  assert.equal(judge([fakeTrack(0.08), fakeTrack(0.1)], none), false);
  // A wide sound scatters only its own timestamps: the co-axial Omega's tick by up to 1.4 ms in
  // short windows, while its two-sound tock kept within 0.32 ms.
  assert.equal(judge([fakeTrack(1.4), fakeTrack(0.32)], none), false);
  assert.ok(SCATTER_LIMIT_MS > 0.32);
  // A beat type too faint to time alone is judged from its averages: four cycles averaged
  // scatter by half as much as single beats.
  assert.equal(judge([fakeTrack(1.1), fakeTrack(1, 10)], [fakeTrack(0, 0, 4), fakeTrack(0.5, 150, 4)]), true);
  assert.equal(judge([fakeTrack(1.1), fakeTrack(1, 10)], [fakeTrack(0, 0, 4), fakeTrack(0.05, 150, 4)]), false);
  // One type alone is not enough for a first verdict.
  assert.equal(judge([fakeTrack(2), fakeTrack(1, 10)], none), false);
  // Once a watch is known to be irregular, a type that cannot be judged does not undo it.
  const known = judgeScatter([fakeTrack(1), fakeTrack(1, 10)], FE);
  assert.equal(known.irregular, true);
  assert.ok(Math.abs(/** @type {number} */ (known.scatterMs[0]) - 1) < 0.15, `scatter ${known.scatterMs[0]} ms`);
  assert.equal(known.scatterMs[1], null);
  assert.equal(judgeScatter([fakeTrack(0.2), fakeTrack(1, 10)], FE).irregular, false);
});

test('regular watches, clear or faint, are not taken for irregular ones', () => {
  // Every analysis while tracking counts, the short early ones too: in those, the second Omega
  // recording's wide tick scatters by up to 1.4 ms.
  for (const [name, bph] of /** @type {[string, number][]} */ ([['eta-2836-2.wav', 28800], ['omega-3861.wav', 21600], ['omega-3861-b.wav', 21600]])) {
    const w = readWav(fixture(name));
    const r = stream(w.channels, w.sampleRate, { chunk: 4096, options: { bph } });
    assert.ok(r.readings.length >= 10, `${name}: ${r.readings.length} readings`);
    assert.ok(r.readings.every((x) => !x.irregular), `${name}: never irregular`);
    assert.equal(r.pipeline.maxLag, Math.floor(4e-3 * r.pipeline.fe), `${name}: the usual search width`);
    assert.equal(r.pipeline.changeChecks, 0, `${name}: no early look for a change in regularity`);
  }
  // A faint regular watch still averages, as it should: its beats are where the grid says.
  const faint = synthesizeWatch({ bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 0.9, seconds: 30, seed: 91 });
  const a = analyze(faint.channels, faint.sampleRate, { bph: 28800 });
  assert.equal(a.irregular, false);
  assert.ok(a.beats.some((s) => s.K > 1), `cycles averaged ${a.beats.map((s) => s.K)}`);
});

test('a clear watch whose beats scatter by 2 or 5 ms is shown beat by beat and stays locked', () => {
  // The 2 ms watch is one that used to lose its lock at a repeat analysis.
  for (const [jitterMs, seed, seconds] of [[2, 1010, 40], [5, 91, 50]]) {
    const w = synthesizeWatch({ bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds, seed, jitterMs });
    const r = stream(w.channels, w.sampleRate, { chunk: 1024 });
    const label = `${jitterMs} ms`;
    assert.ok(r.status.length > 0 && !lockLost(r.status), `${label}: locked and stayed locked (${r.status.map((s) => `${s.t.toFixed(0)} s ${s.state}`).join(', ')})`);
    for (const type of /** @type {(0|1)[]} */ ([0, 1])) {
      const truth = againstTruth(r.beats, w.beatTimes, w.truePeriod, type);
      const line = traceScatter(r.beats, 28800, type);
      assert.deepEqual(line.cycles, [1], `${label}, type ${type}: every timestamp one beat`);
      assert.ok(truth.count > 0.6 * (seconds - 12) * 4, `${label}, type ${type}: ${truth.count} confident timestamps`);
      assert.ok(truth.follows > 0.9 && truth.follows < 1.1, `${label}, type ${type}: follows the true displacements by ${truth.follows.toFixed(2)}`);
      assert.ok(truth.wrong < 0.04 * truth.count, `${label}, type ${type}: ${truth.wrong} of ${truth.count} off by more than 0.5 ms`);
    }
    const after = r.readings.filter((x) => x.rate !== null);
    assert.ok(after.length > 10 && after.every((x) => x.irregular), `${label}: readings say the watch runs irregularly`);
    assert.ok(r.readings.every((x) => x.beatErrorMs === null), `${label}: no beat error is shown`);
    assert.ok(after.every((x) => /** @type {number} */ (x.jitterMs) > 0.75 * jitterMs), `${label}: scatter reading at least ${(0.75 * jitterMs).toFixed(1)} ms`);
  }
});

test('the same watch at 2 ms was smoothed before', () => {
  const w = synthesizeWatch({ bph: 28800, rate: 4, beatOffsetMs: 0.2, gain: 1.6, seconds: 40, seed: 1010, jitterMs: 2 });
  const r = stream(w.channels, w.sampleRate, { chunk: 1024, options: { timing: BEFORE } });
  const types = /** @type {(0|1)[]} */ ([0, 1]).map((type) => ({ truth: againstTruth(r.beats, w.beatTimes, w.truePeriod, type), line: traceScatter(r.beats, 28800, type) }));
  assert.ok(types.some((t) => t.line.cycles.some((K) => K > 1)), `cycles averaged ${types.map((t) => t.line.cycles.join('/'))}`);
  assert.ok(types.some((t) => t.truth.follows < 0.8), `follows ${types.map((t) => t.truth.follows.toFixed(2))}`);
});

test('real watch sounds moved by known amounts are shown where they fell', () => {
  // The ETA recording runs regularly. Every beat of it is moved by a random amount with a
  // standard deviation of 3 ms, and the trace is compared with the known displacements.
  const w = readWav(fixture('eta-2836-2.wav'));
  const seconds = Math.min(60, w.channels[0].length / w.sampleRate);
  const channels = w.channels.map((c) => c.subarray(0, Math.round(seconds * w.sampleRate)));
  const times = regularBeats(analyze(channels, w.sampleRate, { bph: 28800, endSeconds: 30 }).beats, seconds);
  const g = gaussianFrom(seededRandom(77));
  const shifts = times.map(() => g() * 3e-3);
  const moved = retime(channels, w.sampleRate, times, shifts);
  const truth = times.map((t, k) => t + shifts[k]);
  const period = (times[times.length - 1] - times[0]) / (times.length - 1);
  // againstTruth counts beats from 0.137 s; put the first true beat there.
  const lead = 0.137 - truth[0];
  const beatTimes = Float64Array.from(truth, (t) => t + lead);
  const run = (/** @type {import('../js/dsp/timing.js').TimingOptions} */ timing) => {
    const r = stream(moved, w.sampleRate, { chunk: 1024, options: { timing } });
    const beats = r.beats.map((b) => ({ ...b, t: b.t + lead }));
    return { r, types: /** @type {(0|1)[]} */ ([0, 1]).map((type) => ({ truth: againstTruth(beats, beatTimes, period, type), line: traceScatter(beats, 28800, type) })) };
  };
  const after = run({});
  assert.ok(!lockLost(after.r.status), 'stayed locked');
  for (const [type, t] of after.types.entries()) {
    assert.deepEqual(t.line.cycles, [1], `type ${type}: every timestamp one beat`);
    assert.ok(t.truth.count > 40, `type ${type}: ${t.truth.count} confident timestamps`);
    assert.ok(t.truth.follows > 0.9 && t.truth.follows < 1.1, `type ${type}: follows the true displacements by ${t.truth.follows.toFixed(2)}`);
    assert.ok(t.truth.wrong < 0.04 * t.truth.count, `type ${type}: ${t.truth.wrong} of ${t.truth.count} off by more than 0.5 ms`);
  }
  // Before, the beats were averaged and the trace hid most of the scatter.
  const before = run(BEFORE);
  assert.ok(before.types.every((t) => t.truth.follows < 0.8), `before: follows ${before.types.map((t) => t.truth.follows.toFixed(2))}`);
});

test('a basket case is shown as the snow storm it is, with no flattering readings', () => {
  /** @type {number[]} */
  const zs = [];
  for (const seed of [1, 2, 3]) {
    const { w, r } = basket(seed);
    const label = `seed ${seed}`;
    const first = r.status.find((s) => s.state === 'tracking');
    assert.ok(first && first.bph === w.bph, `${label}: locked at ${w.bph} vph`);

    // The watch is found to run irregularly once both beat types have been heard beat by beat,
    // and from then on the lock holds and every reading says so.
    const readings = r.readings.filter((x) => x.rate !== null && x.window !== null);
    assert.ok(readings.length > 20, `${label}: ${readings.length} readings`);
    const verdict = readings.find((x) => x.irregular);
    assert.ok(verdict && verdict.t < 20, `${label}: found irregular at ${verdict ? verdict.t.toFixed(0) : '-'} s`);
    const since = /** @type {NonNullable<typeof verdict>} */ (verdict).t;
    const after = readings.filter((x) => x.t >= since);
    assert.ok(after.every((x) => x.irregular), `${label}: every reading from ${since.toFixed(0)} s says the watch runs irregularly`);
    assert.ok(!r.status.some((s) => s.state === 'listening' && s.t > since), `${label}: stayed locked from then on`);
    assert.ok(after.every((x) => /** @type {number} */ (x.jitterMs) > 1.5), `${label}: scatter reading at least 1.5 ms`);
    // The tock really is 2 ms off; a confused timegrapher shows 0.0 ms. No number is better.
    assert.ok(r.readings.every((x) => x.beatErrorMs === null), `${label}: no beat error is shown`);

    // The trace from then on: one beat per timestamp, scattered as much as the beats really
    // are. A beat type too faint to be timed beat by beat is left out rather than averaged.
    const later = r.beats.filter((b) => b.t >= since);
    let timed = 0;
    for (const type of /** @type {(0|1)[]} */ ([0, 1])) {
      const own = later.filter((b) => b.type === type && b.ok);
      assert.ok(own.every((b) => b.cycles === 1), `${label}, type ${type}: every timestamp one beat from ${since.toFixed(0)} s`);
      if (own.length < 40) continue;
      timed++;
      // Each timestamp against the beat it stands for: the trace shows those beats' scatter in
      // full, and in the right places. A few land on the rattle instead of a quiet beat, as
      // they would on a bench timegrapher; before, most did not match their beats.
      const truth = againstTruth(later, w.beatTimes, w.truePeriod, type);
      assert.ok(truth.shownSd > 0.85 * truth.realSd, `${label}, type ${type}: trace shows ${truth.shownSd.toFixed(2)} ms of the beats' ${truth.realSd.toFixed(2)} ms`);
      assert.ok(truth.follows > 0.85 && truth.follows < 1.15, `${label}, type ${type}: follows the true displacements by ${truth.follows.toFixed(2)}`);
      assert.ok(truth.wrong < 0.12 * truth.count, `${label}, type ${type}: ${truth.wrong} of ${truth.count} off by more than 0.5 ms`);
    }
    assert.ok(timed > 0, `${label}: a beat type timed`);

    // The rate wanders by itself, so a reading over 20 seconds can only be held to the watch's
    // rate over those 20 seconds; its stated uncertainty must allow for the scatter. Every
    // reading counts, those before the verdict too.
    for (const x of readings) {
      const [from, to] = /** @type {[number, number]} */ (x.window);
      zs.push((/** @type {number} */ (x.rate) - smoothRate(w, from, to)) / /** @type {number} */ (x.rateSd));
    }
  }
  const rms = Math.sqrt(zs.reduce((s, z) => s + z * z, 0) / zs.length);
  const far = zs.filter((z) => Math.abs(z) > 3).length;
  assert.ok(rms < 1.5, `rate errors in units of the stated uncertainty: rms ${rms.toFixed(2)}`);
  assert.ok(far <= 0.05 * zs.length, `${far} of ${zs.length} rate readings more than 3 stated uncertainties off`);
});

test('a basket case was smoothed before', () => {
  // The same watch timed as before and as now, measured the same way: before, the beats were
  // averaged and the trace showed little more than half of the scatter that the trace now
  // shows beat by beat (which the test above holds to the truth).
  const { w, r } = basket(1);
  const lines = (/** @type {ReturnType<typeof stream>} */ run) => /** @type {(0|1)[]} */ ([0, 1]).map((type) => traceScatter(run.beats, w.bph, type));
  const before = lines(stream(w.channels, w.sampleRate, { chunk: 1024, options: { timing: BEFORE } }));
  const now = lines(r);
  assert.ok(before.every((l) => l.cycles.some((K) => K > 1)), `cycles averaged before ${before.map((l) => l.cycles.join('/'))}`);
  for (const type of [0, 1]) {
    assert.ok(before[type].spreadMs < 0.75 * now[type].spreadMs, `type ${type}: trace scatter ${before[type].spreadMs.toFixed(2)} ms before, ${now[type].spreadMs.toFixed(2)} ms now`);
  }
});
