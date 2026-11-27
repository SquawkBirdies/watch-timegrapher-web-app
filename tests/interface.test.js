// Milestone 5: what the screen shows. The pipeline's extra events for the interface, the model
// that turns events into trace points and words, the simulator that runs without end, the
// recording decoder and the pacing of sources. Drawing itself is checked in a browser.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Pipeline } from '../js/dsp/pipeline.js';
import { synthesizeWatch, WatchStream, liftSeconds, SIMULATED_LIFT_ANGLE } from '../js/audio/simulator.js';
import { amplitudeOf } from '../js/dsp/amplitude.js';
import { encodeWav, decodeWav } from '../js/audio/wav.js';
import { RecordingSource } from '../js/audio/file-source.js';
import { Player } from '../js/audio/player.js';
import { Measurement, traceRange, ticks, formatRate, formatMs, formatBph, signalLevel, averagingNote, guidance, stageNote, soundsReadout, soundsInWords, whyWords, liftHint, beatName, shiftEvent, BEATS_NEEDED_SECONDS, COAXIAL_LIFT_LIMIT, stateText, irregularWarning } from '../js/ui/model.js';
import { FIRST_READING_SECONDS } from '../js/dsp/soundstage.js';
import { tickByGap, tickByLift, NAME_SD } from '../js/dsp/names.js';
import { clean, DEFAULTS, SETTINGS_KEY } from '../js/store.js';
import { stream } from './helpers/stream.js';
import { readiness } from '../js/ui/positions.js';

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
  // The 28,800 and 21,600 vph watches of stream.test.js are held to the same at the default
  // window; this adds the slowest beat rate.
  const cases = [{ bph: 18000, rate: 4, beatOffsetMs: 0.2, seed: 13 }];
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

test('the averaging window and the escapement can change while measuring', () => {
  const w = synthesizeWatch({ bph: 28800, rate: 6, beatOffsetMs: 0.4, gain: 1.6, seconds: 60, seed: 21 });
  const pipeline = new Pipeline(w.sampleRate, 2);
  let at = 0;
  const next = (/** @type {number} */ n) => {
    const out = w.channels.map((c) => c.subarray(at, at + n));
    at += n;
    return out;
  };
  const first = run(pipeline, next, 30);
  const lockEvent = first.find((e) => e.type === 'status' && e.state === 'tracking');
  const lock = lockEvent ? lockEvent.t : null;
  const before = /** @type {ReadingsEvent[]} */ (first.filter((e) => e.type === 'readings'));
  const a = before[before.length - 1];
  assert.ok(a.beatErrorMs !== null && Math.abs(a.beatErrorMs - 0.4) < 0.05);
  // As a Swiss lever its tick was named at the lock, from the gap between its timed beats.
  assert.ok(before.filter((e) => e.window !== null).every((e) => e.tick === a.tick) && a.tick !== null, 'named from the lock on');
  pipeline.setOptions({ averagingSeconds: 10, escapement: 'coaxial' });
  const after = /** @type {ReadingsEvent[]} */ (run(pipeline, next, 5).filter((e) => e.type === 'readings'));
  const b = after[after.length - 1];
  const span = /** @type {[number, number]} */ (b.window)[1] - /** @type {[number, number]} */ (b.window)[0];
  assert.ok(span > 8.5 && span <= 10.5, `window ${span.toFixed(1)} s after the change`);
  assert.equal(b.beatErrorMs, null, 'co-axial hides the beat error');
  // A co-axial's tick is named by another rule, from an amplitude, which this pipeline has no
  // lift angle to read: the beats lose their names, and setting the escapement back names
  // them again as before.
  assert.ok(after.every((e) => e.tick === null), 'no names as a co-axial');
  pipeline.setOptions({ escapement: 'lever' });
  const again = /** @type {ReadingsEvent[]} */ (run(pipeline, next, 1.5).filter((e) => e.type === 'readings'));
  assert.ok(again.length > 0 && again.every((e) => e.tick === a.tick), 'the same tick as a lever again');
  pipeline.setOptions({ escapement: 'coaxial' });
  assert.ok(b.rate !== null && Math.abs(b.rate - 6) < 0.5);
  pipeline.setOptions({ averagingSeconds: 60 });
  const longer = /** @type {ReadingsEvent[]} */ (run(pipeline, next, 23.5).filter((e) => e.type === 'readings'));
  const c = longer[longer.length - 1];
  const spanC = /** @type {[number, number]} */ (c.window)[1] - /** @type {[number, number]} */ (c.window)[0];
  assert.ok(spanC > 45, `a 60 s window reaches back past the 40 s history: ${spanC.toFixed(1)} s`);
  // The six-position log goes by the window set: a 10 s window is full, and with 60 s set 35 s
  // into the audio, not until the lock has lasted 60 s since it appeared.
  assert.ok(lock !== null && lock < 10, `locked at ${lock}`);
  assert.ok(readiness(true, b, 10, lock).ready && b.windowSeconds === 10, 'a 10 s window is full');
  assert.ok(longer.every((e) => e.windowSeconds === 60 && !readiness(true, e, 60, lock).ready), 'a 60 s window waits for 60 s of lock');
  const covered = readiness(true, c, 60, lock).covered;
  assert.ok(Math.abs(covered - (c.t - /** @type {number} */ (lock))) < 1e-9 && covered < 60, `covered ${covered.toFixed(2)} s`);
});

test('the lift angle reaches the stage that reads the sounds inside the beats, which runs only when one is given', () => {
  const without = new Pipeline(48000, 1);
  assert.equal(without.sounds, null);
  without.setOptions({ liftAngle: 40 });
  assert.equal(without.sounds, null, 'a pipeline made without a lift angle stays without the stage');
  const pipeline = new Pipeline(48000, 1, { liftAngle: 52 });
  assert.ok(pipeline.sounds && pipeline.sounds.liftAngle === 52);
  // Six bands from 5 kHz up, of the first channel, at 48 kHz and at 44.1 kHz.
  assert.equal(pipeline.sounds.rows.length, 6);
  assert.equal(/** @type {NonNullable<Pipeline['sounds']>} */ (new Pipeline(44100, 2, { liftAngle: 52 }).sounds).rows.length, 6);
  pipeline.setOptions({ liftAngle: 36.5 });
  assert.equal(pipeline.sounds.liftAngle, 36.5);
  assert.equal(pipeline.sounds.report(false, false).liftAngle, 36.5);
  // Nothing is locked, so nothing is reported for the change.
  assert.deepEqual(pipeline.push([new Float32Array(4096)]), []);
});

test('the fine print says what the stage costs, and gives the pipeline\'s own reason when a reading is not shown', () => {
  /** @type {import('../js/dsp/soundstage.js').StageLoad} */
  const load = { seconds: 7.5, readings: 3, lastSeconds: 3.14, lastAudioSeconds: 8.4, longestStepSeconds: 0.01 };
  /** @param {Partial<import('../js/dsp/soundstage.js').SoundsReport>} over @param {string|null} [why] */
  const sounds = (over, why = null) => /** @type {import('../js/dsp/soundstage.js').SoundsReport} */ ({ amplitude: null, beatErrorMs: null, amplitudeWhy: null, beatErrorWhy: null, detail: { why }, ...over });
  assert.equal(stageNote(null, null), '', 'no stage');
  assert.equal(stageNote({ ...load, readings: 0, lastSeconds: null, lastAudioSeconds: null }, sounds({ detail: null })), '', 'no reading yet');
  assert.equal(stageNote(load, null), 'beat sounds read 3 times, last in 3.1 s of computing over 8.4 s');
  // Both on the readout: nothing to add.
  assert.equal(stageNote({ ...load, readings: 1 }, sounds({ amplitude: 288, beatErrorMs: 0.3 })), 'beat sounds read 1 time, last in 3.1 s of computing over 8.4 s');
  assert.match(stageNote(load, sounds({ amplitude: 288, beatErrorWhy: 'irregular' })), / s, beat error held back \(irregular\)$/);
  // The placement check can hold either reading back by itself.
  assert.match(stageNote(load, sounds({ amplitude: 288, beatErrorWhy: 'placement' })), / s, beat error held back \(placement\)$/);
  assert.match(stageNote(load, sounds({ beatErrorMs: 0.3, amplitudeWhy: 'placement' })), / s, amplitude held back \(placement\)$/);
  assert.match(stageNote(load, sounds({ amplitudeWhy: 'failing', beatErrorWhy: 'failing' })), /, both held back \(failing\)$/);
  assert.match(stageNote(load, sounds({ amplitudeWhy: 'no-pair', beatErrorWhy: 'no-pair' }, 'no-pair')), /, no reading \(no-pair\)$/);
});

test('the readout gives the amplitude and the beat error from the sounds inside the beats, each with its scatter, or a dash and the reason in plain words', () => {
  /** @param {Partial<import('../js/dsp/soundstage.js').SoundsReport>} over @returns {ReadingsEvent} */
  const readings = (over) => /** @type {any} */ ({ type: 'readings', t: 60, window: [40, 60], rate: 1, rateSd: 0.1, sounds: { liftAngle: 36, amplitude: null, amplitudeSd: null, amplitudeWhy: null, beatErrorMs: null, beatOffsetMs: null, beatErrorSd: null, beatErrorWhy: null, liftMs: null, liftSd: null, window: null, detail: null, ...over } });
  const dash = { amplitude: '—', amplitudeNote: '', beatError: '—', beatErrorNote: '' };
  // Not locked, no readings, or a pipeline that was given no lift angle: dashes and nothing said.
  assert.deepEqual(soundsReadout(false, readings({ amplitude: 288, amplitudeSd: 1 }), 36), dash);
  assert.deepEqual(soundsReadout(true, null, 36), dash);
  assert.deepEqual(soundsReadout(true, /** @type {any} */ ({ ...readings({}), sounds: null }), 36), dash);
  // Both shown: whole degrees and hundredths of a millisecond, each with its scatter and the
  // stretch of beats it rests on. The Omega's capture after 50 s of beats.
  const both = readings({ amplitude: 288.42, amplitudeSd: 1.14, beatErrorMs: 0.3156, beatOffsetMs: -0.3156, beatErrorSd: 0.0443, window: [8.14, 58.63] });
  assert.deepEqual(soundsReadout(true, both, 36), { amplitude: '288', amplitudeNote: '±1.1° over 50 s', beatError: '0.32', beatErrorNote: '±0.04 over 50 s' });
  // A scatter is never shown as nothing: at least one unit of the last digit.
  const tight = soundsReadout(true, readings({ amplitude: 269.6, amplitudeSd: 0.02, beatErrorMs: 0.4934, beatErrorSd: 0.004, window: [8, 38.4] }), 36);
  assert.deepEqual([tight.amplitude, tight.amplitudeNote, tight.beatError, tight.beatErrorNote], ['270', '±0.1° over 30 s', '0.49', '±0.01 over 30 s']);
  // Waiting for beats; once the source has stopped, they will not come.
  const waiting = readings({ amplitudeWhy: 'waiting', beatErrorWhy: 'waiting' });
  assert.deepEqual(soundsReadout(true, waiting, 36), { amplitude: '—', amplitudeNote: 'needs 15 s of beats', beatError: '—', beatErrorNote: 'needs 15 s of beats' });
  assert.equal(soundsReadout(true, waiting, 36, false).amplitudeNote, 'needed 15 s of beats');
  // The same after the watch changed and the stretch of beats started again.
  const changed = readings({ amplitudeWhy: 'changed', beatErrorWhy: 'changed' });
  assert.deepEqual(soundsReadout(true, changed, 36), { amplitude: '—', amplitudeNote: 'changed: reading again', beatError: '—', beatErrorNote: 'changed: reading again' });
  assert.equal(BEATS_NEEDED_SECONDS, FIRST_READING_SECONDS, 'the words give the stage\'s own figure');
  // An irregular watch keeps its amplitude and loses its beat error.
  const irregular = soundsReadout(true, readings({ amplitude: 269.7, amplitudeSd: 0.84, beatErrorWhy: 'irregular', window: [8, 48] }), 36);
  assert.deepEqual(irregular, { amplitude: '270', amplitudeNote: '±0.8° over 40 s', beatError: '—', beatErrorNote: 'irregular beat' });
  // Every reason the pipeline can give has words, and they are short enough for a narrow column.
  /** @type {import('../js/dsp/soundstage.js').StageWhy[]} */
  const reasons = ['waiting', 'changed', 'few-beats', 'averaged', 'short-stretch', 'few-sounds', 'no-pair', 'lift-range', 'no-middle-sound', 'lined-few-blocks', 'lined-lost', 'lined-far', 'unchecked', 'failing', 'irregular', 'halfway', 'scatter', 'unplaced', 'placement'];
  for (const why of reasons) assert.ok(whyWords(why).length > 5 && whyWords(why).length <= 24 && !whyWords(why).includes('-'), `${why}: "${whyWords(why)}"`);
  assert.equal(whyWords(null), '');
  assert.equal(whyWords('lift-range'), 'check the lift angle');
  assert.equal(whyWords('halfway'), 'check the beat rate');
  assert.equal(whyWords('averaged'), 'beats too faint');
  // An amplitude made with another lift angle than the one now set is not shown: after a run
  // has ended, a new setting leaves a dash. The beat error does not depend on the angle.
  assert.deepEqual(soundsReadout(true, both, 38, false), { amplitude: '—', amplitudeNote: 'lift angle changed', beatError: '0.32', beatErrorNote: '±0.04 over 50 s' });
  // The same in a line of text, as the audio diagnostic gives it.
  assert.deepEqual(soundsInWords(soundsReadout(true, both, 36)), { amplitude: 'amplitude 288° ±1.1° over 50 s', beatError: 'beat error 0.32 ms ±0.04 over 50 s' });
  assert.deepEqual(soundsInWords(soundsReadout(true, waiting, 36, false)), { amplitude: 'amplitude — (needed 15 s of beats)', beatError: 'beat error — (needed 15 s of beats)' });
  assert.deepEqual(soundsInWords(irregular), { amplitude: 'amplitude 270° ±0.8° over 40 s', beatError: 'beat error — (irregular beat)' });
  assert.deepEqual(soundsInWords(dash), { amplitude: 'amplitude —', beatError: 'beat error —' });
});

test('a co-axial set with a Swiss lever\'s lift angle is told so, with the two angles known for Omega calibres', () => {
  assert.equal(liftHint('lever', 52), null);
  assert.equal(liftHint('coaxial', 36), null);
  assert.equal(liftHint('coaxial', 38), null);
  assert.equal(liftHint('coaxial', COAXIAL_LIFT_LIMIT), null);
  const hint = liftHint('coaxial', 52);
  assert.equal(hint, "Lift angle 52° suits a Swiss lever. Co-axials use less: 38° for Omega's 8520 and 8521, 36° reported for the 3861.");
  // Left at 52 degrees, the Omega's 288 degrees would come out as 416, which is not believable.
  assert.ok((288 * 52) / 36 > 330);
});

test('the tick is named only by a difference more than three times its uncertainty: the longer gap after it on a lever, the longer time from unlock to lock on a co-axial', () => {
  assert.equal(NAME_SD, 3);
  // The beats of type 1 fall 0.3 ms late of midway: the longer gap follows type 0.
  assert.equal(tickByGap(0.3, 0.01), 0);
  assert.equal(tickByGap(-0.3, 0.01), 1);
  assert.equal(tickByGap(0.03, 0.01), null, 'three times is not more than three times');
  assert.equal(tickByGap(0.031, 0.01), 0);
  assert.equal(tickByGap(0, 0), null, 'a watch in perfect beat has no tick by this rule');
  assert.equal(tickByGap(0.02, NaN), null);
  // The Omega 3861: 6.92 and 6.33 ms, each to about 0.04 ms.
  assert.equal(tickByLift([6.92, 6.33], [0.03, 0.04]), 0);
  assert.equal(tickByLift([6.31, 6.91], [0.04, 0.03]), 1);
  // The ETA 2836-2: 7.49 and 7.45 ms, within their scatter of each other.
  assert.equal(tickByLift([7.49, 7.45], [0.01, 0.02]), null);
  assert.equal(beatName(0, null), null);
  assert.equal(beatName(1, 1), 'tick');
  assert.equal(beatName(0, 1), 'tock');
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
  // The last case has its first sound 22 ms before its last, the earliest the app's simulator
  // can put it: an amplitude of 150 degrees at 18,000 vph.
  for (const [jitterMs, more] of /** @type {[number, {bph?: number, amplitude?: number}][]} */ ([[0, {}], [3, {}], [3, { bph: 18000, amplitude: 150 }]])) {
    const options = { bph: 21600, rate: 5, beatOffsetMs: 0.5, gain: 1.5, seed: 7, jitterMs, ...more };
    const a = new WatchStream(options);
    const b = new WatchStream(options);
    const whole = a.next(60000)[0];
    const parts = [];
    for (const n of [1, 999, 12000, 30000, 17000]) parts.push(...b.next(n)[0]);
    assert.equal(parts.length, whole.length);
    for (let i = 0; i < whole.length; i++) assert.equal(parts[i], whole[i], `${jitterMs} ms, ${JSON.stringify(more)}: sample ${i}`);
  }
});

test('the simulator\'s amplitude sets how long before its lock each beat\'s unlock comes, for the lift angle it is given, and the app reads that amplitude back at that angle', () => {
  assert.equal(SIMULATED_LIFT_ANGLE, DEFAULTS.liftAngle, 'without one, the lift angle the app starts with');
  // The formula the pipeline reads the amplitude by, the other way round.
  for (const bph of [18000, 21600, 28800, 36000]) {
    for (const amplitude of [150, 270, 330]) {
      assert.ok(Math.abs(amplitudeOf(52, bph, liftSeconds(amplitude, bph) * 1e3) - amplitude) < 1e-9, `${bph} vph, ${amplitude} degrees`);
      for (const lift of [30, 36, 70]) assert.ok(Math.abs(amplitudeOf(lift, bph, liftSeconds(amplitude, bph, lift) * 1e3) - amplitude) < 1e-9, `${bph} vph, ${amplitude} degrees, lift ${lift}`);
    }
  }
  assert.ok(Math.abs(liftSeconds(270, 28800) * 1e3 - 7.675) < 0.001 && Math.abs(liftSeconds(270, 21600) * 1e3 - 10.233) < 0.001);
  // Without an amplitude the sounds stay 7 ms apart whatever the beat rate, as before.
  assert.equal(new WatchStream({ bph: 21600 }).unlockSeconds(), 0.007);
  // The app gives its simulator the lift angle of the settings, and a change of it applies from
  // the next beat: the unlock comes sooner before the lock for a smaller angle.
  const follows = new WatchStream({ bph: 28800, amplitude: 270, liftAngle: 36 });
  assert.equal(follows.unlockSeconds(), liftSeconds(270, 28800, 36));
  assert.ok(Math.abs(follows.unlockSeconds() * 1e3 - 5.309) < 0.001);
  follows.liftAngle = 52;
  assert.equal(follows.unlockSeconds(), liftSeconds(270, 28800));
  // 21,600 vph with the lift angle set to 60 degrees, where 7 ms would read 455 degrees and
  // show a dash: 270 degrees, 0.4 ms out of beat, at the loudness the app's simulator starts
  // with. The simulated watch and the pipeline are given the same angle, as in the app.
  const sim = new WatchStream({ bph: 21600, rate: 8, beatOffsetMs: 0.4, gain: 3, amplitude: 270, liftAngle: 60, seed: 3 });
  const pipeline = new Pipeline(sim.sampleRate, 1, { liftAngle: 60, sounds: { share: Infinity } });
  const readings = /** @type {ReadingsEvent[]} */ (run(pipeline, (n) => sim.next(n), 45).filter((e) => e.type === 'readings' && e.window !== null));
  const made = readings.filter((e) => e.sounds && e.sounds.detail !== null);
  // The first reading, from 15 s of beats, loses the unlock in 14% of its draws and is held
  // back; the readings from 20 s of beats on show both.
  const first = /** @type {NonNullable<ReadingsEvent['sounds']>} */ (made[0].sounds);
  assert.ok(first.window && first.window[1] - first.window[0] < 16, 'the first rests on 15 s of beats');
  assert.ok(first.amplitudeWhy === null || first.amplitudeWhy === 'failing', `first: ${first.amplitudeWhy}`);
  const later = made.filter((e) => e.sounds && e.sounds.window && e.sounds.window[1] - e.sounds.window[0] > 19);
  assert.ok(later.length > 3, 'the sounds were read');
  for (const e of later) {
    const s = /** @type {NonNullable<ReadingsEvent['sounds']>} */ (e.sounds);
    assert.ok(s.amplitude !== null && s.beatErrorMs !== null, `shown at ${e.t.toFixed(1)} s: ${s.amplitudeWhy}, ${s.beatErrorWhy}`);
    assert.ok(Math.abs(s.amplitude - 270) <= 2, `amplitude ${s.amplitude.toFixed(1)}`);
    assert.ok(Math.abs(s.beatErrorMs - 0.4) <= 0.05, `beat error ${s.beatErrorMs.toFixed(3)} ms`);
  }
  // Read at 52 degrees, a watch whose lift angle is 60 gives 52/60 of its swing: an amplitude is
  // only as right as the lift angle. That is why the app's simulator takes the angle set. Its
  // beats from before a change of the setting would be read this way for up to a minute, so
  // the app starts the simulator again instead.
  pipeline.setOptions({ liftAngle: 52 });
  const after = /** @type {ReadingsEvent[]} */ (run(pipeline, (n) => sim.next(n), 1.5).filter((e) => e.type === 'readings')).pop();
  assert.ok(after && after.sounds && after.sounds.amplitude !== null && Math.abs(after.sounds.amplitude - (270 * 52) / 60) <= 2, `at 52 degrees ${after?.sounds?.amplitude}`);
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

test('a lock that carries on a lost one keeps its stretch of the trace, so the drift over the gap shows', () => {
  const m = new Measurement();
  m.start();
  const period = 3600 / 18000;
  const gain = 30 / 86400; // +30 s/day
  const at = (/** @type {number} */ n) => 1 + n * period * (1 - gain) + (n % 2 ? 0.0015 : 0);
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 18000, cyclesAveraged: [1, 1], t: 8 });
  m.apply({ type: 'beats', beats: Array.from({ length: 40 }, (_, n) => beat(n, at(n), /** @type {0|1} */ (n % 2))), replaceFrom: 1 });
  m.apply({ type: 'status', state: 'listening', reason: 'lost', bph: null, cyclesAveraged: null, t: 14 });
  // Found again 10 s later, numbering its beats on from the lost lock's.
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 18000, cyclesAveraged: [1, 1], t: 26, continues: true });
  m.apply({ type: 'beats', beats: Array.from({ length: 20 }, (_, i) => beat(90 + i, at(90 + i), /** @type {0|1} */ (i % 2))), replaceFrom: 18 });
  assert.equal(m.episodes.length, 1, 'one stretch');
  const pts = m.points();
  assert.equal(pts.length, 60);
  for (const p of pts) {
    const n = Math.round((p.t - 1) / period);
    const expected = n * period * gain * 1000 - (p.type === 1 ? 1.5 : 0);
    assert.ok(Math.abs(p.y - expected) < 1e-6, `beat ${n} at ${p.y.toFixed(3)} ms, expected ${expected.toFixed(3)}`);
  }
  // A lock at another beat rate starts a stretch of its own even when it says it carries on.
  m.apply({ type: 'status', state: 'listening', reason: 'lost', bph: null, cyclesAveraged: null, t: 40 });
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 36000, cyclesAveraged: [1, 1], t: 50, continues: true });
  assert.equal(m.episodes.length, 2);
});

test('the trace\'s beats have no names until the readings give them, keep them while the lock carries on, and start without them at a new lock', () => {
  const m = new Measurement();
  m.start();
  /** @param {number} t @param {0|1|null} tick @returns {ReadingsEvent} */
  const readings = (t, tick) => /** @type {any} */ ({ type: 'readings', t, window: [t - 5, t], windowStart: t - 5, windowSeconds: 20, signal: { z: [30, 30], cycles: [1, 1] }, rate: 1, rateSd: 0.1, tick, sounds: null });
  const blank = /** @type {ReadingsEvent} */ (/** @type {any} */ ({ type: 'readings', t: 14, window: null, tick: null, sounds: null }));
  assert.equal(m.tick, null, 'nothing to name before a lock');
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 18000, cyclesAveraged: [1, 1], t: 8 });
  m.apply({ type: 'beats', beats: [beat(0, 1, 0), beat(1, 1.2, 1), beat(2, 1.4, 0), beat(3, 1.6, 1, false)], replaceFrom: 1 });
  m.apply(readings(9, null));
  assert.deepEqual(m.points().map((p) => p.name), [null, null, null, null], 'one colour for both beats');
  assert.match(guidance(m, { running: true, finished: false }), /^Clear beats\.$/);
  // The pipeline names its second kind of beat the tick: every dot of the stretch takes its
  // name, those already drawn too.
  m.apply(readings(10, 1));
  assert.equal(m.tick, 1);
  assert.deepEqual(m.points().map((p) => p.name), ['tock', 'tick', 'tock', 'tick']);
  assert.equal(/** @type {import('../js/ui/model.js').TracePoint} */ (m.lastPoint()).name, 'tock');
  assert.match(guidance(m, { running: true, finished: false }), /^Clear t[io]cks\.$/);
  // The lock is lost: the readings blank, the dots drawn keep their names.
  m.apply({ type: 'status', state: 'listening', reason: 'lost', bph: null, cyclesAveraged: null, t: 14 });
  m.apply(blank);
  assert.deepEqual(m.points().map((p) => p.name), ['tock', 'tick', 'tock', 'tick']);
  // A lock that carries on is the same stretch, with the same names, before its first reading.
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 18000, cyclesAveraged: [1, 1], t: 20, continues: true });
  m.apply({ type: 'beats', beats: [beat(90, 19, 0), beat(91, 19.2, 1)], replaceFrom: 18 });
  assert.equal(m.episodes.length, 1);
  assert.deepEqual(m.points().slice(4).map((p) => p.name), ['tock', 'tick']);
  m.apply(readings(21, 1));
  // A lock that does not carry on numbers its beats afresh, and waits for names of its own.
  m.apply({ type: 'status', state: 'listening', reason: 'lost', bph: null, cyclesAveraged: null, t: 30 });
  m.apply({ type: 'status', state: 'tracking', reason: 'locked', bph: 18000, cyclesAveraged: [1, 1], t: 45 });
  m.apply({ type: 'beats', beats: [beat(0, 44, 0), beat(1, 44.2, 1)], replaceFrom: 44 });
  assert.equal(m.episodes.length, 2);
  assert.equal(m.tick, null);
  assert.deepEqual(m.points().map((p) => p.name), ['tock', 'tick', 'tock', 'tick', 'tock', 'tick', null, null]);
  m.apply(readings(46, 0));
  assert.deepEqual(m.points().slice(6).map((p) => p.name), ['tick', 'tock']);
  // The escapement setting is changed: the pipeline takes the names back until its other rule
  // gives them, and the stretch on screen follows.
  m.apply(readings(47, null));
  assert.deepEqual(m.points().slice(6).map((p) => p.name), [null, null]);
  assert.deepEqual(m.points().slice(0, 6).map((p) => p.name), ['tock', 'tick', 'tock', 'tick', 'tock', 'tick'], 'an earlier stretch keeps its own');
  // Moved to the run's timeline after an interruption, a reading keeps its names.
  assert.equal(/** @type {ReadingsEvent} */ (shiftEvent(readings(10, 1), 30)).tick, 1);
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
  // The second kind of beat is the tock when the first is the tick, the tick when the pipeline
  // says so, and neither until it has said.
  assert.equal(averagingNote(readings([10, 14], [1, 2]), 0), 'Tock dots average 2 cycles.');
  assert.equal(averagingNote(readings([10, 14], [1, 2]), 1), 'Tick dots average 2 cycles.');
  assert.equal(averagingNote(readings([10, 14], [1, 2])), 'Every other dot averages 2 cycles.');
  assert.equal(averagingNote(readings([10, 14], [3, 2]), 1), 'Tick dots average 2 cycles. Tock dots average 3 cycles.');
  assert.equal(averagingNote(readings([10, 14], [3, 2])), "The dots of one beat average 3 cycles, the other's 2.");
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
  // The fainter beat is named once the pipeline has named the tick, and until then it is the
  // other beat.
  m.apply({ ...readings([30, 12], [1, 3]), tick: null });
  assert.equal(guidance(m, { running: true, finished: false }), 'Clear beats. Every other beat is fainter and is averaged over 3 cycles.');
  m.apply({ ...readings([30, 12], [1, 3]), tick: 1 });
  assert.equal(guidance(m, { running: true, finished: false }), 'Clear tocks. The ticks are fainter and are averaged over 3 cycles.');
  m.apply({ ...readings([5, 6], [4, 8]), tick: null });
  assert.equal(guidance(m, { running: true, finished: false }), "Faint beats: the dots of one beat average 4 cycles (1.3 s) and the other's 8. Firmer contact with the case would help.");
  m.apply({ ...readings([5, 6], [4, 8]), tick: 0 });
  assert.equal(guidance(m, { running: true, finished: false }), 'Faint beats: tick dots average 4 cycles (1.3 s) and tock dots 8. Firmer contact with the case would help.');
});

test('stored settings are checked, and anything invalid falls back to the default', () => {
  assert.deepEqual(clean({}), DEFAULTS);
  assert.deepEqual(clean({ bph: '36000', escapement: 'coaxial', liftAngle: '50', humHz: '50', averagingSeconds: '60', sensitivity: 'high' }), {
    bph: 36000,
    escapement: 'coaxial',
    liftAngle: 50,
    humHz: 50,
    averagingSeconds: 60,
    sensitivity: 'high',
    microphoneId: '',
    magnetNoticeSeen: false,
    saveMinutes: 1,
    mode: 'continuous',
    theme: 'auto',
  });
  assert.deepEqual(clean({ bph: 12345, escapement: 'tourbillon', liftAngle: 5, humHz: 55, averagingSeconds: 15, sensitivity: 'max' }), DEFAULTS);
});

test('the theme follows the phone unless light or dark is chosen, and both ways of reaching dark give the same colours', () => {
  assert.equal(DEFAULTS.theme, 'auto');
  assert.equal(clean({ theme: 'light' }).theme, 'light');
  assert.equal(clean({ theme: 'dark' }).theme, 'dark');
  assert.equal(clean({ theme: 'blue' }).theme, 'auto');
  // The style sheet's dark colours come twice: for the phone's dark setting with no theme chosen,
  // and for dark chosen. They must be the same, and cover every colour the light theme sets.
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const block = (/** @type {RegExp} */ re) => {
    const m = re.exec(css);
    assert.ok(m, `found ${re}`);
    return m[1].split(';').map((d) => d.trim()).filter(Boolean).sort();
  };
  const light = block(/^:root \{([^}]*)\}/m);
  const phoneDark = block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/);
  const chosenDark = block(/^:root\[data-theme="dark"\] \{([^}]*)\}/m);
  assert.deepEqual(chosenDark, phoneDark);
  const names = (/** @type {string[]} */ ds) => ds.map((d) => d.split(':')[0]).filter((n) => n !== '--font' && n !== '--mono');
  assert.deepEqual(names(phoneDark), names(light));
  // index.html applies a stored choice before the page is drawn, from where the settings are kept.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes(`localStorage.getItem('${SETTINGS_KEY}')`), 'index.html reads the settings key');
  assert.ok(html.indexOf('dataset.theme') < html.indexOf('css/app.css'), 'before the style sheet loads');
});
