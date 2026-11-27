// Stage 10 of the pipeline in real time: the beat error from the unlocks and the amplitude,
// read from the sounds inside the beats while the pipeline keeps up with the audio.
//
// js/dsp/sounds.js and js/dsp/amplitude.js do the reading; this file gives them their beats and
// their time. It keeps the last minute of the envelopes the sounds are read from, as the filter
// bank made them, before Cleanup. When a reading is due it cuts every confident beat's stretch
// out of them and starts the reading on that copy. A reading with its 200 draws takes from half
// a second to several seconds of computing, so it is taken a few steps at a time: at each audio
// block it may compute for a share of the time that has passed since the block before. The
// pipeline's own work comes first, the thread stays free to answer, and a pipeline that has
// fallen behind, whose blocks then come one straight after another, is left most of the time
// to catch up in.

import { STRETCH_BEFORE_S, soundRowIndices } from './sounds.js';
import { MIN_BEATS, timedBeats, trendBeats, readBeatsSteps, noReading, heldBack } from './amplitude.js';

/**
 * @typedef {import('./amplitude.js').SoundsReading} SoundsReading
 * @typedef {import('./amplitude.js').NoReading} NoReading
 * @typedef {import('./amplitude.js').Held} Held
 */

/** How far back the beats of a reading reach, in seconds. */
export const STACK_SECONDS = 60;
/**
 * Each beat type must have beats over this long before a reading is tried, in seconds. With
 * 20 s the Omega 3861's reading was held back, and a stretch under 20 s has a single 10 s block
 * to compare, so a sound that moves cannot be lined up.
 */
export const FIRST_READING_SECONDS = 30;
/**
 * Shortest time from the start of one reading to the start of the next, in seconds of audio,
 * once the beats reach back the whole STACK_SECONDS. A reading of a minute of beats changes
 * little in 10 s, and each costs about a second of computing when no sound moves, several when
 * the beats are lined up again.
 */
export const READING_EVERY_SECONDS = 10;
/**
 * The same while a lock is younger than that and each reading has more beats than the last:
 * a reading held back for want of beats is then tried again sooner.
 */
export const FILLING_EVERY_SECONDS = 5;
/**
 * Share of the time, by the clock, that a reading in progress may compute for. A reading that
 * costs 3 s of computing then takes 6 s to appear.
 */
export const STAGE_SHARE = 0.5;
/**
 * After a reading the stage rests for this share of the audio that went by while the reading
 * was worked out, so that readings that take long do not follow one another without a pause:
 * with STAGE_SHARE they then take a third of the time between them.
 */
export const REST_SHARE = 0.5;
/** How often a stage without enough beats looks again, in seconds. */
const LOOK_EVERY_SECONDS = 0.25;
/**
 * A lock this much older than FIRST_READING_SECONDS that still has too few confident beats is
 * no longer waiting for them, in seconds.
 */
const GIVE_UP_SECONDS = 5;

/**
 * How the real-time stage runs.
 * @typedef {Object} StageOptions
 * @property {number} [windowSeconds] how far back a reading's beats reach; STACK_SECONDS when absent
 * @property {number} [firstSeconds] FIRST_READING_SECONDS when absent
 * @property {number} [everySeconds] READING_EVERY_SECONDS when absent
 * @property {number} [fillingSeconds] FILLING_EVERY_SECONDS when absent, or `everySeconds` if
 *   that is shorter
 * @property {number} [share] STAGE_SHARE when absent; Infinity finishes every reading in the
 *   audio block it starts in, which the tests use so that their results do not depend on the
 *   computer's speed
 * @property {number} [rest] REST_SHARE when absent
 * @property {boolean} [sinceLock] false also reads the beats of the audio the lock was found
 *   in, heard before the lock appeared; true, the default, reads only beats heard since
 * @property {() => number} [clock] the time in milliseconds, for the share; `performance.now`
 *   when absent
 * @property {import('./amplitude.js').ReadOptions} [reading] how the sounds are read
 */

/**
 * Why the stage shows no number: `waiting` while the lock is too young to have enough beats, or
 * while its first reading is being worked out; otherwise why there is no reading, or why the
 * reading is held back.
 * @typedef {'waiting'|NoReading|Held} StageWhy
 */

/**
 * What the stage has to show. A number is null when it is not to be shown, with the reason
 * beside it; the screen shows a dash.
 * @typedef {Object} SoundsReport
 * @property {number} liftAngle lift angle the stage is set to, in degrees
 * @property {number|null} amplitude in degrees
 * @property {number|null} amplitudeSd its scatter over the resamples, with the difference the
 *   placement check found added to it
 * @property {StageWhy|null} amplitudeWhy why there is no amplitude; null when there is one
 * @property {number|null} beatErrorMs the beat error measured from the unlocks
 * @property {number|null} beatOffsetMs how much later than midway between the ticks' unlocks
 *   the tocks' unlocks fall; its size is the beat error
 * @property {number|null} beatErrorSd its scatter over the resamples, with the difference the
 *   placement check found added to it
 * @property {StageWhy|null} beatErrorWhy why there is no beat error; null when there is one
 * @property {[number, number]|null} liftMs with the amplitude: the time from unlock to lock in
 *   the tick and in the tock
 * @property {[number, number]|null} liftSd and their scatter
 * @property {[number, number]|null} window the times of the first and the last beat the latest
 *   reading rests on, in seconds from the start of the audio; null before the first reading
 * @property {SoundsDetail|null} detail the latest reading as it was made, shown or not
 */

/**
 * The latest reading as it was made, whether or not it may be shown: for the diagnostics.
 * @typedef {Object} SoundsDetail
 * @property {NoReading|null} why why no reading was made
 * @property {number|null} amplitude
 * @property {number|null} amplitudeSd its scatter over the resamples, with the placement
 *   check's difference added
 * @property {number|null} beatOffsetMs
 * @property {number|null} beatErrorSd its scatter over the resamples, with the placement
 *   check's difference added
 * @property {number|null} placementMs the beat error's reading less its second reading, made
 *   with every beat on the trend of its timestamps; null when that was not made or found no sounds
 * @property {number|null} amplitudePlacement the amplitude less its second reading, in degrees;
 *   null with it
 * @property {[number, number]|null} liftMs
 * @property {[number, number]} counts beats of each type
 * @property {number|null} failing share of the resamples that did not find the sounds
 * @property {'steady'|'few-blocks'|'lined'|null} lining whether the beats were lined up again
 * @property {number|null} unlockDb the weaker unlock over the quiet stretch's scatter, in decibels
 * @property {number} computeSeconds computing the reading took
 * @property {number} audioSeconds audio that went by while it was worked out
 */

/**
 * What the stage needs from the pipeline to start a reading.
 * @typedef {Object} StageInput
 * @property {{n: number, p: number, type: 0|1}[]} beats every confident beat that was timed
 *   alone, in order of time; `p` in cleaned-envelope samples from the start of the audio
 * @property {number} bph beat rate
 * @property {number} period one tick-tock cycle in envelope samples
 */

/**
 * The stage's computing, for the load figures.
 * @typedef {Object} StageLoad
 * @property {number} seconds computing spent on readings so far
 * @property {number} readings readings finished
 * @property {number|null} lastSeconds computing the latest reading took
 * @property {number|null} lastAudioSeconds audio that went by while it was worked out
 * @property {number} longestStepSeconds longest single step of a reading
 */

export class SoundStage {
  /**
   * @param {import('./filterbank.js').FilterBank} bank the pipeline's filter bank
   * @param {number} delay Cleanup's delay in envelope samples: a beat at cleaned position p lies
   *   at position p + delay of the envelopes
   * @param {number} liftAngle in degrees
   * @param {StageOptions} [options]
   */
  constructor(bank, delay, liftAngle, options = {}) {
    const { windowSeconds = STACK_SECONDS, firstSeconds = FIRST_READING_SECONDS, everySeconds = READING_EVERY_SECONDS, share = STAGE_SHARE, rest = REST_SHARE, sinceLock = true, clock = () => performance.now(), reading = {} } = options;
    const { fillingSeconds = Math.min(FILLING_EVERY_SECONDS, everySeconds) } = options;
    const fe = bank.envelopeRate;
    this.fe = fe;
    this.sampleRate = bank.sampleRate;
    this.dec = bank.decimation;
    this.delay = delay;
    this.liftAngle = liftAngle;
    this.share = share;
    this.rest = rest;
    this.sinceLock = sinceLock;
    this.clock = clock;
    this.readOptions = reading;
    /** Envelope samples a reading's beats reach back over. */
    this.window = Math.round(windowSeconds * fe);
    this.first = Math.round(firstSeconds * fe);
    this.every = Math.round(everySeconds * fe);
    this.fillingEvery = Math.round(fillingSeconds * fe);
    /** The filter bank's rows that are kept. */
    this.pick = soundRowIndices(bank);
    /**
     * Envelope kept: the window, the stretch before its first beat, and Cleanup's delay, by
     * which the envelopes run ahead of the positions the pipeline counts in.
     */
    this.keep = this.window + Math.ceil(STRETCH_BEFORE_S * fe) + delay + Math.round(0.1 * fe);
    this.capacity = this.keep + Math.round(4 * fe);
    /** The envelopes as the filter bank made them. Element 0 of each is envelope sample `base`. */
    this.rows = this.pick.map(() => new Float32Array(this.capacity));
    this.base = 0;
    /** Envelope samples received. */
    this.count = 0;

    /** Cleaned position at which the current lock appeared. */
    this.since = 0;
    /** @type {'waiting'|'few-beats'|'averaged'} why there is no reading, while there is none */
    this.idle = 'waiting';
    /** @type {null | {steps: Generator<void, SoundsReading, void>, startedAt: number, every: number, window: [number, number], computeMs: number}} */
    this.job = null;
    /** @type {SoundsReading|null} the latest reading */
    this.reading = null;
    /** @type {null | {window: [number, number], computeSeconds: number, audioSeconds: number}} */
    this.made = null;
    /** Counts every change to what the stage reports. */
    this.version = 0;
    /** No reading is started before this cleaned position. */
    this.nextAt = 0;
    /** Milliseconds of computing the reading in progress may still take; negative after a long step. */
    this.credit = 0;
    /** The clock when the reading in progress was last taken further. */
    this.workedAt = 0;
    this.computeMs = 0;
    this.finished = 0;
    this.longestStepMs = 0;
  }

  /**
   * Keep the envelopes of the next audio block.
   * @param {Float32Array[]} raw the filter bank's output for the block, before Cleanup
   */
  append(raw) {
    const m = raw[0].length;
    if (m === 0) return;
    let filled = this.count - this.base;
    if (filled + m > this.capacity) {
      const drop = filled + m - this.keep;
      for (const row of this.rows) row.copyWithin(0, drop, filled);
      this.base += drop;
      filled -= drop;
    }
    for (let r = 0; r < this.rows.length; r++) this.rows[r].set(raw[this.pick[r]], filled);
    this.count += m;
  }

  /**
   * A lock has appeared or was lost: what was read belongs to another lock, which may have been
   * another watch or another position.
   * @param {number} since cleaned position at which the new lock appeared, or where the lock was lost
   */
  reset(since) {
    this.since = since;
    this.nextAt = since;
    this.idle = 'waiting';
    this.drop();
  }

  /**
   * A beat type's timestamps each average several cycles, so no single beat's place is known:
   * nothing is read, and what was read before is not shown on.
   */
  averaged() {
    this.idle = 'averaged';
    this.nextAt = 0;
    this.drop();
  }

  /**
   * The lift angle sets which times from unlock to lock are believable and where the quiet
   * stretch ends, as well as the amplitude, so a reading made with another angle is dropped and
   * the next is started at once.
   * @param {number} liftAngle in degrees
   */
  setLiftAngle(liftAngle) {
    if (liftAngle === this.liftAngle) return;
    this.liftAngle = liftAngle;
    this.nextAt = 0;
    this.drop();
  }

  /** Forget the reading and the one in progress. */
  drop() {
    if (this.job || this.reading) this.version++;
    this.job = null;
    this.reading = null;
    this.made = null;
    this.credit = 0;
  }

  /**
   * Seconds from the start of the audio at a cleaned position, as the pipeline's `toSeconds`.
   * @param {number} p
   * @returns {number}
   */
  toSeconds(p) {
    return ((p + this.delay) * this.dec + (this.dec - 1) / 2) / this.sampleRate;
  }

  /**
   * Do the stage's part for one audio block: start a reading when one is due, and take the
   * reading in progress a few steps on.
   * @param {number} now cleaned samples received so far
   * @param {number} seconds length of the audio block
   * @param {() => StageInput} gather the pipeline's beats, asked for only when a reading starts
   */
  step(now, seconds, gather) {
    if (this.idle === 'averaged') this.idle = 'waiting';
    if (!this.job && now >= this.nextAt) this.start(now, gather());
    if (this.job) this.work(now, seconds);
  }

  /**
   * Start a reading of the beats timed so far, if there are enough.
   * @param {number} now
   * @param {StageInput} input
   */
  start(now, input) {
    const from = Math.max(this.sinceLock ? this.since : -Infinity, now - this.window);
    /** @type {[{n: number, p: number}[], {n: number, p: number}[]]} */
    const types = [[], []];
    for (const b of input.beats) if (b.p >= from) types[b.type].push(b);
    const span = Math.min(...types.map((list) => (list.length ? list[list.length - 1].p - list[0].p : 0)));
    if (Math.min(types[0].length, types[1].length) < MIN_BEATS || span < this.first - input.period) {
      // Too few beats, yet or any more: what was read from more of them is not shown on. A lock
      // that has lasted long enough to have them is not waiting for them.
      this.drop();
      this.idle = now - this.since > this.first + Math.round(GIVE_UP_SECONDS * this.fe) ? 'few-beats' : 'waiting';
      this.nextAt = now + Math.round(LOOK_EVERY_SECONDS * this.fe);
      return;
    }
    const series = types.map((list) => ({
      K: 1,
      t: Float64Array.from(list, (b) => this.toSeconds(b.p)),
      n: Float64Array.from(list, (b) => b.n),
      ok: new Uint8Array(list.length).fill(1),
    }));
    /** @type {[number, number]} */
    const window = [Math.min(series[0].t[0], series[1].t[0]), Math.max(series[0].t[series[0].t.length - 1], series[1].t[series[1].t.length - 1])];
    const filled = this.count - this.base;
    const rows = this.rows.map((row) => row.subarray(0, filled));
    // `toSeconds` undone, without Cleanup's delay: where each timestamp lies in the envelopes.
    const toPosition = (/** @type {number} */ t) => (t * this.sampleRate - (this.dec - 1) / 2) / this.dec - this.base;
    const timed = timedBeats(rows, this.fe, series, toPosition);
    // Until the beats reach back the whole window, the next reading will have more of them.
    const every = span < this.window - 2 * input.period ? this.fillingEvery : this.every;
    this.nextAt = now + every;
    if (timed.why !== null) {
      this.publish(noReading(input.bph, this.liftAngle, timed.counts, timed.why), window, 0, 0);
      return;
    }
    // The placement check's beats are cut out now as well: by the time the resamples are done
    // the oldest of them may have left the envelopes kept.
    const onTrend = this.readOptions.placementCheck === false ? null : trendBeats(rows, this.fe, series, toPosition);
    // What the pipeline knows of the watch is applied when the reading is reported, as it
    // stands then.
    const steps = readBeatsSteps(timed.beats, this.fe, timed.gapMs, input.bph, this.liftAngle, { ...this.readOptions, irregular: false, halfway: false, onTrend });
    this.job = { steps, startedAt: now, every, window, computeMs: 0 };
    this.credit = 0;
    this.workedAt = NaN;
  }

  /**
   * Take the reading in progress as far as its share of the time since the last audio block
   * allows.
   * @param {number} now
   * @param {number} seconds length of the audio block
   */
  work(now, seconds) {
    const job = this.job;
    if (!job) return;
    const t0 = this.clock();
    const block = seconds * 1e3;
    if (this.share === Infinity) {
      this.credit = Infinity;
    } else {
      // The first block of a reading counts as one block's time. A gap in the audio earns no
      // more than two blocks do, and what is earned and not used is not saved up beyond that,
      // so the steps stay spread out.
      const passed = Number.isNaN(this.workedAt) ? block : Math.min(t0 - this.workedAt, 2 * block);
      this.credit = Math.min(this.credit + this.share * passed, this.share * 2 * block);
    }
    this.workedAt = t0;
    if (!(this.credit > 0)) return;
    let t = t0;
    /** @type {SoundsReading|null} */
    let done = null;
    while (t - t0 < this.credit) {
      const step = job.steps.next();
      const after = this.clock();
      if (after - t > this.longestStepMs) this.longestStepMs = after - t;
      t = after;
      if (step.done) {
        done = step.value;
        break;
      }
    }
    const spent = t - t0;
    this.credit -= spent;
    job.computeMs += spent;
    this.computeMs += spent;
    if (!done) return;
    this.job = null;
    this.credit = 0;
    this.finished++;
    const took = now - job.startedAt;
    this.nextAt = Math.max(job.startedAt + job.every, now + Math.max(1, Math.round(this.rest * took)));
    this.publish(done, job.window, job.computeMs / 1e3, took / this.fe);
  }

  /**
   * Take the reading in progress to its end in one go. This is for the end of the audio, at
   * Stop or where a recording finishes: no beats are left for the work to keep out of the way
   * of, and no audio blocks to spread it over. No reading is started.
   * @param {number} now cleaned samples received so far
   */
  finish(now) {
    if (!this.job) return;
    const share = this.share;
    this.share = Infinity;
    try {
      this.work(now, 0);
    } finally {
      this.share = share;
    }
  }

  /**
   * @param {SoundsReading} reading
   * @param {[number, number]} window
   * @param {number} computeSeconds
   * @param {number} audioSeconds
   */
  publish(reading, window, computeSeconds, audioSeconds) {
    this.reading = reading;
    this.made = { window, computeSeconds, audioSeconds };
    this.version++;
  }

  /**
   * What the stage has to show.
   * @param {boolean} irregular the pipeline finds the watch's beats falling at scattered times:
   *   the beat error is then not shown
   * @param {boolean} halfway the pipeline finds a beat halfway between the tick and the tock:
   *   neither reading is then shown
   * @returns {SoundsReport}
   */
  report(irregular, halfway) {
    const r = this.reading;
    const made = this.made;
    /** @type {SoundsReport} */
    const out = { liftAngle: this.liftAngle, amplitude: null, amplitudeSd: null, amplitudeWhy: this.idle, beatErrorMs: null, beatOffsetMs: null, beatErrorSd: null, beatErrorWhy: this.idle, liftMs: null, liftSd: null, window: null, detail: null };
    if (!r || !made) return out;
    out.window = made.window;
    out.detail = {
      why: r.why,
      amplitude: r.amplitude,
      amplitudeSd: r.scatter ? r.scatter.amplitude : null,
      beatOffsetMs: r.unlockGapMs,
      beatErrorSd: r.scatter ? r.scatter.unlockGapMs : null,
      placementMs: r.placement ? r.placement.differenceMs : null,
      amplitudePlacement: r.placement ? r.placement.amplitudeDifference : null,
      liftMs: r.liftMs,
      counts: r.counts,
      failing: r.failing,
      lining: r.lining ? r.lining.state : null,
      unlockDb: r.unlockDb,
      computeSeconds: made.computeSeconds,
      audioSeconds: made.audioSeconds,
    };
    if (r.why !== null) {
      out.amplitudeWhy = out.beatErrorWhy = r.why;
      return out;
    }
    const held = heldBack(r, irregular, halfway);
    out.amplitudeWhy = held.amplitude;
    out.beatErrorWhy = held.beatError;
    if (held.amplitude === null && r.scatter) {
      out.amplitude = r.amplitude;
      out.amplitudeSd = r.scatter.amplitude;
      out.liftMs = r.liftMs;
      out.liftSd = r.scatter.liftMs;
    }
    if (held.beatError === null && r.scatter) {
      out.beatErrorMs = r.beatErrorMs;
      out.beatOffsetMs = r.unlockGapMs;
      out.beatErrorSd = r.scatter.unlockGapMs;
    }
    return out;
  }

  /**
   * Where the unlock and the lock start in the tick and in the tock, in milliseconds from each
   * beat's timestamp, when the amplitude that rests on them is shown.
   * @param {boolean} halfway as for `report`
   * @returns {[{unlockMs: number, lockMs: number}, {unlockMs: number, lockMs: number}] | null}
   */
  marks(halfway) {
    const r = this.reading;
    if (!r || !r.places || heldBack(r, false, halfway).amplitude !== null) return null;
    return [{ unlockMs: r.places[0][0], lockMs: r.places[0][1] }, { unlockMs: r.places[1][0], lockMs: r.places[1][1] }];
  }

  /** @returns {StageLoad} */
  load() {
    return {
      seconds: this.computeMs / 1e3,
      readings: this.finished,
      lastSeconds: this.made ? this.made.computeSeconds : null,
      lastAudioSeconds: this.made ? this.made.audioSeconds : null,
      longestStepSeconds: this.longestStepMs / 1e3,
    };
  }
}
