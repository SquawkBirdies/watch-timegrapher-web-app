// Start-up and wiring of the timegrapher screen. A source (the simulator, a demo recording or
// the user's own file) is paced in real time and sent to the pipeline in a worker; the worker's
// events update the measurement model, and the screen is redrawn from the model.

import { Measurement, formatRate, formatMs, formatBph, signalLevel, averagingNote, guidance, stateText, irregularWarning } from './ui/model.js';
import { TraceView } from './ui/trace.js';
import { WaveformView } from './ui/waveform.js';
import { WatchStream } from './audio/simulator.js';
import { decodeRecording, RecordingSource } from './audio/file-source.js';
import { Player } from './audio/player.js';
import { loadSettings, saveSettings, clean, BEAT_RATES, AVERAGING_CHOICES } from './store.js';

/**
 * @typedef {import('./audio/file-source.js').Recording} Recording
 * @typedef {import('./dsp/pipeline.js').PipelineEvent} PipelineEvent
 * @typedef {import('./dsp/session.js').Load} Load
 * @typedef {import('./dsp/estimate.js').Escapement} Escapement
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
  dockSource: $('dock-source'),
  dockDetail: $('dock-detail'),
  start: /** @type {HTMLButtonElement} */ ($('start')),
  settings: /** @type {HTMLDialogElement} */ ($('settings')),
  settingsForm: /** @type {HTMLFormElement} */ ($('settings-form')),
  settingsRestart: $('settings-restart'),
};

let settings = loadSettings();
/** @type {'simulator'|'demo'|'file'} */
let tab = 'simulator';
let demoId = DEMOS[0].id;
/** @type {{name: string, recording: Recording}|null} */
let userFile = null;
/** @type {Map<string, Recording>} */
const demoCache = new Map();
let speed = 1;

/**
 * What is running, or ran last.
 * @typedef {Object} Run
 * @property {'simulator'|'demo'|'file'} kind
 * @property {string} name
 * @property {number|null} duration seconds, for recordings
 * @property {number} sampleRate
 * @property {Escapement} escapement
 * @property {boolean} running
 * @property {boolean} ended the source has no more audio
 * @property {boolean} finished the recording reached its end and the pipeline has heard all of it
 * @property {number} fed frames sent to the pipeline
 * @property {number} posted chunks sent to the pipeline
 * @property {number} answered chunks the pipeline has finished with
 */
/** @type {Run|null} */
let run = null;
/** @type {Player|null} */
let player = null;
/** @type {WatchStream|null} */
let simulator = null;
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

worker.onmessage = (event) => {
  const m = event.data;
  if (m.type === 'events') {
    if (m.id !== sessionId || !run) return;
    for (const e of /** @type {PipelineEvent[]} */ (m.events)) measurement.apply(e);
    load = m.load;
    run.answered++;
    finishIfDone(run);
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
  const id = ++sessionId;
  // The tab may change while a demo downloads; the run is of the source chosen now.
  const kind = tab;
  problem = '';
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
      next = { kind: 'simulator', name: 'Simulator', duration: null, sampleRate: simulator.sampleRate, escapement: settings.escapement, running: true, ended: false, finished: false, fed: 0, posted: 0, answered: 0 };
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
        run = { kind: 'demo', name: demo.name, duration: null, sampleRate: 48000, escapement, running: false, ended: false, finished: false, fed: 0, posted: 0, answered: 0 };
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
      next = { kind, name, duration: recording.duration, sampleRate: recording.sampleRate, escapement, running: true, ended: false, finished: false, fed: 0, posted: 0, answered: 0 };
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
  schedule();
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
}

function stopPlayer() {
  if (player) player.stop();
  player = null;
}

function stop() {
  stopPlayer();
  sessionId++;
  loading = '';
  worker.postMessage({ type: 'stop' });
  if (run) run.running = false;
  schedule();
}

/** Start again with the same source, for settings the pipeline cannot change while running. */
function restart() {
  if (run && run.running) start();
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
  const src = { running: !!(run && run.running), finished: !!(run && run.finished) };
  const tracking = m.state === 'tracking';
  const r = m.readings;

  ui.state.textContent = loading ? 'Loading' : stateText(m, src);
  ui.state.dataset.state = tracking ? 'tracking' : src.running ? 'listening' : 'idle';

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
  const message = tracking ? 'Waiting for beats' : src.running ? 'Listening for a steady beat' : run && run.posted ? 'No lock' : 'Press Start';
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
  waveView.set(tracking ? m.waveform : null, src.running ? 'Shown once locked' : run && run.posted ? 'No lock' : 'Press Start');
  ui.waveCaption.textContent =
    tracking && m.waveform
      ? `Average of ${m.waveform.cycles} tick–tock cycles: sound level above 1.5 kHz around the moment each beat is timed.`
      : 'Sound level above 1.5 kHz around the moment each beat is timed, averaged over many beats.';

  // Source and dock.
  const recordingRun = run && run.kind !== 'simulator' && run.duration !== null;
  ui.speedRow.hidden = tab === 'simulator';
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
    : src.running && run
      ? run.kind === 'simulator'
        ? 'Running'
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
}

function selectedName() {
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
    tab = /** @type {'simulator'|'demo'|'file'} */ (button.id.replace('tab-', ''));
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
  if (loading || (run && run.running)) stop();
  else start();
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
  settings = clean(values);
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
