// Stage 10 in real time (js/dsp/soundstage.js): the envelopes it keeps, the beats it reads, when
// it reads them, how its computing is spread over the audio blocks, and what it reports. First
// on its own, with watches made up as envelopes and timestamps (tests/helpers/envelopes.js), a
// few seconds a test. Then inside the pipeline, on a simulated lever whose unlocks, locks and
// amplitude are known (tests/helpers/balance.js). The Omega's capture in real time is in
// recordings.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SoundStage, STACK_SECONDS, FIRST_READING_SECONDS } from '../js/dsp/soundstage.js';
import { measureSounds } from '../js/dsp/amplitude.js';
import { Pipeline } from '../js/dsp/pipeline.js';
import { madeUpWatch, ENVELOPE_RATE } from './helpers/envelopes.js';
import { synthesizeBalanceWatch, leverWatch } from './helpers/balance.js';
import { parityOf } from './helpers/stream.js';
import { Measurement, soundsReadout } from '../js/ui/model.js';
import { readiness, takeReading, describeReading, positionStep, withReading, emptyLog, summarise, describeSummary } from '../js/ui/positions.js';

/**
 * @typedef {ReturnType<typeof madeUpWatch>} MadeUp
 * @typedef {import('../js/dsp/soundstage.js').SoundsReport} SoundsReport
 */

const BLOCK = 512;
const fe = ENVELOPE_RATE;

/**
 * A filter bank's shape, for a stage fed with envelopes directly: one channel, six bands from
 * 5 kHz up, the envelope rate the audio's own, so that a position is a time without rounding.
 * @param {number} bands
 */
const bankOf = (bands) => /** @type {any} */ ({
  envelopeRate: fe,
  sampleRate: fe,
  decimation: 1,
  rows: Array.from({ length: bands }, (_, band) => ({ channel: 0, band })),
  bands: Array.from({ length: bands }, (_, b) => [5000 + 2000 * b, 7000 + 2000 * b]),
});

/**
 * Feed a made-up watch to a stage block by block, as the pipeline does: the envelopes of each
 * block, then the beats timed so far.
 * @param {MadeUp} w
 * @param {{liftAngle?: number, since?: number, stage?: import('../js/dsp/soundstage.js').StageOptions, types?: number[], each?: (stage: SoundStage, seconds: number) => void, tick?: () => void}} [how]
 *   `since`: when the lock appeared, in seconds; `types`: the beat types the pipeline timed;
 *   `each` is called after every block; `tick` before every block
 * @returns {{stage: SoundStage, reports: {t: number, report: SoundsReport}[]}} the stage, and
 *   its report after every block in which it changed
 */
function feed(w, how = {}) {
  const { liftAngle = 50, since = 0, stage: options = {}, types = [0, 1], each, tick } = how;
  const stage = new SoundStage(bankOf(w.rows.length), 0, liftAngle, { share: Infinity, ...options });
  stage.reset(Math.round(since * fe));
  const beats = types.flatMap((type) => Array.from(w.beats[type].t, (t, i) => ({ n: w.beats[type].n[i], p: t * fe, type: /** @type {0|1} */ (type) }))).sort((a, b) => a.p - b.p);
  /** @type {{t: number, report: SoundsReport}[]} */
  const reports = [];
  for (let at = 0; at + BLOCK <= w.rows[0].length; at += BLOCK) {
    if (tick) tick();
    stage.append(w.rows.map((row) => row.subarray(at, at + BLOCK)));
    const now = at + BLOCK;
    const before = stage.version;
    // A beat is timed once the audio a little past it has come.
    stage.step(now, BLOCK / fe, () => ({ beats: beats.filter((b) => b.p + 200 <= now), bph: w.bph, period: (2 * 3600 * fe) / w.bph }));
    if (stage.version !== before) reports.push({ t: now / fe, report: stage.report(false, false) });
    if (each) each(stage, now / fe);
  }
  return { stage, reports };
}

/**
 * What the whole-recording stage reads of the beats a report rests on.
 * @param {MadeUp} w
 * @param {SoundsReport} report
 * @param {number} liftAngle
 * @param {import('../js/dsp/amplitude.js').ReadOptions} [options]
 */
function whole(w, report, liftAngle, options = {}) {
  const [from, to] = /** @type {[number, number]} */ (report.window);
  const beats = w.beats.map((b) => {
    const keep = Array.from(b.t, (t, i) => i).filter((i) => b.t[i] >= from - 1e-9 && b.t[i] <= to + 1e-9);
    return { ...b, t: Float64Array.from(keep, (i) => b.t[i]), n: Float64Array.from(keep, (i) => b.n[i]), ok: new Uint8Array(keep.length).fill(1) };
  });
  return measureSounds(w.rows, fe, beats, w.bph, liftAngle, w.toPosition, options);
}

/**
 * Hold a report to the whole-recording reading of the same beats: the same numbers, to within
 * the rounding of a time turned into a position and back.
 * @param {SoundsReport} report
 * @param {ReturnType<typeof measureSounds>} s
 * @param {string} what
 */
function assertSameReading(report, s, what) {
  const d = report.detail;
  assert.ok(d && s.scatter && s.amplitude !== null && s.unlockGapMs !== null && s.liftMs && s.lining, what);
  assert.equal(d.why, s.why, what);
  assert.deepEqual(d.counts, s.counts, what);
  /** @param {number|null} a @param {number} b @param {string} name */
  const same = (a, b, name) => assert.ok(a !== null && Math.abs(a - b) < 1e-7, `${what}: ${name} ${a} against ${b}`);
  same(d.amplitude, s.amplitude, 'amplitude');
  same(d.amplitudeSd, s.scatter.amplitude, 'its scatter');
  same(d.beatOffsetMs, s.unlockGapMs, 'gap between the unlocks');
  same(d.beatErrorSd, s.scatter.unlockGapMs, 'its scatter');
  // The placement check's second reading, from the beats cut out on the trend when the reading
  // started: the difference it found, or none when the check was left out.
  if (s.placement && s.placement.differenceMs !== null && s.placement.amplitudeDifference !== null) {
    same(d.placementMs, s.placement.differenceMs, 'the difference with the beats on the trend');
    same(d.amplitudePlacement, s.placement.amplitudeDifference, 'the amplitude\'s difference with the beats on the trend');
  } else {
    assert.deepEqual([d.placementMs, d.amplitudePlacement], [null, null], what);
  }
  same(/** @type {[number, number]} */ (d.liftMs)[0], s.liftMs[0], 'tick unlock to lock');
  same(/** @type {[number, number]} */ (d.liftMs)[1], s.liftMs[1], 'tock unlock to lock');
  assert.equal(d.failing, s.failing, what);
  assert.equal(d.lining, s.lining.state, what);
}

test('the stage shows nothing until each beat type has 15 s of beats, then reads the last minute of them as the whole-recording stage would', () => {
  const w = madeUpWatch({ seconds: 80, gapMs: 0.4, seed: 21 });
  /** @type {{t: number, why: string|null}[]} */
  const early = [];
  const { stage, reports } = feed(w, {
    stage: { everySeconds: 20, fillingSeconds: 20 },
    each: (s, t) => {
      if (t < FIRST_READING_SECONDS - 0.5) early.push({ t, why: s.report(false, false).amplitudeWhy });
    },
  });
  assert.ok(early.length > 280 && early.every((e) => e.why === 'waiting'), 'waiting, and saying so, for the first 15 s');
  // A reading every 20 s, as set here, from the moment both types have their 15 s: four in 80 s.
  assert.equal(reports.length, 4);
  // The beats start 0.1 s in, and the stage looks four times a second.
  assert.ok(reports[0].t > FIRST_READING_SECONDS - 0.2 && reports[0].t < FIRST_READING_SECONDS + 0.4, `first reading at ${reports[0].t.toFixed(2)} s`);
  assert.deepEqual(reports.map((r) => Math.round(r.t - reports[0].t)), [0, 20, 40, 60]);
  for (const { t, report } of reports) {
    assert.ok(report.window && report.detail);
    assert.ok(report.amplitude !== null && report.beatErrorMs !== null && report.amplitudeWhy === null && report.beatErrorWhy === null, `shown at ${t.toFixed(1)} s`);
    assertSameReading(report, whole(w, report, 50), `at ${t.toFixed(1)} s`);
    // The made-up watch's truth: 0.4 ms between its unlocks, 7.4 ms from unlock to lock.
    assert.ok(Math.abs(/** @type {number} */ (report.beatOffsetMs) - 0.4) < 0.03, `beat error ${report.beatOffsetMs}`);
    assert.ok(report.liftMs && report.liftSd && report.liftMs.every((v) => Math.abs(v - 7.4) < 0.03), `unlock to lock ${report.liftMs}`);
    assert.equal(report.beatErrorMs, Math.abs(/** @type {number} */ (report.beatOffsetMs)));
    assert.ok(/** @type {number} */ (report.amplitudeSd) > 0 && /** @type {number} */ (report.beatErrorSd) > 0);
    // The placement check is made in real time too. This watch's beats fall anywhere within an
    // envelope sample, which the trend leaves out: the two readings differ by 0.01 ms at most.
    assert.ok(report.detail.placementMs !== null && Math.abs(report.detail.placementMs) < 0.01, `difference with the beats on the trend ${report.detail.placementMs}`);
    assert.ok(/** @type {number} */ (report.beatErrorSd) >= Math.abs(report.detail.placementMs));
    assert.ok(report.detail.amplitudePlacement !== null && Math.abs(report.detail.amplitudePlacement) < 0.3 && /** @type {number} */ (report.amplitudeSd) >= Math.abs(report.detail.amplitudePlacement), `amplitudes ${report.detail.amplitudePlacement} degrees apart`);
  }
  // The first reading rests on the 15 s since the start; the last on the minute before it, by
  // which time the envelopes kept have been moved up in their buffer more than once.
  const first = /** @type {[number, number]} */ (reports[0].report.window);
  const last = /** @type {[number, number]} */ (reports[3].report.window);
  assert.ok(first[0] < 0.3 && first[1] > FIRST_READING_SECONDS - 0.5 && first[1] < reports[0].t);
  assert.ok(last[1] - last[0] > STACK_SECONDS - 0.5 && last[1] - last[0] <= STACK_SECONDS, `the last reading spans ${(last[1] - last[0]).toFixed(1)} s`);
  assert.ok(stage.base > 0, 'the envelopes from the start are gone');
  const load = stage.load();
  assert.equal(load.readings, 4);
  assert.ok(load.seconds > 0 && load.lastSeconds !== null && load.lastSeconds > 0 && load.lastAudioSeconds === 0, 'each reading was finished in the block it started in');
});

test('a reading worked out a few steps at a time, while the audio goes on, is the reading worked out at once, and so is one finished where the audio ends', () => {
  const w = madeUpWatch({ seconds: 45, gapMs: -0.3, liftMs: (t) => 7.2 + 0.02 * t, seed: 22 });
  // Every sound lined up again and fewer draws: the costliest steps there are, in less time. A
  // first reading at 30 s of beats, as before 27 November 2026, gives each reading at least three
  // blocks of beats to line up; how a reading is spread does not depend on it.
  const reading = /** @type {import('../js/dsp/amplitude.js').ReadOptions} */ ({ lineUp: 'always', resamples: 30 });
  const atOnce = feed(w, { stage: { reading, firstSeconds: 30 } });
  // A clock that the test keeps: each block of audio is 42.7 ms, and every look at the clock
  // comes a millisecond after the last, so every step of a reading takes a millisecond.
  let ms = 0;
  let blocks = 0;
  let working = 0;
  const spread = feed(w, {
    stage: { reading, firstSeconds: 30, share: 0.5, clock: () => ++ms },
    tick: () => {
      ms += (1e3 * BLOCK) / fe;
      blocks++;
    },
    each: (stage) => {
      if (stage.job) working++;
    },
  });
  assert.equal(atOnce.reports.length, 3, 'readings 5 s apart from 30 s on');
  assert.equal(spread.reports.length, 3, 'as many when spread out: each is done within its 5 s');
  for (let i = 0; i < 3; i++) {
    const a = atOnce.reports[i].report;
    const b = spread.reports[i].report;
    assert.ok(a.detail && b.detail);
    // The same beats, cut out of the envelopes when the reading started.
    assert.deepEqual(b.window, a.window);
    const { computeSeconds: c1, audioSeconds: a1, ...one } = a.detail;
    const { computeSeconds: c2, audioSeconds: a2, ...other } = b.detail;
    assert.deepEqual(other, one, 'the same reading to the last digit');
    assert.equal(a1, 0);
    assert.ok(a2 > 0.3 && a2 < 3, `spread over ${a2.toFixed(2)} s of audio`);
    assert.ok(c1 > 0 && c2 > 0);
    assert.ok(spread.reports[i].t > atOnce.reports[i].t, 'and reported later');
    assert.equal(b.detail.lining, 'lined');
  }
  assert.ok(working > 20, `a reading was in progress during ${working} of ${blocks} blocks`);
  // Half the time by that clock: no step came with less than a block's share of time in hand,
  // so no block had more than its share and one step over.
  const load = spread.stage.load();
  assert.equal(load.longestStepSeconds, 1e-3);
  assert.ok(load.seconds < 0.5 * (ms / 1e3), `${load.seconds.toFixed(2)} s of computing in ${(ms / 1e3).toFixed(1)} s`);

  // The audio ends 1.5 s after the first reading starts, by a clock on which every step takes a
  // second: the reading has hardly begun. Finished there, it is the first reading worked out at
  // once, from the same beats.
  const first = atOnce.reports[0];
  const cut = Math.round(first.t * fe) + BLOCK * Math.round((1.5 * fe) / BLOCK);
  let slow = 0;
  const ended = feed(
    { ...w, rows: w.rows.map((row) => row.subarray(0, cut)) },
    {
      stage: { reading, firstSeconds: 30, share: 0.5, clock: () => (slow += 1e3) },
      tick: () => {
        slow += (1e3 * BLOCK) / fe;
      },
    },
  );
  assert.equal(ended.reports.length, 0, 'nothing is shown while the reading is in progress');
  assert.ok(ended.stage.job, 'and it is in progress where the audio ends');
  ended.stage.finish(cut);
  assert.equal(ended.stage.job, null);
  const finished = ended.stage.report(false, false);
  assert.ok(first.report.detail && finished.detail);
  assert.deepEqual(finished.window, first.report.window);
  const { computeSeconds: c0, audioSeconds: a0, ...one } = first.report.detail;
  const { computeSeconds: c3, audioSeconds: a3, ...last } = finished.detail;
  assert.deepEqual(last, one, 'the same reading to the last digit');
  assert.ok(c0 > 0 && c3 > 0 && a0 === 0);
  assert.ok(Math.abs(a3 - 1.5) < 0.05, `finished ${a3.toFixed(2)} s of audio after it started`);
  // Nothing is left to finish then, and no reading is started for it.
  const version = ended.stage.version;
  ended.stage.finish(cut);
  assert.equal(ended.stage.version, version);
  assert.equal(ended.stage.job, null);
});

test('only beats heard since the lock appeared are read, unless the stage is told otherwise, and a beat type that was never timed is not waited for', () => {
  const w = madeUpWatch({ seconds: 47, seed: 23 });
  const reading = { resamples: 20 };
  // The lock appears at 10 s: the beats before it were found in the audio the lock was found in.
  const since = feed(w, { since: 10, stage: { reading } });
  assert.ok(since.reports.length >= 1);
  // The first tick and the first tock after the lock come up to a beat later.
  assert.ok(since.reports[0].t > 10 + FIRST_READING_SECONDS - 0.2 && since.reports[0].t < 10 + FIRST_READING_SECONDS + 0.75, `first reading at ${since.reports[0].t.toFixed(2)} s`);
  assert.ok(since.reports.every((r) => r.report.window && r.report.window[0] >= 10 && r.report.window[0] < 10.2));
  // Told also to leave the placement check out, as the stage was before it had one.
  const all = feed(w, { since: 10, stage: { reading: { ...reading, placementCheck: false }, sinceLock: false } });
  assert.ok(all.reports[0].t > FIRST_READING_SECONDS - 0.2 && all.reports[0].t < FIRST_READING_SECONDS + 0.4, `with the earlier beats, at ${all.reports[0].t.toFixed(2)} s`);
  assert.ok(all.reports[0].report.window && all.reports[0].report.window[0] < 0.3);
  assert.ok(since.reports[0].report.detail && since.reports[0].report.detail.placementMs !== null);
  for (const { t, report } of all.reports) assertSameReading(report, whole(w, report, 50, { ...reading, placementCheck: false }), `without the check, at ${t.toFixed(1)} s`);
  // Only the ticks timed: 5 s after the reading would have come, the stage stops waiting.
  /** @type {{t: number, why: string|null}[]} */
  const whys = [];
  const ticksOnly = feed(w, { types: [0], stage: { reading }, each: (s, t) => whys.push({ t, why: s.report(false, false).amplitudeWhy }) });
  assert.equal(ticksOnly.reports.length, 0);
  assert.ok(whys.filter((x) => x.t < FIRST_READING_SECONDS + 5).every((x) => x.why === 'waiting'));
  assert.ok(whys.filter((x) => x.t > FIRST_READING_SECONDS + 6.5).every((x) => x.why === 'few-beats'));
});

test('a lost lock, timestamps that average several cycles and a new lift angle each blank what was read; a new lift angle is read at once', () => {
  const w = madeUpWatch({ seconds: 44, seed: 24 });
  /** @type {Record<string, SoundsReport>} */
  const seen = {};
  let stopped = false;
  const { stage } = feed(w, {
    stage: { reading: { resamples: 20 } },
    each: (s, t) => {
      if (t > 31 && !seen.read) seen.read = s.report(false, false);
      if (t > 32 && !seen.averaged) {
        // The pipeline's timestamps start to average several cycles each.
        s.averaged();
        seen.averaged = s.report(false, false);
      }
      if (t > 33 && !seen.again) seen.again = s.report(false, false);
      if (t > 34 && !seen.dropped) {
        s.setLiftAngle(44);
        seen.dropped = s.report(false, false);
      }
      if (t > 34.1 && !seen.newAngle) seen.newAngle = s.report(false, false);
      if (t > 36 && !stopped) {
        stopped = true;
        // The lock is lost, and a new one appears at once.
        s.reset(Math.round(t * fe));
        seen.lost = s.report(false, false);
      }
      if (t > 43) seen.late = s.report(false, false);
    },
  });
  assert.ok(seen.read.amplitude !== null && seen.read.liftAngle === 50);
  assert.deepEqual([seen.averaged.amplitude, seen.averaged.beatErrorMs, seen.averaged.amplitudeWhy, seen.averaged.beatErrorWhy, seen.averaged.detail], [null, null, 'averaged', 'averaged', null]);
  // Timed beat by beat again, the next block starts a reading.
  assert.ok(seen.again.amplitude !== null, 'read again once the beats are timed alone');
  assert.deepEqual([seen.dropped.amplitude, seen.dropped.amplitudeWhy, seen.dropped.liftAngle], [null, 'waiting', 44]);
  assert.ok(seen.newAngle.amplitude !== null && seen.read.amplitude !== null && seen.newAngle.liftAngle === 44);
  // The same time from unlock to lock at a smaller lift angle is a smaller swing, by their ratio.
  assert.ok(Math.abs(seen.newAngle.amplitude / seen.read.amplitude - 44 / 50) < 0.01, `${seen.newAngle.amplitude} after ${seen.read.amplitude}`);
  assert.deepEqual([seen.lost.amplitude, seen.lost.amplitudeWhy, seen.lost.window], [null, 'waiting', null]);
  assert.deepEqual([seen.late.amplitude, seen.late.amplitudeWhy], [null, 'waiting'], 'the new lock is 8 s old: nothing yet');
  assert.equal(stage.job, null);
});

test('what the pipeline knows of the watch is applied when a reading is reported: an irregular watch keeps its amplitude, a beat halfway holds both back and takes the marks away', () => {
  const w = madeUpWatch({ seconds: FIRST_READING_SECONDS + 1.5, gapMs: 0.25, seed: 25 });
  const { stage, reports } = feed(w, { stage: { reading: { resamples: 20 } } });
  assert.equal(reports.length, 1);
  const plain = stage.report(false, false);
  assert.ok(plain.amplitude !== null && plain.beatErrorMs !== null && plain.liftMs);
  const irregular = stage.report(true, false);
  assert.deepEqual([irregular.beatErrorMs, irregular.beatOffsetMs, irregular.beatErrorSd, irregular.beatErrorWhy], [null, null, null, 'irregular']);
  assert.deepEqual([irregular.amplitude, irregular.amplitudeWhy], [plain.amplitude, null]);
  const halfway = stage.report(false, true);
  assert.deepEqual([halfway.amplitude, halfway.amplitudeWhy, halfway.beatErrorMs, halfway.beatErrorWhy, halfway.liftMs], [null, 'halfway', null, 'halfway', null]);
  // What was read is still told, for the diagnostics.
  assert.ok(halfway.detail && halfway.detail.amplitude === plain.amplitude);
  // The marks: where the unlock and the lock start in each beat, the lock just before the
  // timestamp and the unlock 7.4 ms before the lock.
  const marks = stage.marks(false);
  assert.ok(marks);
  for (const j of [0, 1]) {
    assert.ok(Math.abs(marks[j].lockMs - marks[j].unlockMs - plain.liftMs[j]) < 1e-9);
    assert.ok(marks[j].lockMs > -0.4 && marks[j].lockMs < 0, `the lock starts ${marks[j].lockMs.toFixed(2)} ms from the timestamp`);
  }
  assert.equal(stage.marks(true), null);
});

// ---- Inside the pipeline -----------------------------------------------------------------------

/**
 * @typedef {import('../js/dsp/pipeline.js').PipelineEvent} PipelineEvent
 * @typedef {import('../js/dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 * @typedef {import('../js/dsp/pipeline.js').WaveformEvent} WaveformEvent
 */

/** A simulated lever 0.5 ms out of beat at 270 degrees, 46 s of it, made once. */
let leverMade = /** @type {ReturnType<typeof synthesizeBalanceWatch>|null} */ (null);
const lever = () => (leverMade ??= synthesizeBalanceWatch(leverWatch({ restOffsetDeg: 1.7, seconds: 46, seed: 61 })));

/** Where the lift angle is changed from 50 to 44 degrees: at 41.98 s, the end of a chunk of either size. */
const CHANGE_AT = 4096 * 492;

/** @type {Map<string, {events: PipelineEvent[], pipeline: Pipeline}>} */
const leverRuns = new Map();
/**
 * The pipeline that has heard the lever, fed in chunks, and everything it reported. With the
 * stage, each reading is finished in the block it starts in, and the lift angle changes at
 * CHANGE_AT.
 * @param {number} chunk
 * @param {boolean} stage
 */
function leverRun(chunk, stage) {
  const key = `${chunk} ${stage}`;
  let run = leverRuns.get(key);
  if (!run) {
    const w = lever();
    const pipeline = new Pipeline(w.sampleRate, 1, stage ? { bph: 28800, liftAngle: 50, sounds: { share: Infinity } } : { bph: 28800 });
    /** @type {PipelineEvent[]} */
    const events = [];
    const c = w.channels[0];
    for (let i = 0; i < c.length; i += chunk) {
      if (stage && i === CHANGE_AT) {
        pipeline.setOptions({ liftAngle: 44 });
        // What a change of settings brings is reported with the next audio.
      }
      events.push(...pipeline.push([c.subarray(i, Math.min(c.length, i + chunk))]));
    }
    run = { events, pipeline };
    leverRuns.set(key, run);
  }
  return run;
}

/**
 * Everything the pipeline reports for the lever while its audio comes.
 * @param {number} chunk
 * @param {boolean} stage
 */
const leverEvents = (chunk, stage) => leverRun(chunk, stage).events;

/**
 * Events without the time their readings took to compute, which is the computer's own.
 * @param {PipelineEvent[]} events
 */
const withoutTimings = (events) => events.map((e) => (e.type === 'readings' && e.sounds && e.sounds.detail ? { ...e, sounds: { ...e.sounds, detail: { ...e.sounds.detail, computeSeconds: 0 } } } : e));

test('in the pipeline, a simulated lever shows nothing for 15 s after the lock, then its beat error from the unlocks and its amplitude, right within 0.03 ms and 1 degree', () => {
  const events = leverEvents(4096, true);
  const truth = lever().truth;
  const lockEvent = events.find((e) => e.type === 'status');
  assert.ok(lockEvent && lockEvent.type === 'status' && lockEvent.state === 'tracking' && lockEvent.t < 10);
  const lock = lockEvent.t;
  const readings = /** @type {ReadingsEvent[]} */ (events.filter((e) => e.type === 'readings' && e.t < CHANGE_AT / 48000));
  assert.ok(readings.every((e) => e.sounds !== null && e.sounds.liftAngle === 50));
  const early = readings.filter((e) => e.t < lock + FIRST_READING_SECONDS - 0.5);
  assert.ok(early.length > 12 && early.every((e) => e.sounds && e.sounds.amplitude === null && e.sounds.beatErrorMs === null && e.sounds.amplitudeWhy === 'waiting' && e.sounds.detail === null), 'a dash, and why, until the lock is 15 s old');
  const first = readings.find((e) => e.sounds && e.sounds.detail !== null);
  assert.ok(first && first.sounds && first.sounds.window && first.t > lock + FIRST_READING_SECONDS - 0.5 && first.t < lock + FIRST_READING_SECONDS + 1.5, `first reading at ${first?.t.toFixed(1)} s, locked at ${lock.toFixed(1)} s`);
  // Only beats heard since the lock appeared, as the six-position log needs: the beats of the
  // 8 s the lock was found in are not read.
  assert.ok(first.sounds.window[0] >= lock && first.sounds.window[0] < lock + 0.3, `beats from ${first.sounds.window[0].toFixed(2)} s`);
  const shown = readings.filter((e) => e.sounds && e.sounds.detail !== null);
  assert.ok(shown.length >= 3);
  for (const e of shown) {
    const s = /** @type {NonNullable<ReadingsEvent['sounds']>} */ (e.sounds);
    assert.ok(s.amplitude !== null && s.beatErrorMs !== null && s.beatErrorSd !== null && s.amplitudeSd !== null && s.liftMs && s.detail, `shown at ${e.t.toFixed(1)} s`);
    // The pipeline calls either beat the tick, so the gap's sign is its own.
    assert.ok(Math.abs(s.beatErrorMs - Math.abs(truth.unlockGapMs)) <= 0.03, `beat error ${s.beatErrorMs.toFixed(4)} ms, truly ${Math.abs(truth.unlockGapMs).toFixed(4)}`);
    assert.ok(Math.abs(s.amplitude - truth.meanAmplitude) <= 1, `amplitude ${s.amplitude.toFixed(2)}, truly ${truth.meanAmplitude.toFixed(2)}`);
    assert.ok(s.beatErrorSd < 0.03 && s.amplitudeSd < 1, `+-${s.beatErrorSd.toFixed(3)} ms and +-${s.amplitudeSd.toFixed(2)} degrees`);
    assert.equal(s.detail.lining, 'steady');
    // The readings from the timestamps go on beside it: the loudest sounds are 0.5 ms out too.
    assert.ok(e.beatErrorMs !== null && Math.abs(e.beatErrorMs - 0.5) < 0.05);
  }
});

test('in the pipeline, the marks on the averaged beat come with the amplitude and follow it, and a new lift angle is read at once', () => {
  const events = leverEvents(4096, true);
  const waves = /** @type {WaveformEvent[]} */ (events.filter((e) => e.type === 'waveform'));
  const firstReading = /** @type {ReadingsEvent} */ (events.find((e) => e.type === 'readings' && e.sounds !== null && e.sounds.detail !== null));
  assert.ok(waves.filter((w) => w.t < firstReading.t - 1.1).every((w) => w.marks === null), 'no marks before there is an amplitude');
  // The reading brings a waveform event of its own, in the same block of audio.
  const marked = waves.find((w) => w.marks !== null);
  assert.ok(marked && marked.marks && marked.t <= firstReading.t && marked.t > firstReading.t - 1.1, `marks at ${marked?.t.toFixed(2)} s, reading reported at ${firstReading.t.toFixed(2)} s`);
  const lifts = /** @type {[number, number]} */ (/** @type {NonNullable<ReadingsEvent['sounds']>} */ (firstReading.sounds).liftMs);
  for (const j of [0, 1]) {
    assert.ok(Math.abs(marked.marks[j].lockMs - marked.marks[j].unlockMs - lifts[j]) < 1e-9, 'from the unlock mark to the lock mark is the time the amplitude rests on');
    // The timestamp follows the drop, the loudest sound, which starts at the lock.
    assert.ok(Math.abs(marked.marks[j].lockMs) < 0.5 && marked.marks[j].unlockMs > marked.from * 1e3, `unlock ${marked.marks[j].unlockMs.toFixed(2)} ms, lock ${marked.marks[j].lockMs.toFixed(2)} ms`);
  }
  // The lift angle goes from 50 to 44 degrees: the same beats are read again in the next block.
  const changeT = CHANGE_AT / 48000;
  const before = /** @type {ReadingsEvent[]} */ (events.filter((e) => e.type === 'readings' && e.t < changeT)).pop();
  const after = /** @type {ReadingsEvent|undefined} */ (events.find((e) => e.type === 'readings' && e.t > changeT));
  assert.ok(before && before.sounds && before.sounds.amplitude !== null && after && after.sounds && after.sounds.amplitude !== null && after.sounds.window);
  assert.equal(after.sounds.liftAngle, 44);
  assert.ok(after.t < changeT + 1.1 && after.sounds.window[1] > changeT - 0.5, 'read from the beats up to the change');
  assert.ok(Math.abs(after.sounds.amplitude / before.sounds.amplitude - 44 / 50) < 0.005, `${after.sounds.amplitude.toFixed(2)} after ${before.sounds.amplitude.toFixed(2)}`);
  // The marks went with the old reading and came back with the new one.
  const around = waves.filter((w) => w.t > changeT - 0.05 && w.t < changeT + 0.2);
  assert.ok(around.length >= 2 && around[0].marks === null && around[around.length - 1].marks !== null, `${around.length} waveform events at the change`);
});

test('on the screen, that lever is named at the lock by the longer gap after its tick; amplitude and beat error show a dash and why for 15 s, then the watch\'s own within 1 degree and 0.03 ms; the six-position log keeps both, with Save ready 5 s after they come', () => {
  const events = leverEvents(4096, true);
  const truth = lever().truth;
  const changeT = CHANGE_AT / 48000;
  const m = new Measurement();
  m.start();
  /** @type {{reading: ReadingsEvent, words: ReturnType<typeof soundsReadout>, ready: boolean, names: (string|null)[]}[]} */
  const seen = [];
  for (const e of events) {
    if (e.type !== 'beats' && e.t >= changeT) break;
    m.apply(e);
    if (e.type !== 'readings' || e.window === null) continue;
    seen.push({ reading: e, words: soundsReadout(m.state === 'tracking', m.readings, 50), ready: readiness(true, e, 20, m.lockSince).ready, names: [...new Set(m.points().map((p) => p.name))] });
  }
  const lock = /** @type {number} */ (m.lockSince);
  // The names: with the first reading, and every dot of the trace then has one. The simulated
  // odd beats lock 0.5 ms from midway between the even ones; the tick is the beat the longer
  // gap follows.
  const tick = seen[0].reading.tick;
  assert.ok(tick !== null && seen.every((x) => x.reading.tick === tick), 'named at the lock, and kept');
  assert.ok(seen.every((x) => x.names.length === 2 && x.names.includes('tick') && x.names.includes('tock')), 'no dot without a name');
  assert.ok(Math.abs(Math.abs(truth.lockGapMs) - 0.5) < 0.01);
  assert.equal(parityOf(m.episodes[0].beats, truth.lock, tick), truth.lockGapMs > 0 ? 0 : 1, 'the beat followed by the longer gap');
  // The readout: a dash and the reason until the first reading of the sounds, 15 s after the lock.
  const firstShown = seen.findIndex((x) => x.words.amplitude !== '—');
  assert.ok(firstShown > 12 && seen[firstShown].reading.t > lock + FIRST_READING_SECONDS - 0.5 && seen[firstShown].reading.t < lock + FIRST_READING_SECONDS + 1.5);
  for (const x of seen.slice(0, firstShown)) assert.deepEqual(x.words, { amplitude: '—', amplitudeNote: 'needs 15 s of beats', beatError: '—', beatErrorNote: 'needs 15 s of beats' });
  // Then both, in the digits the screen gives, with their scatter and the beats they rest on.
  for (const x of seen.slice(firstShown)) {
    assert.ok(Math.abs(Number(x.words.amplitude) - truth.meanAmplitude) <= 1, `amplitude ${x.words.amplitude}, truly ${truth.meanAmplitude.toFixed(1)}`);
    assert.ok(Math.abs(Number(x.words.beatError) - Math.abs(truth.unlockGapMs)) <= 0.03, `beat error ${x.words.beatError} ms, truly ${Math.abs(truth.unlockGapMs).toFixed(3)}`);
    assert.match(x.words.amplitudeNote, /^±0\.\d° over [1-3]\d s$/);
    assert.match(x.words.beatErrorNote, /^±0\.0[1-3] over [1-3]\d s$/);
  }
  // After the run, a lift angle set to 52 degrees leaves a dash for the amplitude made at 50.
  const last = seen[seen.length - 1];
  const changed = soundsReadout(true, last.reading, 52, false);
  assert.deepEqual([changed.amplitude, changed.amplitudeNote, changed.beatError], ['—', 'lift angle changed', last.words.beatError]);

  // The six-position log. Save is ready 20 s after the lock, 5 s after the sounds are read
  // since 27 November 2026, when the first reading came 10 s after Save was ready: the line says
  // nothing more is to come, and a position saved then keeps both. One saved before the
  // readings come keeps a dash for both (tests/positions.test.js).
  const firstReady = seen.findIndex((x) => x.ready);
  assert.ok(firstReady > firstShown && seen[firstReady].reading.t < lock + 21);
  const context = { bph: 28800, escapement: /** @type {const} */ ('lever'), source: 'Simulator', now: new Date('2026-11-26T12:00:00Z') };
  const sounds = /** @type {NonNullable<ReadingsEvent['sounds']>} */ (seen[firstReady].reading.sounds);
  assert.equal(positionStep({ target: 'dialUp', saved: null, running: true, tracking: true, covered: 20, needed: 20, ready: true, rateSd: seen[firstReady].reading.rateSd, waiting: sounds.amplitudeWhy === 'waiting' }), 'Ready to save as Dial up.');
  const early = takeReading(seen[firstReady].reading, context);
  assert.ok(early && early.beatErrorMs !== null && early.amplitude !== null);
  assert.deepEqual([early.beatErrorGap, early.amplitudeGap, early.liftAngle], [null, null, 50]);
  // Saved once they are on the screen, the position keeps both as they were shown.
  const late = takeReading(last.reading, context);
  assert.ok(late && late.beatErrorMs !== null && late.beatErrorSd !== null && late.amplitude !== null && late.amplitudeSd !== null);
  assert.ok(Math.abs(late.beatErrorMs - Math.abs(truth.unlockGapMs)) <= 0.03 && Math.abs(late.amplitude - truth.meanAmplitude) <= 1);
  assert.deepEqual([late.beatErrorGap, late.amplitudeGap, late.liftAngle], [null, null, 50]);
  assert.equal(describeReading(late).main.split(' · ').slice(1).join(' · '), `${last.words.beatError} ms · ${last.words.amplitude}°`);
  // A position saved a moment before the readings came keeps a dash for both, and the summary
  // takes its largest beat error and its median amplitude from the position that has them.
  const dashed = takeReading(seen[firstShown - 1].reading, context);
  assert.ok(dashed);
  assert.deepEqual([dashed.beatErrorMs, dashed.beatErrorGap, dashed.amplitude, dashed.amplitudeGap], [null, 'waiting', null, 'waiting']);
  assert.match(describeReading(dashed).detail, / · no beat error or amplitude: saved before 15 s of beats$/);
  const log = withReading(withReading(emptyLog(), 'dialUp', dashed), 'dialDown', late);
  const summary = describeSummary(summarise(log));
  assert.deepEqual([summary.beatError, summary.beatErrorNote, summary.amplitude, summary.amplitudeNote], [`${last.words.beatError} ms`, 'Dial down', `${last.words.amplitude}°`, 'of 1 position']);

  // The lift angle is then set to 44 degrees while the run goes on: the next reading is made
  // with it and shown with it, 44/50 of the amplitude before.
  const after = /** @type {ReadingsEvent} */ (events.find((e) => e.type === 'readings' && e.t > changeT));
  const at44 = soundsReadout(true, after, 44);
  assert.ok(Math.abs(Number(at44.amplitude) - (truth.meanAmplitude * 44) / 50) <= 1, `at 44 degrees ${at44.amplitude}`);
  assert.equal(soundsReadout(true, after, 50).amplitudeNote, 'lift angle changed', 'and not shown as if made at 50');
});

test('where the audio ends, the pipeline finishes the reading in progress and reports it once, with its marks, and reports one finished since the readings last went out; with nothing new it reports nothing', () => {
  const { events, pipeline } = leverRun(4096, true);
  const shown = /** @type {ReadingsEvent[]} */ (events.filter((e) => e.type === 'readings' && e.sounds !== null && e.sounds.amplitude !== null));
  const before = /** @type {NonNullable<ReadingsEvent['sounds']>} */ (shown[shown.length - 1].sounds);
  // Every reading of this run was finished in the block it started in and has gone out with
  // the readings since, so nothing is left.
  assert.deepEqual(pipeline.finish(), []);
  // One more is started on the beats heard by the end, with a clock by which every step takes a
  // second, so that it has hardly begun.
  const stage = /** @type {SoundStage} */ (pipeline.sounds);
  let ms = 0;
  stage.share = 0.5;
  stage.clock = () => (ms += 1e3);
  stage.nextAt = 0;
  pipeline.stepSounds(stage, /** @type {NonNullable<Pipeline['lock']>} */ (pipeline.lock));
  assert.ok(stage.job, 'a reading in progress');
  const last = pipeline.finish();
  assert.deepEqual(last.map((e) => e.type), ['waveform', 'readings']);
  const [wave, readings] = /** @type {[WaveformEvent, ReadingsEvent]} */ (last);
  const s = readings.sounds;
  assert.ok(s && s.window && before.window && s.amplitude !== null && s.beatErrorMs !== null && before.amplitude !== null && before.beatErrorMs !== null);
  assert.equal(s.liftAngle, 44);
  assert.ok(s.window[1] > before.window[1] + 3 && s.window[1] > 45, `read from the beats up to ${s.window[1].toFixed(1)} s, where the last reading before had them up to ${before.window[1].toFixed(1)} s`);
  assert.ok(Math.abs(s.amplitude - before.amplitude) < 1 && Math.abs(s.beatErrorMs - before.beatErrorMs) < 0.03, `${s.amplitude.toFixed(1)} degrees and ${s.beatErrorMs.toFixed(3)} ms after ${before.amplitude.toFixed(1)} and ${before.beatErrorMs.toFixed(3)}`);
  assert.ok(wave.marks && s.liftMs && Math.abs(wave.marks[0].lockMs - wave.marks[0].unlockMs - s.liftMs[0]) < 1e-9, 'the marks are the new reading\'s');
  assert.equal(readings.t, wave.t);
  // Once: nothing is left, and nothing was started.
  assert.equal(stage.job, null);
  assert.deepEqual(pipeline.finish(), []);
  // The same beats read again and finished in their own block, as within the second before the
  // audio ends: the marks have been reported, and the readings have not gone out since.
  stage.share = Infinity;
  stage.nextAt = 0;
  pipeline.stepSounds(stage, /** @type {NonNullable<Pipeline['lock']>} */ (pipeline.lock));
  assert.equal(stage.job, null);
  const late = pipeline.finish();
  assert.deepEqual(late.map((e) => e.type), ['waveform', 'readings']);
  const again = /** @type {ReadingsEvent} */ (late[1]).sounds;
  assert.ok(again && again.detail && s.detail);
  assert.deepEqual(again.window, s.window);
  assert.equal(again.amplitude, s.amplitude);
  assert.equal(again.beatErrorMs, s.beatErrorMs);
  assert.deepEqual(pipeline.finish(), []);
});

test('in the pipeline, the stage\'s readings do not depend on how the audio is cut into chunks, and timestamps, rate and beat error are the same with the stage as without', () => {
  const big = withoutTimings(leverEvents(4096, true));
  const small = withoutTimings(leverEvents(1024, true));
  assert.equal(small.length, big.length);
  assert.deepEqual(small, big);
  const none = leverEvents(4096, false);
  /** @param {PipelineEvent[]} events */
  const apartFromTheStage = (events) => events.filter((e) => e.type === 'beats' || e.type === 'status' || e.type === 'readings').map((e) => (e.type === 'readings' ? { ...e, sounds: null } : e));
  assert.ok(none.every((e) => e.type !== 'readings' || e.sounds === null), 'no lift angle, no stage');
  assert.deepEqual(apartFromTheStage(big), apartFromTheStage(none));
  // Without the stage a waveform event comes with each analysis only, and carries no marks.
  assert.ok(none.filter((e) => e.type === 'waveform').every((e) => e.type === 'waveform' && e.marks === null));
});
