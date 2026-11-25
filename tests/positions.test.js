// Milestone 7: the six-position log and the choice between it and continuous measuring. A
// reading may be saved only once the lock has lasted the whole averaging window; saved readings
// keep what the pipeline measured; the summary's average and spread come from the readings that
// are certain enough, and the log survives being stored. Drawing and tapping are checked in a
// browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeWatch } from '../js/audio/simulator.js';
import {
  POSITIONS,
  MAX_RATE_SD,
  emptyLog,
  readiness,
  takeReading,
  withReading,
  nextPosition,
  summarise,
  describeReading,
  describeSummary,
  positionStep,
  cleanLog,
  isUncertain,
} from '../js/ui/positions.js';
import { clean, DEFAULTS, loadLog } from '../js/store.js';
import { stream } from './helpers/stream.js';

/**
 * @typedef {import('../js/dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 * @typedef {import('../js/ui/positions.js').PositionReading} PositionReading
 * @typedef {import('../js/ui/positions.js').PositionId} PositionId
 */

/**
 * Two positions of one watch, simulated as two runs whose rates differ as a watch's do between
 * dial up and crown down. Each run is 24 s, long enough for a full 20 s window after the lock.
 */
const positionRuns = (() => {
  /** @type {Map<string, ReturnType<typeof stream>>} */
  const memo = new Map();
  /** @param {{rate: number, seed: number}} watch */
  return (watch) => {
    const key = `${watch.rate}/${watch.seed}`;
    let r = memo.get(key);
    if (!r) {
      const w = synthesizeWatch({ bph: 28800, rate: watch.rate, beatOffsetMs: 0.3, gain: 1.4, seconds: 24, seed: watch.seed });
      r = stream(w.channels, w.sampleRate, { chunk: 1024 });
      memo.set(key, r);
    }
    return r;
  };
})();
const DIAL_UP = { rate: 4, seed: 701 };
const CROWN_DOWN = { rate: -3, seed: 702 };

/**
 * A made-up reading with the given rate and uncertainty, for the arithmetic of the summary.
 * @param {number} rate
 * @param {number} rateSd
 * @param {number|null} beatErrorMs
 * @param {Partial<PositionReading>} [more]
 * @returns {PositionReading}
 */
function reading(rate, rateSd, beatErrorMs, more = {}) {
  return {
    rate,
    rateSd,
    beatErrorMs,
    beatErrorGap: beatErrorMs === null ? 'unmeasured' : null,
    irregular: false,
    beats: 160,
    windowSeconds: 20,
    seconds: 19.9,
    bph: 28800,
    escapement: 'lever',
    source: 'Microphone',
    savedAt: '2026-11-25T12:00:00.000Z',
    ...more,
  };
}

test('a reading can be saved only once the lock has lasted the whole averaging window', () => {
  const r = positionRuns(DIAL_UP);
  assert.ok(r.status.length && r.status[0].state === 'tracking', 'locked');
  const locked = r.readings.filter((e) => e.window !== null);
  const states = locked.map((e) => ({ e, ...readiness(true, e, 20) }));
  const first = states.findIndex((s) => s.ready);
  assert.ok(first > 0, 'not ready at the lock, ready later');
  // Before: every reading drew on less than 20 s of audio since the lock began.
  for (const s of states.slice(0, first)) assert.ok(s.covered < 20 && !s.ready);
  // From then on every reading covers the full window, and its timestamps span almost all of it.
  for (const s of states.slice(first)) {
    assert.ok(s.ready, `ready at ${s.e.t.toFixed(1)} s`);
    assert.equal(s.needed, 20);
    const [from, to] = /** @type {[number, number]} */ (s.e.window);
    assert.ok(to - from > 19.5, `timestamps span ${(to - from).toFixed(2)} s`);
  }
  // The lock covers the audio from its start, so the window is full 20 s into the recording.
  const at = states[first].e.t;
  assert.ok(at >= 19.9 && at <= 21, `first ready at ${at.toFixed(2)} s`);
  // Not tracking, or no readings: never ready.
  assert.equal(readiness(false, states[first].e, 20).ready, false);
  assert.equal(readiness(true, null, 20).ready, false);
});

test('a saved reading keeps the rate, its uncertainty, the beat error and the beats behind them, as measured', () => {
  const r = positionRuns(DIAL_UP);
  const last = /** @type {ReadingsEvent} */ (r.last);
  const saved = takeReading(last, { bph: 28800, escapement: 'lever', source: 'Simulator', now: new Date('2026-11-25T12:00:00Z') });
  assert.ok(saved);
  assert.equal(saved.rate, last.rate);
  assert.equal(saved.rateSd, last.rateSd);
  assert.ok(Math.abs(saved.rate - DIAL_UP.rate) <= 3 * saved.rateSd + 0.05, `rate ${saved.rate.toFixed(2)} ± ${saved.rateSd.toFixed(2)}, true ${DIAL_UP.rate}`);
  assert.ok(saved.beatErrorMs !== null && Math.abs(saved.beatErrorMs - 0.3) <= 0.05, `beat error ${saved.beatErrorMs}`);
  assert.equal(saved.beatErrorGap, null);
  // 28,800 vph is 8 beats a second: about 160 in a 20 s window, ticks and tocks together.
  assert.ok(saved.beats >= 150 && saved.beats <= 162, `${saved.beats} beats`);
  assert.equal(saved.windowSeconds, 20, 'made over the 20 s window');
  assert.ok(saved.seconds > 19.5 && saved.seconds <= 20, `timestamps span ${saved.seconds} s`);
  assert.match(describeReading(saved).detail, /^Over a 20 s window · \d+ beats$/);
  assert.equal(saved.savedAt, '2026-11-25T12:00:00.000Z');
  // The same reading on a watch set as co-axial says why it has no beat error once the
  // pipeline leaves it out.
  const coaxial = takeReading({ ...last, beatErrorMs: null }, { bph: 28800, escapement: 'coaxial', source: 'Microphone', now: new Date() });
  assert.equal(coaxial && coaxial.beatErrorGap, 'coaxial');
  const irregular = takeReading({ ...last, beatErrorMs: null, irregular: true }, { bph: 28800, escapement: 'lever', source: 'Microphone', now: new Date() });
  assert.equal(irregular && irregular.beatErrorGap, 'irregular');
  assert.equal(takeReading({ ...last, rate: null }, { bph: 28800, escapement: 'lever', source: 'x', now: new Date() }), null);
});

test('two positions measured from simulated watches give the average and spread of their true rates, within the readings\' uncertainty', () => {
  let log = emptyLog();
  for (const [id, watch] of /** @type {[PositionId, typeof DIAL_UP][]} */ ([
    ['dialUp', DIAL_UP],
    ['crownDown', CROWN_DOWN],
  ])) {
    const r = positionRuns(watch);
    const last = /** @type {ReadingsEvent} */ (r.last);
    assert.ok(readiness(true, last, 20).ready);
    const saved = takeReading(last, { bph: 28800, escapement: 'lever', source: 'Simulator', now: new Date() });
    assert.ok(saved);
    log = withReading(log, id, saved);
  }
  const s = summarise(log);
  const up = /** @type {PositionReading} */ (log.readings.dialUp);
  const down = /** @type {PositionReading} */ (log.readings.crownDown);
  assert.equal(s.measured, 2);
  assert.deepEqual(s.used, ['dialUp', 'crownDown']);
  const sd = Math.hypot(up.rateSd, down.rateSd);
  assert.ok(s.average !== null && Math.abs(s.average - 0.5) <= (3 * sd) / 2 + 0.05, `average ${s.average}`);
  assert.ok(s.spread !== null && Math.abs(s.spread - 7) <= 3 * sd + 0.05, `spread ${s.spread}`);
  assert.equal(s.fastest, 'dialUp');
  assert.equal(s.slowest, 'crownDown');
  assert.ok(s.largestBeatError && Math.abs(s.largestBeatError.ms - 0.3) <= 0.05);
});

test('the next position suggested is the first without a reading, looking on from the last one saved', () => {
  let log = emptyLog();
  assert.equal(nextPosition(log), 'dialUp');
  log = withReading(log, 'dialUp', reading(1, 0.1, 0.2));
  assert.equal(nextPosition(log, 'dialUp'), 'dialDown');
  // A position skipped is suggested again once the others are done.
  log = withReading(log, 'crownUp', reading(2, 0.1, 0.2));
  assert.equal(nextPosition(log, 'crownUp'), 'crownDown');
  for (const id of /** @type {PositionId[]} */ (['crownDown', 'crownLeft', 'crownRight'])) log = withReading(log, id, reading(0, 0.1, 0.2));
  assert.equal(nextPosition(log, 'crownRight'), 'dialDown');
  // Measured again: the new reading replaces the old one.
  log = withReading(log, 'dialUp', reading(5, 0.1, 0.2));
  assert.equal(/** @type {PositionReading} */ (log.readings.dialUp).rate, 5);
  assert.equal(Object.keys(log.readings).length, 5);
  log = withReading(log, 'dialDown', reading(0, 0.1, 0.2));
  assert.equal(nextPosition(log, 'dialDown'), null, 'all six saved');
  assert.equal(log.started, '2026-11-25T12:00:00.000Z', 'started at the first save');
});

test('a reading too uncertain to count is marked and left out of the average and spread, but its beat error still counts', () => {
  let log = emptyLog();
  log = withReading(log, 'dialUp', reading(2, 0.08, 0.15));
  log = withReading(log, 'dialDown', reading(-1, 0.3, 0.42));
  log = withReading(log, 'crownUp', reading(40, MAX_RATE_SD * 1.6, 0.9, { irregular: true }));
  log = withReading(log, 'crownDown', reading(-6, 0.12, null));
  const s = summarise(log);
  assert.deepEqual(s.used, ['dialUp', 'dialDown', 'crownDown']);
  assert.deepEqual(s.leftOut, ['crownUp']);
  assert.ok(s.average !== null && Math.abs(s.average - -5 / 3) < 1e-9);
  assert.equal(s.spread, 8);
  assert.equal(s.fastest, 'dialUp');
  assert.equal(s.slowest, 'crownDown');
  assert.deepEqual(s.largestBeatError, { ms: 0.9, position: 'crownUp' });
  assert.equal(s.beatErrorGaps, 1);
  const words = describeSummary(s);
  assert.equal(words.average, '−1.7 s/d');
  assert.equal(words.averageNote, 'over 3 positions');
  assert.equal(words.spread, '8.0 s/d');
  assert.equal(words.spreadNote, 'Dial up fastest, Crown down slowest');
  assert.equal(words.beatError, '0.90 ms');
  assert.equal(words.beatErrorNote, 'Crown up');
  assert.match(words.leftOut, /uncertain by more than ±1 s\/d: Crown up\./);
  assert.ok(isUncertain(/** @type {PositionReading} */ (log.readings.crownUp)));
  assert.match(describeReading(/** @type {PositionReading} */ (log.readings.crownUp)).detail, /uncertain, left out of the average/);
  assert.deepEqual(describeReading(/** @type {PositionReading} */ (log.readings.dialUp)), { main: '+2.0 s/d ±0.08 · 0.15 ms', detail: 'Over a 20 s window · 160 beats' });
  assert.match(describeReading(/** @type {PositionReading} */ (log.readings.crownDown)).detail, /beat error not measurable/);
  // A faint watch's lengthened window is given in minutes and seconds.
  assert.match(describeReading(reading(1, 0.2, 0.1, { windowSeconds: 153.5 })).detail, /^Over a 2 min 34 s window/);
});

test('the summary says what it lacks: no positions, one position, co-axial beat error', () => {
  const none = describeSummary(summarise(emptyLog()));
  assert.deepEqual([none.average, none.averageNote, none.spread, none.spreadNote, none.beatError, none.beatErrorNote, none.leftOut], ['—', 'no positions yet', '—', 'needs two positions', '—', 'no positions yet', '']);
  const one = summarise(withReading(emptyLog(), 'dialUp', reading(3, 0.1, null, { escapement: 'coaxial', beatErrorGap: 'coaxial' })));
  const words = describeSummary(one);
  assert.equal(words.average, '+3.0 s/d');
  assert.equal(words.averageNote, 'over 1 position');
  assert.equal(one.spread, null);
  assert.equal(words.spreadNote, 'needs two positions');
  assert.equal(words.beatErrorNote, 'not shown for co-axial');
  const unsure = describeSummary(summarise(withReading(emptyLog(), 'dialUp', reading(3, 2, 0.1))));
  assert.equal(unsure.average, '—');
  assert.equal(unsure.averageNote, 'no certain reading yet');
});

test('the line under the log says what to do next', () => {
  const base = { target: /** @type {PositionId|null} */ ('dialDown'), saved: null, running: false, tracking: false, covered: 0, needed: 20, ready: false, rateSd: null };
  assert.equal(positionStep(base), 'Place the watch dial down, then press Start.');
  assert.equal(positionStep({ ...base, running: true }), 'Listening. The reading can be saved once it covers 20 s.');
  assert.equal(positionStep({ ...base, running: true, tracking: true, covered: 12.7 }), 'Keep the watch still: the reading covers 12 of 20 s.');
  assert.equal(positionStep({ ...base, running: true, tracking: true, covered: 41.5, needed: 48.04 }), 'Keep the watch still: the reading covers 41 of 48 s.');
  assert.equal(positionStep({ ...base, running: true, tracking: true, covered: 20, ready: true, rateSd: 0.09 }), 'Ready to save as Dial down.');
  assert.match(positionStep({ ...base, running: true, tracking: true, covered: 20, ready: true, rateSd: 1.4 }), /uncertain by ±1\.4 s\/d, so it would be left out of the average/);
  assert.equal(positionStep({ ...base, saved: 'dialUp' }), 'Saved Dial up. Place the watch dial down, then press Start.');
  assert.equal(positionStep({ ...base, saved: 'crownRight', target: null }), 'Saved Crown right. All six positions are saved.');
  assert.match(positionStep({ ...base, target: null }), /^All six positions are saved\. Tap one/);
});

test('the log comes back from storage as it was saved, and anything invalid in it is dropped', () => {
  let log = emptyLog();
  log = withReading(log, 'dialUp', reading(2, 0.08, 0.15));
  log = withReading(log, 'crownLeft', reading(-3.5, 0.2, null, { escapement: 'coaxial', beatErrorGap: 'coaxial', irregular: true }));
  assert.deepEqual(cleanLog(JSON.parse(JSON.stringify(log))), log);
  const stored = JSON.parse(JSON.stringify(log));
  stored.readings.dialDown = { rate: 'fast', rateSd: 0.1 };
  stored.readings.crownUp = { ...reading(1, -1, 0.1) };
  stored.readings.crownDown = { ...reading(1, 0.1, 0.1), escapement: 'tourbillon' };
  stored.readings.crownRight = { ...reading(1, 0.1, 0.1), windowSeconds: undefined };
  stored.readings.nowhere = reading(1, 0.1, 0.1);
  assert.deepEqual(cleanLog(stored), log);
  assert.deepEqual(cleanLog(null), emptyLog());
  assert.deepEqual(cleanLog('[]'), emptyLog());
  assert.deepEqual(cleanLog({ started: '2026-11-25', readings: {} }), emptyLog(), 'no start without a reading');
  // Without the browser's storage (as here, in Node) the log starts empty.
  assert.deepEqual(loadLog(), emptyLog());
  assert.equal(POSITIONS.length, 6);
});

test('the mode is continuous unless six positions was chosen, and is remembered', () => {
  assert.equal(DEFAULTS.mode, 'continuous');
  assert.equal(clean({ mode: 'positions' }).mode, 'positions');
  assert.equal(clean({ mode: 'continuous' }).mode, 'continuous');
  assert.equal(clean({ mode: 'six' }).mode, 'continuous');
});
