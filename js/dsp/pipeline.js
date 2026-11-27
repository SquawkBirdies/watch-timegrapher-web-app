// The real-time pipeline. Audio goes in as chunks of any size; status, beats and readings
// come out as events. It moves between two states:
//
//   listening  audio is arriving and the pipeline is looking for a beat rate
//   tracking   a beat rate is locked; beats are timestamped and readings update
//
// When the lock is lost the readings are blanked and the pipeline listens again. A lock found
// again soon after, at the same beat rate, carries on the lost one's beat numbers and reference
// points, so a tick stays a tick.
//
// A lock is found by analysing a stretch of the history buffer with the same stages as the
// offline analysis, then confirmed on beats the analysis has not seen. While tracking, each new
// beat is timed against the template from the last analysis, at the position the Kalman
// tracker predicts. The analysis is repeated on the sliding history window from time to time,
// which refreshes the template, the averaging and the noise thresholds. The tracker expects the
// rate to wander slowly; when a watch's rate changes faster, the tracker is started again from
// the latest beats, and a repeat analysis folds only as much audio as one beat period describes.
//
// A beat's timestamp is the moment a reference point of its sound arrives. Each analysis picks
// that point afresh, as the loudest part of the averaged beat, and a beat made of several sounds
// of similar loudness (a co-axial escapement's, for one) can have a different loudest part from
// one analysis to the next. So that timestamps stay comparable for as long as a lock lasts, each
// repeat analysis measures how far its timestamps lie from the ones already reported for the
// same beats, and reports its own moved back by that much.
//
// Given a lift angle, the pipeline also reads the sounds inside the beats: the beat error from
// the unlocks and the amplitude (stage 10, js/dsp/soundstage.js). That stage takes the filter
// bank's envelopes before they are cleaned and the confident beats timed since the lock, and
// its readings go out with the others.

import { FilterBank } from './filterbank.js';
import { Cleanup } from './cleanup.js';
import { acquireFast } from './acquire.js';
import { analyzeRows } from './offline.js';
import { buildWeights, correlateAt, pickPeak, pickPeakNear, pickPeaks, matchedFilter, averageCycles, NEAR_MS, LAG_MS } from './timing.js';
import { summarize, halfwayBeat } from './estimate.js';
import { SCATTER_LIMIT_MS } from './irregular.js';
import { BeatTracker } from './tracker.js';
import { robustLine, median, mean, std, percentile } from './mathutil.js';
import { SoundStage } from './soundstage.js';
import { tickByGap, tickByLift } from './names.js';

/**
 * @typedef {Object} PipelineOptions
 * @property {number} [humHz] mains frequency, 50 or 60
 * @property {number} [bph] beat-rate override; all standard rates are searched when absent
 * @property {number} [historySeconds] length of the sliding window of cleaned audio that is kept
 * @property {number} [averagingSeconds] window of the rate and beat-error readings; it may be
 *   longer than the history, because beats are kept after their audio is dropped
 * @property {number} [attemptSeconds] time between lock attempts while listening
 * @property {number[]} [windows] lengths, in seconds, of the recent audio a lock attempt analyses;
 *   the first is tried at every attempt, the second at every other one, and the whole history at
 *   every fourth
 * @property {number} [refreshSeconds] time between repeat analyses while tracking
 * @property {number} [lostSeconds] time without a trusted beat before the lock is dropped
 * @property {number} [readingSeconds] time between readings
 * @property {number} [driftPpm] drift tolerance of the tracker: how far the rate may wander in
 *   one second, in parts per million
 * @property {number} [blockSize] audio samples processed at a time
 * @property {number[][]} [bands] filter-bank band edges in hertz, replacing the defaults
 * @property {import('./estimate.js').Escapement} [escapement] 'coaxial' hides the beat error, as in `summarize`
 * @property {import('./timing.js').TimingOptions} [timing] switches for the measures against
 *   scattered timestamps, as in `trackBeats`
 * @property {boolean} [followRate] false keeps the tracker's prediction when it refuses confident
 *   timestamps that agree with one another, and gives a repeat analysis the tracker's period to
 *   start from, as before 22 November 2026: a watch whose rate changes faster than the tracker
 *   allows then loses its lock
 * @property {boolean} [resumeLock] false gives a lock found soon after a lost one beat numbers and
 *   a reference point of its own, as before 22 November 2026, so the tick and the tock can swap
 *   and the trace steps
 * @property {number} [liftAngle] lift angle in degrees. With it the sounds inside each beat are
 *   read too, for the beat error from the unlocks and the amplitude (`sounds` in the readings);
 *   without it that stage does not run
 * @property {import('./soundstage.js').StageOptions} [sounds] how that stage runs
 */

/**
 * @typedef {Object} Beat
 * @property {number} n beat number; a timestamp averaged over several cycles carries the number
 *   of the middle of the average
 * @property {number} t time of the beat in seconds from the start of the audio
 * @property {0|1} type 0 for a tick, 1 for a tock
 * @property {number} confidence peak height in noise standard deviations
 * @property {boolean} ok true when the beat stands above the noise
 * @property {number} cycles tick-tock cycles averaged for this timestamp
 */

/**
 * @typedef {Object} Signal
 * @property {(number|null)[]} z for ticks and tocks: median confidence of the last few
 *   timestamps, in noise standard deviations; null when that beat type is not timed
 * @property {(number|null)[]} cycles for ticks and tocks: tick-tock cycles averaged per timestamp
 */

/**
 * @typedef {Object} AveragedBeat
 * @property {0|1} type 0 for a tick, 1 for a tock
 * @property {Float32Array} values the averaged beat's energy summed over the bands, relative to
 *   the background noise, one value per envelope sample from `from` to `to`
 */

/**
 * @typedef {{type: 'status', state: 'listening'|'tracking', reason: string, bph: number|null, cyclesAveraged: (number|null)[]|null, t: number, continues?: boolean}} StatusEvent
 *   `continues` is true when a lock carries on from one lost moments before: its beats keep the
 *   numbers and the reference points they had, so a tick stays a tick and the trace carries on
 * @typedef {{type: 'beats', beats: Beat[], replaceFrom: number|null}} BeatsEvent
 *   replaceFrom: when set, beats from that time on are superseded by this list
 * @typedef {{type: 'readings', t: number, window: [number, number]|null, windowStart: number|null, windowSeconds: number|null, signal: Signal|null, irregular: boolean, sounds: import('./soundstage.js').SoundsReport|null, tick: 0|1|null} & import('./estimate.js').Readings} ReadingsEvent
 *   Everything given for the two kinds of beat is in the order of their types, 0 then 1, as
 *   the beats carry them: `fits`, the two entries of `signal`, the sign of `beatOffsetMs` and of
 *   `beatErrorDetail.offsetMs` (how much later than midway between the beats of type 0 those of
 *   type 1 fall), and everything in `sounds`.
 *   window: the first and last timestamp the readings use.
 *   windowStart: where the audio the readings draw on begins: `t` less the averaging window, or
 *   the start of the lock until the lock has lasted that long.
 *   windowSeconds: how long the averaging window is, the setting or longer for faint ticks (see
 *   `averagingSpan`); the window is full once `t - windowStart` reaches it.
 *   irregular: true when the beats fall at scattered times; every timestamp is then one beat.
 *   sounds: the beat error from the unlocks and the amplitude, from the sounds inside each beat;
 *   null when no lift angle was given, and when the lock is lost
 *   tick: which type of beat is the tick, once the readings have made it clear (see
 *   js/dsp/names.js); null until then, and the two types are then beats without names. Once
 *   given it stays for as long as the beat numbers carry on, through repeat analyses and
 *   through a lock that carries on from one lost moments before.
 * @typedef {{type: 'waveform', t: number, rate: number, from: number, to: number, cycles: number, beats: AveragedBeat[], marks: [SoundMarks, SoundMarks]|null}} WaveformEvent
 *   The averaged tick and tock from the latest analysis. `rate` is the envelope sample rate;
 *   `from` and `to` are the window's ends in seconds relative to each beat's timestamp;
 *   `cycles` is the number of tick-tock cycles averaged. `marks`: for the tick and the tock,
 *   where the unlock and the lock start, when an amplitude is shown that rests on them.
 * @typedef {{unlockMs: number, lockMs: number}} SoundMarks
 *   milliseconds from the beat's timestamp
 * @typedef {StatusEvent | BeatsEvent | ReadingsEvent | WaveformEvent} PipelineEvent
 */

/**
 * @typedef {Object} BeatTypeState
 * @property {boolean} tracked false when this beat type could not be timed in the last analysis
 * @property {number} K cycles averaged per timestamp
 * @property {number} threshold peak height a timestamp must exceed to count as confident
 * @property {number} noiseMean
 * @property {number} noiseSd
 * @property {number} typical median confidence of the recent timestamps
 * @property {number[]} recentZ confidence of the recent timestamps
 * @property {Float64Array[]} weights matched-filter weights
 * @property {number} centre cluster position in the template, in samples
 * @property {number} adjust samples added to positions measured at `centre`, so that timestamps
 *   keep the reference point this beat type had when the lock began
 * @property {number} nextCycle next cycle of the current grid to be correlated
 * @property {Float64Array} acc sum of the correlation curves of the current block
 * @property {number} filled cycles in the current block
 * @property {number} n0 global beat number of the first cycle of the current block
 * @property {number} p0 predicted position of that beat
 * @property {number} step predicted beat period for the current block
 * @property {number} failed consecutive timestamps that were not confident or not trusted
 * @property {number} refused consecutive confident timestamps that the tracker refused
 */

/**
 * @typedef {Object} Dot
 * @property {number} n global beat number
 * @property {number} p position in cleaned-envelope samples from the start of the audio, at the
 *   beat type's reference point
 * @property {0|1} j cluster of the current template the beat belongs to
 * @property {0|1} type 0 for a tick, 1 for a tock; stays the same across repeat analyses
 * @property {boolean} ok
 * @property {number} z
 * @property {number} K
 */

/**
 * @typedef {Object} Line
 * @property {number} b slope: samples per beat
 * @property {number} sd scatter of the points about the line
 * @property {number} last largest beat number among the points
 * @property {number} periodVar variance of the slope
 * @property {(n: number) => number} at value of the line at beat n
 * @property {(n: number) => number} varAt variance of that value
 * @property {(n: number) => number} covAt covariance of that value with the slope
 */

/**
 * Robust line through beat positions, with the uncertainties the tracker starts from.
 * @param {number[]} ns beat numbers
 * @param {number[]} ps positions
 * @returns {Line | null} null with fewer than three points
 */
function lineThrough(ns, ps) {
  if (ns.length < 3) return null;
  const fit = robustLine(ns, ps);
  let count = 0;
  let mean = 0;
  for (let i = 0; i < ns.length; i++) {
    if (fit.weights[i] > 0) {
      count++;
      mean += ns[i];
    }
  }
  mean /= count || 1;
  let spread = 0;
  for (let i = 0; i < ns.length; i++) if (fit.weights[i] > 0) spread += (ns[i] - mean) ** 2;
  const sd = Math.max(fit.residualSd, 1e-3);
  const v = sd * sd;
  return {
    b: fit.b,
    sd,
    last: ns[ns.length - 1],
    periodVar: v / (spread || 1),
    at: (n) => fit.a + fit.b * n,
    varAt: (n) => v * (1 / (count || 1) + (n - mean) ** 2 / (spread || 1)),
    covAt: (n) => (v * (n - mean)) / (spread || 1),
  };
}

const PRE_MS = 8;
const POST_MS = 12;
/** Window of the averaged beat sent to the interface, in milliseconds around the timestamp. */
const WAVE_BEFORE_MS = 12;
const WAVE_AFTER_MS = 12;
/** Timestamps of each beat type whose confidence makes up the signal reading. */
const SIGNAL_BEATS = 8;
/**
 * Fewest independent timestamps of one beat type that a reading should rest on. When faint
 * ticks need averaging, the averaging window is lengthened to hold this many; with the Omega's
 * 8-cycle averages a 20 s window held only five, and its rate was off by 12 s/day.
 */
const MIN_TIMESTAMPS = 12;
/** Fewest beats timed both before and after a repeat analysis for the reference to be carried over. */
const MIN_COMMON_BEATS = 3;
/** Recent timestamps of each beat type watched for a change in how regularly the watch runs. */
const CHANGE_BEATS = 24;
/** Audio analysed when the watch's regularity seems to have changed, in seconds. */
const CHANGE_WINDOW_SECONDS = 8;
/** Seconds before a suspected change is looked at again, when the last look found none. */
const CHANGE_RETRY_SECONDS = 4;
/**
 * Scatter of recent timestamps below which an irregular watch seems to have settled, in
 * milliseconds. Lower than the limit for becoming irregular, so that a watch close to it does
 * not flip between the two.
 */
const SETTLED_MS = 0.3;
/**
 * Confident timestamps of every timed beat type that the tracker must refuse in a row before it
 * is started again from the beats themselves.
 */
const RESYNC_REFUSED = 3;
/**
 * The tracker is also started again when its latest `RESYNC_RECENT` misses of every timed beat
 * type all fall the same way, with a median more than this many milliseconds: it is falling
 * behind a watch whose rate is changing. A beat is preferred within `NEAR_MS` of where the
 * tracker expects it, so a prediction this far out can start to take another of the beat's
 * sounds. Misses that scatter both ways are the timestamps' own scatter, however large.
 */
const RESYNC_LAG_MS = 0.5;
/** Latest misses of each beat type that are judged for falling behind. */
const RESYNC_RECENT = 6;
/** Latest confident timestamps of each beat type that a restarted tracker is fitted to. */
const RESYNC_TIMESTAMPS = 8;
/**
 * How far those timestamps may scatter about their line, as a multiple of the scatter the
 * tracker has been seeing, for them to count as agreeing with one another.
 */
const RESYNC_SCATTER = 3;
/**
 * Longest time from the last trusted beat of a lost lock to the first beat of a new one for the
 * new lock to carry on the old one's beat numbers, in seconds. Over 20 s, a tracker 1,000 ppm
 * (86 s/day) off predicts a beat 20 ms out, a fifth of a beat at 36,000 vph.
 */
const RESUME_SECONDS = 20;
/** Farthest a new lock's first beat may lie from a beat the lost lock predicts, in beats. */
const RESUME_FRACTION = 0.25;
/**
 * Farthest the beats already timed in a repeat analysis's audio may bend away from a straight
 * line, in milliseconds. The analysis folds its audio at one beat period and looks for each beat
 * no more than `LAG_MS` from where that period puts it, so a watch whose rate changed within the
 * audio has its beats at the ends looked for in the wrong place, where another of the beat's
 * sounds can be taken for it.
 */
const FOLD_BEND_MS = 1;
/**
 * Length of the stretches of a repeat analysis's audio whose median distances from the line
 * measure its bend, and the step by which the audio is shortened, in seconds.
 */
const FOLD_STEP_SECONDS = 4;

export class Pipeline {
  /**
   * @param {number} sampleRate audio sample rate in hertz
   * @param {number} channelCount
   * @param {PipelineOptions} [options]
   */
  constructor(sampleRate, channelCount, options = {}) {
    this.options = {
      humHz: 60,
      bph: /** @type {number|undefined} */ (undefined),
      historySeconds: 40,
      averagingSeconds: 20,
      attemptSeconds: 4,
      windows: [8, 16],
      refreshSeconds: 20,
      lostSeconds: 5,
      readingSeconds: 1,
      driftPpm: 2,
      blockSize: 2048,
      bands: /** @type {number[][]|undefined} */ (undefined),
      escapement: /** @type {import('./estimate.js').Escapement} */ ('lever'),
      /** Re-analyse at once when the watch starts or stops running irregularly. */
      watchChanges: true,
      ...options,
    };
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.bank = new FilterBank(sampleRate, channelCount, this.options.bands ? { bands: this.options.bands } : {});
    this.fe = this.bank.envelopeRate;
    this.cleanup = new Cleanup(this.fe, this.bank.rowCount, { humHz: this.options.humHz });
    const fe = this.fe;
    this.pre = Math.floor(PRE_MS * 1e-3 * fe);
    /** How far from the tracker's prediction a peak is still preferred, in lags. */
    this.nearLag = Math.round(NEAR_MS * 1e-3 * fe);
    this.nTau = this.pre + Math.floor(POST_MS * 1e-3 * fe) + 1;
    this.maxLag = 0;
    this.nLag = 0;
    this.segLen = 0;
    this.lags = new Int32Array(0);
    this.seg = new Float64Array(0);
    this.setReach(LAG_MS);

    /** Incoming audio is regrouped into fixed blocks, so results do not depend on chunk sizes. */
    this.block = Array.from({ length: channelCount }, () => new Float32Array(this.options.blockSize));
    this.blockFill = 0;

    /** History of cleaned envelope rows. Element 0 of each row is cleaned sample `base`. */
    this.historyLength = Math.round(this.options.historySeconds * fe);
    this.capacity = this.historyLength + Math.round(4 * fe);
    this.rows = Array.from({ length: this.bank.rowCount }, () => new Float32Array(this.capacity));
    this.base = 0;
    /** Number of cleaned samples received so far. */
    this.count = 0;

    /** @type {'listening'|'tracking'} */
    this.state = 'listening';
    this.listenFrom = 0;
    this.attempts = 0;
    this.nextAttempt = Math.round(this.options.windows[0] * fe);
    /** Start of the audio the current lock was first found in. */
    this.lockedFrom = 0;
    /** @type {null | {bph: number, nominalPeriod: number, start: number, length: number, period: number, template: Float32Array[], clusters: [number, number], types: BeatTypeState[], confirmed: boolean, blocks: number, blocksOk: number, irregular: boolean, continues: boolean, halfway: boolean|null}} */
    this.lock = null;
    /**
     * The last lock lost, kept so that a new lock found soon after can carry on its beat numbers,
     * its reference points and its beats' names.
     * @type {null | {bph: number, tracker: BeatTracker, dots: Dot[], lastTrusted: number, tick: 0|1|null}}
     */
    this.lost = null;
    /**
     * Which type of beat is the tick, once the readings have made it clear; null until then.
     * It belongs to the beat numbers: a lock that does not carry them on starts without names.
     * @type {0|1|null}
     */
    this.tick = null;
    /** @type {BeatTracker|null} */
    this.tracker = null;
    /** @type {Dot[]} */
    this.dots = [];
    /** Global beat number of the first cluster of the first analysed cycle. */
    this.shift = 0;
    this.lastTrusted = 0;
    /** When the current lock was confirmed or last re-analysed. */
    this.trackingSince = 0;
    this.nextRefresh = Infinity;
    this.nextReading = Infinity;
    /**
     * For each beat type, tick and tock: where the highest correlation peak of each recent
     * confident timestamp lay from the tracker's prediction, in samples, scaled by √K. Kept
     * across repeat analyses, and cleared when the verdict on the watch's regularity changes.
     * @type {[number[], number[]]}
     */
    this.recentLag = [[], []];
    /** No look at a suspected change in regularity before this position. */
    this.changeHold = 0;
    /** Early analyses made because the regularity seemed to change, and how many changed it. */
    this.changeChecks = 0;
    this.changesFound = 0;
    /** Times the tracker was started again from the beats because it refused or lagged them. */
    this.resyncs = 0;
    /** @type {PipelineEvent[]} */
    this.events = [];
    /** Seconds spent in the lock analyses, for the speed check. */
    this.analysisSeconds = 0;
    /**
     * Stage 10, the sounds inside each beat; null without a lift angle.
     * @type {SoundStage|null}
     */
    this.sounds = this.options.liftAngle === undefined ? null : new SoundStage(this.bank, this.cleanup.delay, this.options.liftAngle, this.options.sounds);
  }

  /**
   * Set how far either side of the predicted position each beat is looked for. An irregular
   * watch needs more than a regular one.
   * @param {number} lagMs
   */
  setReach(lagMs) {
    const maxLag = Math.floor(lagMs * 1e-3 * this.fe);
    if (maxLag === this.maxLag && this.nLag > 0) return;
    this.maxLag = maxLag;
    this.nLag = 2 * maxLag + 1;
    this.segLen = this.nTau + 2 * maxLag;
    this.lags = new Int32Array(this.nLag);
    for (let i = 0; i < this.nLag; i++) this.lags[i] = i - maxLag;
    this.seg = new Float64Array(this.segLen);
  }

  /**
   * Convert a position in cleaned-envelope samples to seconds from the start of the audio.
   * @param {number} p
   * @returns {number}
   */
  toSeconds(p) {
    const dec = this.bank.decimation;
    return ((p + this.cleanup.delay) * dec + (dec - 1) / 2) / this.sampleRate;
  }

  /**
   * Change the settings that can change while measuring: the averaging window, the escapement
   * and the lift angle. They apply from the next reading; a new lift angle blanks the beat error
   * from the unlocks and the amplitude until they have been read again with it. Another
   * escapement names the tick by another rule, so the beats lose their names until that rule
   * gives them. Other settings need a new pipeline, and so does a lift angle for a pipeline
   * that was made without one.
   * @param {{averagingSeconds?: number, escapement?: import('./estimate.js').Escapement, liftAngle?: number}} changes
   */
  setOptions(changes) {
    if (changes.averagingSeconds !== undefined) this.options.averagingSeconds = changes.averagingSeconds;
    if (changes.escapement !== undefined && changes.escapement !== this.options.escapement) {
      this.options.escapement = changes.escapement;
      this.tick = null;
      if (this.lost) this.lost.tick = null;
    }
    if (changes.liftAngle !== undefined && this.sounds) {
      this.options.liftAngle = changes.liftAngle;
      const before = this.sounds.version;
      this.sounds.setLiftAngle(changes.liftAngle);
      if (this.sounds.version !== before && this.state === 'tracking' && this.lock) this.events.push(this.waveform());
    }
  }

  /**
   * Feed audio to the pipeline.
   * @param {ArrayLike<number>[]} channels the next samples of every channel, all the same length
   * @returns {PipelineEvent[]} everything that happened while these samples were processed
   */
  push(channels) {
    const size = this.options.blockSize;
    const n = channels[0].length;
    let i = 0;
    while (i < n) {
      const take = Math.min(size - this.blockFill, n - i);
      for (let c = 0; c < this.channelCount; c++) {
        const src = channels[c];
        const dst = this.block[c];
        for (let k = 0; k < take; k++) dst[this.blockFill + k] = src[i + k];
      }
      this.blockFill += take;
      i += take;
      if (this.blockFill === size) {
        this.blockFill = 0;
        const raw = this.bank.process(this.block);
        // Stage 10 reads the envelopes as the filter bank made them.
        if (this.sounds) this.sounds.append(raw);
        this.append(this.cleanup.process(raw));
        this.step();
      }
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  /**
   * Add cleaned samples to the history, dropping the oldest when the buffer is full.
   * @param {Float32Array[]} cleaned
   */
  append(cleaned) {
    const m = cleaned[0].length;
    if (m === 0) return;
    let filled = this.count - this.base;
    if (filled + m > this.capacity) {
      const drop = filled + m - this.historyLength;
      for (const row of this.rows) row.copyWithin(0, drop, filled);
      this.base += drop;
      filled -= drop;
    }
    for (let r = 0; r < this.rows.length; r++) this.rows[r].set(cleaned[r], filled);
    this.count += m;
  }

  /** Do whatever the new samples make possible. */
  step() {
    if (this.state === 'listening' && !this.lock) {
      if (this.count >= this.nextAttempt) this.attempt();
    }
    if (this.lock) {
      this.stream();
      if (!this.lock.confirmed) this.confirm();
    }
    if (this.state === 'tracking' && this.lock) {
      const lock = this.lock;
      const tracked = lock.types.filter((ty) => ty.tracked);
      // The clock for a lost lock starts at the last trusted beat, or at the last analysis if
      // that is more recent.
      const stale = this.count - Math.max(this.lastTrusted, this.trackingSince) > this.options.lostSeconds * this.fe;
      if (stale && tracked.every((ty) => ty.failed >= 3)) {
        this.lose('no trusted beat for several seconds');
      } else if (this.count >= this.nextRefresh) {
        this.refresh();
      } else if (lock.confirmed && this.options.watchChanges && this.count >= this.changeHold && this.regularityChanged()) {
        this.reanalyseChange();
      }
    }
    if (this.sounds && this.state === 'tracking' && this.lock) this.stepSounds(this.sounds, this.lock);
    if (this.state === 'tracking' && this.count >= this.nextReading) {
      this.nextReading = this.count + Math.round(this.options.readingSeconds * this.fe);
      this.emitReadings();
    }
  }

  /**
   * Stage 10's part of an audio block: a reading of the sounds inside the beats is started when
   * one is due, and the one in progress is taken a little further.
   * @param {SoundStage} stage
   * @param {NonNullable<Pipeline['lock']>} lock
   */
  stepSounds(stage, lock) {
    const before = stage.version;
    if (lock.types.some((ty) => ty.tracked && ty.K > 1)) {
      stage.averaged();
    } else {
      stage.step(this.count, this.options.blockSize / this.sampleRate, () => ({
        beats: this.dots.filter((d) => d.ok && d.K === 1),
        bph: lock.bph,
        period: lock.period,
      }));
    }
    // The marks on the averaged beat follow the reading.
    if (stage.version !== before) this.events.push(this.waveform());
  }

  /**
   * Whether the current template holds a beat halfway between its tick and its tock: the beat
   * rate in use is then half the watch's own. Worked out once for each analysis.
   * @returns {boolean}
   */
  halfway() {
    const lock = this.lock;
    if (!lock) return false;
    if (lock.halfway === null) lock.halfway = halfwayBeat(lock.template, lock.clusters, this.fe).found;
    return lock.halfway;
  }

  /**
   * A view of the history rows between two absolute positions.
   * @param {number} from
   * @param {number} to
   * @returns {Float32Array[]}
   */
  view(from, to) {
    return this.rows.map((row) => row.subarray(from - this.base, to - this.base));
  }

  /**
   * Listening: analyse the recent audio, shortest window first. A clear watch is found in the
   * last few seconds; a faint one needs the longer windows.
   */
  attempt() {
    const fe = this.fe;
    const o = this.options;
    const available = this.count - Math.max(this.listenFrom, this.base);
    this.attempts++;
    this.nextAttempt = this.count + Math.round(o.attemptSeconds * fe);
    /** @type {number[]} */
    const lengths = [];
    o.windows.forEach((seconds, i) => {
      const length = Math.round(seconds * fe);
      if (this.attempts % (1 << i) === 0 && available >= length && length <= this.historyLength) lengths.push(length);
    });
    const longest = Math.min(available, this.historyLength);
    if (this.attempts % (1 << o.windows.length) === 0 && longest >= 1.5 * (lengths[lengths.length - 1] || 0)) lengths.push(longest);
    for (const length of lengths) {
      // The last part of the window is held back: the lock must also hold on beats that the
      // analysis has not seen.
      const held = Math.max(Math.round(2 * fe), length >> 2);
      const start = this.count - length;
      const analysed = length - held;
      const rows = this.view(start, start + analysed);
      const t0 = performance.now();
      const analysis = analyzeRows(rows, fe, (p) => this.toSeconds(p + start), {
        bph: o.bph,
        acquireWith: acquireFast,
        accept: (c) => c.secondZ >= 5,
        refineSpan: (600 * fe) / analysed,
        escapement: o.escapement,
        timing: o.timing,
      });
      if (analysis && analysis.locked) {
        this.lockedFrom = start;
        this.install(analysis, rows, start, analysed, false);
      }
      this.analysisSeconds += (performance.now() - t0) / 1000;
      if (this.lock) {
        this.stream();
        this.confirm();
      }
      if (this.lock) break;
    }
  }

  /** Tracking: repeat the analysis on the sliding window to refresh template and thresholds. */
  /**
   * Whether the recent timestamps suggest the watch has started or stopped running irregularly
   * since the last analysis. A regular lock needs both beat types to scatter by more than the
   * irregular limit; an irregular lock needs every timed beat type to scatter by less than
   * `SETTLED_MS`.
   * @returns {boolean}
   */
  regularityChanged() {
    const lock = this.lock;
    if (!lock) return false;
    const ms = 1000 / this.fe;
    const scatter = lock.types.map((ty, j) => {
      const recent = this.recentLag[Math.abs((j + this.shift) % 2)];
      if (!ty.tracked || recent.length < CHANGE_BEATS) return null;
      const mid = median(recent);
      return 1.4826 * median(recent.map((v) => Math.abs(v - mid))) * ms;
    });
    const known = /** @type {number[]} */ (scatter.filter((v) => v !== null));
    return lock.irregular ? known.length > 0 && known.every((v) => v < SETTLED_MS) : known.length === 2 && known.every((v) => v > SCATTER_LIMIT_MS);
  }

  /**
   * Analyse the most recent audio when the watch's regularity seems to have changed. A result
   * that changes the verdict is taken over as if the lock began at the start of that audio, so
   * that later analyses and the readings do not mix the two kinds of running. A result that
   * does not is set aside, and the question waits a few seconds.
   */
  reanalyseChange() {
    const lock = this.lock;
    const tracker = this.tracker;
    if (!lock || !tracker) return;
    const fe = this.fe;
    const start = Math.max(this.lockedFrom, this.base, this.count - Math.round(CHANGE_WINDOW_SECONDS * fe));
    const length = this.count - start;
    const rows = this.view(start, this.count);
    const span = (600 * fe) / length;
    const ppm = this.periodHint(start, span);
    const t0 = performance.now();
    const analysis = analyzeRows(rows, fe, (p) => this.toSeconds(p + start), {
      bph: lock.bph,
      periodPpm: ppm,
      refineSpan: span,
      escapement: this.options.escapement,
      timing: this.options.timing,
    });
    this.changeChecks++;
    const previous = this.lockedFrom;
    let kept = false;
    if (analysis !== null && analysis.locked && analysis.irregular !== lock.irregular) {
      this.lockedFrom = start;
      kept = this.install(analysis, rows, start, length, true);
      if (!kept) this.lockedFrom = previous;
    }
    this.analysisSeconds += (performance.now() - t0) / 1000;
    if (kept) {
      this.changesFound++;
      this.stream();
    } else {
      this.changeHold = this.count + Math.round(CHANGE_RETRY_SECONDS * fe);
    }
  }

  refresh() {
    const lock = this.lock;
    const tracker = this.tracker;
    if (!lock || !tracker) return;
    const fe = this.fe;
    const start = this.foldStart(Math.max(this.lockedFrom, this.count - this.historyLength, this.base));
    const length = this.count - start;
    const rows = this.view(start, this.count);
    const span = (600 * fe) / length;
    const ppm = this.periodHint(start, span);
    const t0 = performance.now();
    const analysis = analyzeRows(rows, fe, (p) => this.toSeconds(p + start), {
      bph: lock.bph,
      periodPpm: ppm,
      refineSpan: span,
      irregular: lock.irregular ? { lagMs: (1000 * this.maxLag) / fe, beats: this.dots.filter((d) => d.ok && d.K === 1 && d.p >= start).map((d) => ({ q: d.p - lock.types[d.j].adjust - start, n: d.n })) } : null,
      escapement: this.options.escapement,
      timing: this.options.timing,
    });
    const kept = analysis !== null && analysis.locked && this.install(analysis, rows, start, length, true);
    this.analysisSeconds += (performance.now() - t0) / 1000;
    if (kept) {
      this.stream();
    } else {
      this.lose('the repeat analysis found no beat');
    }
  }

  /**
   * Take over the result of an analysis: template, averaging, thresholds, the beats inside the
   * analysed window, and a tracker started from them.
   * @param {NonNullable<ReturnType<typeof analyzeRows>>} analysis
   * @param {Float32Array[]} rows the analysed audio
   * @param {number} start absolute position of the first analysed sample
   * @param {number} length number of analysed samples
   * @param {boolean} confirmed true when the pipeline was already tracking
   * @returns {boolean} false when the analysis left nothing to track
   */
  install(analysis, rows, start, length, confirmed) {
    const fe = this.fe;
    const o = this.options;
    const period = analysis.period;
    const beatPeriod = period / 2;
    const previous = this.tracker;
    this.setReach(analysis.lagMs);
    // Beat numbers continue from the previous lock when there is one, so that a tick stays a
    // tick. Local beat 0 is the first cluster of the first analysed cycle.
    let shift = 0;
    /** Beats already reported, whose reference points the new timestamps keep. */
    let earlier = this.dots;
    const resumed = confirmed ? null : this.resume(analysis, start);
    if (previous && confirmed) {
      shift = previous.n + Math.round((start + analysis.clusters[0] - previous.phase) / previous.period);
    } else if (resumed !== null && this.lost) {
      shift = resumed;
      earlier = this.lost.dots;
    }
    // The names go with the beat numbers: a repeat analysis keeps them, a lock that carries on
    // a lost one takes that lock's, and any other lock starts without.
    if (!(previous && confirmed)) this.tick = resumed !== null && this.lost ? this.lost.tick : null;
    /** @type {Dot[]} */
    const dots = [];
    /** @type {BeatTypeState[]} */
    const types = [];
    /** @type {(Line|null)[]} */
    const lines = [];
    /** @type {number[]} */
    const adjusts = [];
    for (let j = 0; j < 2; j++) {
      const tr = analysis.tracks[j];
      const tracked = analysis.fits[j] !== null;
      const centre = analysis.clusters[j];
      const type = /** @type {0|1} */ (Math.abs((j + shift) % 2));
      let nextCycle = 0;
      /** @type {Dot[]} */
      const own = [];
      if (tracked) {
        for (let i = 0; i < tr.lag.length; i += tr.K) {
          const cycle = i + (tr.K - 1) / 2;
          const p = start + cycle * period + centre + tr.lag[i];
          own.push({ n: 2 * cycle + j + shift, p, j: /** @type {0|1} */ (j), type, ok: tr.value[i] > tr.threshold, z: tr.z[i], K: tr.K });
          nextCycle = i + tr.K;
        }
      }
      // Keep the reference point this beat type has had since the lock began.
      const adjust = (previous && confirmed) || resumed !== null ? this.carryReference(own, type, beatPeriod, earlier) : 0;
      adjusts.push(adjust);
      /** @type {number[]} */
      const ns = [];
      /** @type {number[]} */
      const ps = [];
      for (const d of own) {
        d.p += adjust;
        dots.push(d);
        if (d.ok) {
          ns.push(d.n);
          ps.push(d.p);
        }
      }
      lines.push(tracked ? lineThrough(ns, ps) : null);
      // New beats are matched against the whole template, so the noise level they must exceed
      // is measured with the whole template too, at two places between the beats.
      let threshold = tr.threshold;
      let noiseMean = tr.noiseMean;
      let noiseSd = tr.noiseSd;
      if (lines[j]) {
        /** @type {number[]} */
        const peaks = [];
        for (const dataOffset of [period / 4, (3 * period) / 4]) {
          const noise = matchedFilter(rows, fe, period, [analysis.template, analysis.template], centre, { dataOffset, lagMs: analysis.lagMs });
          peaks.push(...pickPeaks(averageCycles(noise.corr, tr.K), noise.lags).value);
        }
        if (peaks.length >= 8) {
          noiseMean = mean(peaks);
          noiseSd = std(peaks) + 1e-12;
          threshold = percentile(peaks, 99);
        }
      }
      types.push({
        tracked: lines[j] !== null,
        K: tr.K,
        threshold,
        noiseMean,
        noiseSd,
        typical: 0,
        recentZ: [],
        weights: buildWeights(analysis.template, centre, this.pre, this.nTau),
        centre,
        adjust,
        nextCycle,
        acc: new Float64Array(this.nLag),
        filled: 0,
        n0: 0,
        p0: 0,
        step: beatPeriod,
        failed: 0,
        refused: 0,
      });
    }
    if (!lines.some((l) => l !== null)) return false;
    // Which cluster is the tick depends on how the beat numbers continue from the previous lock.
    const parity = Math.abs(shift % 2);
    const geometry = (analysis.clusters[1] + adjusts[1] - analysis.clusters[0] - adjusts[0] - beatPeriod) * (parity === 0 ? 1 : -1);
    this.tracker = this.startTracker(lines[parity], lines[1 - parity], geometry, beatPeriod);
    // Beats inside the analysed window are superseded by the ones just computed.
    this.dots = this.dots.filter((d) => d.p < start).concat(dots).sort((a, b) => a.p - b.p);
    // What was heard under another verdict says nothing about a change from this one.
    if (!this.lock || this.lock.irregular !== analysis.irregular) this.recentLag = [[], []];
    this.lock = { bph: analysis.bph, nominalPeriod: 3600 / analysis.bph, start, length, period, template: analysis.template, clusters: analysis.clusters, types, confirmed, blocks: 0, blocksOk: 0, irregular: analysis.irregular, continues: resumed !== null, halfway: null };
    this.shift = shift;
    this.lastTrusted = start + length;
    this.trackingSince = this.count;
    if (confirmed) this.announce(dots, start);
    // Repeat the analysis when the audio since the lock began has grown by half, then at a
    // steady interval once the history is full.
    const age = this.count - this.lockedFrom;
    this.nextRefresh = age < this.historyLength ? this.lockedFrom + Math.min(this.historyLength, Math.round(1.5 * age)) : this.count + Math.round(o.refreshSeconds * fe);
    return true;
  }

  /**
   * Where a repeat analysis of a regular watch starts: as far back as the history allows, unless
   * the beats timed since then bend away from one beat period by more than `FOLD_BEND_MS`, as
   * when the watch's rate changed within it. The audio is then shortened from its start until they
   * do not, but not below the shortest window a lock is first found in. Irregular watches are
   * analysed from the beats already timed, not folded, and keep the whole history; so do faint
   * ones whose beats are averaged over several cycles, which need all of it to be heard.
   * @param {number} start the earliest start the history allows
   * @returns {number}
   */
  foldStart(start) {
    const lock = /** @type {NonNullable<Pipeline['lock']>} */ (this.lock);
    if (this.options.followRate === false || lock.irregular || lock.types.some((ty) => ty.tracked && ty.K > 1)) return start;
    const fe = this.fe;
    const shortest = Math.round(this.options.windows[0] * fe);
    const step = Math.round(FOLD_STEP_SECONDS * fe);
    let from = start;
    while (this.count - from > shortest && this.bend(from) > FOLD_BEND_MS * 1e-3 * fe) from = Math.min(from + step, this.count - shortest);
    return from;
  }

  /**
   * How far the confident beats timed since `from` bend away from a straight line: for each beat
   * type, the median distance from its line over each `FOLD_STEP_SECONDS` of audio, and the
   * largest of these, in envelope samples. Medians, so that a beat taken on the wrong sound now
   * and then does not count as a bend.
   * @param {number} from absolute position
   * @returns {number}
   */
  bend(from) {
    const step = FOLD_STEP_SECONDS * this.fe;
    let largest = 0;
    for (const type of [0, 1]) {
      const inside = this.dots.filter((d) => d.type === type && d.ok && d.p >= from);
      if (inside.length < MIN_TIMESTAMPS) continue;
      const line = lineThrough(inside.map((d) => d.n), inside.map((d) => d.p));
      if (!line) continue;
      /** @type {Map<number, number[]>} */
      const pieces = new Map();
      for (const d of inside) {
        const k = Math.floor((d.p - from) / step);
        const list = pieces.get(k) || [];
        list.push(d.p - line.at(d.n));
        pieces.set(k, list);
      }
      for (const list of pieces.values()) largest = Math.max(largest, Math.abs(median(list)));
    }
    return largest;
  }

  /**
   * The beat period a repeat analysis starts its search from, in parts per million from the
   * nominal period. The analysis searches only a narrow span around where it starts: 15 ppm,
   * about 1.3 s/day, either way over a 40 s window. It starts from the tracker's period, unless
   * the beats already timed in the window run at a period beyond that reach from it. The
   * tracker's period is the watch's latest rate, and when the rate changes quickly it can lie
   * tens of seconds a day from the average over the window; folded at such a period, the beats
   * at the ends of the window smear and their timestamps hop between the sounds of the beat.
   * @param {number} start absolute position of the first sample to be analysed
   * @param {number} span how far either way the analysis searches, in parts per million
   * @returns {number}
   */
  periodHint(start, span) {
    const lock = /** @type {NonNullable<Pipeline['lock']>} */ (this.lock);
    const tracker = /** @type {BeatTracker} */ (this.tracker);
    const ppmOf = (/** @type {number} */ period) => (period / (lock.nominalPeriod * this.fe) - 1) * 1e6;
    const own = ppmOf(tracker.period);
    if (this.options.followRate === false) return own;
    let sum = 0;
    let weight = 0;
    for (const type of [0, 1]) {
      const inside = this.dots.filter((d) => d.type === type && d.ok && d.p >= start);
      const line = inside.length >= MIN_TIMESTAMPS ? lineThrough(inside.map((d) => d.n), inside.map((d) => d.p)) : null;
      if (!line) continue;
      sum += line.b / line.periodVar;
      weight += 1 / line.periodVar;
    }
    if (weight === 0) return own;
    const timed = ppmOf(sum / weight);
    return Math.abs(timed - own) > span ? timed : own;
  }

  /**
   * The beat number a new lock's first beat carries on from the last lock, when that lock was
   * lost moments before at the same beat rate: the lost tracker predicts a beat there. Without
   * it, a new lock numbers its beats afresh, its first cluster becomes the tick whichever beat it
   * is, and half the time the tick and the tock swap.
   * @param {NonNullable<ReturnType<typeof analyzeRows>>} analysis
   * @param {number} start absolute position of the first analysed sample
   * @returns {number|null} the beat number, or null when the new lock starts afresh
   */
  resume(analysis, start) {
    const lost = this.lost;
    if (!lost || this.options.resumeLock === false || analysis.bph !== lost.bph) return null;
    const first = start + analysis.clusters[0];
    if (first - lost.lastTrusted > RESUME_SECONDS * this.fe) return null;
    const t = lost.tracker;
    const beats = (first - t.phase) / t.period;
    const k = Math.round(beats);
    return Math.abs(beats - k) <= RESUME_FRACTION ? t.n + k : null;
  }

  /**
   * A tracker started at the last timed beat, from the better-determined of the tick and tock
   * lines.
   * @param {Line|null} tick
   * @param {Line|null} tock
   * @param {number} geometry tock minus tick, less one beat, for when only one line is known
   * @param {number} beatPeriod in envelope samples
   * @returns {BeatTracker}
   */
  startTracker(tick, tock, geometry, beatPeriod) {
    const fe = this.fe;
    const usable = /** @type {Line[]} */ ([tick, tock].filter((l) => l !== null));
    const n = Math.max(...usable.map((l) => l.last));
    const main = usable.reduce((best, l) => (l.periodVar < best.periodVar ? l : best));
    const offset = tick && tock ? tock.at(n) - tick.at(n) : geometry;
    const seconds = beatPeriod / fe;
    return new BeatTracker({
      n,
      phase: main.at(n) - (main === tock ? offset : 0),
      period: main.b,
      offset,
      phaseSd: Math.sqrt(main.varAt(n)),
      periodSd: Math.sqrt(main.periodVar),
      phasePeriodCov: main.covAt(n),
      offsetSd: tick && tock ? Math.sqrt(tick.varAt(n) + tock.varAt(n)) : 0,
      periodDrift: this.options.driftPpm * 1e-6 * beatPeriod * Math.sqrt(seconds),
      offsetDrift: tick && tock ? 1e-6 * fe * Math.sqrt(seconds) : 0,
      // The scatter about a line fitted to a few points is an optimistic guide to how far the
      // next timestamps will fall from it, so the tracker starts with twice that.
      scatter: [2 * (tick ? tick.sd : main.sd), 2 * (tock ? tock.sd : main.sd)],
      minScatter: 2e-5 * fe,
    });
  }

  /**
   * Start the tracker again from the beats themselves, when it keeps refusing confident
   * timestamps or its predictions keep missing them the same way, and the latest timestamps
   * agree with one another. The tracker allows the rate to wander only slowly, which suits most
   * watches; a watch whose rate changes faster than that pulls its beats away from the
   * prediction. Until 22 November 2026 every beat was then refused and the lock dropped although
   * the beats were clear, or, where the tracker's spread widened to let them through, its
   * prediction lagged them by up to 4 ms. Seen on an old 18,000 vph watch whose rate fell by
   * 25 s/day within 10 s.
   */
  resync() {
    const lock = this.lock;
    const tracker = this.tracker;
    if (!lock || !tracker || !lock.confirmed || this.options.followRate === false) return;
    const tracked = lock.types.filter((ty) => ty.tracked);
    if (tracked.length === 0) return;
    if (!tracked.every((ty) => ty.refused >= RESYNC_REFUSED) && !this.fallingBehind()) return;
    // Lines through the latest confident timestamps of each beat type, which must lie close to
    // them: beats that jump between sounds or between noise and watch are not followed.
    const lines = /** @type {(Line|null)[]} */ ([null, null]);
    for (let j = 0; j < 2; j++) {
      if (!lock.types[j].tracked) continue;
      const type = /** @type {0|1} */ (Math.abs((j + this.shift) % 2));
      const recent = this.dots.filter((d) => d.type === type && d.ok).slice(-RESYNC_TIMESTAMPS);
      const line = lineThrough(recent.map((d) => d.n), recent.map((d) => d.p));
      if (!line || line.sd > RESYNC_SCATTER * Math.max(tracker.scatter(type), tracker.minScatter)) return;
      lines[type] = line;
    }
    this.tracker = this.startTracker(lines[0], lines[1], tracker.offset, tracker.period);
    for (const ty of lock.types) {
      ty.failed = 0;
      ty.refused = 0;
    }
    const latest = this.dots.filter((d) => d.ok).pop();
    if (latest) this.lastTrusted = Math.max(this.lastTrusted, latest.p);
    this.resyncs++;
  }

  /**
   * Whether the tracker's latest predictions miss every timed beat type the same way: the last
   * `RESYNC_RECENT` misses of each all on one side, with a median beyond `RESYNC_LAG_MS`.
   * @returns {boolean}
   */
  fallingBehind() {
    const lock = /** @type {NonNullable<Pipeline['lock']>} */ (this.lock);
    const tracker = /** @type {BeatTracker} */ (this.tracker);
    const limit = RESYNC_LAG_MS * 1e-3 * this.fe;
    let sign = 0;
    for (let j = 0; j < 2; j++) {
      if (!lock.types[j].tracked) continue;
      const misses = tracker.recent[Math.abs((j + this.shift) % 2)];
      if (misses.length < RESYNC_RECENT) return false;
      const latest = misses.slice(-RESYNC_RECENT);
      const m = median(latest);
      if (Math.abs(m) <= limit || (sign !== 0 && Math.sign(m) !== sign)) return false;
      if (!latest.every((x) => Math.sign(x) === Math.sign(m))) return false;
      sign = Math.sign(m);
    }
    return sign !== 0;
  }

  /**
   * How far a repeat analysis, or a lock that carries on a lost one, must move its timestamps of
   * one beat type for them to agree with the timestamps already reported for the same beats.
   * Every new confident timestamp is compared with the nearest old one of its type; the median
   * difference is the distance between the new analysis's reference point and the one in use.
   * @param {Dot[]} fresh the new analysis's timestamps of one beat type, in time order
   * @param {0|1} type
   * @param {number} beatPeriod samples per beat
   * @param {Dot[]} earlier the timestamps already reported
   * @returns {number} samples to add to the new timestamps; 0 when too few beats are common to
   *   both, as when this beat type was not timed before
   */
  carryReference(fresh, type, beatPeriod, earlier) {
    const old = earlier.filter((d) => d.type === type && d.ok);
    if (old.length === 0) return 0;
    /** @type {number[]} */
    const moved = [];
    let k = 0;
    for (const d of fresh) {
      if (!d.ok) continue;
      while (k + 1 < old.length && Math.abs(old[k + 1].n - d.n) <= Math.abs(old[k].n - d.n)) k++;
      const o = old[k];
      // Averaged timestamps sit up to one average's length apart on the two grids.
      if (Math.abs(o.n - d.n) > 2 * Math.max(o.K, d.K)) continue;
      moved.push(d.p - o.p - (d.n - o.n) * beatPeriod);
    }
    return moved.length >= MIN_COMMON_BEATS ? -median(moved) : 0;
  }

  /**
   * Report the state and the beats of a fresh analysis.
   * @param {Dot[]} dots
   * @param {number} start
   */
  announce(dots, start) {
    const lock = this.lock;
    if (!lock) return;
    this.events.push({ type: 'status', state: 'tracking', reason: 'locked', bph: lock.bph, cyclesAveraged: lock.types.map((ty) => (ty.tracked ? ty.K : null)), t: this.toSeconds(this.count), continues: lock.continues });
    this.events.push({ type: 'beats', beats: dots.map((d) => this.beat(d)), replaceFrom: this.toSeconds(start) });
    this.events.push(this.waveform());
  }

  /**
   * The averaged tick and tock of the current template, for the waveform view.
   * @returns {WaveformEvent}
   */
  waveform() {
    const lock = /** @type {NonNullable<Pipeline['lock']>} */ (this.lock);
    const fe = this.fe;
    const before = Math.round(WAVE_BEFORE_MS * 1e-3 * fe);
    const after = Math.round(WAVE_AFTER_MS * 1e-3 * fe);
    const nb = lock.template[0].length;
    /** @type {AveragedBeat[]} */
    const beats = [];
    for (let j = 0; j < 2; j++) {
      const values = new Float32Array(before + after + 1);
      const centre = Math.round(lock.clusters[j] + lock.types[j].adjust);
      for (const row of lock.template) {
        for (let i = 0; i < values.length; i++) values[i] += row[(((centre - before + i) % nb) + nb) % nb];
      }
      beats.push({ type: /** @type {0|1} */ (Math.abs((j + this.shift) % 2)), values });
    }
    beats.sort((a, b) => a.type - b.type);
    const marks = this.sounds ? this.sounds.marks(this.halfway()) : null;
    return { type: 'waveform', t: this.toSeconds(this.count), rate: fe, from: -before / fe, to: after / fe, cycles: Math.max(0, Math.floor(lock.length / lock.period) - 1), beats, marks };
  }

  /**
   * @param {Dot} d
   * @returns {Beat}
   */
  beat(d) {
    return { n: d.n, t: this.toSeconds(d.p), type: d.type, confidence: d.z, ok: d.ok, cycles: d.K };
  }

  /** Time every beat for which the audio has arrived. */
  stream() {
    const lock = this.lock;
    if (!lock || !this.tracker) return;
    const filled = this.count - this.base;
    /** @type {Dot[]} */
    const fresh = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (let j = 0; j < 2; j++) {
        const ty = lock.types[j];
        if (!ty.tracked) continue;
        const n = 2 * ty.nextCycle + j + this.shift;
        const type = /** @type {0|1} */ (Math.abs((j + this.shift) % 2));
        if (ty.filled === 0) {
          // A new block: the cycles in it lie on a straight grid predicted by the tracker.
          ty.n0 = n;
          const tracker = /** @type {BeatTracker} */ (this.tracker);
          ty.p0 = tracker.expect(n, type).arrival;
          ty.step = tracker.period;
          ty.acc.fill(0);
        }
        // The grid gives where the reference point is expected; the filter's own centre lies
        // `adjust` samples before it.
        const position = ty.p0 + (n - ty.n0) * ty.step;
        const startAt = position - ty.adjust - this.pre - this.maxLag - this.base;
        if (Math.floor(startAt) + this.segLen + 1 >= filled) continue;
        if (startAt >= 0) correlateAt(this.rows, startAt, ty.weights, this.nLag, ty.acc, this.seg);
        ty.filled++;
        ty.nextCycle++;
        progress = true;
        if (ty.filled < ty.K) continue;
        for (let L = 0; L < this.nLag; L++) ty.acc[L] /= ty.K;
        // The tracker says where the beat is expected: lag 0. A confident peak close to that
        // is preferred to a higher one on another of the beat's sounds.
        // An irregular watch gives no reason to expect its beat near the prediction.
        const preferNear = !lock.irregular && (!this.options.timing || this.options.timing.preferNear !== false);
        const peak = preferNear ? pickPeakNear(ty.acc, this.lags, 0, this.nearLag, ty.threshold) : pickPeak(ty.acc, this.lags);
        const centreN = ty.n0 + (ty.K - 1);
        const p = ty.p0 + (ty.K - 1) * ty.step + peak.lag;
        const ok = peak.value > ty.threshold;
        const z = (peak.value - ty.noiseMean) / ty.noiseSd;
        const dot = { n: centreN, p, j: /** @type {0|1} */ (j), type, ok, z, K: ty.K };
        if (ok) {
          // Where the beat was heard, without the preference for a peak near the prediction:
          // that preference would hide the scatter being watched for.
          const highest = preferNear ? pickPeak(ty.acc, this.lags) : peak;
          const recent = this.recentLag[type];
          recent.push(highest.lag * Math.sqrt(ty.K));
          if (recent.length > CHANGE_BEATS) recent.shift();
        }
        this.dots.push(dot);
        fresh.push(dot);
        ty.filled = 0;
        let trusted = false;
        if (ok) {
          ty.recentZ.push(z);
          if (ty.recentZ.length > 16) ty.recentZ.shift();
          if (ty.recentZ.length >= 4) ty.typical = median(ty.recentZ);
          trusted = /** @type {BeatTracker} */ (this.tracker).update(centreN, type, p, ty.typical > 0 ? z / ty.typical : 1).accepted;
        }
        if (trusted) {
          ty.failed = 0;
          ty.refused = 0;
          this.lastTrusted = p;
        } else {
          ty.failed++;
          if (ok) ty.refused++;
        }
        if (ok) this.resync();
        if (!lock.confirmed) {
          lock.blocks++;
          if (trusted) lock.blocksOk++;
        }
      }
    }
    // Beats outlive their audio when the averaging window is longer than the history, and for as
    // long as stage 10 reads their sounds, which it keeps the envelopes for.
    const oldest = this.count - Math.max(this.historyLength, this.averagingSpan(), this.sounds ? this.sounds.window : 0);
    if (this.dots.length && this.dots[0].p < oldest) this.dots = this.dots.filter((d) => d.p >= oldest);
    if (fresh.length && lock.confirmed) this.events.push({ type: 'beats', beats: fresh.map((d) => this.beat(d)), replaceFrom: null });
  }

  /** Decide whether a provisional lock holds on the beats that followed the analysed window. */
  confirm() {
    const lock = this.lock;
    if (!lock) return;
    if (lock.blocks < 3) return;
    // At least half of the first timestamps after the analysed window, and at least two of
    // them, must be confident and land where the tracker expects them.
    if (lock.blocksOk >= Math.max(2, 0.5 * lock.blocks)) {
      lock.confirmed = true;
      this.lost = null;
      this.trackingSince = this.count;
      // Stage 10 reads only beats heard from here on.
      if (this.sounds) this.sounds.reset(this.count);
      this.state = 'tracking';
      this.nextReading = this.count;
      this.announce(this.dots.filter((d) => d.p >= lock.start), lock.start);
    } else {
      this.lock = null;
      this.tracker = null;
      this.dots = [];
    }
  }

  /**
   * Drop the lock and listen again, using only audio that arrived after the last trusted beat.
   * @param {string} reason
   */
  lose(reason) {
    if (this.lock && this.lock.confirmed && this.tracker) this.lost = { bph: this.lock.bph, tracker: this.tracker, dots: this.dots, lastTrusted: this.lastTrusted, tick: this.tick };
    this.state = 'listening';
    this.lock = null;
    this.tracker = null;
    this.dots = [];
    this.listenFrom = Math.ceil(this.lastTrusted);
    this.attempts = 0;
    this.nextAttempt = Math.max(this.count + 1, this.listenFrom + Math.round(this.options.windows[0] * this.fe));
    this.nextRefresh = Infinity;
    this.nextReading = Infinity;
    if (this.sounds) this.sounds.reset(this.count);
    const t = this.toSeconds(this.count);
    this.events.push({ type: 'status', state: 'listening', reason, bph: null, cyclesAveraged: null, t });
    this.events.push({ type: 'readings', t, window: null, windowStart: null, windowSeconds: null, signal: null, irregular: false, sounds: null, tick: null, fits: [null, null], rate: null, rateSd: null, jitterMs: null, beatErrorMs: null, beatOffsetMs: null, beatErrorDetail: null });
  }

  /**
   * Length of the averaging window in envelope samples: the setting, or longer when faint ticks
   * are averaged over several cycles, so that each beat type has enough independent timestamps.
   * @returns {number}
   */
  averagingSpan() {
    const set = Math.round(this.options.averagingSeconds * this.fe);
    const lock = this.lock;
    const tracker = this.tracker;
    if (!lock || !tracker) return set;
    const K = Math.max(...lock.types.map((ty) => (ty.tracked ? ty.K : 1)));
    return Math.max(set, Math.round(MIN_TIMESTAMPS * K * 2 * tracker.period));
  }

  /**
   * Readings over the averaging window, from the raw timestamps. The window reaches back no
   * further than the start of the current lock, and is lengthened for faint ticks (see
   * `averagingSpan`). Beats are grouped by type rather than by
   * template cluster, because repeat analyses can number the clusters differently. The first
   * readings that make it clear name the tick (see `nameTick`).
   * @returns {ReadingsEvent | null}
   */
  readings() {
    const lock = this.lock;
    if (!lock) return null;
    const span = this.averagingSpan();
    const from = Math.max(this.lockedFrom, this.count - span);
    const inside = this.dots.filter((d) => d.p >= from);
    if (inside.length === 0) return null;
    // Cluster j of the current template holds beats of type (j + shift) mod 2.
    const typeOf = (/** @type {number} */ j) => Math.abs((j + this.shift) % 2);
    const beats = [0, 1].map((j) => {
      const ds = inside.filter((d) => d.type === typeOf(j));
      const z = Float64Array.from(ds, (d) => d.z);
      return {
        type: /** @type {0|1} */ (j),
        K: 1,
        t: Float64Array.from(ds, (d) => this.toSeconds(d.p)),
        n: Float64Array.from(ds, (d) => d.n),
        ok: Uint8Array.from(ds, (d) => (d.ok ? 1 : 0)),
        z,
        confidentFraction: ds.length ? ds.filter((d) => d.ok).length / ds.length : 0,
        zMedian: z.length ? median(z) : 0,
      };
    });
    const referenceGap = (lock.types[1].adjust - lock.types[0].adjust) / this.fe;
    const r = summarize(beats, lock.nominalPeriod, lock.template, lock.clusters, this.fe, this.options.escapement, referenceGap, lock.irregular);
    // `summarize` compares the template's second cluster with its first. When the first holds
    // the beats of type 1, what it gives for the two is turned round, so that the readings are
    // in the order of the types whichever beat a repeat analysis happened to start on. Until
    // 26 November 2026 they were not, and the offset's sign could flip within a run.
    if (typeOf(0) === 1) {
      r.fits = [r.fits[1], r.fits[0]];
      if (r.beatOffsetMs !== null) r.beatOffsetMs = -r.beatOffsetMs;
      if (r.beatErrorDetail) r.beatErrorDetail = { ...r.beatErrorDetail, offsetMs: -r.beatErrorDetail.offsetMs };
    }
    /** @type {Signal} */
    const signal = { z: [null, null], cycles: [null, null] };
    for (let j = 0; j < 2; j++) {
      const ty = lock.types[j];
      if (!ty.tracked) continue;
      const type = typeOf(j);
      const recent = this.dots.filter((d) => d.type === type).slice(-SIGNAL_BEATS);
      signal.z[type] = recent.length ? median(recent.map((d) => d.z)) : null;
      signal.cycles[type] = ty.K;
    }
    const sounds = this.sounds ? this.sounds.report(lock.irregular, this.halfway()) : null;
    if (this.tick === null) this.tick = this.nameTick(r, sounds, lock.irregular);
    return { type: 'readings', t: this.toSeconds(this.count), window: [this.toSeconds(inside[0].p), this.toSeconds(inside[inside.length - 1].p)], windowStart: this.toSeconds(from), windowSeconds: span / this.fe, signal, irregular: lock.irregular, sounds, tick: this.tick, ...r };
  }

  /**
   * Which type of beat is the tick, if these readings make it clear. A Swiss lever's tick is
   * the beat followed by the longer gap between the timed beats, named only from an offset
   * that a beat error could be read from: both types timed precisely and sounding alike, no
   * beat halfway between them, and a watch that is not running irregularly. A co-axial's is
   * the beat with the longer time from unlock to lock, named only from an amplitude that is
   * shown.
   * @param {import('./estimate.js').Readings} r in the order of the types
   * @param {import('./soundstage.js').SoundsReport|null} sounds
   * @param {boolean} irregular
   * @returns {0|1|null}
   */
  nameTick(r, sounds, irregular) {
    if (this.options.escapement === 'coaxial') {
      return sounds && sounds.amplitude !== null && sounds.liftMs && sounds.liftSd ? tickByLift(sounds.liftMs, sounds.liftSd) : null;
    }
    if (irregular || r.beatOffsetMs === null || !r.beatErrorDetail) return null;
    return tickByGap(r.beatOffsetMs, r.beatErrorDetail.offsetSdMs);
  }

  emitReadings() {
    const r = this.readings();
    if (r) this.events.push(r);
  }
}
