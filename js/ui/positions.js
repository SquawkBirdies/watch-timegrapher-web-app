// The six-position log: one reading for each position a watch is checked in, and what they add
// up to. A watch keeps different time dial up, dial down and on its edges, because gravity pulls
// on its balance differently in each, so watchmakers check it in all six. Nothing here touches the
// page, so the automated tests can run it, and nothing is measured here: every number comes from
// the pipeline's readings.

import { formatRate, formatMs, formatDuration } from './model.js';

/**
 * @typedef {'dialUp'|'dialDown'|'crownUp'|'crownDown'|'crownLeft'|'crownRight'} PositionId
 * @typedef {import('../dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 * @typedef {import('../dsp/estimate.js').Escapement} Escapement
 */

/** The six positions, in the order they are suggested. */
export const POSITIONS = /** @type {ReadonlyArray<{id: PositionId, name: string}>} */ (
  Object.freeze([
    { id: 'dialUp', name: 'Dial up' },
    { id: 'dialDown', name: 'Dial down' },
    { id: 'crownUp', name: 'Crown up' },
    { id: 'crownDown', name: 'Crown down' },
    { id: 'crownLeft', name: 'Crown left' },
    { id: 'crownRight', name: 'Crown right' },
  ])
);

/**
 * Largest rate uncertainty, in seconds per day, of a reading that counts in the summary. A
 * steady watch's 20 s reading is good to about ±0.1 s/day, and a faint one's to a few tenths; a
 * reading less certain than this is shown, marked, and left out of the average and the spread
 * rather than quietly blurring them.
 */
export const MAX_RATE_SD = 1;

/**
 * A reading has settled once the lock has lasted the whole averaging window, counted from the
 * moment the lock appeared. The window slides with the audio, so the reading then draws only on
 * audio heard since the lock: none from before the watch was placed or while it was settling,
 * and none from the stretch the lock was found in, which the readings shown in continuous mode
 * do use. Times come from the same sample counts; this allows only for rounding.
 */
const FULL_WINDOW_TOLERANCE_SECONDS = 0.01;

/**
 * Why a saved reading has no beat error.
 * @typedef {'coaxial'|'irregular'|'unmeasured'} BeatErrorGap
 */

/**
 * One position's saved reading.
 * @typedef {Object} PositionReading
 * @property {number} rate seconds per day, positive when gaining
 * @property {number} rateSd statistical uncertainty of the rate
 * @property {number|null} beatErrorMs null when it was not measured
 * @property {BeatErrorGap|null} beatErrorGap why the beat error is missing; null when it is there
 * @property {boolean} irregular the beats fell at scattered times
 * @property {number} beats confident timestamps behind the rate, ticks and tocks together: one
 *   beat each, or for a faint watch an average of several cycles each (see `cycles`)
 * @property {(number|null)[]|null} cycles tick-tock cycles averaged per timestamp, for ticks and
 *   tocks, null for a type not timed; null when not known (readings saved before 26 November)
 * @property {number} windowSeconds length of the averaging window the reading was made over:
 *   the setting, or longer when faint ticks were averaged
 * @property {number} seconds time from the first timestamp in the window to the last
 * @property {number} bph beat rate
 * @property {Escapement} escapement as set for the run
 * @property {string} source what was measured: Microphone, Simulator or a recording's name
 * @property {string} savedAt when, as an ISO 8601 time
 */

/**
 * The log: at most one reading per position.
 * @typedef {Object} PositionLog
 * @property {string|null} started when the first reading of this log was saved
 * @property {Partial<Record<PositionId, PositionReading>>} readings
 */

/** @returns {PositionLog} */
export function emptyLog() {
  return { started: null, readings: {} };
}

/**
 * @param {string} id
 * @returns {id is PositionId}
 */
export function isPosition(id) {
  return POSITIONS.some((p) => p.id === id);
}

/**
 * @param {PositionId} id
 * @returns {string}
 */
export function positionName(id) {
  const p = POSITIONS.find((q) => q.id === id);
  return p ? p.name : id;
}

/**
 * Whether the reading on screen can be saved: the lock must have lasted the whole averaging
 * window since it appeared. The window is the one set, or longer when faint ticks are averaged.
 * @param {boolean} tracking the pipeline is locked
 * @param {ReadingsEvent|null} readings latest readings
 * @param {number} averagingSeconds the window set in the settings
 * @param {number|null} lockSince when the current lock appeared, in seconds of audio
 * @returns {{ready: boolean, covered: number, needed: number}} seconds of the window heard since
 *   the lock appeared, and how many it holds
 */
export function readiness(tracking, readings, averagingSeconds, lockSince) {
  if (!tracking || lockSince === null || !readings || readings.windowStart === null || readings.windowSeconds === null || readings.rate === null || readings.rateSd === null) {
    return { ready: false, covered: 0, needed: averagingSeconds };
  }
  const needed = readings.windowSeconds;
  const covered = Math.max(0, Math.min(needed, readings.t - lockSince));
  // The window must hold the whole set length and begin no earlier than the lock.
  const ready = covered >= needed - FULL_WINDOW_TOLERANCE_SECONDS && readings.t - readings.windowStart >= needed - FULL_WINDOW_TOLERANCE_SECONDS && readings.windowStart >= lockSince - FULL_WINDOW_TOLERANCE_SECONDS;
  return { ready, covered, needed };
}

/**
 * The reading on screen, as it is kept in the log.
 * @param {ReadingsEvent} readings
 * @param {{bph: number, escapement: Escapement, source: string, now: Date}} context
 * @returns {PositionReading|null} null when there is no rate to keep
 */
export function takeReading(readings, context) {
  if (readings.rate === null || readings.rateSd === null || !readings.window || readings.windowSeconds === null) return null;
  const beatErrorMs = readings.beatErrorMs;
  /** @type {BeatErrorGap|null} */
  let beatErrorGap = null;
  if (beatErrorMs === null) beatErrorGap = context.escapement === 'coaxial' ? 'coaxial' : readings.irregular ? 'irregular' : 'unmeasured';
  return {
    rate: readings.rate,
    rateSd: readings.rateSd,
    beatErrorMs,
    beatErrorGap,
    irregular: readings.irregular,
    beats: readings.fits.reduce((sum, f) => sum + (f ? f.count : 0), 0),
    cycles: readings.signal ? readings.signal.cycles.map((k, type) => (readings.fits[type] ? k || 1 : null)) : null,
    windowSeconds: readings.windowSeconds,
    seconds: readings.window[1] - readings.window[0],
    bph: context.bph,
    escapement: context.escapement,
    source: context.source,
    savedAt: context.now.toISOString(),
  };
}

/**
 * The log with a reading saved for one position, replacing any reading it had.
 * @param {PositionLog} log
 * @param {PositionId} id
 * @param {PositionReading} reading
 * @returns {PositionLog}
 */
export function withReading(log, id, reading) {
  return { started: log.started || reading.savedAt, readings: { ...log.readings, [id]: reading } };
}

/**
 * The next position without a reading, looking on from `after` in the usual order and wrapping
 * round; from the first position when `after` is null.
 * @param {PositionLog} log
 * @param {PositionId|null} [after]
 * @returns {PositionId|null} null once all six have readings
 */
export function nextPosition(log, after = null) {
  const start = after === null ? 0 : POSITIONS.findIndex((p) => p.id === after) + 1;
  for (let k = 0; k < POSITIONS.length; k++) {
    const p = POSITIONS[(start + k) % POSITIONS.length];
    if (!log.readings[p.id]) return p.id;
  }
  return null;
}

/**
 * @param {PositionReading} r
 * @returns {boolean} the reading is too uncertain to count in the summary
 */
export function isUncertain(r) {
  return !(r.rateSd <= MAX_RATE_SD);
}

/**
 * What the saved readings add up to.
 * @typedef {Object} Summary
 * @property {number} measured positions with a reading
 * @property {PositionId[]} used positions counted in the average and the spread
 * @property {PositionId[]} leftOut positions whose reading is too uncertain to count
 * @property {number|null} average mean rate of the positions used, seconds per day
 * @property {number|null} spread fastest minus slowest rate; null with fewer than two used
 * @property {PositionId|null} fastest
 * @property {PositionId|null} slowest
 * @property {{ms: number, position: PositionId}|null} largestBeatError among all readings
 * @property {number} beatErrorGaps readings without a beat error
 * @property {boolean} coaxial some reading without a beat error was of a co-axial escapement
 */

/**
 * @param {PositionLog} log
 * @returns {Summary}
 */
export function summarise(log) {
  /** @type {PositionId[]} */
  const used = [];
  /** @type {PositionId[]} */
  const leftOut = [];
  /** @type {{ms: number, position: PositionId}|null} */
  let largestBeatError = null;
  let beatErrorGaps = 0;
  let coaxial = false;
  let measured = 0;
  for (const { id } of POSITIONS) {
    const r = log.readings[id];
    if (!r) continue;
    measured++;
    (isUncertain(r) ? leftOut : used).push(id);
    // Beat error does not depend on the rate's certainty, so every reading that has one counts.
    if (r.beatErrorMs !== null) {
      if (!largestBeatError || r.beatErrorMs > largestBeatError.ms) largestBeatError = { ms: r.beatErrorMs, position: id };
    } else {
      beatErrorGaps++;
      if (r.beatErrorGap === 'coaxial') coaxial = true;
    }
  }
  const rate = (/** @type {PositionId} */ id) => /** @type {PositionReading} */ (log.readings[id]).rate;
  const average = used.length ? used.reduce((sum, id) => sum + rate(id), 0) / used.length : null;
  /** @type {PositionId|null} */
  let fastest = null;
  /** @type {PositionId|null} */
  let slowest = null;
  for (const id of used) {
    if (fastest === null || rate(id) > rate(fastest)) fastest = id;
    if (slowest === null || rate(id) < rate(slowest)) slowest = id;
  }
  const spread = used.length >= 2 && fastest !== null && slowest !== null ? rate(fastest) - rate(slowest) : null;
  return { measured, used, leftOut, average, spread, fastest: used.length >= 2 ? fastest : null, slowest: used.length >= 2 ? slowest : null, largestBeatError, beatErrorGaps, coaxial };
}

/**
 * A rate uncertainty as shown: two decimals below 0.1 s/day, one above.
 * @param {number} sd
 * @returns {string}
 */
export function formatSd(sd) {
  return sd < 0.1 ? sd.toFixed(2) : sd.toFixed(1);
}

/**
 * A saved reading in words, for its row in the log.
 * @param {PositionReading} r
 * @returns {{main: string, detail: string}}
 */
export function describeReading(r) {
  const main = `${formatRate(r.rate)} s/d ±${formatSd(r.rateSd)}` + (r.beatErrorMs !== null ? ` · ${formatMs(r.beatErrorMs)} ms` : '');
  const parts = [`Over a ${formatDuration(Math.round(r.windowSeconds))} window`, countText(r)];
  if (r.beatErrorGap === 'coaxial') parts.push('beat error not shown: co-axial');
  else if (r.beatErrorGap === 'irregular') parts.push('irregular beat, no beat error');
  else if (r.beatErrorGap === 'unmeasured') parts.push('beat error not measurable');
  else if (r.irregular) parts.push('irregular beat');
  if (isUncertain(r)) parts.push(`uncertain, left out of the average`);
  return { main, detail: parts.join(' · ') };
}

/**
 * What the rate was measured from, in words. A faint watch's timestamps each average several
 * cycles, so counting them as beats would undercount what was heard.
 * @param {PositionReading} r
 * @returns {string}
 */
function countText(r) {
  const ks = r.cycles ? /** @type {number[]} */ (r.cycles.filter((k) => k !== null)) : [];
  if (ks.length === 0) return `${r.beats} timestamps`;
  const most = Math.max(...ks);
  if (most === 1) return `${r.beats} beats`;
  return Math.min(...ks) === most ? `${r.beats} timestamps of ${most} cycles` : `${r.beats} timestamps of up to ${most} cycles`;
}

/**
 * The summary in words: each figure with a note under it, and a line on anything left out.
 * @param {Summary} s
 * @returns {{average: string, averageNote: string, spread: string, spreadNote: string, beatError: string, beatErrorNote: string, leftOut: string}}
 */
export function describeSummary(s) {
  const plural = (/** @type {number} */ n) => `${n} position${n === 1 ? '' : 's'}`;
  const average = s.average === null ? '—' : `${formatRate(s.average)} s/d`;
  const averageNote = s.average === null ? (s.measured ? 'no certain reading yet' : 'no positions yet') : `over ${plural(s.used.length)}`;
  const spread = s.spread === null ? '—' : `${s.spread.toFixed(Math.abs(s.spread) >= 100 ? 0 : 1)} s/d`;
  const spreadNote =
    s.spread === null || s.fastest === null || s.slowest === null
      ? 'needs two positions'
      : `${positionName(s.fastest)} fastest, ${positionName(s.slowest)} slowest`;
  const beatError = s.largestBeatError ? `${formatMs(s.largestBeatError.ms)} ms` : '—';
  const beatErrorNote = s.largestBeatError
    ? positionName(s.largestBeatError.position)
    : s.measured === 0
      ? 'no positions yet'
      : s.coaxial
        ? 'not shown for co-axial'
        : 'not measurable';
  const leftOut = s.leftOut.length
    ? `Left out of the average and the spread, as their rates are uncertain by more than ±${MAX_RATE_SD} s/d: ${s.leftOut.map(positionName).join(', ')}.`
    : '';
  return { average, averageNote, spread, spreadNote, beatError, beatErrorNote, leftOut };
}

/**
 * What the measurement looks like to the position log.
 * @typedef {Object} StepState
 * @property {PositionId|null} target the position the next save goes to
 * @property {PositionId|null} saved the position this run's reading was saved as, if it was
 * @property {boolean} running the source is running
 * @property {boolean} tracking the pipeline is locked
 * @property {number} covered seconds of the window heard since the lock appeared
 * @property {number} needed seconds the reading covers once full
 * @property {boolean} ready the current reading can be saved
 * @property {number|null} rateSd the current reading's rate uncertainty
 */

/**
 * The line telling the user what to do next.
 * @param {StepState} s
 * @returns {string}
 */
export function positionStep(s) {
  const place = (/** @type {PositionId} */ id) => positionName(id).toLowerCase();
  if (s.saved) {
    const done = `Saved ${positionName(s.saved)}.`;
    return s.target ? `${done} Place the watch ${place(s.target)}, then press Start.` : `${done} All six positions are saved.`;
  }
  if (!s.target) return 'All six positions are saved. Tap one to measure it again, or start a new log.';
  if (s.ready) {
    const uncertain = s.rateSd !== null && s.rateSd > MAX_RATE_SD ? ` Its rate is uncertain by ±${formatSd(s.rateSd)} s/d, so it would be left out of the average.` : '';
    return `Ready to save as ${positionName(s.target)}.${uncertain}`;
  }
  if (!s.running) return `Place the watch ${place(s.target)}, then press Start.`;
  const needed = Math.round(s.needed);
  if (!s.tracking) return `Listening. Once locked, the reading takes ${needed} s.`;
  return `Keep the watch still: ${Math.min(needed, Math.floor(s.covered))} of ${needed} s since the lock.`;
}

/**
 * Keep only valid readings from a stored log; anything else is dropped.
 * @param {unknown} raw
 * @returns {PositionLog}
 */
export function cleanLog(raw) {
  const log = emptyLog();
  if (!raw || typeof raw !== 'object') return log;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const readings = obj.readings && typeof obj.readings === 'object' ? /** @type {Record<string, unknown>} */ (obj.readings) : {};
  for (const { id } of POSITIONS) {
    const r = cleanReading(readings[id]);
    if (r) log.readings[id] = r;
  }
  if (typeof obj.started === 'string' && obj.started.length <= 40 && Object.keys(log.readings).length) log.started = obj.started;
  return log;
}

/**
 * @param {unknown} raw
 * @returns {PositionReading|null}
 */
function cleanReading(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const finite = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
  if (!finite(r.rate) || !finite(r.rateSd) || /** @type {number} */ (r.rateSd) < 0) return null;
  if (!(r.beatErrorMs === null || (finite(r.beatErrorMs) && /** @type {number} */ (r.beatErrorMs) >= 0))) return null;
  if (!finite(r.beats) || !finite(r.windowSeconds) || !finite(r.seconds) || !finite(r.bph) || /** @type {number} */ (r.bph) <= 0) return null;
  if (r.escapement !== 'lever' && r.escapement !== 'coaxial') return null;
  const gap = r.beatErrorGap === 'coaxial' || r.beatErrorGap === 'irregular' || r.beatErrorGap === 'unmeasured' ? r.beatErrorGap : null;
  return {
    rate: /** @type {number} */ (r.rate),
    rateSd: /** @type {number} */ (r.rateSd),
    beatErrorMs: /** @type {number|null} */ (r.beatErrorMs),
    beatErrorGap: r.beatErrorMs === null ? gap || 'unmeasured' : null,
    irregular: r.irregular === true,
    beats: Math.max(0, Math.round(/** @type {number} */ (r.beats))),
    cycles: cleanCycles(r.cycles),
    windowSeconds: Math.max(0, /** @type {number} */ (r.windowSeconds)),
    seconds: Math.max(0, /** @type {number} */ (r.seconds)),
    bph: /** @type {number} */ (r.bph),
    escapement: r.escapement,
    source: typeof r.source === 'string' ? r.source.slice(0, 200) : '',
    savedAt: typeof r.savedAt === 'string' ? r.savedAt.slice(0, 40) : '',
  };
}

/**
 * @param {unknown} raw
 * @returns {(number|null)[]|null} two whole numbers of at least 1, or null for a type not timed;
 *   null when missing or invalid
 */
function cleanCycles(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const ok = raw.every((k) => k === null || (Number.isInteger(k) && k >= 1));
  return ok ? raw.map((k) => (k === null ? null : Number(k))) : null;
}
