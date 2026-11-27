// Rule B (js/dsp/steps.js): the amplitude and the beat error start their stretch of beats again
// when the watch changes, and the sensitivity setting that governs it. First the rule on its
// own, with gaps made up to known values, a fraction of a second a test; then inside the
// pipeline, on a simulated lever whose beat error is stepped, as when a watch is adjusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SENSITIVITY, DEFAULT_SENSITIVITY, StepWatch, timedGaps } from '../js/dsp/steps.js';
import { STACK_SECONDS, FIRST_READING_SECONDS } from '../js/dsp/soundstage.js';
import { Pipeline } from '../js/dsp/pipeline.js';
import { WatchStream } from '../js/audio/simulator.js';
import { DEFAULTS, clean } from '../js/store.js';
import { whyWords } from '../js/ui/model.js';
import { stream } from './helpers/stream.js';

/**
 * Normally distributed numbers from a fixed seed, so that a test gives the same gaps each time.
 * @param {number} seed
 */
function normal(seed) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * Four tick-tock cycles a second, each gap `level(t)` with a scatter of `sd`, judged once a
 * second from `from` to `to`, against a reading that rests on the gaps from 10 to 50 s.
 * @param {StepWatch} watch
 * @param {(t: number) => number} level ms
 * @param {number} sd ms
 * @param {number} from
 * @param {number} to
 * @param {number} seed
 * @returns {{at: number, from: number}[]} when the rule fired, and where it put the step
 */
function judgeMadeUp(watch, level, sd, from, to, seed) {
  const noise = normal(seed);
  const all = Array.from({ length: to * 4 }, (_, i) => ({ t: i / 4, p: i, g: level(i / 4) + sd * noise() }));
  const fired = [];
  for (let now = from; now <= to; now++) {
    const at = watch.judge(all.filter((x) => x.t <= now), fired.length ? null : [10, 50]);
    if (at) fired.push({ at: now, from: at.t });
  }
  return fired;
}

test('the gap of a cycle is its tock less the midpoint of the ticks either side, from beats each timed alone and confidently', () => {
  // Ticks every 0.25 s; the tocks 0.1 ms late of midway, one of them 0.3 ms late.
  const beats = [];
  for (let n = 0; n < 12; n++) {
    const type = /** @type {0|1} */ (n % 2);
    const late = type === 1 ? (n === 5 ? 0.3e-3 : 0.1e-3) : 0;
    beats.push({ n, p: 1000 * (n * 0.125 + late), type, ok: true, K: 1 });
  }
  const toSeconds = (/** @type {number} */ p) => p / 1000;
  const gaps = timedGaps([...beats].reverse(), toSeconds);
  assert.deepEqual(gaps.map((x) => x.t.toFixed(4)), ['0.1251', '0.3751', '0.6253', '0.8751', '1.1251']);
  assert.deepEqual(gaps.map((x) => x.g.toFixed(3)), ['0.100', '0.100', '0.300', '0.100', '0.100']);
  // A tick not confident, or a timestamp averaged over several cycles, takes away the gaps it
  // borders; so does a start after it.
  const unsure = beats.map((b) => (b.n === 4 ? { ...b, ok: false } : b.n === 9 ? { ...b, K: 3 } : b));
  assert.deepEqual(timedGaps(unsure, toSeconds).map((x) => x.t.toFixed(3)), ['0.125', '0.875']);
  assert.deepEqual(timedGaps(beats, toSeconds, 600).map((x) => x.t.toFixed(3)), ['0.875', '1.125']);
});

test('rule B starts the stretch again 3 s after the gaps step, at the step, and not for gaps that only scatter', () => {
  // 0.4 ms, scattered by 0.02 ms, stepping to 1.0 ms at 60 s: the latest 5 s disagree once most
  // of them are new, at 62 to 63 s, and the rule fires when they have for 3 s running.
  for (const K of [4, 6, 8]) {
    const fired = judgeMadeUp(new StepWatch(K), (t) => (t < 60 ? 0.4 : 1.0), 0.02, 51, 80, 7);
    assert.equal(fired.length, 1, `K = ${K}: fired at ${fired.map((f) => f.at)}`);
    assert.ok(fired[0].at >= 63 && fired[0].at <= 66, `K = ${K}: fired at ${fired[0].at} s`);
    assert.ok(Math.abs(fired[0].from - 60) <= 0.25, `K = ${K}: from ${fired[0].from} s`);
  }
  // Five minutes of the same scatter and no step: never.
  for (const K of [4, 6, 8]) assert.deepEqual(judgeMadeUp(new StepWatch(K), () => 0.4, 0.02, 51, 300, 11), [], `K = ${K}`);
  // A step of 6 standard errors of the difference between 5 s and 40 s of gaps scattered by
  // 0.05 ms: high and medium sensitivity see it, low does not.
  const small = (/** @type {number} */ K) => judgeMadeUp(new StepWatch(K), (t) => (t < 60 ? 0.4 : 0.472), 0.05, 51, 90, 5);
  assert.equal(small(SENSITIVITY.high.K).length, 1, 'high');
  assert.equal(small(SENSITIVITY.medium.K).length, 1, 'medium');
  assert.equal(small(SENSITIVITY.low.K).length, 0, 'low');
  // A difference under 0.03 ms is never enough, however steady the gaps.
  assert.deepEqual(judgeMadeUp(new StepWatch(4), (t) => (t < 60 ? 0.4 : 0.425), 0.002, 51, 90, 3), []);
  // With no reading to compare with, and no restart, there is nothing to judge.
  const watch = new StepWatch(4);
  assert.equal(watch.judge([{ t: 1, p: 1, g: 0.4 }], null), null);
});

test('the presets: High reads 45 s of beats and restarts most readily, Medium and Low 60 s; all read first after 15 s; Medium is the default here, in the settings and in the pipeline', () => {
  assert.deepEqual(SENSITIVITY, { high: { windowSeconds: 45, firstSeconds: 15, K: 4 }, medium: { windowSeconds: 60, firstSeconds: 15, K: 6 }, low: { windowSeconds: 60, firstSeconds: 15, K: 8 } });
  assert.equal(FIRST_READING_SECONDS, 15);
  assert.equal(STACK_SECONDS, 60);
  assert.equal(DEFAULT_SENSITIVITY, 'medium');
  assert.equal(DEFAULTS.sensitivity, DEFAULT_SENSITIVITY);
  for (const s of Object.keys(SENSITIVITY)) assert.equal(clean({ sensitivity: s }).sensitivity, s, 'every preset can be kept');
  assert.equal(clean({ sensitivity: 'highest' }).sensitivity, 'medium', 'anything else is the default');
  assert.equal(whyWords('changed'), 'changed: reading again');

  const p = new Pipeline(48000, 1, { liftAngle: 52 });
  const stage = /** @type {NonNullable<Pipeline['sounds']>} */ (p.sounds);
  const steps = /** @type {StepWatch} */ (p.steps);
  const fe = stage.fe;
  assert.deepEqual([stage.window, stage.first, stage.reach, steps.K], [Math.round(60 * fe), Math.round(15 * fe), Math.round(60 * fe), 6]);
  // A change while measuring sets the next reading's stretch and the rule's threshold. The
  // envelopes and beats are kept for 60 s in any case, so that a longer stretch can be had.
  p.setOptions({ sensitivity: 'high' });
  assert.deepEqual([stage.window, stage.first, stage.reach, steps.K], [Math.round(45 * fe), Math.round(15 * fe), Math.round(60 * fe), 4]);
  p.setOptions({ sensitivity: 'low' });
  assert.deepEqual([stage.window, steps.K], [Math.round(60 * fe), 8]);
  const high = new Pipeline(48000, 1, { liftAngle: 52, sensitivity: 'high' });
  assert.deepEqual([high.sounds?.window, high.steps?.K], [Math.round(45 * fe), 4]);
  // The stage's own lengths, given, win; the rule can be switched off; no lift angle, no stage
  // and no rule.
  const own = new Pipeline(48000, 1, { liftAngle: 52, sensitivity: 'high', sounds: { windowSeconds: 30, firstSeconds: 20 } });
  own.setOptions({ sensitivity: 'low' });
  assert.deepEqual([own.sounds?.window, own.sounds?.first, own.steps?.K], [Math.round(30 * fe), Math.round(20 * fe), 8]);
  assert.equal(new Pipeline(48000, 1, { liftAngle: 52, followSteps: false }).steps, null);
  assert.equal(new Pipeline(48000, 1).steps, null);
});

/** The simulated lever's beat error before and after it is stepped, and when. */
const STEP = { from: 0.4, to: 1.0, at: 45, seconds: 75 };

/** The lever's audio, made once: 28,800 vph, 270 degrees at 52 degrees of lift, stepped. */
let stepped = /** @type {Float32Array|null} */ (null);
function steppedAudio() {
  if (stepped) return stepped;
  const sampleRate = 48000;
  const sim = new WatchStream({ bph: 28800, rate: 4, beatOffsetMs: STEP.from, amplitude: 270, gain: 3, seed: 3 });
  stepped = new Float32Array(STEP.seconds * sampleRate);
  for (let i = 0; i < stepped.length; i += 4096) {
    if (i <= STEP.at * sampleRate && i + 4096 > STEP.at * sampleRate) sim.beatOffsetMs = STEP.to;
    stepped.set(sim.next(4096)[0].subarray(0, Math.min(4096, stepped.length - i)), i);
  }
  return stepped;
}

/** Runs of that audio, each made once, by sensitivity, or 'off' for no rule B. */
const runs = new Map();
/** @param {'medium'|'off'} how */
function stepRun(how) {
  if (!runs.has(how)) {
    const options = how === 'off' ? { followSteps: false } : { sensitivity: how };
    runs.set(how, stream([steppedAudio()], 48000, { chunk: 4096, options: { liftAngle: 52, sounds: { share: Infinity }, ...options } }));
  }
  return /** @type {ReturnType<typeof stream>} */ (runs.get(how));
}

test('in the pipeline, a simulated lever adjusted from 0.4 to 1.0 ms shows a dash 2 to 8 s after the change, then 1.0 ms within 17 s of it and its amplitude within 22 s, and never the old value once the dash has come', () => {
  const r = stepRun('medium');
  const shown = r.readings.filter((x) => x.sounds);
  const s = (/** @type {typeof shown[0]} */ x) => /** @type {NonNullable<typeof x.sounds>} */ (x.sounds);
  // Before the change: no restart, and 0.4 ms from 15 s after the lock.
  const before = shown.filter((x) => x.t < STEP.at);
  assert.ok(before.every((x) => s(x).beatErrorWhy !== 'changed'), 'no restart before the change');
  const lock = r.status[0].t;
  const first = before.find((x) => s(x).beatErrorMs !== null);
  assert.ok(first && first.t - lock < FIRST_READING_SECONDS + 1.5, `locked at ${lock.toFixed(1)} s, first beat error at ${first?.t.toFixed(1)} s`);
  assert.ok(before.filter((x) => s(x).beatErrorMs !== null).every((x) => Math.abs(/** @type {number} */ (s(x).beatErrorMs) - STEP.from) <= 0.05));
  // The restart: both readings go to a dash, with the reason.
  const dash = shown.find((x) => x.t >= STEP.at && s(x).beatErrorWhy === 'changed');
  assert.ok(dash && dash.t - STEP.at >= 2 && dash.t - STEP.at <= 8, `dash at ${dash?.t.toFixed(1)} s`);
  assert.equal(s(dash).amplitudeWhy, 'changed');
  const after = shown.filter((x) => x.t >= dash.t);
  const right = after.find((x) => s(x).beatErrorMs !== null);
  assert.ok(right && right.t - STEP.at <= 17, `1.0 ms from ${right ? (right.t - STEP.at).toFixed(1) : '—'} s after the change`);
  for (const x of after) {
    const ms = s(x).beatErrorMs;
    if (ms !== null) assert.ok(Math.abs(ms - STEP.to) <= Math.max(0.05, 3 * /** @type {number} */ (s(x).beatErrorSd)), `${ms.toFixed(3)} ms at ${x.t.toFixed(1)} s`);
    if (s(x).amplitude !== null) assert.ok(Math.abs(/** @type {number} */ (s(x).amplitude) - 270) <= 3, 'the amplitude, which did not change, comes back');
  }
  // The amplitude waits for a second block of beats: 20 s of them.
  assert.equal(s(right).amplitudeWhy, 'one-block');
  const amplitude = after.find((x) => s(x).amplitude !== null);
  assert.ok(amplitude && amplitude.t - STEP.at <= 22, `amplitude from ${amplitude ? (amplitude.t - STEP.at).toFixed(1) : '—'} s after the change`);
  // The reading after the change rests only on beats from after it.
  const window = /** @type {[number, number]} */ (s(right).window);
  assert.ok(window[0] >= STEP.at - 0.3, `beats from ${window[0].toFixed(2)} s`);
});

test('without rule B, as before 27 November 2026, that lever still shows the old beat error, or a mixture of the two, 16 s after the change, with no dash', () => {
  const r = stepRun('off');
  const at = r.readings.filter((x) => x.sounds && x.t >= STEP.at && x.t <= STEP.at + 16);
  assert.ok(at.every((x) => x.sounds && x.sounds.beatErrorWhy !== 'changed' && x.sounds.beatErrorMs !== null), 'shown throughout');
  const last = /** @type {NonNullable<typeof at[0]['sounds']>} */ (at[at.length - 1].sounds);
  assert.ok(/** @type {number} */ (last.beatErrorMs) < 0.8, `${last.beatErrorMs?.toFixed(3)} ms shown, 1.0 ms true`);
});
