// Start-up and wiring of the timegrapher screen. A source (the microphone, the simulator, a demo
// recording or the user's own file) is sent to the pipeline in a worker as it arrives, or paced
// in real time for the simulator and recordings; the worker's events update the measurement
// model, and the screen is redrawn from the model.

import { Measurement, formatRate, formatMs, formatBph, signalLevel, averagingNote, guidance, stateText, irregularWarning, shiftEvent, microphoneProblem, describeInput, formatDuration, saveLabel, recordingMegabytes } from './ui/model.js';
import { TraceView } from './ui/trace.js';
import { WaveformView } from './ui/waveform.js';
import { ScreenWake } from './ui/wake.js';
import { offerFile, stampedName } from './ui/save.js';
import { WatchStream } from './audio/simulator.js';
import { decodeRecording, RecordingSource } from './audio/file-source.js';
import { Player } from './audio/player.js';
import { LiveInput } from './audio/live.js';
import { listMicrophones } from './audio/capture.js';
import { encodeWav } from './audio/wav.js';
import { POSITION_ICONS } from './ui/position-icons.js';
import { POSITIONS, positionName, readiness, takeReading, withReading, nextPosition, summarise, describeReading, describeSummary, positionStep, isUncertain, emptyLog, isPosition } from './ui/positions.js';
import { loadSettings, saveSettings, clean, loadLog, saveLog, BEAT_RATES, AVERAGING_CHOICES, SAVE_MINUTES } from './store.js';

/**
 * @typedef {import('./audio/file-source.js').Recording} Recording
 * @typedef {import('./dsp/pipeline.js').PipelineEvent} PipelineEvent
 * @typedef {import('./dsp/session.js').Load} Load
 * @typedef {import('./dsp/estimate.js').Escapement} Escapement
 * @typedef {import('./ui/positions.js').PositionId} PositionId
 */

/** The recordings in the repository's test fixtures, served from the same site. */
const DEMOS = [
  { id: 'eta', name: 'ETA 2836-2', detail: 'Phone against the case. 64 s, 12 MB.', url: 'tests/fixtures/eta-2836-2.wav', escapement: /** @type {Escapement} */ ('lever') },
  { id: 'omega', name: 'Omega 3861', detail: 'Co-axial escapement, faint ticks. 62 s, 12 MB.', url: 'tests/fixtures/omega-3861.wav', escapement: /** @type {Escapement} */ ('coaxial') },
  { id: 'omega-b', name: 'Omega 3861, second recording', detail: 'Co-axial, phone held over the dial. 76 s, 15 MB.', url: 'tests/fixtures/omega-3861-b.wav', escapement: /** @type {Escapement} */ ('coaxial') },
];

/** Seconds of trace shown while a source runs. */
const TRACE_SECONDS = 30;
/** Chunks the pipeline may have waiting before a replay pauses for it. */
const MAX_BACKLOG = 3;
/** Seconds of microphone audio the pipeline may have waiting before the measurement stops: the
 *  microphone cannot wait, so a device too slow to keep up would fall further and further
 *  behind. */
const LIVE_MAX_BACKLOG_SECONDS = 8;

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const ui = {
  state: $('state'),
  rate: $('rate'),
  rateWhy: $('rate-why'),
  numRate: $('num-rate'),
  beatError: $('beat-error'),
  beatErrorWhy: $('beat-error-why'),
  irregular: $('irregular'),
  irregularText: $('irregular-text'),
  numBeatError: $('num-beat-error'),
  sub: $('sub'),
  trace: /** @type {HTMLCanvasElement} */ ($('trace')),
  traceCaption: $('trace-caption'),
  meter: $('meter'),
  meterFill: $('meter-fill'),
  meterLabel: $('meter-label'),
  signalZ: $('signal-z'),
  guidance: $('guidance'),
  levels: $('levels'),
  waveform: /** @type {HTMLCanvasElement} */ ($('waveform')),
  waveCaption: $('wave-caption'),
  simBph: /** @type {HTMLSelectElement} */ ($('sim-bph')),
  simRate: /** @type {HTMLInputElement} */ ($('sim-rate')),
  simBe: /** @type {HTMLInputElement} */ ($('sim-be')),
  simGain: /** @type {HTMLInputElement} */ ($('sim-gain')),
  simJitter: /** @type {HTMLInputElement} */ ($('sim-jitter')),
  demos: $('demos'),
  file: /** @type {HTMLInputElement} */ ($('file')),
  fileInfo: $('file-info'),
  speedRow: $('speed-row'),
  speed: $('speed'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  progressText: $('progress-text'),
  micInput: /** @type {HTMLSelectElement} */ ($('mic-input')),
  micInfo: $('mic-info'),
  micWake: $('mic-wake'),
  micKeep: /** @type {HTMLSelectElement} */ ($('mic-keep')),
  micSave: /** @type {HTMLButtonElement} */ ($('mic-save')),
  micSaveInfo: $('mic-save-info'),
  magnet: /** @type {HTMLDialogElement} */ ($('magnet')),
  magnetContinue: $('magnet-continue'),
  dockSource: $('dock-source'),
  dockDetail: $('dock-detail'),
  start: /** @type {HTMLButtonElement} */ ($('start')),
  settings: /** @type {HTMLDialogElement} */ ($('settings')),
  settingsForm: /** @type {HTMLFormElement} */ ($('settings-form')),
  settingsRestart: $('settings-restart'),
  mode: $('mode'),
  positions: $('positions'),
  positionsCount: $('positions-count'),
  positionStep: $('position-step'),
  positionStepIcon: $('position-step-icon'),
  savePosition: /** @type {HTMLButtonElement} */ ($('save-position')),
  positionList: $('position-list'),
  sumAverage: $('sum-average'),
  sumAverageNote: $('sum-average-note'),
  sumSpread: $('sum-spread'),
  sumSpreadNote: $('sum-spread-note'),
  sumBeatError: $('sum-beat-error'),
  sumBeatErrorNote: $('sum-beat-error-note'),
  sumLeftOut: $('sum-left-out'),
  newLog: $('new-log'),
  logInfo: $('log-info'),
  newLogDialog: /** @type {HTMLDialogElement} */ ($('new-log-dialog')),
  newLogText: $('new-log-text'),
  newLogConfirm: $('new-log-confirm'),
};

let settings = loadSettings();
/** @typedef {'microphone'|'simulator'|'demo'|'file'} SourceKind */
/** @type {SourceKind} */
let tab = 'microphone';
let demoId = DEMOS[0].id;
/** @type {{name: string, recording: Recording}|null} */
let userFile = null;
/** @type {Map<string, Recording>} */
const demoCache = new Map();
let speed = 1;
/** The six-position log, and the position the next reading is saved as: the first without a
 *  reading, until the user taps another. */
let log = loadLog();
/** @type {PositionId|null} */
let target = nextPosition(log);

/**
 * What is running, or ran last.
 * @typedef {Object} Run
 * @property {SourceKind} kind
 * @property {string} name
 * @property {number|null} duration seconds, for recordings
 * @property {number} sampleRate
 * @property {Escapement} escapement
 * @property {boolean} running
 * @property {boolean} ended the source has no more audio
 * @property {boolean} finished the recording reached its end and the pipeline has heard all of it
 * @property {boolean} stopping Stop was pressed and the pipeline is still analysing audio handed
 *   to it before then; the run ends when it has answered every chunk
 * @property {number} fed frames sent to the pipeline
 * @property {number} posted chunks sent to the pipeline
 * @property {number} answered chunks the pipeline has finished with
 * @property {number} offset seconds on the run's timeline where the pipeline's time starts; the
 *   microphone restarts the pipeline after each interruption
 * @property {boolean} interrupted the microphone is interrupted
 * @property {boolean} resumed the microphone came back after an interruption, and the pipeline
 *   has not locked since
 * @property {number} interruptions so far
 * @property {PositionId|null} savedAs the position this run's reading was saved as; a run's
 *   reading is saved once at most
 */
/** @type {Run|null} */
let run = null;
/** @type {Player|null} */
let player = null;
/** @type {WatchStream|null} */
let simulator = null;
/** The microphone of the current or last microphone run; kept after stopping, for saving.
 *  @type {LiveInput|null} */
let live = null;
let saveMessage = '';
let sessionId = 0;
let loading = '';
/** @type {Load|null} */
let load = null;
let inputPeak = 0;
let problem = '';

const measurement = new Measurement();
const traceView = new TraceView(ui.trace);
const waveView = new WaveformView(ui.waveform);
const worker = new Worker(new URL('./dsp/worker.js', import.meta.url), { type: 'module' });
const wake = new ScreenWake();

worker.onmessage = (event) => {
  const m = event.data;
  if (m.type === 'events') {
    if (m.id !== sessionId || !run) return;
    for (const e of /** @type {PipelineEvent[]} */ (m.events)) measurement.apply(shiftEvent(e, run.offset));
    if (measurement.state === 'tracking') run.resumed = false;
    load = m.load;
    run.answered++;
    finishIfDone(run);
    finishStopping(run);
    schedule();
  } else if (m.type === 'error') {
    problem = `The measurement stopped with an error: ${m.message}`;
    stop();
  }
};

// ---- Sources -------------------------------------------------------------------------------

/**
 * Download a demo recording, with progress shown in the dock.
 * @param {typeof DEMOS[number]} demo
 * @param {number} id session that asked for it
 * @returns {Promise<Recording>}
 */
async function loadDemo(demo, id) {
  const cached = demoCache.get(demo.id);
  if (cached) return cached;
  const response = await fetch(demo.url);
  if (!response.ok || !response.body) throw new Error(`Could not download ${demo.name} (${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    if (id === sessionId) {
      loading = total ? `Downloading ${(received / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB` : `Downloading ${(received / 1e6).toFixed(1)} MB`;
      schedule();
    }
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  const recording = await decodeRecording(bytes.buffer);
  demoCache.set(demo.id, recording);
  return recording;
}

async function start() {
  stopPlayer();
  stopLive();
  const id = ++sessionId;
  // The tab may change while a demo downloads; the run is of the source chosen now.
  const kind = tab;
  problem = '';
  saveMessage = '';
  if (kind === 'microphone') {
    startMicrophone(id);
    return;
  }
  /** @type {import('./audio/player.js').PacedSource} */
  let source;
  /** @type {Run} */
  let next;
  try {
    if (kind === 'simulator') {
      simulator = new WatchStream({
        bph: Number(ui.simBph.value),
        rate: Number(ui.simRate.value),
        beatOffsetMs: Number(ui.simBe.value),
        gain: Number(ui.simGain.value),
        jitterMs: Number(ui.simJitter.value),
        seed: Math.floor(Math.random() * 2 ** 31),
      });
      source = simulator;
      next = newRun('simulator', 'Simulator', null, simulator.sampleRate, settings.escapement);
      next.running = true;
    } else {
      simulator = null;
      /** @type {Recording} */
      let recording;
      let name;
      /** @type {Escapement} */
      let escapement = settings.escapement;
      if (kind === 'demo') {
        const demo = DEMOS.find((d) => d.id === demoId) || DEMOS[0];
        loading = 'Downloading';
        run = newRun('demo', demo.name, null, 48000, escapement);
        schedule();
        recording = await loadDemo(demo, id);
        name = demo.name;
        // The demo watch's escapement is known, whatever the setting for the user's own watch.
        escapement = demo.escapement;
      } else {
        if (!userFile) {
          problem = 'Choose a recording first.';
          schedule();
          return;
        }
        recording = userFile.recording;
        name = userFile.name;
      }
      if (id !== sessionId) return;
      source = new RecordingSource(recording);
      next = newRun(kind, name, recording.duration, recording.sampleRate, escapement);
      next.running = true;
    }
  } catch (error) {
    if (id !== sessionId) return;
    loading = '';
    problem = error instanceof Error ? error.message : String(error);
    if (run) run.running = false;
    schedule();
    return;
  }
  loading = '';
  run = next;
  const thisRun = next;
  measurement.start();
  load = null;
  inputPeak = 0;
  worker.postMessage({
    type: 'start',
    id,
    sampleRate: source.sampleRate,
    channelCount: kind === 'simulator' ? 1 : /** @type {RecordingSource} */ (source).channelCount,
    options: { humHz: settings.humHz, bph: settings.bph || undefined, escapement: thisRun.escapement, averagingSeconds: settings.averagingSeconds },
  });
  player = new Player(source, {
    speed: thisRun.kind === 'simulator' ? 1 : speed,
    onChunk: (channels) => {
      let peak = 0;
      for (const v of channels[0]) {
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      inputPeak = Math.max(peak, inputPeak * 0.8);
      thisRun.fed += channels[0].length;
      thisRun.posted++;
      measurement.setPosition(thisRun.fed / thisRun.sampleRate);
      worker.postMessage({ type: 'chunk', channels }, channels.map((c) => c.buffer));
      schedule();
    },
    onEnd: () => {
      // The run finishes when the pipeline has answered the last chunk, which may already
      // have happened.
      thisRun.ended = true;
      finishIfDone(thisRun);
      schedule();
    },
    busy: () => thisRun.posted - thisRun.answered > MAX_BACKLOG,
  });
  player.start();
  wake.want(true);
  schedule();
}

/**
 * @param {SourceKind} kind
 * @param {string} name
 * @param {number|null} duration
 * @param {number} sampleRate
 * @param {Escapement} escapement
 * @returns {Run}
 */
function newRun(kind, name, duration, sampleRate, escapement) {
  return { kind, name, duration, sampleRate, escapement, running: false, ended: false, finished: false, stopping: false, fed: 0, posted: 0, answered: 0, offset: 0, interrupted: false, resumed: false, interruptions: 0, savedAs: null };
}

/**
 * Measure from the microphone. This runs inside the tap on Start, or on Continue in the
 * magnetism notice: iOS only lets audio start in response to the user, so the audio context is
 * created before anything waits.
 * @param {number} id session of this start
 */
async function startMicrophone(id) {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    problem = 'This browser does not offer the microphone to this page. It needs a secure (https) address.';
    schedule();
    return;
  }
  const thisRun = newRun('microphone', 'Microphone', null, 48000, settings.escapement);
  const input = new LiveInput({
    onAudio: (channels) => {
      if (live !== input || !thisRun.running) return;
      // The arrays are handed to the worker, which empties them, so they are measured first.
      const frames = channels[0].length;
      let peak = 0;
      for (const v of channels[0]) {
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      inputPeak = Math.max(peak, inputPeak * 0.8);
      thisRun.fed += frames;
      thisRun.posted++;
      measurement.setPosition(input.position());
      worker.postMessage({ type: 'chunk', channels }, channels.map((c) => c.buffer));
      if ((thisRun.posted - thisRun.answered) * frames > LIVE_MAX_BACKLOG_SECONDS * thisRun.sampleRate) {
        problem = 'This device could not analyse the sound as fast as it arrived, so the measurement stopped.';
        stop();
        return;
      }
      schedule();
    },
    onInterrupt: () => {
      if (live !== input || !thisRun.running) return;
      // The pipeline's session ends here; answers still on their way are ignored.
      thisRun.interrupted = true;
      thisRun.interruptions++;
      sessionId++;
      worker.postMessage({ type: 'stop' });
      measurement.interrupt();
      measurement.setPosition(input.position());
      schedule();
    },
    onResume: () => {
      if (live !== input || !thisRun.running) return;
      thisRun.interrupted = false;
      thisRun.resumed = true;
      beginLiveSession(thisRun, input.segmentStart);
    },
    onEnd: (message) => {
      if (live !== input) return;
      problem = message;
      stop();
    },
  });
  live = input;
  run = thisRun;
  loading = 'Waiting for the microphone';
  schedule();
  try {
    input.keep(settings.saveMinutes * 60);
    await input.open(settings.microphoneId);
  } catch (error) {
    if (id !== sessionId) return;
    loading = '';
    problem = microphoneProblem(error);
    schedule();
    return;
  }
  if (id !== sessionId || live !== input) {
    input.close();
    return;
  }
  loading = '';
  thisRun.sampleRate = input.sampleRate;
  thisRun.running = true;
  measurement.start();
  inputPeak = 0;
  beginLiveSession(thisRun, 0);
  wake.want(true);
  refreshMicrophones();
}

/**
 * Start a pipeline session for the microphone, whose time begins at `offset` on the run's
 * timeline: at the start, after an interruption, or after a restart.
 * @param {Run} r
 * @param {number} offset
 */
function beginLiveSession(r, offset) {
  r.offset = offset;
  r.fed = 0;
  r.posted = 0;
  r.answered = 0;
  load = null;
  worker.postMessage({
    type: 'start',
    id: sessionId,
    sampleRate: r.sampleRate,
    channelCount: 1,
    options: { humHz: settings.humHz, bph: settings.bph || undefined, escapement: r.escapement, averagingSeconds: settings.averagingSeconds },
  });
  schedule();
}

/** The microphone run starts again from nothing, keeping the microphone open. */
function restartMicrophone() {
  const r = run;
  if (!r || !live || r.kind !== 'microphone' || !r.running) return;
  sessionId++;
  worker.postMessage({ type: 'stop' });
  live.restart();
  measurement.start();
  measurement.setPosition(live.position());
  inputPeak = 0;
  saveMessage = '';
  if (r.interrupted) {
    // The new session begins when the sound comes back.
    r.offset = 0;
    schedule();
  } else {
    beginLiveSession(r, 0);
  }
}

/** Fill the input picker. Names are only given once the microphone has been allowed. */
async function refreshMicrophones() {
  let inputs;
  try {
    inputs = await listMicrophones();
  } catch {
    return;
  }
  /** @type {[string, string][]} */
  const options = [['', 'Default microphone']];
  inputs.forEach((d, i) => {
    if (!d.deviceId || d.deviceId === 'default') return;
    options.push([d.deviceId, d.label || `Microphone ${i + 1}`]);
  });
  fill(ui.micInput, options);
  ui.micInput.value = options.some(([value]) => value === settings.microphoneId) ? settings.microphoneId : '';
}

/**
 * A recording's run is finished once its audio has ended and the pipeline has answered every
 * chunk of it.
 * @param {Run} r
 */
function finishIfDone(r) {
  if (!r.ended || r.finished || r.answered < r.posted) return;
  r.running = false;
  r.finished = true;
  worker.postMessage({ type: 'stop' });
  wake.want(false);
}

/**
 * A run stopped with Stop ends once the pipeline has answered every chunk handed to it before
 * then.
 * @param {Run} r
 */
function finishStopping(r) {
  if (!r.stopping || r.answered < r.posted) return;
  r.stopping = false;
  sessionId++;
  worker.postMessage({ type: 'stop' });
}

function stopPlayer() {
  if (player) player.stop();
  player = null;
}

/** Close the microphone. Its last minute of audio stays available for saving. */
function stopLive() {
  if (live) live.close();
}

/**
 * End the run: the source stops at once. With `finish`, as when Stop is pressed, the audio
 * already handed to the pipeline is still analysed and shown, so that the trace and the last
 * reading cover all the audio heard, which is all that a saved recording holds; a run that fits
 * in the length kept then reads exactly as a replay of its saved file. Until 22 November 2026 the
 * answers still on their way were ignored, up to a second of audio or more while an analysis
 * ran. Without `finish`, as after an error or when the analysis cannot keep up, they still are.
 * @param {boolean} [finish]
 */
function stop(finish = false) {
  stopPlayer();
  stopLive();
  loading = '';
  const r = run;
  // An interrupted microphone has no session whose answers count: they were set aside when the
  // interruption began.
  if (finish && r && r.running && !r.interrupted && r.answered < r.posted) {
    r.stopping = true;
  } else {
    sessionId++;
    worker.postMessage({ type: 'stop' });
  }
  if (r) {
    r.running = false;
    r.interrupted = false;
  }
  wake.want(false);
  schedule();
}

/** Start again with the same source, for settings the pipeline cannot change while running. */
function restart() {
  if (!run || !run.running) return;
  if (run.kind === 'microphone') restartMicrophone();
  else start();
}

// ---- Drawing -------------------------------------------------------------------------------

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

function render() {
  const m = measurement;
  const micRun = run && run.kind === 'microphone' ? run : null;
  /** @type {import('./ui/model.js').SourceState} */
  const src = {
    running: !!(run && run.running),
    finished: !!(run && run.finished),
    interrupted: !!(micRun && micRun.running && micRun.interrupted),
    resumed: !!(micRun && micRun.resumed),
  };
  const tracking = m.state === 'tracking';
  const r = m.readings;

  ui.state.textContent = loading ? 'Loading' : stateText(m, src);
  ui.state.dataset.state = tracking && (src.running || src.finished) ? 'tracking' : src.running ? 'listening' : 'idle';

  // Header readout. Numbers are only shown while locked; otherwise a dash, never a stale value.
  ui.rate.textContent = tracking && r ? formatRate(r.rate) : '—';
  const span = r && r.window ? r.window[1] - r.window[0] : 0;
  ui.rateWhy.textContent = tracking && r && r.rate !== null && r.rateSd !== null ? `±${r.rateSd < 0.1 ? r.rateSd.toFixed(2) : r.rateSd.toFixed(1)} over ${Math.round(span)} s` : '';
  ui.beatError.textContent = tracking && r ? formatMs(r.beatErrorMs) : '—';
  const escapement = run ? run.escapement : settings.escapement;
  ui.beatErrorWhy.textContent =
    escapement === 'coaxial'
      ? 'not shown: co-axial'
      : tracking && r && r.rate !== null && r.beatErrorMs === null
        ? r.irregular
          ? 'irregular beat'
          : 'not measurable here'
        : '';
  const bph = m.bph || settings.bph;
  const parts = [bph ? `${formatBph(bph)} vph` : 'Beat rate automatic', `lift ${settings.liftAngle}°`, `${settings.averagingSeconds} s window`];
  if (tracking && span > settings.averagingSeconds + 2) parts[2] = `window lengthened to ${Math.round(span)} s`;
  ui.sub.textContent = parts.join(' · ');
  // Irregular running: a warning in the readout, for as long as the latest readings say so.
  const warning = tracking ? irregularWarning(r) : null;
  ui.irregular.hidden = warning === null;
  ui.irregularText.textContent = warning || '';

  // Trace.
  const now = m.audioSeconds;
  const whole = src.finished || (!src.running && run && run.kind !== 'simulator');
  const from = whole ? 0 : Math.max(0, now - TRACE_SECONDS);
  const to = whole ? Math.max(now, 1) : Math.max(TRACE_SECONDS, now);
  const message = tracking ? 'Waiting for beats' : src.interrupted ? 'Interrupted' : src.running ? 'Listening for a steady beat' : run && (run.posted || run.interruptions) ? 'No lock' : 'Press Start';
  const points = m.points(from, to);
  traceView.set(points, from, to, loading || message);
  ui.trace.setAttribute(
    'aria-label',
    points.length ? `Trace of ${points.filter((p) => p.type === 0).length} ticks and ${points.filter((p) => p.type === 1).length} tocks from ${from.toFixed(0)} to ${to.toFixed(0)} s` : `Trace: ${message}`,
  );
  const note = tracking ? averagingNote(r) : '';
  ui.traceCaption.textContent =
    'Milliseconds ahead of an ideal clock. A gaining watch climbs; the gap between the lines is the beat error.' +
    (note ? ` ${note}` : '') +
    (micRun && micRun.interruptions ? ' Gaps are interruptions of the microphone.' : '') +
    ' Touch a dot to read it.';

  // Signal.
  const level = tracking ? signalLevel(r) : null;
  ui.meterFill.style.width = level ? `${Math.round(level.fraction * 100)}%` : '0%';
  ui.meter.setAttribute('aria-valuenow', level ? String(Math.round(level.fraction * 100)) : '0');
  ui.meterLabel.textContent = level ? level.level[0].toUpperCase() + level.level.slice(1) : '—';
  ui.signalZ.textContent = level ? `${level.z.toFixed(0)}× the noise spread` : '';
  ui.guidance.textContent = problem || guidance(m, src);
  const levels = [];
  if (src.running && inputPeak > 0) levels.push(`Input peak ${(20 * Math.log10(inputPeak)).toFixed(0).replace('-', '−')} dBFS`);
  if (load && load.audioSeconds > 1) levels.push(`analysis uses ${((100 * load.busySeconds) / load.audioSeconds).toFixed(0)}% of real time`);
  ui.levels.textContent = levels.join(' · ');

  // Averaged beat.
  waveView.set(tracking ? m.waveform : null, src.interrupted ? 'Interrupted' : src.running ? 'Shown once locked' : run && run.posted ? 'No lock' : 'Press Start');
  ui.waveCaption.textContent =
    tracking && m.waveform
      ? `Average of ${m.waveform.cycles} tick–tock cycles: sound level above 1.5 kHz around the moment each beat is timed.`
      : 'Sound level above 1.5 kHz around the moment each beat is timed, averaged over many beats.';

  // Source and dock.
  const recordingRun = run && run.kind !== 'simulator' && run.duration !== null;
  ui.speedRow.hidden = tab === 'simulator' || tab === 'microphone';
  const listening = !!(micRun && micRun.running && live && !live.closed);
  ui.micInfo.textContent = listening && live ? describeInput(live.label, live.inputSampleRate || live.sampleRate).text : 'Start asks for the microphone. The sound stays on this device.';
  ui.micWake.hidden = wake.supported;
  const kept = live ? live.recordedSeconds : 0;
  const minutes = settings.saveMinutes;
  ui.micSave.disabled = kept < 1;
  ui.micSave.textContent = saveLabel(minutes);
  const since = micRun && micRun.interrupted && micRun.running ? ' before the interruption' : micRun && micRun.interruptions ? ' since the last interruption' : '';
  ui.micSaveInfo.textContent =
    saveMessage ||
    (kept >= 1 && live
      ? `Saves the last ${formatDuration(kept)}${since} (${recordingMegabytes(kept, live.sampleRate).toFixed(0)} MB) as a WAV file, which you can replay under Your file.`
      : `Keeps the last ${minutes === 1 ? 'minute' : `${minutes} minutes`} of what the microphone hears, about ${recordingMegabytes(minutes * 60, 48000).toFixed(0)} MB, to save as a WAV file you can replay under Your file.`);
  ui.progress.hidden = ui.progressText.hidden = !(recordingRun && run && (run.running || run.finished) && run.kind === tab);
  if (recordingRun && run && run.duration) {
    const seconds = run.fed / run.sampleRate;
    ui.progressFill.style.width = `${Math.min(100, (100 * seconds) / run.duration).toFixed(1)}%`;
    ui.progressText.textContent = `${seconds.toFixed(1)} of ${run.duration.toFixed(1)} s`;
  }
  const busy = !!loading || src.running;
  ui.start.textContent = busy ? 'Stop' : 'Start';
  ui.start.toggleAttribute('data-running', busy);
  // While something runs the dock names it, even if another source's tab is open.
  ui.dockSource.textContent = run && (run.running || loading) ? run.name : selectedName();
  ui.dockDetail.textContent = loading
    ? loading
    : run && run.stopping
      ? 'Finishing the last audio'
      : src.running && run
        ? run.kind === 'simulator'
          ? 'Running'
          : run.kind === 'microphone'
            ? run.interrupted
              ? 'Interrupted · waiting for sound'
              : `Listening · ${(live && live.label) || 'microphone'}`
            : run.ended
              ? 'Finishing'
              : speed > 16
                ? 'Replaying as fast as this device allows'
                : `Replaying at ${speed}×`
        : src.finished && run && run.kind === tab
          ? 'Replay finished'
          : tab === 'file' && !userFile
            ? 'No file chosen'
            : 'Ready';

  renderPositions(tracking, src);
}

/**
 * The mode switch, and in Six positions the log: what to do next, the save button, a row for
 * each position and the summary.
 * @param {boolean} tracking
 * @param {import('./ui/model.js').SourceState} src
 */
function renderPositions(tracking, src) {
  for (const b of modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  const show = settings.mode === 'positions';
  ui.positions.hidden = !show;
  if (!show) return;
  const r = measurement.readings;
  const state = readiness(tracking, r, settings.averagingSeconds, measurement.lockSince);
  const savedAs = run ? run.savedAs : null;
  const canSave = state.ready && !!target && !!run && !savedAs && !loading;
  // "Saved" is said only while the log still holds that reading, not after a new log.
  const saved = savedAs && log.readings[savedAs] ? savedAs : null;
  ui.savePosition.disabled = !canSave;
  ui.savePosition.textContent = target ? `Save as ${positionName(target)}` : 'Save';
  ui.positionStep.textContent = positionStep({
    target,
    saved,
    running: src.running,
    tracking,
    covered: state.covered,
    needed: state.needed,
    ready: canSave,
    rateSd: r ? r.rateSd : null,
  });
  // The drawing beside the instruction is of the position to measure next.
  if (ui.positionStepIcon.dataset.position !== (target || '')) {
    ui.positionStepIcon.dataset.position = target || '';
    ui.positionStepIcon.innerHTML = target ? POSITION_ICONS[target] : '';
  }
  ui.positionStepIcon.hidden = !target;
  const count = Object.keys(log.readings).length;
  ui.positionsCount.textContent = `${count} of ${POSITIONS.length} saved`;
  for (const { id } of POSITIONS) {
    const row = positionRows[id];
    const reading = log.readings[id];
    row.input.checked = target === id;
    row.toggleAttribute('data-empty', !reading);
    row.toggleAttribute('data-uncertain', !!reading && isUncertain(reading));
    if (reading) {
      const words = describeReading(reading);
      row.reading.textContent = words.main;
      row.detail.textContent = words.detail;
    } else {
      row.reading.textContent = '—';
      row.detail.textContent = 'Not measured yet';
    }
  }
  const summary = describeSummary(summarise(log));
  ui.sumAverage.textContent = summary.average;
  ui.sumAverageNote.textContent = summary.averageNote;
  ui.sumSpread.textContent = summary.spread;
  ui.sumSpreadNote.textContent = summary.spreadNote;
  ui.sumBeatError.textContent = summary.beatError;
  ui.sumBeatErrorNote.textContent = summary.beatErrorNote;
  ui.sumLeftOut.textContent = summary.leftOut;
  ui.sumLeftOut.hidden = !summary.leftOut;
  ui.newLog.toggleAttribute('disabled', count === 0);
  ui.logInfo.textContent = log.started ? `Started ${new Date(log.started).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. Kept on this device.` : 'The log is kept on this device.';
}

function selectedName() {
  if (tab === 'microphone') return 'Microphone';
  if (tab === 'simulator') return 'Simulator';
  if (tab === 'demo') return (DEMOS.find((d) => d.id === demoId) || DEMOS[0]).name;
  return userFile ? userFile.name : 'Your file';
}

// ---- Controls ------------------------------------------------------------------------------

/**
 * @param {HTMLSelectElement} select
 * @param {[string, string][]} options value and label
 */
function fill(select, options) {
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
}

fill(ui.simBph, BEAT_RATES.map((b) => [String(b), `${formatBph(b)} vph`]));
ui.simBph.value = '28800';

function showSimulatorValues() {
  /** @param {string} id @param {string} text */
  const out = (id, text) => {
    $(id).textContent = text;
  };
  const rate = Number(ui.simRate.value);
  out('sim-rate-out', `${formatRate(rate)} s/d`);
  out('sim-be-out', `${Number(ui.simBe.value).toFixed(2)} ms`);
  const gain = Number(ui.simGain.value);
  out('sim-gain-out', gain === 0 ? 'silent' : `${gain.toFixed(2)}×`);
  const jitter = Number(ui.simJitter.value);
  out('sim-jitter-out', jitter === 0 ? 'none' : `${jitter.toFixed(1)} ms`);
}
showSimulatorValues();
for (const input of [ui.simRate, ui.simBe, ui.simGain, ui.simJitter]) {
  input.addEventListener('input', () => {
    showSimulatorValues();
    if (simulator && run && run.running && run.kind === 'simulator') {
      simulator.rate = Number(ui.simRate.value);
      simulator.beatOffsetMs = Number(ui.simBe.value);
      simulator.gain = Number(ui.simGain.value);
      simulator.jitterMs = Number(ui.simJitter.value);
    }
  });
}
ui.simBph.addEventListener('change', () => {
  if (run && run.running && run.kind === 'simulator') start();
});

for (const demo of DEMOS) {
  const label = document.createElement('label');
  label.className = 'choice';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'demo';
  input.value = demo.id;
  input.checked = demo.id === demoId;
  input.addEventListener('change', () => {
    demoId = demo.id;
    schedule();
  });
  const name = document.createElement('strong');
  name.textContent = demo.name;
  const detail = document.createElement('span');
  detail.textContent = demo.detail;
  label.append(input, name, detail);
  ui.demos.append(label);
}

ui.file.addEventListener('change', async () => {
  const file = ui.file.files && ui.file.files[0];
  if (!file) return;
  ui.fileInfo.textContent = `Reading ${file.name}…`;
  try {
    const recording = await decodeRecording(await file.arrayBuffer());
    userFile = { name: file.name, recording };
    ui.fileInfo.textContent = `${file.name} · ${recording.duration.toFixed(1)} s · ${(recording.sampleRate / 1000).toFixed(1)} kHz · ${recording.channels.length === 1 ? 'mono' : 'stereo'}`;
  } catch (error) {
    userFile = null;
    ui.fileInfo.textContent = `Could not read ${file.name}: ${error instanceof Error ? error.message : error}`;
  }
  schedule();
});

/** @type {HTMLButtonElement[]} */
const tabButtons = Array.from(document.querySelectorAll('[role="tab"]'));
for (const button of tabButtons) {
  button.addEventListener('click', () => {
    tab = /** @type {SourceKind} */ (button.id.replace('tab-', ''));
    for (const b of tabButtons) {
      const selected = b === button;
      b.setAttribute('aria-selected', String(selected));
      $(/** @type {string} */ (b.getAttribute('aria-controls'))).hidden = !selected;
    }
    schedule();
  });
}

/** @type {HTMLButtonElement[]} */
const speedButtons = Array.from(ui.speed.querySelectorAll('button'));
for (const button of speedButtons) {
  button.addEventListener('click', () => {
    speed = Number(button.dataset.speed);
    for (const b of speedButtons) {
      b.setAttribute('aria-checked', String(b === button));
      b.setAttribute('aria-selected', String(b === button));
    }
    if (player && run && run.running && run.kind !== 'simulator') player.setSpeed(speed);
    schedule();
  });
}

ui.start.addEventListener('click', () => {
  if (loading || (run && run.running)) stop(true);
  // The magnetism notice comes once, before the first microphone measurement.
  else if (tab === 'microphone' && !settings.magnetNoticeSeen) ui.magnet.showModal();
  else start();
});

ui.magnetContinue.addEventListener('click', () => {
  settings = { ...settings, magnetNoticeSeen: true };
  saveSettings(settings);
  // Still inside the tap, so the microphone may start.
  start();
});

ui.micInput.addEventListener('change', async () => {
  settings = { ...settings, microphoneId: ui.micInput.value };
  saveSettings(settings);
  const input = live;
  if (input && !input.closed && run && run.running && run.kind === 'microphone') {
    try {
      await input.switchInput(settings.microphoneId);
    } catch (error) {
      if (live === input) {
        problem = microphoneProblem(error);
        stop();
      }
      return;
    }
    if (live === input) restartMicrophone();
  }
  schedule();
});

fill(ui.micKeep, SAVE_MINUTES.map((m) => /** @type {[string, string]} */ ([String(m), m === 1 ? 'Last minute' : `Last ${m} minutes`])));
ui.micKeep.value = String(settings.saveMinutes);
ui.micKeep.addEventListener('change', () => {
  settings = clean({ ...settings, saveMinutes: Number(ui.micKeep.value) });
  saveSettings(settings);
  // Takes effect at once, also on what a stopped run kept: a shorter length drops the oldest.
  if (live) live.keep(settings.saveMinutes * 60);
  saveMessage = '';
  schedule();
});

ui.micSave.addEventListener('click', async () => {
  const recording = live && live.recording();
  if (!recording) return;
  const seconds = recording.channels[0].length / recording.sampleRate;
  const name = stampedName('timegrapher-live', 'wav');
  const blob = new Blob([encodeWav(recording.channels, recording.sampleRate)], { type: 'audio/wav' });
  const how = await offerFile(blob, name);
  if (how === 'shared') saveMessage = `Shared ${Math.round(seconds)} s as ${name}. Choose Save to Files if you have not already.`;
  else if (how === 'downloaded') saveMessage = `Saved ${Math.round(seconds)} s as ${name}.`;
  schedule();
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshMicrophones);
refreshMicrophones();

// Coming back to the page: reopen or restart the microphone if the system took it away.
const wakeMicrophone = () => {
  if (document.visibilityState === 'visible' && live && !live.closed && run && run.running) live.wake();
};
document.addEventListener('visibilitychange', wakeMicrophone);
window.addEventListener('pageshow', wakeMicrophone);
// While the microphone is interrupted no audio arrives, so the clock moves the trace on.
setInterval(() => {
  if (live && !live.closed && run && run.running && run.interrupted) {
    measurement.setPosition(live.position());
    schedule();
  }
}, 500);

// ---- Mode and positions --------------------------------------------------------------------

/** @type {HTMLButtonElement[]} */
const modeButtons = Array.from(ui.mode.querySelectorAll('button'));
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    settings = clean({ ...settings, mode: button.dataset.mode });
    saveSettings(settings);
    schedule();
  });
}

/**
 * A row of the log for each position: a choice of which position to measure next, a drawing of
 * the position, its name and its saved reading.
 * @typedef {HTMLLabelElement & {input: HTMLInputElement, reading: HTMLElement, detail: HTMLElement}} PositionRow
 */
/** @type {Record<PositionId, PositionRow>} */
const positionRows = /** @type {Record<PositionId, PositionRow>} */ ({});
for (const p of POSITIONS) {
  const row = /** @type {PositionRow} */ (document.createElement('label'));
  row.className = 'choice position-row';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'position';
  input.value = p.id;
  input.addEventListener('change', () => {
    if (isPosition(input.value)) target = input.value;
    schedule();
  });
  const title = document.createElement('strong');
  const name = document.createElement('span');
  name.textContent = p.name;
  const reading = document.createElement('span');
  reading.className = 'reading';
  title.append(name, reading);
  const detail = document.createElement('span');
  const icon = document.createElement('span');
  icon.className = 'position-icon';
  // Markup from js/ui/position-icons.js, not from the user.
  icon.innerHTML = POSITION_ICONS[p.id];
  row.append(input, icon, title, detail);
  Object.assign(row, { input, reading, detail });
  ui.positionList.append(row);
  positionRows[p.id] = row;
}

ui.savePosition.addEventListener('click', () => {
  const r = run;
  const readings = measurement.readings;
  const id = target;
  if (!r || r.savedAs || !id || !readings || loading) return;
  if (!readiness(measurement.state === 'tracking', readings, settings.averagingSeconds, measurement.lockSince).ready) return;
  const reading = takeReading(readings, { bph: measurement.bph || settings.bph, escapement: r.escapement, source: r.name, now: new Date() });
  if (!reading) return;
  log = withReading(log, id, reading);
  saveLog(log);
  r.savedAs = id;
  target = nextPosition(log, id);
  // The watch is moved to its next position now, so the run ends here and the screen keeps the
  // reading just saved: answers still on their way would mix in the handling of the watch.
  if (r.running || r.stopping) {
    r.stopping = false;
    stop();
  }
  schedule();
});

ui.newLog.addEventListener('click', () => {
  const count = Object.keys(log.readings).length;
  if (count === 0) return;
  ui.newLogText.textContent = `The ${count === 1 ? 'reading' : `readings of ${count} positions`} saved in this log ${count === 1 ? 'is' : 'are'} cleared.`;
  ui.newLogDialog.showModal();
});
ui.newLogConfirm.addEventListener('click', () => {
  log = emptyLog();
  saveLog(log);
  target = nextPosition(log);
  schedule();
});

// ---- Settings ------------------------------------------------------------------------------

fill(/** @type {HTMLSelectElement} */ ($('set-bph')), [['0', 'Automatic'], ...BEAT_RATES.map((b) => /** @type {[string, string]} */ ([String(b), `${formatBph(b)} vph`]))]);
fill(/** @type {HTMLSelectElement} */ ($('set-avg')), AVERAGING_CHOICES.map((s) => /** @type {[string, string]} */ ([String(s), `${s} s${s === 20 ? ' (default)' : ''}`])));

function showSettings() {
  const f = ui.settingsForm.elements;
  /** @param {string} name @param {string|number} value */
  const set = (name, value) => {
    /** @type {HTMLInputElement} */ (f.namedItem(name)).value = String(value);
  };
  set('bph', settings.bph);
  set('escapement', settings.escapement);
  set('liftAngle', settings.liftAngle);
  set('humHz', settings.humHz);
  set('averagingSeconds', settings.averagingSeconds);
  ui.settingsRestart.hidden = !(run && run.running);
}

ui.settingsForm.addEventListener('change', () => {
  const before = settings;
  const values = Object.fromEntries(new FormData(ui.settingsForm));
  // An empty or out-of-range lift angle keeps the previous value.
  if (values.liftAngle === '' || !Number.isFinite(Number(values.liftAngle))) values.liftAngle = String(before.liftAngle);
  // Settings kept elsewhere on the screen (the microphone) are not in this form.
  settings = clean({ ...before, ...values });
  saveSettings(settings);
  if (settings.bph !== before.bph || settings.humHz !== before.humHz) {
    restart();
  } else if (run && run.running) {
    /** @type {{averagingSeconds?: number, escapement?: Escapement}} */
    const changes = {};
    if (settings.averagingSeconds !== before.averagingSeconds) changes.averagingSeconds = settings.averagingSeconds;
    if (settings.escapement !== before.escapement) {
      changes.escapement = settings.escapement;
      run.escapement = settings.escapement;
    }
    worker.postMessage({ type: 'settings', changes });
  }
  schedule();
});
ui.settingsForm.addEventListener('submit', () => {
  // Show the lift angle as it was kept, in case the typed value was out of range.
  showSettings();
});

$('open-settings').addEventListener('click', () => {
  showSettings();
  ui.settings.showModal();
});
ui.settings.addEventListener('click', (e) => {
  // A tap on the backdrop closes the dialog.
  if (e.target === ui.settings) ui.settings.close();
});

window.addEventListener('resize', schedule);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);

// On GitHub Pages the address is https://OWNER.github.io/REPOSITORY/, so the source is
// https://github.com/OWNER/REPOSITORY.
const host = location.hostname.match(/^([^.]+)\.github\.io$/);
const repo = location.pathname.split('/').filter(Boolean)[0];
if (host && repo) /** @type {HTMLAnchorElement} */ ($('source-link')).href = `https://github.com/${host[1]}/${repo}`;

render();
