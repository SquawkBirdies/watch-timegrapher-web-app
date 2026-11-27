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
 * @property {0|1|null} tick which type of beat is the tick, once the pipeline's readings have
 *   said so; null until then, and the stretch's beats then have no names
 */

/**
 * What a beat is called once the pipeline has named the tick.
 * @typedef {'tick'|'tock'} BeatName
 */

/**
 * A point of the trace.
 * @typedef {Object} TracePoint
 * @property {number} t seconds from the start of the audio
 * @property {number} y milliseconds ahead of an ideal clock at the nominal beat rate
 * @property {0|1} type the pipeline's two kinds of beat, which alternate
 * @property {BeatName|null} name tick or tock; null while the pipeline has not named them, and
 *   both kinds are then drawn in one colour
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
    /** @type {number|null} when the current lock appeared, in seconds of audio; null without one */
    this.lockSince = null;
    /** Seconds of audio sent to the pipeline so far. */
    this.audioSeconds = 0;
  }

  /**
   * Which type of beat is the tick in the stretch of lock now on, or in the last one.
   * @returns {0|1|null} null when the pipeline has not named it
   */
  get tick() {
    const ep = this.episodes[this.episodes.length - 1];
    return ep ? ep.tick : null;
  }

  /** The source is starting: everything goes back to its starting state. */
  start() {
    this.state = 'listening';
    this.bph = null;
    this.episodes = [];
    this.readings = null;
    this.waveform = null;
    this.lockedAt = null;
    this.lockSince = null;
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
    this.lockSince = null;
  }

  /** @param {PipelineEvent} e */
  apply(e) {
    if (e.type === 'status') {
      if (e.state === 'tracking' && this.state !== 'tracking') {
        // A lock that carries on from one lost moments before keeps its beat numbers, so its
        // beats stay on the same stretch of the trace, measured from the same reference beat.
        const ep = this.episodes[this.episodes.length - 1];
        if (!(e.continues && ep && ep.bph === e.bph && ep.n0 !== null)) {
          const last = this.lastPoint();
          this.episodes.push({ bph: /** @type {number} */ (e.bph), n0: null, t0: null, base: last ? last.y : 0, beats: [], tick: null });
        }
        if (this.lockedAt === null) this.lockedAt = e.t;
        // A lock that carries on a lost one is still a new lock: what was heard while it was
        // lost belongs to neither.
        this.lockSince = e.t;
      }
      if (e.state === 'listening') {
        this.readings = null;
        this.waveform = null;
        this.lockSince = null;
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
      // The names are the pipeline's to give and to take back: it keeps them for as long as
      // the beat numbers carry on, and drops them only when the escapement setting changes.
      const ep = this.episodes[this.episodes.length - 1];
      if (ep && e.window !== null && this.state === 'tracking') ep.tick = e.tick;
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
        out.push({ t: b.t, y: Measurement.ahead(ep, b), type: b.type, name: beatName(b.type, ep.tick), ok: b.ok, cycles: b.cycles });
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
        if (b.ok) return { t: b.t, y: Measurement.ahead(ep, b), type: b.type, name: beatName(b.type, ep.tick), ok: true, cycles: b.cycles };
      }
    }
    return null;
  }
}

/**
 * @param {0|1} type one of the pipeline's two kinds of beat
 * @param {0|1|null} tick the kind that is the tick, or null while they have no names
 * @returns {BeatName|null}
 */
export function beatName(type, tick) {
  if (tick === null) return null;
  return type === tick ? 'tick' : 'tock';
}

/**
 * The same event with its times moved later by `dt` seconds. A live measurement restarts the
 * pipeline after an interruption, and the pipeline counts time from its own start; this places
 * the new segment's events after the gap on the run's timeline. Every time an event carries
 * moves, because they are compared with one another: the six-position log sets where a
 * reading's audio begins against when the lock appeared, which comes from a status event.
 * @param {PipelineEvent} e
 * @param {number} dt
 * @returns {PipelineEvent}
 */
export function shiftEvent(e, dt) {
  if (dt === 0) return e;
  if (e.type === 'status') return { ...e, t: e.t + dt };
  if (e.type === 'beats') return { ...e, beats: e.beats.map((b) => ({ ...b, t: b.t + dt })), replaceFrom: e.replaceFrom === null ? null : e.replaceFrom + dt };
  if (e.type === 'readings') {
    const sounds = e.sounds && e.sounds.window ? { ...e.sounds, window: /** @type {[number, number]} */ ([e.sounds.window[0] + dt, e.sounds.window[1] + dt]) } : e.sounds;
    return {
      ...e,
      t: e.t + dt,
      window: e.window === null ? null : [e.window[0] + dt, e.window[1] + dt],
      windowStart: e.windowStart === null ? null : e.windowStart + dt,
      sounds,
    };
  }
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
 * @param {0|1|null} [tick] the kind of beat that is the tick; null while they have no names
 * @returns {string}
 */
export function averagingNote(readings, tick = null) {
  const s = readings && readings.signal;
  if (!s) return '';
  const cycles = s.cycles.map((c) => c || 1);
  if (cycles[0] > 1 && cycles[0] === cycles[1]) return `Each dot averages ${cycles[0]} cycles.`;
  const averaged = /** @type {(0|1)[]} */ ([0, 1]).filter((type) => s.cycles[type] !== null && cycles[type] > 1);
  if (tick === null) {
    if (averaged.length === 2) return `The dots of one beat average ${cycles[0]} cycles, the other's ${cycles[1]}.`;
    return averaged.length ? `Every other dot averages ${cycles[averaged[0]]} cycles.` : '';
  }
  // Tick first, whichever kind it is.
  return averaged
    .sort((a, b) => Number(a !== tick) - Number(b !== tick))
    .map((type) => `${type === tick ? 'Tick' : 'Tock'} dots average ${cycles[type]} cycles.`)
    .join(' ');
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
 * The fine print on the computing that reading the sounds inside the beats takes, for the beat
 * error and the amplitude. It is there so that the cost can be read off a phone. When a reading
 * gave nothing, or one of the two is held back, it adds the pipeline's own word for the reason,
 * which the readout gives in plain language.
 * @param {import('../dsp/soundstage.js').StageLoad|null} stage the stage's computing so far
 * @param {import('../dsp/soundstage.js').SoundsReport|null} sounds what the latest readings carry
 * @returns {string} empty when the stage is not running or has not finished a reading
 */
export function stageNote(stage, sounds) {
  if (!stage || stage.readings === 0 || stage.lastSeconds === null || stage.lastAudioSeconds === null) return '';
  let result = '';
  if (sounds && sounds.detail) {
    if (sounds.detail.why !== null) result = `, no reading (${sounds.detail.why})`;
    else if (sounds.amplitude !== null && sounds.beatErrorMs !== null) result = '';
    else if (sounds.amplitude !== null) result = `, beat error held back (${sounds.beatErrorWhy})`;
    else if (sounds.beatErrorMs !== null) result = `, amplitude held back (${sounds.amplitudeWhy})`;
    else result = `, both held back (${sounds.amplitudeWhy})`;
  }
  return `beat sounds read ${stage.readings} time${stage.readings === 1 ? '' : 's'}, last in ${stage.lastSeconds.toFixed(1)} s of computing over ${stage.lastAudioSeconds.toFixed(1)} s${result}`;
}

/**
 * Seconds of beats the pipeline wants of each kind before it first reads the sounds inside
 * them: FIRST_READING_SECONDS of js/dsp/soundstage.js, repeated here so that the page does not
 * load the pipeline's code, which runs in the worker. A test holds the two together.
 */
export const BEATS_NEEDED_SECONDS = 30;

/**
 * Why a reading taken from the sounds inside the beats shows a dash, in plain language. The
 * words are short: they stand under a number in a narrow column.
 * @param {import('../dsp/soundstage.js').StageWhy|null} why the pipeline's reason
 * @returns {string} empty for no reason
 */
export function whyWords(why) {
  switch (why) {
    case null:
      return '';
    case 'waiting':
      return `needs ${BEATS_NEEDED_SECONDS} s of beats`;
    case 'averaged':
      return 'beats too faint';
    case 'few-beats':
      return 'too few clear beats';
    case 'lift-range':
      return 'check the lift angle';
    case 'failing':
      return 'sounds not clear enough';
    case 'irregular':
      return 'irregular beat';
    case 'halfway':
      return 'check the beat rate';
    case 'scatter':
      return 'readings too scattered';
    case 'unplaced':
    case 'placement':
      return 'beat timing unsure';
    case 'unchecked':
      return 'not checked';
    default:
      // The remaining reasons are all the same to the user: the unlock, or the lock to pair it
      // with, was not found in the averaged beats.
      return 'sounds not found';
  }
}

/**
 * A scatter as shown beside its reading: at least one unit of the last digit shown, so that a
 * reading is never given as exact.
 * @param {number} sd
 * @param {number} digits
 * @returns {string}
 */
function formatScatter(sd, digits) {
  return Math.max(sd, 10 ** -digits).toFixed(digits);
}

/**
 * What the readout shows for the amplitude and the beat error, which are both read from the
 * sounds inside the beats.
 * @typedef {Object} SoundsReadout
 * @property {string} amplitude whole degrees, or a dash
 * @property {string} amplitudeNote its scatter and the beats it rests on, or why there is a dash
 * @property {string} beatError milliseconds, or a dash
 * @property {string} beatErrorNote as for the amplitude
 */

/**
 * @param {boolean} tracking the pipeline is locked
 * @param {ReadingsEvent|null} readings the latest readings
 * @param {number} liftAngle the lift angle in effect, in degrees. An amplitude made with another
 *   is not shown: after a run has ended, a new setting leaves a dash and says why
 * @param {boolean} [running] false once the source has stopped or a recording has ended: a
 *   reading that was still waiting for beats will not get them
 * @returns {SoundsReadout}
 */
export function soundsReadout(tracking, readings, liftAngle, running = true) {
  const s = tracking && readings ? readings.sounds : null;
  if (!s) return { amplitude: '—', amplitudeNote: '', beatError: '—', beatErrorNote: '' };
  const span = s.window ? `over ${Math.round(s.window[1] - s.window[0])} s` : '';
  const words = (/** @type {import('../dsp/soundstage.js').StageWhy|null} */ why) => (why === 'waiting' && !running ? `needed ${BEATS_NEEDED_SECONDS} s of beats` : whyWords(why));
  const out = { amplitude: '—', amplitudeNote: words(s.amplitudeWhy), beatError: '—', beatErrorNote: words(s.beatErrorWhy) };
  if (s.liftAngle !== liftAngle) {
    out.amplitudeNote = 'lift angle changed';
  } else if (s.amplitude !== null && s.amplitudeSd !== null) {
    out.amplitude = s.amplitude.toFixed(0);
    out.amplitudeNote = `±${formatScatter(s.amplitudeSd, s.amplitudeSd < 9.95 ? 1 : 0)}° ${span}`;
  }
  if (s.beatErrorMs !== null && s.beatErrorSd !== null) {
    out.beatError = formatMs(s.beatErrorMs);
    out.beatErrorNote = `±${formatScatter(s.beatErrorSd, 2)} ${span}`;
  }
  return out;
}

/**
 * The amplitude and the beat error as a phrase each, for text with no column to put a note
 * under, such as the audio diagnostic's reading line and its report: "amplitude 288° ±1.1° over
 * 50 s", or "amplitude — (needs 30 s of beats)".
 * @param {SoundsReadout} r
 * @returns {{amplitude: string, beatError: string}}
 */
export function soundsInWords(r) {
  /** @param {string} name @param {string} value @param {string} unit @param {string} note */
  const phrase = (name, value, unit, note) => (value === '—' ? `${name} —${note ? ` (${note})` : ''}` : `${name} ${value}${unit} ${note}`.trim());
  return { amplitude: phrase('amplitude', r.amplitude, '°', r.amplitudeNote), beatError: phrase('beat error', r.beatError, ' ms', r.beatErrorNote) };
}

/** A lift angle above this is a Swiss lever's, in degrees: co-axial calibres are set lower. */
export const COAXIAL_LIFT_LIMIT = 40;

/**
 * A reminder that co-axial movements are measured with a smaller lift angle than Swiss levers,
 * shown while the escapement is set to co-axial and the lift angle is still a lever's: the
 * amplitude would read some 40% high, and usually not be believable at all. The two angles
 * are the ones the co-axial investigation found: Omega's technical guide for its calibres 8520
 * and 8521, and a watchmaker's figure for the 3861.
 * @param {import('../dsp/estimate.js').Escapement} escapement
 * @param {number} liftAngle in degrees
 * @returns {string|null} null when there is nothing to say
 */
export function liftHint(escapement, liftAngle) {
  if (escapement !== 'coaxial' || !(liftAngle > COAXIAL_LIFT_LIMIT)) return null;
  // Kept short at Lawrence's request (27 November 2026); the README gives the sources.
  return `Lift angle ${liftAngle}° suits a Swiss lever. Co-axials use less: 38° for Omega's 8520 and 8521, 36° reported for the 3861.`;
}

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
  // Until the pipeline has named the tick, the two kinds of beat are told apart only as one
  // and the other.
  const name = beatName(s.type, m.tick);
  const other = s.fainter ? beatName(s.fainter.type, m.tick) : null;
  const fainter = s.fainter ? (other ? ` The ${other}s are fainter and are averaged over ${s.fainter.cycles} cycles.` : ` Every other beat is fainter and is averaged over ${s.fainter.cycles} cycles.`) : '';
  if (s.level === 'clear') return `Clear ${name || 'beat'}s.${fainter}`;
  if (s.level === 'usable') return `Usable ${name || 'beat'}s.${fainter} A quieter room or firmer contact would make them clearer.`;
  if (s.cycles > 1) {
    const seconds = m.bph ? (s.cycles * 7200) / m.bph : 0;
    const which = !s.fainter
      ? `each dot averages ${s.cycles} cycles (${seconds.toFixed(1)} s)`
      : name && other
        ? `${name} dots average ${s.cycles} cycles (${seconds.toFixed(1)} s) and ${other} dots ${s.fainter.cycles}`
        : `the dots of one beat average ${s.cycles} cycles (${seconds.toFixed(1)} s) and the other's ${s.fainter.cycles}`;
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
