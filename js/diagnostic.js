// The audio diagnostic page (diagnostic.html). Records the microphone, runs the pipeline on the
// audio as it arrives, and builds a report that can be copied into a chat or bug report.

import { listMicrophones, openMicrophone } from './audio/capture.js';
import { encodeWav } from './audio/wav.js';
import { offerFile } from './ui/save.js';
import { Cascade, highpass, BUTTERWORTH4_Q } from './dsp/biquad.js';

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return /** @type {T} */ (element);
}

const ui = {
  device: /** @type {HTMLSelectElement} */ ($('device')),
  echo: /** @type {HTMLInputElement} */ ($('echo')),
  noise: /** @type {HTMLInputElement} */ ($('noise')),
  gain: /** @type {HTMLInputElement} */ ($('gain')),
  length: /** @type {HTMLSelectElement} */ ($('length')),
  mains: /** @type {HTMLSelectElement} */ ($('mains')),
  escapement: /** @type {HTMLSelectElement} */ ($('escapement')),
  start: /** @type {HTMLButtonElement} */ ($('start')),
  stop: /** @type {HTMLButtonElement} */ ($('stop')),
  elapsed: $('elapsed'),
  peak: $('peak'),
  load: $('load'),
  meter: $('meter'),
  wave: /** @type {HTMLCanvasElement} */ ($('wave')),
  status: $('status'),
  reading: $('reading'),
  results: $('results'),
  save: /** @type {HTMLButtonElement} */ ($('save')),
  copy: /** @type {HTMLButtonElement} */ ($('copy')),
  resultFeedback: $('result-feedback'),
  report: $('report'),
  bench: /** @type {HTMLButtonElement} */ ($('bench')),
  benchResult: $('bench-result'),
};

const worker = new Worker(new URL('./dsp/worker.js', import.meta.url), { type: 'module' });

/**
 * Everything about the current or last recording.
 * @typedef {Object} Run
 * @property {import('./audio/capture.js').Capture} capture
 * @property {number} sampleRate
 * @property {number} channelCount 0 until the first chunk arrives
 * @property {Float32Array[][]} chunks
 * @property {number} frames
 * @property {number} limitFrames
 * @property {number} wallStart performance.now() at the first chunk
 * @property {number} wallEnd
 * @property {number} peak
 * @property {number} sumSquares
 * @property {number} clipped
 * @property {number} silentBlocks
 * @property {number} blocks
 * @property {{t: number, what: string}[]} interruptions
 * @property {number} sent chunks sent to the worker
 * @property {number} answered chunks the worker has answered
 * @property {string} state pipeline state
 * @property {number|null} bph
 * @property {(number|null)[]|null} cycles
 * @property {number|null} lockedAt
 * @property {number} lockLost
 * @property {import('./dsp/pipeline.js').ReadingsEvent|null} readings
 * @property {import('./dsp/session.js').Load|null} load
 * @property {boolean} stopped
 * @property {import('./dsp/estimate.js').Escapement} escapement
 */

/** @type {Run|null} */
let run = null;
/** @type {WakeLockSentinel|null} */
let wakeLock = null;
/** @type {string} */
let benchText = '';
/** Last two seconds of the first channel above 2 kHz, for the waveform. */
let recent = new Float32Array(0);
let recentAt = 0;
/** @type {Cascade|null} */
let displayFilter = null;
let displayBuffer = new Float64Array(0);

// ---------------------------------------------------------------------------- devices

async function refreshDevices(selectedId = '') {
  try {
    const inputs = await listMicrophones();
    const keep = selectedId || ui.device.value;
    ui.device.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Default microphone';
    ui.device.appendChild(first);
    inputs.forEach((d, i) => {
      if (!d.deviceId || d.deviceId === 'default') return;
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      ui.device.appendChild(o);
    });
    if ([...ui.device.options].some((o) => o.value === keep)) ui.device.value = keep;
  } catch {
    // Leave the default entry.
  }
}

// ---------------------------------------------------------------------------- recording

/** @param {string} text @param {'tracking'|'problem'|''} [kind] */
function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = 'status' + (kind ? ' ' + kind : '');
}

/** @param {number} v */
const dbfs = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
/** @param {number} v */
const fmtDb = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : 'silent');
/** @param {number|null} v @param {number} [digits] */
const signed = (v, digits = 2) => (v === null ? '–' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits));

async function start() {
  ui.start.disabled = true;
  ui.results.hidden = true;
  ui.reading.textContent = '';
  setStatus('Asking for the microphone…');
  /** @type {import('./audio/capture.js').Capture} */
  let capture;
  try {
    capture = await openMicrophone(
      {
        deviceId: ui.device.value || undefined,
        echoCancellation: ui.echo.checked,
        noiseSuppression: ui.noise.checked,
        autoGainControl: ui.gain.checked,
      },
      onChunk,
      onChange,
    );
  } catch (error) {
    ui.start.disabled = false;
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError') setStatus('Microphone permission was refused. Allow it in the address bar or in Settings, then try again.', 'problem');
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') setStatus('That microphone is not available. Choose another one and try again.', 'problem');
    else setStatus(`The microphone could not be opened: ${error instanceof Error ? error.message : error}`, 'problem');
    return;
  }
  run = {
    capture,
    sampleRate: capture.context.sampleRate,
    channelCount: 0,
    chunks: [],
    frames: 0,
    limitFrames: Number(ui.length.value) * capture.context.sampleRate,
    wallStart: 0,
    wallEnd: 0,
    peak: 0,
    sumSquares: 0,
    clipped: 0,
    silentBlocks: 0,
    blocks: 0,
    interruptions: [],
    sent: 0,
    answered: 0,
    state: 'listening',
    bph: null,
    cycles: null,
    lockedAt: null,
    lockLost: 0,
    readings: null,
    load: null,
    stopped: false,
    escapement: ui.escapement.value === 'coaxial' ? 'coaxial' : 'lever',
  };
  recent = new Float32Array(Math.round(2 * run.sampleRate));
  recentAt = 0;
  // Ticks are clicks of a few kilohertz; below that, room noise and hum hide them.
  displayFilter = new Cascade(BUTTERWORTH4_Q.map((q) => highpass(run ? run.sampleRate : 48000, 2000, q)));
  ui.stop.disabled = false;
  setStatus('Listening for the watch…');
  refreshDevices(capture.settings.deviceId || '');
  try {
    wakeLock = 'wakeLock' in navigator ? await navigator.wakeLock.request('screen') : null;
  } catch {
    wakeLock = null;
  }
  requestAnimationFrame(draw);
}

/** @param {import('./audio/capture.js').Chunk} chunk */
function onChunk(chunk) {
  const r = run;
  if (!r || r.stopped) return;
  let channels = chunk.channels;
  if (r.channelCount === 0) {
    r.channelCount = channels.length;
    r.wallStart = performance.now() - (1000 * channels[0].length) / r.sampleRate;
    worker.postMessage({ type: 'start', sampleRate: r.sampleRate, channelCount: r.channelCount, options: { humHz: Number(ui.mains.value), escapement: r.escapement } });
  }
  const room = r.limitFrames - r.frames;
  if (channels[0].length > room) channels = channels.map((c) => c.subarray(0, room));
  const n = channels[0].length;
  if (n === 0) return;
  let peak = 0;
  for (const c of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) r.clipped++;
      r.sumSquares += c[i] * c[i];
    }
  }
  r.peak = Math.max(r.peak, peak);
  ui.meter.style.width = `${Math.max(0, Math.min(100, ((dbfs(peak) + 60) / 60) * 100))}%`;
  r.chunks.push(channels);
  r.frames += n;
  r.silentBlocks = chunk.silentBlocks;
  r.blocks = chunk.blocks;
  // Keep the last two seconds of the first channel, above 2 kHz, for the waveform.
  if (displayBuffer.length < n) displayBuffer = new Float64Array(n);
  if (displayFilter) displayFilter.process(channels[0], displayBuffer, n);
  for (let i = 0; i < n; i++) {
    recent[recentAt] = displayBuffer[i];
    recentAt = (recentAt + 1) % recent.length;
  }
  r.sent++;
  worker.postMessage({ type: 'chunk', channels });
  if (r.frames >= r.limitFrames) stop();
}

/** @param {string} what */
function onChange(what) {
  const r = run;
  if (!r || r.stopped) return;
  if (what === 'audio running' || what === 'microphone unmuted') return;
  r.interruptions.push({ t: r.frames / r.sampleRate, what });
  setStatus(`Audio problem: ${what}.`, 'problem');
}

async function stop() {
  const r = run;
  if (!r || r.stopped) return;
  r.stopped = true;
  r.wallEnd = performance.now();
  ui.stop.disabled = true;
  await r.capture.stop();
  try {
    if (wakeLock) await wakeLock.release();
  } catch {
    // Already released.
  }
  wakeLock = null;
  setStatus(r.answered < r.sent ? 'Stopped. Finishing the measurement…' : 'Stopped.');
  finishIfDone();
}

function finishIfDone() {
  const r = run;
  if (!r || !r.stopped || r.answered < r.sent) return;
  worker.postMessage({ type: 'stop' });
  ui.start.disabled = false;
  setStatus(r.state === 'tracking' ? `Stopped. The pipeline was tracking ${r.bph?.toLocaleString('en-US')} vph.` : 'Stopped. The pipeline did not lock on a watch.', r.state === 'tracking' ? 'tracking' : 'problem');
  ui.report.textContent = report();
  ui.results.hidden = false;
  ui.resultFeedback.textContent = '';
}

worker.onmessage = (event) => {
  const m = event.data;
  if (m.type === 'events') {
    const r = run;
    if (!r) return;
    r.answered++;
    r.load = m.load;
    for (const e of /** @type {import('./dsp/pipeline.js').PipelineEvent[]} */ (m.events)) {
      if (e.type === 'status') {
        if (r.state === 'tracking' && e.state === 'listening') r.lockLost++;
        r.state = e.state;
        r.bph = e.bph;
        r.cycles = e.cyclesAveraged;
        if (e.state === 'tracking' && r.lockedAt === null) r.lockedAt = e.t;
        if (!r.stopped) {
          if (e.state === 'tracking') setStatus(`Tracking ${e.bph?.toLocaleString('en-US')} vph.`, 'tracking');
          else setStatus('Lost the beat. Listening again…', 'problem');
        }
      } else if (e.type === 'readings') {
        r.readings = e;
        ui.reading.textContent = readingText(e);
      }
    }
    if (r.load && r.load.audioSeconds > 0) ui.load.textContent = `${Math.round((100 * r.load.busySeconds) / r.load.audioSeconds)}%`;
    finishIfDone();
  } else if (m.type === 'benchmark') {
    showBenchmark(m.result);
  } else if (m.type === 'error') {
    setStatus(`The measurement stopped with an error: ${m.message}`, 'problem');
    ui.bench.disabled = false;
  }
};

/** @param {import('./dsp/pipeline.js').ReadingsEvent} e */
function readingText(e) {
  if (e.rate === null) return 'No reading.';
  const be = run && run.escapement === 'coaxial' ? 'no beat error for co-axial' : e.beatErrorMs === null ? 'beat error blank' : `beat error ${e.beatErrorMs.toFixed(2)} ms`;
  return `Rate ${signed(e.rate)} s/day · ${be} · scatter ${e.jitterMs === null ? '–' : e.jitterMs.toFixed(3) + ' ms'}`;
}

// ---------------------------------------------------------------------------- drawing

function draw() {
  const r = run;
  if (r) {
    ui.elapsed.textContent = `${(r.frames / r.sampleRate).toFixed(1)} s`;
    ui.peak.textContent = r.frames ? fmtDb(dbfs(r.peak)) : '–';
  }
  const canvas = ui.wave;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d');
  if (g && recent.length) {
    g.clearRect(0, 0, w, h);
    // Scale to the background noise rather than the loudest sound, so that faint ticks show up
    // and a knock or click simply runs off the edge.
    const sample = new Float32Array(Math.ceil(recent.length / 8));
    for (let i = 0, j = 0; i < recent.length; i += 8, j++) sample[j] = Math.abs(recent[i]);
    sample.sort();
    const top = Math.max(1e-6, 20 * sample[sample.length >> 1]);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--trace').trim() || '#27449c';
    const per = recent.length / w;
    for (let x = 0; x < w; x++) {
      let lo = 0;
      let hi = 0;
      const a = Math.floor(x * per);
      const b = Math.floor((x + 1) * per);
      for (let i = a; i < b; i++) {
        const v = recent[(recentAt + i) % recent.length];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const y0 = h / 2 - Math.min(1, hi / top) * (h / 2 - 2);
      const y1 = h / 2 - Math.max(-1, lo / top) * (h / 2 - 2);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
  if (r && !r.stopped) requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------- report

function report() {
  const r = run;
  if (!r) return '';
  const lines = ['Watch Timegrapher audio diagnostic (milestone 4)'];
  lines.push(`Browser: ${navigator.userAgent}`);
  lines.push(`Microphone: ${r.capture.label || 'unnamed'}`);
  lines.push(`Escapement: ${r.escapement === 'coaxial' ? 'co-axial (beat error not shown)' : 'Swiss lever'}`);
  const onOff = (/** @type {unknown} */ v) => (v ? 'on' : 'off');
  lines.push(`Requested: echo cancellation ${onOff(r.capture.requested.echoCancellation)}, noise suppression ${onOff(r.capture.requested.noiseSuppression)}, automatic gain ${onOff(r.capture.requested.autoGainControl)}`);
  const applied = Object.entries(r.capture.settings)
    .filter(([k]) => k !== 'deviceId' && k !== 'groupId')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  lines.push(`Applied by the browser: ${applied || 'not reported'}`);
  const supported = Object.entries(navigator.mediaDevices.getSupportedConstraints())
    .filter(([k, v]) => v && ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'sampleRate', 'channelCount', 'sampleSize', 'latency', 'voiceIsolation'].includes(k))
    .map(([k]) => k)
    .join(', ');
  lines.push(`Constraints the browser supports: ${supported || 'none reported'}`);
  const ctx = r.capture.context;
  lines.push(`Audio context: ${r.sampleRate} Hz, base latency ${(1000 * (ctx.baseLatency || 0)).toFixed(1)} ms`);
  const audio = r.frames / r.sampleRate;
  const wall = (r.wallEnd - r.wallStart) / 1000;
  lines.push(`Recorded: ${audio.toFixed(1)} s of audio in ${wall.toFixed(1)} s, ${r.channelCount} channel${r.channelCount === 1 ? '' : 's'}`);
  const rms = Math.sqrt(r.sumSquares / Math.max(1, r.frames * r.channelCount));
  lines.push(`Levels: peak ${fmtDb(dbfs(r.peak))}, average ${fmtDb(dbfs(rms))}, clipped samples ${r.clipped}`);
  lines.push(`Silent 128-sample blocks: ${r.silentBlocks} of ${r.blocks}`);
  lines.push(`Interruptions: ${r.interruptions.length ? r.interruptions.map((i) => `${i.what} at ${i.t.toFixed(1)} s`).join('; ') : 'none'}`);
  if (r.lockedAt === null) {
    lines.push('Pipeline: did not lock on a watch');
  } else {
    lines.push(`Pipeline: locked at ${r.lockedAt.toFixed(1)} s on ${r.bph?.toLocaleString('en-US') ?? '?'} vph, lock lost ${r.lockLost} time${r.lockLost === 1 ? '' : 's'}`);
    const e = r.readings;
    if (e) {
      lines.push(`Last reading: rate ${signed(e.rate)} s/day${e.rateSd === null ? '' : ` (± ${e.rateSd.toFixed(2)})`}, beat error ${e.beatErrorMs === null ? 'blank' : e.beatErrorMs.toFixed(2) + ' ms'}, scatter ${e.jitterMs === null ? '–' : e.jitterMs.toFixed(3) + ' ms'}, cycles averaged ${r.cycles ? r.cycles.map((k) => k ?? '–').join('/') : '–'}`);
      if (e.beatErrorDetail) lines.push(`Tick-tock detail: offset ${e.beatErrorDetail.offsetMs.toFixed(2)} ms, uncertainty ${e.beatErrorDetail.offsetSdMs.toFixed(3)} ms, shape similarity ${e.beatErrorDetail.similarity.toFixed(2)}`);
    }
  }
  if (r.load && r.load.audioSeconds > 0) {
    lines.push(`Pipeline load: ${((100 * r.load.busySeconds) / r.load.audioSeconds).toFixed(1)}% of real time, longest single step ${(1000 * r.load.longestSeconds).toFixed(0)} ms`);
  }
  if (benchText) lines.push(`Speed test: ${benchText}`);
  return lines.join('\n');
}

/** @returns {Float32Array[]} */
function joinedChannels() {
  const r = run;
  if (!r) return [];
  return Array.from({ length: r.channelCount }, (_, c) => {
    const out = new Float32Array(r.frames);
    let at = 0;
    for (const chunk of r.chunks) {
      out.set(chunk[c], at);
      at += chunk[c].length;
    }
    return out;
  });
}

async function save() {
  const r = run;
  if (!r || r.frames === 0) return;
  const stamp = new Date();
  const pad = (/** @type {number} */ v) => String(v).padStart(2, '0');
  const name = `timegrapher-capture-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.wav`;
  const blob = new Blob([encodeWav(joinedChannels(), r.sampleRate)], { type: 'audio/wav' });
  const how = await offerFile(blob, name);
  if (how === 'shared') ui.resultFeedback.textContent = 'Shared. Choose Save to Files if you have not already.';
  else if (how === 'downloaded') ui.resultFeedback.textContent = `Saved as ${name}.`;
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(ui.report.textContent || '');
    ui.resultFeedback.textContent = 'Report copied.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(ui.report);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    ui.resultFeedback.textContent = 'Copying was blocked. The report is selected; copy it from the menu.';
  }
}

// ---------------------------------------------------------------------------- speed test

/** @param {import('./dsp/session.js').BenchmarkResult} b */
function showBenchmark(b) {
  ui.bench.disabled = false;
  benchText =
    `${b.audioSeconds.toFixed(0)} s of simulated audio (${b.channelCount} channel${b.channelCount === 1 ? '' : 's'}) took ${b.busySeconds.toFixed(1)} s, ` +
    `${b.speed.toFixed(1)} times faster than real time; longest single step ${(1000 * b.longestSeconds).toFixed(0)} ms; ` +
    `locked at ${b.lockedAt === null ? 'never' : b.lockedAt.toFixed(1) + ' s'}; read ${signed(b.rate)} s/day and ${b.beatErrorMs === null ? 'no beat error' : b.beatErrorMs.toFixed(2) + ' ms'} (true +12.00 and 0.30)`;
  ui.benchResult.textContent = `${b.speed.toFixed(1)} times faster than real time. ${b.speed >= 3 ? 'This device keeps up comfortably.' : b.speed >= 1 ? 'This device keeps up, with little to spare.' : 'This device is too slow to keep up.'}`;
  if (!ui.results.hidden) ui.report.textContent = report();
}

function runBenchmark() {
  ui.bench.disabled = true;
  ui.benchResult.textContent = 'Running…';
  worker.postMessage({ type: 'benchmark', options: { seconds: 60, channelCount: run && run.channelCount ? run.channelCount : 1 } });
}

// ---------------------------------------------------------------------------- wiring

ui.start.addEventListener('click', start);
ui.stop.addEventListener('click', stop);
ui.save.addEventListener('click', save);
ui.copy.addEventListener('click', copyReport);
ui.bench.addEventListener('click', runBenchmark);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && run && !run.stopped) onChange('page hidden');
});
if (!window.isSecureContext || !navigator.mediaDevices) {
  setStatus('This page needs a secure (HTTPS) connection to use the microphone.', 'problem');
  ui.start.disabled = true;
}
refreshDevices();
draw();
