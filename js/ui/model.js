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
 * One line of advice under the signal meter.
 * @param {Measurement} m
 * @param {{running: boolean, finished: boolean}} source
 * @returns {string}
 */
export function guidance(m, source) {
  if (!source.running && !source.finished && m.state === 'idle') return 'Choose a source below and press Start.';
  if (m.state !== 'tracking') {
    if (source.finished) return m.lockedAt !== null ? 'The beat was lost before the end of the recording.' : 'No steady beat was found in this recording.';
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
 * @param {{running: boolean, finished: boolean}} source
 * @returns {string}
 */
export function stateText(m, source) {
  if (m.state === 'tracking') return source.finished ? 'End of recording' : 'Locked';
  if (source.running) return 'No lock · listening';
  if (source.finished) return 'End of recording · no lock';
  return 'Not running';
}
