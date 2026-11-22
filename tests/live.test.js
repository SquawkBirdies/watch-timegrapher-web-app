// Milestone 6: the live microphone. The browser's microphone is replaced by a stand-in that
// delivers chunks and reports interruptions the way the capture module does, so that keeping the
// last minute of audio, noticing interruptions, resuming after them and placing each segment on
// the run's timeline can be checked here. Opening a real microphone is checked in a browser
// with a simulated input.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AudioRing } from '../js/audio/ring.js';
import { LiveInput, KEEP_SECONDS, SILENCE_SECONDS } from '../js/audio/live.js';
import { synthesizeWatch } from '../js/audio/simulator.js';
import { Pipeline } from '../js/dsp/pipeline.js';
import { Measurement, shiftEvent, guidance, stateText, microphoneProblem, describeInput, formatDuration, saveLabel, recordingMegabytes } from '../js/ui/model.js';
import { clean, DEFAULTS, SAVE_MINUTES } from '../js/store.js';
import { stream } from './helpers/stream.js';

/**
 * @typedef {import('../js/dsp/pipeline.js').PipelineEvent} PipelineEvent
 * @typedef {import('../js/dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 */

/**
 * A stand-in for the capture module: `open` behaves like `openMicrophone`, and the test drives
 * the chunks and the reports.
 * @param {number} sampleRate
 */
function fakeMicrophone(sampleRate) {
  /** @type {{chunk: (samples: Float32Array) => void, change: (what: string) => void}} */
  const drive = { chunk: () => {}, change: () => {} };
  const capture = {
    context: { state: 'running', sampleRate, resume: async () => {} },
    track: { readyState: 'live' },
    settings: { sampleRate },
    label: 'Test microphone',
    /** @type {import('../js/audio/capture.js').CaptureOptions[]} */
    replaced: [],
    failReplace: false,
    stopped: false,
    /** @type {import('../js/audio/capture.js').CaptureOptions|null} */
    options: null,
    /** @param {import('../js/audio/capture.js').CaptureOptions} o */
    replaceStream: async (o) => {
      if (capture.failReplace) throw new Error('no microphone');
      capture.replaced.push(o);
      capture.track = { readyState: 'live' };
    },
    stop: async () => {
      capture.stopped = true;
    },
  };
  /**
   * @param {import('../js/audio/capture.js').CaptureOptions} options
   * @param {(chunk: {channels: Float32Array[]}) => void} onChunk
   * @param {(what: string) => void} onChange
   */
  const open = async (options, onChunk, onChange) => {
    capture.options = options;
    drive.chunk = (samples) => onChunk({ channels: [samples] });
    drive.change = onChange;
    return capture;
  };
  return { capture, drive, open: /** @type {any} */ (open) };
}

/** Handlers that record what they were told. */
function recorder() {
  const log = /** @type {string[]} */ ([]);
  let frames = 0;
  return {
    log,
    get frames() {
      return frames;
    },
    handlers: {
      /** @param {Float32Array[]} channels */
      onAudio: (channels) => {
        frames += channels[0].length;
        log.push('audio');
      },
      /** @param {string} reason */
      onInterrupt: (reason) => log.push(`interrupt ${reason}`),
      onResume: () => log.push('resume'),
      /** @param {string} message */
      onEnd: (message) => log.push(`end ${message}`),
    },
  };
}

/** @param {number} n @param {number} [seed] */
function noise(n, seed = 1) {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = (s / 2147483648 - 0.5) * 1e-3;
  }
  return out;
}

// ---- Keeping the last minute -----------------------------------------------------------------

test('the audio ring keeps the most recent samples in order, across wrap-arounds and long pushes', () => {
  const ring = new AudioRing(1, 10);
  assert.equal(ring.capacity, 10);
  assert.deepEqual(Array.from(ring.read()), []);
  ring.push(Float32Array.from([1, 2, 3, 4]));
  assert.deepEqual(Array.from(ring.read()), [1, 2, 3, 4]);
  ring.push(Float32Array.from([5, 6, 7, 8, 9, 10, 11, 12]));
  assert.deepEqual(Array.from(ring.read()), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(ring.seconds, 1);
  ring.push(Float32Array.from({ length: 25 }, (_, i) => 100 + i));
  assert.deepEqual(Array.from(ring.read()), [115, 116, 117, 118, 119, 120, 121, 122, 123, 124], 'a push longer than the ring keeps its end');
  ring.push([7, 8]);
  assert.deepEqual(Array.from(ring.read()), [117, 118, 119, 120, 121, 122, 123, 124, 7, 8], 'plain arrays too');
  ring.clear();
  assert.equal(ring.length, 0);
  ring.push(Float32Array.from([1]));
  assert.deepEqual(Array.from(ring.read()), [1]);

  // A longer length keeps everything held and fills up from there; a shorter one keeps the
  // most recent part.
  const longer = new AudioRing(1, 4);
  longer.push(Float32Array.from([1, 2, 3, 4, 5, 6]));
  longer.resize(2);
  assert.equal(longer.capacity, 8);
  assert.deepEqual(Array.from(longer.read()), [3, 4, 5, 6]);
  longer.push(Float32Array.from([7, 8, 9, 10, 11]));
  assert.deepEqual(Array.from(longer.read()), [4, 5, 6, 7, 8, 9, 10, 11]);
  longer.resize(0.75);
  assert.deepEqual(Array.from(longer.read()), [9, 10, 11]);
  longer.push(Float32Array.from([12]));
  assert.deepEqual(Array.from(longer.read()), [10, 11, 12]);
});

// ---- Interruptions ---------------------------------------------------------------------------

test('a run of exact silence after sound is an interruption, and the sound coming back starts a new segment after the gap', async () => {
  const fs = 48000;
  const mic = fakeMicrophone(fs);
  const r = recorder();
  let clock = 0;
  const input = new LiveInput(r.handlers, { open: mic.open, now: () => clock });
  await input.open('chosen-input');
  assert.deepEqual(mic.capture.options, { deviceId: 'chosen-input', deviceExact: false }, 'a remembered input falls back to the default when it is gone');
  const chunk = fs / 10;

  for (let i = 0; i < 10; i++) mic.drive.chunk(noise(chunk, i + 1));
  assert.equal(r.frames, fs);
  assert.ok(Math.abs(input.position() - 1) < 1e-9);
  assert.ok(Math.abs(input.recordedSeconds - 1) < 1e-9);

  // Silence shorter than the limit is passed on: it could be a pause in the data, and the
  // pipeline judges it.
  clock = 1000;
  const shortSilence = Math.floor((SILENCE_SECONDS * fs) / chunk);
  for (let i = 0; i < shortSilence - 1; i++) mic.drive.chunk(new Float32Array(chunk));
  assert.ok(!r.log.some((x) => x.startsWith('interrupt')));
  mic.drive.chunk(new Float32Array(chunk));
  assert.deepEqual(r.log.filter((x) => x !== 'audio'), ['interrupt silence']);
  const stoppedAt = 1 + (shortSilence - 1) * 0.1;
  assert.ok(Math.abs(input.position() - stoppedAt) < 1e-9, 'the interruption begins where the audio stopped');

  // While interrupted nothing is passed on, and the clock moves the timeline on.
  const before = r.frames;
  clock = 3500;
  mic.drive.chunk(new Float32Array(chunk));
  assert.equal(r.frames, before);
  assert.ok(Math.abs(input.position() - (stoppedAt + 2.5)) < 1e-9);
  assert.ok(input.recording() !== null, 'the audio before the interruption can still be saved');

  mic.drive.chunk(noise(chunk, 99));
  assert.deepEqual(r.log.slice(-2), ['resume', 'audio'], 'the new segment begins before its first audio is passed on');
  assert.ok(Math.abs(input.segmentStart - (stoppedAt + 2.5)) < 1e-9);
  assert.ok(Math.abs(input.position() - (stoppedAt + 2.6)) < 1e-9);
  assert.ok(Math.abs(input.recordedSeconds - 0.1) < 1e-9, 'what is kept starts again with the new segment');
  assert.equal(input.interruptions, 1);

  // Silence before any sound, as when a microphone starts up, is not an interruption.
  const quiet = new LiveInput(recorder().handlers, { open: fakeMicrophone(fs).open, now: () => 0 });
  await quiet.open();
  const q = /** @type {any} */ (quiet).capture;
  assert.ok(q);
  for (let i = 0; i < 20; i++) quiet.chunk([new Float32Array(chunk)]);
  assert.equal(quiet.interrupted, '');
  assert.ok(Math.abs(quiet.position() - 2) < 1e-9);
});

test('a muted microphone, suspended audio and a closed or lost microphone are handled as the capture reports them', async () => {
  const fs = 44100;
  const mic = fakeMicrophone(fs);
  const r = recorder();
  const input = new LiveInput(r.handlers, { open: mic.open, now: () => 0, visible: () => true });
  await input.open();
  mic.drive.chunk(noise(4096));

  // Muted: no resuming while the microphone stays muted, even if something arrives.
  mic.drive.change('microphone muted');
  assert.equal(input.interrupted, 'muted');
  mic.drive.chunk(noise(4096, 2));
  assert.ok(!r.log.includes('resume'));
  mic.drive.change('microphone unmuted');
  mic.drive.chunk(noise(4096, 3));
  assert.deepEqual(r.log.slice(-2), ['resume', 'audio']);

  // The system holds the audio (a call): it resumes once the audio runs again and sound arrives.
  mic.drive.change('audio interrupted');
  assert.equal(input.interrupted, 'interrupted');
  mic.capture.context.state = 'interrupted';
  mic.drive.chunk(noise(4096, 4));
  assert.equal(r.log.filter((x) => x === 'resume').length, 1);
  mic.capture.context.state = 'running';
  mic.drive.change('audio running');
  mic.drive.chunk(noise(4096, 5));
  assert.equal(r.log.filter((x) => x === 'resume').length, 2);

  // The microphone taken away while the page is on screen: it is reopened at once.
  mic.capture.track.readyState = 'ended';
  mic.drive.change('microphone ended');
  assert.equal(input.interrupted, 'ended');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mic.capture.replaced.length, 1);
  mic.drive.chunk(noise(4096, 6));
  assert.equal(r.log.filter((x) => x === 'resume').length, 3);

  // When it cannot be reopened, the run ends with a message.
  mic.capture.failReplace = true;
  mic.capture.track.readyState = 'ended';
  mic.drive.change('microphone ended');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(r.log[r.log.length - 1], /^end The microphone was closed/);
  assert.ok(input.closed && mic.capture.stopped);

  // An audio context closed by the system ends the run too.
  const mic2 = fakeMicrophone(fs);
  const r2 = recorder();
  const input2 = new LiveInput(r2.handlers, { open: mic2.open, now: () => 0 });
  await input2.open();
  mic2.drive.change('audio closed');
  assert.match(r2.log[r2.log.length - 1], /^end /);
  assert.ok(input2.closed && mic2.capture.stopped);

  // Closing it ourselves reports nothing.
  const mic3 = fakeMicrophone(fs);
  const r3 = recorder();
  const input3 = new LiveInput(r3.handlers, { open: mic3.open, now: () => 0 });
  await input3.open();
  input3.close();
  mic3.drive.change('audio closed');
  assert.deepEqual(r3.log, []);
});

test('the length kept for saving can be set before the microphone opens and changed while it runs', async () => {
  const fs = 1000;
  const mic = fakeMicrophone(fs);
  const input = new LiveInput(recorder().handlers, { open: mic.open, now: () => 0 });
  input.keep(120);
  await input.open();
  for (let i = 0; i < 150; i++) mic.drive.chunk(noise(fs, i + 1));
  assert.equal(input.recordedSeconds, 120, 'two minutes kept of two and a half heard');
  const before = /** @type {{channels: Float32Array[]}} */ (input.recording()).channels[0];
  input.keep(300);
  assert.equal(input.recordedSeconds, 120, 'a longer length cannot bring back what was dropped');
  for (let i = 0; i < 30; i++) mic.drive.chunk(noise(fs, 200 + i));
  assert.equal(input.recordedSeconds, 150, 'and fills up from there');
  input.keep(60);
  const after = /** @type {{channels: Float32Array[]}} */ (input.recording()).channels[0];
  assert.equal(after.length, 60 * fs);
  // 180 one-second chunks were heard; the minute kept starts with the 121st, made with seed 121.
  assert.deepEqual(after.subarray(0, fs), noise(fs, 121), 'the most recent minute is kept');
  assert.ok(before.length === 120 * fs);
  // Closing keeps what was held, and the length can still change.
  input.close();
  input.keep(300);
  assert.equal(input.recordedSeconds, 60);
});

test('the save button and its note describe the length kept', () => {
  assert.deepEqual(SAVE_MINUTES, [1, 2, 5]);
  assert.equal(saveLabel(1), 'Save the last minute');
  assert.equal(saveLabel(5), 'Save the last 5 minutes');
  assert.equal(formatDuration(45.9), '45 s');
  assert.equal(formatDuration(60), '1 min');
  assert.equal(formatDuration(97), '1 min 37 s');
  assert.equal(formatDuration(300), '5 min');
  // The file is the samples, four bytes each at 48 kHz, and a 58-byte header.
  assert.ok(Math.abs(recordingMegabytes(60, 48000) - 11.520058) < 1e-9);
  assert.ok(Math.abs(recordingMegabytes(300, 48000) - 57.600058) < 1e-9);
});

test('switching input or restarting starts the timeline and the kept audio again', async () => {
  const fs = 48000;
  const mic = fakeMicrophone(fs);
  const r = recorder();
  const input = new LiveInput(r.handlers, { open: mic.open, now: () => 0 });
  await input.open();
  for (let i = 0; i < 5; i++) mic.drive.chunk(noise(4800, i + 1));
  assert.ok(input.position() > 0.49);
  await input.switchInput('earbuds');
  assert.deepEqual(mic.capture.replaced, [{ deviceId: 'earbuds', deviceExact: false }]);
  assert.equal(input.position(), 0);
  assert.equal(input.recording(), null);
  mic.drive.chunk(noise(4800, 9));
  assert.ok(Math.abs(input.position() - 0.1) < 1e-9);
});

// ---- A live run with an interruption, end to end ----------------------------------------------

test('a live run blanks its readings when the microphone is cut off, locks again after the gap, and its saved minute replays to the same reading', async () => {
  const fs = 48000;
  const truth = { bph: 28800, rate: 12, beatOffsetMs: 0.3 };
  const w = synthesizeWatch({ ...truth, gain: 1.6, seconds: 75, sampleRate: fs, seed: 61 });
  const audio = w.channels[0];
  const gap = [25, 27]; // seconds of the source cut off to exact silence
  const mic = fakeMicrophone(fs);
  let clock = 0;
  const measurement = new Measurement();
  /** @type {Pipeline|null} */
  let pipeline = null;
  let offset = 0;
  /** @type {ReadingsEvent|null} */
  let lastReadings = null;
  /** @type {number|null} */
  let blankAt = null;
  const input = new LiveInput(
    {
      // As the screen does it: each segment has its own pipeline, whose events are moved to
      // the run's timeline.
      onAudio: (channels) => {
        if (!pipeline) pipeline = new Pipeline(fs, 1, {});
        for (const e of pipeline.push(channels)) {
          const shifted = shiftEvent(e, offset);
          measurement.apply(shifted);
          if (shifted.type === 'readings') lastReadings = shifted;
        }
        measurement.setPosition(input.position());
      },
      onInterrupt: () => {
        pipeline = null;
        measurement.interrupt();
        blankAt = input.position();
      },
      onResume: () => {
        offset = input.segmentStart;
      },
      onEnd: () => assert.fail('the run should not end'),
    },
    { open: mic.open, now: () => clock },
  );
  measurement.start();
  await input.open();

  const chunk = 4096;
  /** @type {number|null} */
  let readingsDuringGap = null;
  for (let i = 0; i < audio.length; i += chunk) {
    const end = Math.min(audio.length, i + chunk);
    const t = i / fs;
    clock = (end / fs) * 1000;
    const samples = audio.slice(i, end);
    if (t >= gap[0] && t < gap[1]) samples.fill(0);
    mic.drive.chunk(samples);
    if (t > gap[0] + 1 && t < gap[1] - 0.2 && readingsDuringGap === null) readingsDuringGap = measurement.readings === null ? 0 : 1;
  }

  assert.equal(input.interruptions, 1);
  assert.ok(blankAt !== null && Math.abs(blankAt - (gap[0] + SILENCE_SECONDS)) < 0.1, `cut off at ${blankAt}`);
  assert.equal(readingsDuringGap, 0, 'no readings are shown while the microphone is cut off');
  assert.ok(Math.abs(input.segmentStart - gap[1]) < 0.1, `the second segment starts at ${input.segmentStart.toFixed(2)} s, where the sound came back`);
  const points = measurement.points();
  // Before the silence is long enough to count, the tracker may still place a dim dot or two in
  // it where a beat was due; no confident dot falls in the gap.
  assert.ok(!points.some((p) => p.ok && p.t > gap[0] + 0.01 && p.t < gap[1]), 'the trace has a gap where the sound was cut off');
  assert.ok(points.filter((p) => p.t > gap[0] + 0.01 && p.t < gap[1]).length <= 3);
  assert.ok(points.some((p) => p.t > gap[1] + 25), 'and continues after it');
  assert.equal(measurement.state, 'tracking', 'locked again after the gap');
  const live = /** @type {ReadingsEvent} */ (/** @type {unknown} */ (lastReadings));
  assert.ok(live && live.rate !== null && live.rateSd !== null);
  assert.ok(/** @type {[number, number]} */ (live.window)[0] > gap[1], 'the readings after the gap use only audio after it');
  assert.ok(Math.abs(live.rate - truth.rate) <= 3 * live.rateSd + 0.05, `live ${live.rate.toFixed(2)} ± ${live.rateSd.toFixed(2)}`);

  // The saved recording is the last minute since the interruption, exactly as it was analysed:
  // replayed in other chunk sizes it gives the same reading.
  const saved = /** @type {{sampleRate: number, channels: Float32Array[]}} */ (input.recording());
  const segmentSeconds = (audio.length - Math.round(gap[1] * fs)) / fs;
  assert.ok(Math.abs(saved.channels[0].length / fs - Math.min(KEEP_SECONDS, segmentSeconds)) < 0.1);
  const tail = audio.subarray(audio.length - saved.channels[0].length);
  assert.deepEqual(saved.channels[0], tail, 'kept sample for sample');
  const replay = stream(saved.channels, saved.sampleRate, { chunk: 1000 });
  const again = /** @type {ReadingsEvent} */ (replay.last);
  assert.ok(again.rate !== null);
  assert.ok(Math.abs(again.rate - live.rate) < 0.1, `replay ${again.rate.toFixed(3)} against live ${live.rate.toFixed(3)}`);
});

// ---- What the screen says --------------------------------------------------------------------

test('events move to the run timeline, and an interruption blanks the readings but keeps the trace', () => {
  const beats = { type: /** @type {const} */ ('beats'), beats: [{ n: 4, t: 1.5, type: /** @type {0} */ (0), confidence: 30, ok: true, cycles: 1 }], replaceFrom: 1.25 };
  assert.deepEqual(shiftEvent(beats, 10), { ...beats, beats: [{ ...beats.beats[0], t: 11.5 }], replaceFrom: 11.25 });
  assert.equal(shiftEvent(beats, 0), beats);
  assert.equal(/** @type {any} */ (shiftEvent({ ...beats, replaceFrom: null }, 2)).replaceFrom, null);
  const status = { type: /** @type {const} */ ('status'), state: /** @type {const} */ ('tracking'), reason: 'locked', bph: 28800, cyclesAveraged: [1, 1], t: 9 };
  assert.equal(/** @type {any} */ (shiftEvent(status, 3)).t, 12);
  const readings = /** @type {any} */ ({ type: 'readings', t: 9, window: [1, 9], rate: 4 });
  assert.deepEqual(/** @type {any} */ (shiftEvent(readings, 3)).window, [4, 12]);
  assert.equal(/** @type {any} */ (shiftEvent({ ...readings, window: null }, 3)).window, null);
  assert.equal(/** @type {any} */ (shiftEvent(/** @type {any} */ ({ type: 'waveform', t: 9, from: -0.01, to: 0.01 }), 3)).t, 12);

  const m = new Measurement();
  m.start();
  m.apply(status);
  m.apply(beats);
  m.apply(readings);
  m.interrupt();
  assert.equal(m.state, 'listening');
  assert.equal(m.readings, null);
  assert.equal(m.points().length, 1, 'the trace keeps its dots');
  const src = { running: true, finished: false, interrupted: true };
  assert.equal(stateText(m, src), 'Interrupted');
  assert.match(guidance(m, src), /interrupted/);
  assert.match(guidance(m, { running: true, finished: false, resumed: true }), /back after an interruption/);
  assert.equal(stateText(m, { running: true, finished: false, resumed: true }), 'No lock · listening');

  // Stopped by the user: said plainly, and the last numbers are explained.
  assert.equal(stateText(m, { running: false, finished: false }), 'Stopped');
  assert.match(guidance(m, { running: false, finished: false }), /^Stopped\. Press Start/);
  m.apply(status);
  assert.equal(stateText(m, { running: false, finished: false }), 'Stopped');
  assert.match(guidance(m, { running: false, finished: false }), /last reading/);
  assert.equal(stateText(new Measurement(), { running: false, finished: false }), 'Not running');
});

test('microphone problems and inputs are described in plain words', () => {
  /** @param {string} name */
  const error = (name) => Object.assign(new Error('x'), { name });
  assert.match(microphoneProblem(error('NotAllowedError')), /not allowed/);
  assert.match(microphoneProblem(error('NotFoundError')), /No microphone/);
  assert.match(microphoneProblem(error('NotReadableError')), /in use/);
  assert.match(microphoneProblem(new Error('boom')), /could not be opened: boom/);
  assert.deepEqual(describeInput('iPhone Microphone', 48000), { text: 'iPhone Microphone · 48 kHz', bluetooth: false });
  assert.equal(describeInput('', 44100).text, 'Microphone · 44.1 kHz');
  assert.ok(describeInput('AirPods Pro', 24000).bluetooth);
  assert.ok(describeInput('Headset', 16000).bluetooth, 'a 16 kHz input is treated as Bluetooth');
  assert.match(describeInput('AirPods Pro', 24000).text, /experimental/);
});

test('the chosen microphone and the magnetism notice are remembered, and invalid values are not', () => {
  assert.equal(DEFAULTS.microphoneId, '');
  assert.equal(DEFAULTS.magnetNoticeSeen, false);
  assert.equal(clean({ microphoneId: 'abc', magnetNoticeSeen: true }).microphoneId, 'abc');
  assert.equal(clean({ microphoneId: 'abc', magnetNoticeSeen: true }).magnetNoticeSeen, true);
  assert.equal(clean({ microphoneId: 7, magnetNoticeSeen: 'yes' }).microphoneId, '');
  assert.equal(clean({ microphoneId: 'x'.repeat(300) }).microphoneId, '');
  assert.equal(clean({ magnetNoticeSeen: 'yes' }).magnetNoticeSeen, false);
  assert.equal(DEFAULTS.saveMinutes, 1);
  assert.equal(clean({ saveMinutes: '5' }).saveMinutes, 5);
  assert.equal(clean({ saveMinutes: 3 }).saveMinutes, 1);
});
