// What the interface shows, worked out from the pipeline's events. Nothing here draws or touches
// the page, so the automated tests can check it. The interface never measures anything itself:
// every number comes from the pipeline.

/**
 * @typedef {import('../dsp/pipeline.js').Beat} Beat
 * @typedef {import('../dsp/pipeline.js').PipelineEvent} PipelineEvent
 * @typedef {import('../dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 * @typedef {import('../dsp/pipeline.js').WaveformEvent} WaveformEvent
 */

/**
 * One stretch of continuous lock. Beat numbers restart when a lock is lost and found again,
 * so each stretch has its own reference beat.
 * @typedef {Object} Episode
 * @property {number} bph
 * @property {number|null} n0 beat number of the reference beat
 * @property {number|null} t0 time of the reference beat in seconds
 * @property {number} base trace value of the reference beat, in milliseconds: 0 for the first
 *   stretch, and where the previous stretch ended for later ones, so the trace does not jump
 * @property {Beat[]} beats in time order
 */

/**
 * A point of the trace.
 * @typedef {Object} TracePoint
 * @property {number} t seconds from the start of the audio
 * @property {number} y milliseconds ahead of an ideal clock at the nominal beat rate
 * @property {0|1} type 0 for a tick, 1 for a tock
 * @property {boolean} ok false for a low-confidence timestamp
 * @property {number} cycles tick-tock cycles averaged for this timestamp
 */

/** Beats older than this are dropped from the trace, to bound memory on long sessions. */
const KEEP_SECONDS = 600;

export class Measurement {
  constructor() {
    /** @type {'idle'|'listening'|'tracking'} */
    this.state = 'idle';
    /** @type {number|null} */
    this.bph = null;
    /** @type {Episode[]} */
    this.episodes = [];
    /** @type {ReadingsEvent|null} latest readings; blank ones mean the lock was lost */
    this.readings = null;
    /** @type {WaveformEvent|null} */
    this.waveform = null;
    /** @type {number|null} seconds of audio before the first lock */
    this.lockedAt = null;
    /** Seconds of audio sent to the pipeline so far. */
    this.audioSeconds = 0;
  }

  /** The source is starting: everything goes back to its starting state. */
  start() {
    this.state = 'listening';
    this.bph = null;
    this.episodes = [];
    this.readings = null;
    this.waveform = null;
    this.lockedAt = null;
    this.audioSeconds = 0;
  }

  /** @param {number} seconds */
  setPosition(seconds) {
    this.audioSeconds = seconds;
  }

  /**
   * The audio stopped (the microphone was interrupted). The readings blank at once; the trace
   * keeps what it has, and a later lock continues it after the gap.
   */
  interrupt() {
    if (this.state === 'idle') return;
    this.state = 'listening';
    this.readings = null;
    this.waveform = null;
  }

  /** @param {PipelineEvent} e */
  apply(e) {
    if (e.type === 'status') {
      if (e.state === 'tracking' && this.state !== 'tracking') {
        const last = this.lastPoint();
        this.episodes.push({ bph: /** @type {number} */ (e.bph), n0: null, t0: null, base: last ? last.y : 0, beats: [] });
        if (this.lockedAt === null) this.lockedAt = e.t;
      }
      if (e.state === 'listening') {
        this.readings = null;
        this.waveform = null;
      }
      this.state = e.state;
      this.bph = e.bph;
    } else if (e.type === 'beats') {
      const ep = this.episodes[this.episodes.length - 1];
      if (!ep) return;
      const cut = e.replaceFrom;
      if (cut !== null) for (const other of this.episodes) other.beats = other.beats.filter((b) => b.t < cut);
      if (ep.n0 === null && e.beats.length) {
        const ordered = [...e.beats].sort((a, b) => a.t - b.t);
        const ref = ordered.find((b) => b.type === 0 && b.ok) || ordered.find((b) => b.ok) || ordered[0];
        ep.n0 = ref.n;
        ep.t0 = ref.t;
      }
      ep.beats.push(...e.beats);
      ep.beats.sort((a, b) => a.t - b.t);
      this.trim();
    } else if (e.type === 'readings') {
      this.readings = e.window === null ? null : e;
    } else if (e.type === 'waveform') {
      this.waveform = e;
    }
  }

  /** Drop beats and whole stretches that have scrolled far out of view. */
  trim() {
    const oldest = this.audioSeconds - KEEP_SECONDS;
    if (oldest <= 0) return;
    for (const ep of this.episodes) if (ep.beats.length && ep.beats[0].t < oldest) ep.beats = ep.beats.filter((b) => b.t >= oldest);
    while (this.episodes.length > 1 && this.episodes[0].beats.length === 0) this.episodes.shift();
  }

  /**
   * Milliseconds ahead of an ideal clock: how much earlier than the reference beat's schedule
   * this beat arrived. A gaining watch climbs; the gap between ticks and tocks is the beat error.
   * @param {Episode} ep
   * @param {Beat} b
   * @returns {number}
   */
  static ahead(ep, b) {
    const period = 3600 / ep.bph;
    return ((b.n - /** @type {number} */ (ep.n0)) * period - (b.t - /** @type {number} */ (ep.t0))) * 1000 + ep.base;
  }

  /**
   * Trace points between two times.
   * @param {number} [from]
   * @param {number} [to]
   * @returns {TracePoint[]}
   */
  points(from = -Infinity, to = Infinity) {
    /** @type {TracePoint[]} */
    const out = [];
    for (const ep of this.episodes) {
      if (ep.n0 === null) continue;
      for (const b of ep.beats) {
        if (b.t < from || b.t > to) continue;
        out.push({ t: b.t, y: Measurement.ahead(ep, b), type: b.type, ok: b.ok, cycles: b.cycles });
      }
    }
    return out;
  }

  /** @returns {TracePoint|null} the latest confident point */
  lastPoint() {
    for (let i = this.episodes.length - 1; i >= 0; i--) {
      const ep = this.episodes[i];
      if (ep.n0 === null) continue;
      for (let k = ep.beats.length - 1; k >= 0; k--) {
        const b = ep.beats[k];
        if (b.ok) return { t: b.t, y: Measurement.ahead(ep, b), type: b.type, ok: true, cycles: b.cycles };
      }
    }
    return null;
  }
}

/**
 * The same event with its times moved later by `dt` seconds. A live measurement restarts the
 * pipeline after an interruption, and the pipeline counts time from its own start; this places
 * the new segment's events after the gap on the run's timeline.
 * @param {PipelineEvent} e
 * @param {number} dt
 * @returns {PipelineEvent}
 */
export function shiftEvent(e, dt) {
  if (dt === 0) return e;
  if (e.type === 'status') return { ...e, t: e.t + dt };
  if (e.type === 'beats') return { ...e, beats: e.beats.map((b) => ({ ...b, t: b.t + dt })), replaceFrom: e.replaceFrom === null ? null : e.replaceFrom + dt };
  if (e.type === 'readings') return { ...e, t: e.t + dt, window: e.window === null ? null : [e.window[0] + dt, e.window[1] + dt] };
  return { ...e, t: e.t + dt };
}

/**
 * The vertical range of the trace: most of the confident points, with a margin. A few stray
 * points do not squash the rest; they are drawn at the edge instead.
 * @param {TracePoint[]} points
 * @returns {[number, number]} lowest and highest value in milliseconds
 */
export function traceRange(points) {
  const ys = points.filter((p) => p.ok).map((p) => p.y).sort((a, b) => a - b);
  if (ys.length === 0) return [-0.5, 0.5];
  const at = (/** @type {number} */ q) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(q * (ys.length - 1))))];
  let lo = at(0.02);
  let hi = at(0.98);
  const margin = Math.max(0.15, 0.15 * (hi - lo));
  lo -= margin;
  hi += margin;
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  return [lo, hi];
}

/**
 * Evenly spaced round values for axis labels.
 * @param {number} lo
 * @param {number} hi
 * @param {number} count about how many
 * @returns {number[]}
 */
export function ticks(lo, hi, count) {
  const raw = (hi - lo) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) || 10 * power;
  /** @type {number[]} */
  const out = [];
  // Whole multiples of the step, rounded so that 3 × 0.2 is 0.6 and not 0.6000000000000001.
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9 * step; k++) out.push(Number((k * step).toPrecision(12)) || 0);
  return out;
}

/**
 * @param {number|null|undefined} rate seconds per day
 * @returns {string}
 */
export function formatRate(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  const digits = Math.abs(rate) >= 100 ? 0 : 1;
  const text = Math.abs(rate).toFixed(digits);
  if (Number(text) === 0) return text;
  return (rate > 0 ? '+' : '−') + text;
}

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return ms.toFixed(ms >= 10 ? 1 : 2);
}

/**
 * @param {number|null|undefined} bph
 * @returns {string}
 */
export function formatBph(bph) {
  if (!bph) return '—';
  return bph.toLocaleString('en-US');
}

/**
 * How clearly the beats stand above the noise.
 * @typedef {Object} SignalLevel
 * @property {'clear'|'usable'|'faint'} level judged on the better-timed beat type
 * @property {0|1} type the better-timed beat type
 * @property {number} z its confidence, in noise standard deviations
 * @property {number} cycles cycles it averages per timestamp
 * @property {{type: 0|1, cycles: number}|null} fainter the other beat type when it needs more
 *   averaging, or null
 * @property {number} fraction position on the meter, 0 to 1
 */

/** Confidence at which beats count as clear, and below which they count as faint. */
export const CLEAR_Z = 20;
export const FAINT_Z = 8;

/** @param {0|1} type */
const typeName = (type) => (type === 0 ? 'tick' : 'tock');

/**
 * @param {ReadingsEvent|null} readings
 * @returns {SignalLevel|null} null when there is no lock
 */
export function signalLevel(readings) {
  const s = readings && readings.signal;
  if (!s) return null;
  /** @type {{type: 0|1, z: number, cycles: number}[]} */
  const types = [];
  for (const type of /** @type {(0|1)[]} */ ([0, 1])) {
    const z = s.z[type];
    if (z !== null) types.push({ type, z, cycles: s.cycles[type] || 1 });
  }
  if (types.length === 0) return null;
  // The better-timed type is the one needing the least averaging, then the more confident.
  types.sort((a, b) => a.cycles - b.cycles || b.z - a.z);
  const best = types[0];
  const other = types[1];
  // Needing to average cycles means single beats were too faint to time.
  const level = best.cycles > 1 || best.z < FAINT_Z ? 'faint' : best.z >= CLEAR_Z ? 'clear' : 'usable';
  // The meter shows the confidence a single beat would have: averaging K cycles raises it by
  // about the square root of K. Logarithmic scale from 3 (barely above the noise) to 100.
  const single = best.z / Math.sqrt(best.cycles);
  const fraction = Math.min(1, Math.max(0.03, Math.log(single / 3) / Math.log(100 / 3)));
  const fainter = other && other.cycles > best.cycles ? { type: other.type, cycles: other.cycles } : null;
  return { level, type: best.type, z: best.z, cycles: best.cycles, fainter, fraction };
}

/**
 * Which dots of the trace are averages, in words; empty when every beat is timed on its own.
 * @param {ReadingsEvent|null} readings
 * @returns {string}
 */
export function averagingNote(readings) {
  const s = readings && readings.signal;
  if (!s) return '';
  const [tick, tock] = s.cycles.map((c) => c || 1);
  if (tick > 1 && tick === tock) return `Each dot averages ${tick} cycles.`;
  /** @type {string[]} */
  const parts = [];
  if (s.cycles[0] !== null && tick > 1) parts.push(`Tick dots average ${tick} cycles.`);
  if (s.cycles[1] !== null && tock > 1) parts.push(`Tock dots average ${tock} cycles.`);
  return parts.join(' ');
}

/**
 * The warning shown when the watch runs irregularly: its beats fall early or late by an amount
 * that changes from one beat to the next.
 * @param {ReadingsEvent|null} readings
 * @returns {string|null} the words under the warning's title, or null for no warning
 */
export function irregularWarning(readings) {
  if (!readings || !readings.irregular) return null;
  const scatter = readings.jitterMs;
  const size = scatter !== null && Number.isFinite(scatter) ? `by ${scatter.toFixed(scatter >= 10 ? 0 : 1)} ms ` : '';
  return (
    `Beats wander ${size}from one to the next, where a steady watch keeps within about 0.1 ms. ` +
    'Each dot is one beat, nothing is averaged, and the beat error cannot be measured. ' +
    'This is often a sign that the watch needs service.'
  );
}

/**
 * What the screen needs to know about the source.
 * @typedef {Object} SourceState
 * @property {boolean} running
 * @property {boolean} finished a recording reached its end
 * @property {boolean} [interrupted] the microphone is interrupted
 * @property {boolean} [resumed] the microphone came back after an interruption
 */

/**
 * One line of advice under the signal meter.
 * @param {Measurement} m
 * @param {SourceState} source
 * @returns {string}
 */
export function guidance(m, source) {
  if (!source.running && !source.finished && m.state === 'idle') return 'Choose a source below and press Start.';
  if (source.running && source.interrupted) {
    return 'The microphone was interrupted, by a call, another app or the screen locking. Measuring starts again when the sound comes back.';
  }
  if (!source.running && !source.finished) {
    return m.state === 'tracking' ? 'Stopped. The numbers are the last reading. Press Start to measure again.' : 'Stopped. Press Start to measure again.';
  }
  if (m.state !== 'tracking') {
    if (source.finished) return m.lockedAt !== null ? 'The beat was lost before the end of the recording.' : 'No steady beat was found in this recording.';
    if (source.running && source.resumed) return 'The sound is back after an interruption. Listening for a steady beat again.';
    if (m.lockedAt !== null) return 'Lost the beat. Listening again.';
    return 'Listening for a steady beat. This usually takes 8 to 20 seconds.';
  }
  const s = signalLevel(m.readings);
  if (!s) return 'Locked. Waiting for the first reading.';
  const fainter = s.fainter ? ` The ${typeName(s.fainter.type)}s are fainter and are averaged over ${s.fainter.cycles} cycles.` : '';
  if (s.level === 'clear') return `Clear ${typeName(s.type)}s.${fainter}`;
  if (s.level === 'usable') return `Usable ${typeName(s.type)}s.${fainter} A quieter room or firmer contact would make them clearer.`;
  if (s.cycles > 1) {
    const seconds = m.bph ? (s.cycles * 7200) / m.bph : 0;
    const which = s.fainter ? `${typeName(s.type)} dots average ${s.cycles} cycles (${seconds.toFixed(1)} s) and ${typeName(s.fainter.type)} dots ${s.fainter.cycles}` : `each dot averages ${s.cycles} cycles (${seconds.toFixed(1)} s)`;
    return `Faint beats: ${which}. Firmer contact with the case would help.`;
  }
  return 'Faint beats. Firmer contact with the case would help.';
}

/**
 * The state line above the readout.
 * @param {Measurement} m
 * @param {SourceState} source
 * @returns {string}
 */
export function stateText(m, source) {
  if (source.running && source.interrupted) return 'Interrupted';
  if (m.state === 'tracking') return source.finished ? 'End of recording' : source.running ? 'Locked' : 'Stopped';
  if (source.running) return 'No lock · listening';
  if (source.finished) return 'End of recording · no lock';
  return m.state === 'idle' ? 'Not running' : 'Stopped';
}

/**
 * What to tell the user when the microphone cannot be opened.
 * @param {unknown} error from getUserMedia or the audio context
 * @returns {string}
 */
export function microphoneProblem(error) {
  const name = error instanceof Error || (error && typeof error === 'object' && 'name' in error) ? String(/** @type {{name: unknown}} */ (error).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "Microphone access was not allowed. Allow it in the browser's website settings for this site, then press Start.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one, or choose another input, then press Start.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is in use by something else, such as a call or another app. Press Start when it is free.';
  const message = error instanceof Error ? error.message : String(error);
  return `The microphone could not be opened: ${message}`;
}

/**
 * The active input as shown under the picker: its name, its sample rate, and a caution for
 * Bluetooth inputs, which usually run at 16 kHz against 44.1 or 48 kHz for a phone's own
 * microphone.
 * @param {string} label as the browser names it; may be empty
 * @param {number|null} sampleRate the input's own rate, when known
 * @returns {{text: string, bluetooth: boolean}}
 */
export function describeInput(label, sampleRate) {
  const bluetooth = /bluetooth|airpods|beats|hands-?free|\bbt\b|buds/i.test(label) || (sampleRate !== null && sampleRate <= 16000);
  const parts = [label || 'Microphone'];
  if (sampleRate) parts.push(`${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz`);
  let text = parts.join(' · ');
  if (bluetooth) text += '. Bluetooth inputs are experimental: their sound is coarser than a wired or built-in microphone.';
  return { text, bluetooth };
}

/**
 * A length of audio in words: 45 s, 1 min, 1 min 37 s.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/**
 * The save button's words for the length kept.
 * @param {number} minutes
 * @returns {string}
 */
export function saveLabel(minutes) {
  return minutes === 1 ? 'Save the last minute' : `Save the last ${minutes} minutes`;
}

/**
 * Size in megabytes of a saved recording: 32-bit floating-point samples, one channel, and the
 * WAV header.
 * @param {number} seconds
 * @param {number} sampleRate
 * @returns {number}
 */
export function recordingMegabytes(seconds, sampleRate) {
  return (58 + Math.floor(seconds * sampleRate) * 4) / 1e6;
}
