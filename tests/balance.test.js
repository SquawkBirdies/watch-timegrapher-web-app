// The simulated watch built from the motion of its balance (tests/helpers/balance.js). The
// prototype in tools/prototype/coaxial/ is judged against its truth, so the truth is checked
// here against the geometry it was given. Its co-axial watch must also fool Swiss-lever mode
// the way the real Omega 3861 does, or it would not be a test of anything. The app's simulator
// streams the same co-axial (js/audio/balance.js), which is checked at the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from './helpers/balance.js';
import { analyze } from '../js/dsp/offline.js';
import { Cascade, bandpassSections } from '../js/dsp/biquad.js';
import { BalanceStream, coaxialEscapement, restOffsetFor, COAXIAL_LIFT_ANGLE } from '../js/audio/balance.js';
import { liftSeconds } from '../js/audio/simulator.js';
import { BEAT_RATES } from '../js/store.js';
import { Pipeline } from '../js/dsp/pipeline.js';

test('the simulated balance unlocks and locks when the geometry says it should', () => {
  const amplitude = 270;
  const rest = 1.7;
  const options = leverWatch({ seconds: 4, amplitude, restOffsetDeg: rest, unlockDeg: [25, 25], lockDeg: [26, 23], lockJitterMs: 0 });
  const { truth } = synthesizeBalanceWatch(options);
  // The balance's phase advances by pi every beat.
  const omega = Math.PI / (3600 / options.bph / (1 + /** @type {number} */ (options.rate) / 86400));
  /** @param {number} degrees time in milliseconds, from passing the rest position, at which the balance is this far from it */
  const at = (degrees) => (1e3 * Math.asin(degrees / amplitude)) / omega;
  // Even beats swing towards positive angles, odd beats the other way, so the rest offset
  // delays one beat's unlock and advances the other's.
  const evenUnlock = at(-25 - rest);
  const oddUnlock = at(rest - 25);
  assert.ok(Math.abs(truth.unlockGapMs - (oddUnlock - evenUnlock)) < 1e-6, `unlock gap ${truth.unlockGapMs}`);
  assert.ok(Math.abs(truth.unlockGapMs - 0.5) < 0.01, 'a rest position 1.7 degrees out is a beat error of half a millisecond here');
  assert.ok(Math.abs(truth.liftMs[0] - (at(26 - rest) - evenUnlock)) < 1e-6, `even lift ${truth.liftMs[0]}`);
  assert.ok(Math.abs(truth.liftMs[1] - (at(23 + rest) - oddUnlock)) < 1e-6, `odd lift ${truth.liftMs[1]}`);
  assert.equal(truth.meanAmplitude, amplitude);

  const inBeat = synthesizeBalanceWatch(leverWatch({ seconds: 4, lockJitterMs: 0 }));
  assert.ok(Math.abs(inBeat.truth.unlockGapMs) < 1e-9 && Math.abs(inBeat.truth.lockGapMs) < 1e-9, 'in beat, both gaps are zero');
});

/**
 * Standard deviation, about zero, of a list of numbers.
 * @param {number[]} v
 */
const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);

test('timing jitter moves each whole beat off the regular grid by about the asked scatter, and none leaves the watch as it was', () => {
  const base = leverWatch({ seconds: 40, seed: 3, lockJitterMs: 0 });
  const regular = synthesizeBalanceWatch(base);
  const zero = synthesizeBalanceWatch({ ...base, beatJitterMs: 0, amplitudeJitterDeg: 0 });
  assert.ok(regular.channels[0].every((x, i) => x === zero.channels[0][i]), 'no jitter, the same samples');

  const { truth } = synthesizeBalanceWatch({ ...base, beatJitterMs: 0.5 });
  const halfPeriod = 3600 / base.bph / (1 + /** @type {number} */ (base.rate) / 86400);
  const omega = Math.PI / halfPeriod;
  const amplitude = /** @type {number} */ (base.amplitude);
  // Without jitter, each unlock falls a fixed time before the balance passes its rest position
  // on the grid, so what is left over is the jitter itself.
  const unlockBefore = Math.asin(-25 / amplitude) / omega;
  const off = Array.from(truth.unlock, (t, k) => 1e3 * (t - (0.137 + k * halfPeriod) - unlockBefore));
  const scatter = rms(off);
  // 319 beats give the scatter to about 4%, so 20% is five times that. Seed 3 gives 0.479 ms.
  assert.ok(Math.abs(scatter - 0.5) < 0.1, `scatter of the unlocks ${scatter} ms`);
  // The whole beat moves: every lock follows its unlock by the regular lift time.
  const lift = (2 * Math.asin(25 / amplitude)) / omega;
  assert.ok(truth.unlock.every((t, k) => Math.abs(truth.lock[k] - t - lift) < 1e-12), 'each lock moves with its unlock');
});

test('amplitude jitter scatters each beat\'s amplitude by about the asked amount without moving the beat', () => {
  const base = leverWatch({ seconds: 40, seed: 4, lockJitterMs: 0 });
  const { truth } = synthesizeBalanceWatch({ ...base, amplitudeJitterDeg: 10 });
  const halfPeriod = 3600 / base.bph / (1 + /** @type {number} */ (base.rate) / 86400);
  const omega = Math.PI / halfPeriod;
  // With the unlock and the lock 25 degrees either side of the rest position, a beat's lift time
  // gives its amplitude, and the beat stays centred on the grid whatever the amplitude.
  const amplitudes = Array.from(truth.unlock, (t, k) => 25 / Math.sin((omega * (truth.lock[k] - t)) / 2));
  const mean = amplitudes.reduce((s, a) => s + a, 0) / amplitudes.length;
  const scatter = rms(amplitudes.map((a) => a - mean));
  // As above, 20% is five times the uncertainty of 319 beats' scatter, and 2 degrees about
  // three and a half times that of their mean. Seed 4 gives 9.72 and 270.62 degrees.
  assert.ok(Math.abs(scatter - 10) < 2, `scatter of the amplitudes ${scatter} degrees`);
  assert.ok(Math.abs(mean - 270) < 2, `mean amplitude ${mean}`);
  assert.ok(Math.abs(truth.meanAmplitude - mean) < 1e-6, 'the truth gives the amplitude the beats had');
  assert.ok(truth.unlock.every((t, k) => Math.abs((t + truth.lock[k]) / 2 - (0.137 + k * halfPeriod)) < 1e-12), 'each beat stays on the grid');
});

test('a sound given its own start in each band starts later in a band given a later delay, and the truth is unchanged', () => {
  // A loud sound in two bands; in one watch the upper band starts with the lower one, in the
  // other half a millisecond after it. Everything else, the noise included, is drawn the same.
  /**
   * @param {number} late
   * @returns {import('./helpers/balance.js').BeatSound[]}
   */
  const beat = (late) => [{ after: 'unlock', db: 40, riseMs: 0.12, decayMs: 0.5, band: [6000, 20000], arrival: [{ band: [6000, 10000] }, { band: [15000, 20000], delayMs: late }] }];
  const base = leverWatch({ seconds: 1, seed: 5, lockJitterMs: 0 });
  const together = synthesizeBalanceWatch({ ...base, sounds: [beat(0), beat(0)] });
  const apart = synthesizeBalanceWatch({ ...base, sounds: [beat(0.5), beat(0.5)] });
  assert.deepStrictEqual(apart.truth, together.truth, 'the events are where they were');
  const fs = together.sampleRate;
  const first = together.truth.unlock[0];
  /** @param {Float32Array} x @param {number} lo @param {number} hi */
  const filtered = (x, lo, hi) => {
    const y = new Float64Array(x.length);
    new Cascade(bandpassSections(fs, lo, hi)).process(x, y);
    return y;
  };
  /**
   * How much later a band's sound comes in the second watch than in the first, near the first
   * unlock: the lag at which the two, through the same filter, line up best. The filter's own
   * delay is the same for both and cancels.
   * @param {number} lo
   * @param {number} hi
   */
  const shiftMs = (lo, hi) => {
    const a = filtered(together.channels[0], lo, hi);
    const b = filtered(apart.channels[0], lo, hi);
    const from = Math.floor((first - 1e-3) * fs);
    const to = Math.floor((first + 4e-3) * fs);
    let best = 0;
    let bestSum = -Infinity;
    for (let lag = -48; lag <= 48; lag++) {
      let sum = 0;
      for (let i = from; i < to; i++) sum += a[i] * b[i + lag];
      if (sum > bestSum) [best, bestSum] = [lag, sum];
    }
    return (1e3 * best) / fs;
  };
  assert.ok(Math.abs(shiftMs(6500, 9500)) < 0.03, `lower band moved ${shiftMs(6500, 9500)} ms`);
  assert.ok(Math.abs(shiftMs(15500, 19500) - 0.5) < 0.03, `upper band moved ${shiftMs(15500, 19500)} ms`);
});

test('Swiss-lever mode reads a large beat error on a simulated co-axial watch that is exactly in beat', () => {
  const w = synthesizeBalanceWatch(coaxialWatch({ seconds: 30, seed: 7 }));
  assert.ok(Math.abs(w.truth.unlockGapMs) < 1e-9, 'the watch is in beat');
  const r = analyze(w.channels, w.sampleRate);
  assert.equal(r.bph, 21600);
  assert.ok(r.rate !== null && Math.abs(r.rate - 0.4) < 0.3, `rate ${r.rate}`);
  // The real Omega's Safari capture reads 3.4 ms the same way, and recordings.test.js holds the
  // app to that. This checks the simulated watch instead: that it poses the same problem.
  assert.ok(r.beatErrorDetail !== null && Math.abs(r.beatErrorDetail.offsetMs) > 3, `tick-tock offset ${r.beatErrorDetail && r.beatErrorDetail.offsetMs}`);
});

// ---- The app's simulated co-axial ----------------------------------------------------------

/**
 * Every beat's unlock and lock times and sound starts from the app's simulated co-axial.
 * @param {import('../js/audio/balance.js').BalanceStreamOptions} options
 * @param {number} seconds
 * @returns {{unlock: number[], lock: number[], starts: number[][]}}
 */
function coaxialEvents(options, seconds) {
  const sim = new BalanceStream({ ...options, record: true });
  sim.next(Math.round(seconds * sim.sampleRate));
  return /** @type {{unlock: number[], lock: number[], starts: number[][]}} */ (sim.events);
}

/**
 * How much later than midway between the even entries the odd entries fall, on average, in ms.
 * @param {number[]} t
 */
function gapMs(t) {
  let sum = 0;
  let count = 0;
  for (let k = 1; k + 1 < t.length; k += 2) {
    sum += t[k] - 0.5 * (t[k - 1] + t[k + 1]);
    count++;
  }
  return (1e3 * sum) / count;
}

test('the app\'s simulated co-axial gives the same audio whatever the chunk sizes, and the same audio for the same seed', () => {
  const options = { bph: 18000, rate: 5, beatOffsetMs: 1.2, amplitude: 150, liftAngle: 70, jitterMs: 3, seed: 7 };
  const whole = new BalanceStream(options).next(90000)[0];
  const b = new BalanceStream(options);
  const parts = [];
  for (const n of [1, 999, 12000, 30000, 17000, 30000]) parts.push(...b.next(n)[0]);
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.equal(parts[i], whole[i], `sample ${i}`);
  const other = new BalanceStream({ ...options, seed: 8 }).next(90000)[0];
  assert.ok(other.some((v, i) => v !== whole[i]), 'another seed, other audio');
});

test('at its reference the app\'s simulated co-axial unlocks, locks and sounds as the tests\' co-axial does', () => {
  const { reference, liftAngle, sounds } = coaxialEscapement();
  assert.equal(liftAngle, COAXIAL_LIFT_ANGLE);
  assert.deepEqual(reference, { bph: 21600, amplitude: 285 });
  // Without the lock's variation the two give the same events, to rounding: the same balance
  // with its rest position set for the same beat error.
  const steady = { ...coaxialEscapement(), lockJitterMs: 0 };
  const events = coaxialEvents({ bph: 21600, rate: 0.4, beatOffsetMs: 0.4, amplitude: 285, escapement: steady }, 20);
  const omega = Math.PI / (3600 / 21600 / (1 + 0.4 / 86400));
  const rest = restOffsetFor(0.4, 285, [18, 18], omega);
  const made = synthesizeBalanceWatch(coaxialWatch({ seconds: 20, restOffsetDeg: rest, lockJitterMs: 0 }));
  assert.ok(Math.abs(gapMs(events.unlock) - 0.4) < 1e-6 && Math.abs(made.truth.unlockGapMs - 0.4) < 1e-6, `unlock gaps ${gapMs(events.unlock)} and ${made.truth.unlockGapMs} ms`);
  for (const j of [0, 1]) {
    let sum = 0;
    let count = 0;
    for (let k = j; k < events.unlock.length; k += 2) {
      sum += events.lock[k] - events.unlock[k];
      count++;
    }
    assert.ok(Math.abs((1e3 * sum) / count - made.truth.liftMs[j]) < 1e-6, `beat ${j}: ${(1e3 * sum) / count} against ${made.truth.liftMs[j]} ms`);
  }
  // At the reference the sounds come the pattern's delays after their events: within three
  // standard errors of the delays' variation over the beats of a minute.
  const minute = coaxialEvents({ bph: 21600, amplitude: 285, seed: 3 }, 60);
  for (const j of [0, 1]) {
    sounds[j].forEach((sound, i) => {
      const delays = [];
      for (let k = j; k < minute.unlock.length; k += 2) delays.push(1e3 * (minute.starts[k][i] - (sound.after === 'unlock' ? minute.unlock[k] : minute.lock[k])));
      const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
      const allowed = 3 * ((sound.delayJitterMs || 0) / Math.sqrt(delays.length)) + 1e-9;
      assert.ok(Math.abs(mean - (sound.delayMs || 0)) <= allowed, `beat ${j}, sound ${i}: ${mean.toFixed(4)} ms against ${sound.delayMs || 0}`);
    });
  }
});

test('the app\'s simulated co-axial puts its unlocks the beat error apart and keeps its impulses inside the lift at every beat rate, amplitude and lift angle it offers', () => {
  // Silent, which changes no event, so that this runs in a few seconds.
  const reference = liftSeconds(285, 21600, COAXIAL_LIFT_ANGLE);
  for (const bph of BEAT_RATES) {
    for (const amplitude of [150, 330]) {
      for (const liftAngle of [30, 36, 70]) {
        for (const beatOffsetMs of [0, 2]) {
          const label = `${bph} vph, ${amplitude} degrees, lift ${liftAngle}, ${beatOffsetMs} ms`;
          const events = coaxialEvents({ bph, amplitude, liftAngle, beatOffsetMs, gain: 0, seed: 11 }, 4);
          assert.ok(Math.abs(gapMs(events.unlock) - beatOffsetMs) < 1e-6, `${label}: unlock gap ${gapMs(events.unlock)}`);
          const { sounds } = coaxialEscapement();
          let impulse = 0;
          let impulses = 0;
          for (let k = 0; k < events.unlock.length; k++) {
            const pattern = sounds[k % 2];
            pattern.forEach((sound, i) => {
              const start = events.starts[k][i];
              if (sound.after === 'unlock') {
                // A third of a millisecond is about three of the impulses' variations.
                assert.ok(start >= events.unlock[k] && start < events.lock[k] - 3e-4, `${label}, beat ${k}: sound ${i} at ${(1e3 * (start - events.unlock[k])).toFixed(2)} ms, lock at ${(1e3 * (events.lock[k] - events.unlock[k])).toFixed(2)} ms`);
              } else {
                assert.ok(start >= events.lock[k], `${label}, beat ${k}: sound ${i} before the lock`);
              }
            });
            if (k % 2 === 0) {
              impulse += events.starts[k][1] - events.unlock[k];
              impulses++;
            }
          }
          // The loud impulse keeps its place within the lift: its delay grows and shrinks with
          // the time the balance takes to cross the lift angle.
          const expected = (3.25e-3 * liftSeconds(amplitude, bph, liftAngle)) / reference;
          assert.ok(Math.abs(impulse / impulses - expected) < 0.08e-3, `${label}: impulse ${(1e3 * impulse) / impulses} ms against ${1e3 * expected}`);
        }
      }
    }
  }
});

test('the loudness of the app\'s simulated co-axial changes nothing but its sounds', () => {
  const options = { bph: 25200, rate: -4, beatOffsetMs: 0.7, amplitude: 240, jitterMs: 0.5, seed: 4 };
  const loud = new BalanceStream({ ...options, gain: 4, record: true });
  const silent = new BalanceStream({ ...options, gain: 0, record: true });
  const a = loud.next(48000)[0];
  const b = silent.next(48000)[0];
  assert.deepEqual(loud.events, silent.events, 'the same beats');
  // Away from the sounds the two are the same background, to the last bit; no sound lasts 7 ms.
  const near = new Uint8Array(a.length);
  for (const starts of /** @type {{starts: number[][]}} */ (loud.events).starts) {
    for (const t of starts) for (let i = Math.max(0, Math.floor(t * 48000) - 2); i < Math.min(a.length, Math.ceil((t + 0.007) * 48000)); i++) near[i] = 1;
  }
  let most = 0;
  for (let i = 0; i < a.length; i++) {
    if (near[i]) most = Math.max(most, Math.abs(a[i] - b[i]));
    else assert.equal(a[i], b[i], `sample ${i}`);
  }
  assert.ok(most > 1e-3, 'the loud one has sounds');
});

test('the app reads back the beat error, amplitude and rate its simulated co-axial is set to, at the simulator\'s first settings for it', () => {
  // The Simulator tab's sliders as they start, at 21,600 vph, the co-axial's own lift angle and
  // the app's other settings, fed in the app's 40 ms chunks for a minute and a half. The faint
  // unlock is found in time but not always kept: of 10 seeds at the pattern's own 285 degrees,
  // all showed both readings within 64 s and 2 had them held back again at 90 s, with 8 and 13%
  // of their draws failing. This seed shows them from 44 s.
  const sim = new BalanceStream({ bph: 21600, rate: 8, beatOffsetMs: 0.4, amplitude: 270, gain: 3, liftAngle: COAXIAL_LIFT_ANGLE, seed: 1 });
  const pipeline = new Pipeline(sim.sampleRate, 1, { escapement: 'coaxial', liftAngle: COAXIAL_LIFT_ANGLE, sounds: { share: Infinity } });
  /** @type {import('../js/dsp/pipeline.js').ReadingsEvent[]} */
  const readings = [];
  for (let i = 0; i < 90 * sim.sampleRate; i += 1920) {
    for (const e of pipeline.push(sim.next(1920))) if (e.type === 'readings') readings.push(e);
  }
  const shown = readings.filter((e) => e.sounds && e.sounds.beatErrorMs !== null && e.sounds.amplitude !== null);
  assert.ok(shown.length > 20 && shown[0].t < 60, `${shown.length} shown, the first at ${shown.length ? shown[0].t.toFixed(1) : '-'} s`);
  for (const e of shown) {
    const s = /** @type {NonNullable<typeof e.sounds>} */ (e.sounds);
    assert.ok(Math.abs(Math.abs(/** @type {number} */ (s.beatErrorMs)) - 0.4) <= 0.1, `at ${e.t.toFixed(1)} s, beat error ${s.beatErrorMs}`);
    assert.ok(Math.abs(/** @type {number} */ (s.amplitude) - 270) <= 3, `at ${e.t.toFixed(1)} s, amplitude ${s.amplitude}`);
  }
  const last = readings[readings.length - 1];
  assert.ok(last.rate !== null && Math.abs(last.rate - 8) < 0.5, `rate ${last.rate}`);
});
