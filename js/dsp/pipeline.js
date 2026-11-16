// The real-time pipeline. Audio goes in as chunks of any size; status, beats and readings
// come out as events. It moves between two states:
//
//   listening  audio is arriving and the pipeline is looking for a beat rate
//   tracking   a beat rate is locked; beats are timestamped and readings update
//
// When the lock is lost the readings are blanked and the pipeline listens again.
//
// A lock is found by analysing a stretch of the history buffer with the same stages as the
// offline analysis, then confirmed on beats the analysis has not seen. While tracking, each new
// beat is timed against the template from the last analysis, at the position the Kalman
// tracker predicts. The analysis is repeated on the sliding history window from time to time,
// which refreshes the template, the averaging and the noise thresholds.
//
// A beat's timestamp is the moment a reference point of its sound arrives. Each analysis picks
// that point afresh, as the loudest part of the averaged beat, and a beat made of several sounds
// of similar loudness (a co-axial escapement's, for one) can have a different loudest part from
// one analysis to the next. So that timestamps stay comparable for as long as a lock lasts, each
// repeat analysis measures how far its timestamps lie from the ones already reported for the
// same beats, and reports its own moved back by that much.

import { FilterBank } from './filterbank.js';
import { Cleanup } from './cleanup.js';
import { acquireFast } from './acquire.js';
import { analyzeRows } from './offline.js';
import { buildWeights, correlateAt, pickPeak, pickPeakNear, pickPeaks, matchedFilter, averageCycles, NEAR_MS, LAG_MS } from './timing.js';
import { summarize } from './estimate.js';
import { BeatTracker } from './tracker.js';
import { robustLine, median, mean, std, percentile } from './mathutil.js';

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
 * @typedef {{type: 'status', state: 'listening'|'tracking', reason: string, bph: number|null, cyclesAveraged: (number|null)[]|null, t: number}} StatusEvent
 * @typedef {{type: 'beats', beats: Beat[], replaceFrom: number|null}} BeatsEvent
 *   replaceFrom: when set, beats from that time on are superseded by this list
 * @typedef {{type: 'readings', t: number, window: [number, number]|null, signal: Signal|null, irregular: boolean} & import('./estimate.js').Readings} ReadingsEvent
 *   irregular: true when the beats fall at scattered times; every timestamp is then one beat
 * @typedef {{type: 'waveform', t: number, rate: number, from: number, to: number, cycles: number, beats: AveragedBeat[]}} WaveformEvent
 *   The averaged tick and tock from the latest analysis. `rate` is the envelope sample rate;
 *   `from` and `to` are the window's ends in seconds relative to each beat's timestamp;
 *   `cycles` is the number of tick-tock cycles averaged.
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
    /** @type {null | {bph: number, nominalPeriod: number, start: number, length: number, period: number, template: Float32Array[], clusters: [number, number], types: BeatTypeState[], confirmed: boolean, blocks: number, blocksOk: number, irregular: boolean}} */
    this.lock = null;
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
    /** @type {PipelineEvent[]} */
    this.events = [];
    /** Seconds spent in the lock analyses, for the speed check. */
    this.analysisSeconds = 0;
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
   * Change the settings that can change while measuring: the averaging window and the
   * escapement. They apply from the next reading. Other settings need a new pipeline.
   * @param {{averagingSeconds?: number, escapement?: import('./estimate.js').Escapement}} changes
   */
  setOptions(changes) {
    if (changes.averagingSeconds !== undefined) this.options.averagingSeconds = changes.averagingSeconds;
    if (changes.escapement !== undefined) this.options.escapement = changes.escapement;
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
        this.append(this.cleanup.process(this.bank.process(this.block)));
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
      }
    }
    if (this.state === 'tracking' && this.count >= this.nextReading) {
      this.nextReading = this.count + Math.round(this.options.readingSeconds * this.fe);
      this.emitReadings();
    }
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
  refresh() {
    const lock = this.lock;
    const tracker = this.tracker;
    if (!lock || !tracker) return;
    const fe = this.fe;
    const start = Math.max(this.lockedFrom, this.count - this.historyLength, this.base);
    const length = this.count - start;
    const rows = this.view(start, this.count);
    const ppm = (tracker.period / (lock.nominalPeriod * fe) - 1) * 1e6;
    const t0 = performance.now();
    const analysis = analyzeRows(rows, fe, (p) => this.toSeconds(p + start), {
      bph: lock.bph,
      periodPpm: ppm,
      refineSpan: (600 * fe) / length,
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
    if (previous && confirmed) {
      shift = previous.n + Math.round((start + analysis.clusters[0] - previous.phase) / previous.period);
    }
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
      const adjust = previous && confirmed ? this.carryReference(own, type, beatPeriod) : 0;
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
      });
    }
    const usable = /** @type {Line[]} */ (lines.filter((l) => l !== null));
    if (usable.length === 0) return false;
    // Start the tracker at the last timed beat, from the better-determined of the two lines.
    // Which cluster is the tick depends on how the beat numbers continue from the previous lock.
    const n = Math.max(...usable.map((l) => l.last));
    const parity = Math.abs(shift % 2);
    const tick = lines[parity];
    const tock = lines[1 - parity];
    const main = usable.reduce((best, l) => (l.periodVar < best.periodVar ? l : best));
    const geometry = (analysis.clusters[1] + adjusts[1] - analysis.clusters[0] - adjusts[0] - beatPeriod) * (parity === 0 ? 1 : -1);
    const offset = tick && tock ? tock.at(n) - tick.at(n) : geometry;
    const seconds = beatPeriod / fe;
    this.tracker = new BeatTracker({
      n,
      phase: main.at(n) - (main === tock ? offset : 0),
      period: main.b,
      offset,
      phaseSd: Math.sqrt(main.varAt(n)),
      periodSd: Math.sqrt(main.periodVar),
      phasePeriodCov: main.covAt(n),
      offsetSd: tick && tock ? Math.sqrt(tick.varAt(n) + tock.varAt(n)) : 0,
      periodDrift: o.driftPpm * 1e-6 * beatPeriod * Math.sqrt(seconds),
      offsetDrift: tick && tock ? 1e-6 * fe * Math.sqrt(seconds) : 0,
      // The scatter about a line fitted to a few points is an optimistic guide to how far the
      // next timestamps will fall from it, so the tracker starts with twice that.
      scatter: [2 * (tick ? tick.sd : main.sd), 2 * (tock ? tock.sd : main.sd)],
      minScatter: 2e-5 * fe,
    });
    // Beats inside the analysed window are superseded by the ones just computed.
    this.dots = this.dots.filter((d) => d.p < start).concat(dots).sort((a, b) => a.p - b.p);
    this.lock = { bph: analysis.bph, nominalPeriod: 3600 / analysis.bph, start, length, period, template: analysis.template, clusters: analysis.clusters, types, confirmed, blocks: 0, blocksOk: 0, irregular: analysis.irregular };
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
   * How far a repeat analysis must move its timestamps of one beat type for them to agree with
   * the timestamps already reported for the same beats. Every new confident timestamp is
   * compared with the nearest old one of its type; the median difference is the distance
   * between the new analysis's reference point and the one in use.
   * @param {Dot[]} fresh the new analysis's timestamps of one beat type, in time order
   * @param {0|1} type
   * @param {number} beatPeriod samples per beat
   * @returns {number} samples to add to the new timestamps; 0 when too few beats are common to
   *   both, as when this beat type was not timed before
   */
  carryReference(fresh, type, beatPeriod) {
    const old = this.dots.filter((d) => d.type === type && d.ok);
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
    this.events.push({ type: 'status', state: 'tracking', reason: 'locked', bph: lock.bph, cyclesAveraged: lock.types.map((ty) => (ty.tracked ? ty.K : null)), t: this.toSeconds(this.count) });
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
    return { type: 'waveform', t: this.toSeconds(this.count), rate: fe, from: -before / fe, to: after / fe, cycles: Math.max(0, Math.floor(lock.length / lock.period) - 1), beats };
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
    const tracker = this.tracker;
    if (!lock || !tracker) return;
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
        this.dots.push(dot);
        fresh.push(dot);
        ty.filled = 0;
        let trusted = false;
        if (ok) {
          ty.recentZ.push(z);
          if (ty.recentZ.length > 16) ty.recentZ.shift();
          if (ty.recentZ.length >= 4) ty.typical = median(ty.recentZ);
          trusted = tracker.update(centreN, type, p, ty.typical > 0 ? z / ty.typical : 1).accepted;
        }
        if (trusted) {
          ty.failed = 0;
          this.lastTrusted = p;
        } else {
          ty.failed++;
        }
        if (!lock.confirmed) {
          lock.blocks++;
          if (trusted) lock.blocksOk++;
        }
      }
    }
    // Beats outlive their audio when the averaging window is longer than the history.
    const oldest = this.count - Math.max(this.historyLength, this.averagingSpan());
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
      this.trackingSince = this.count;
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
    this.state = 'listening';
    this.lock = null;
    this.tracker = null;
    this.dots = [];
    this.listenFrom = Math.ceil(this.lastTrusted);
    this.attempts = 0;
    this.nextAttempt = Math.max(this.count + 1, this.listenFrom + Math.round(this.options.windows[0] * this.fe));
    this.nextRefresh = Infinity;
    this.nextReading = Infinity;
    const t = this.toSeconds(this.count);
    this.events.push({ type: 'status', state: 'listening', reason, bph: null, cyclesAveraged: null, t });
    this.events.push({ type: 'readings', t, window: null, signal: null, irregular: false, fits: [null, null], rate: null, rateSd: null, jitterMs: null, beatErrorMs: null, beatOffsetMs: null, beatErrorDetail: null });
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
   * template cluster, because repeat analyses can number the clusters differently.
   * @returns {ReadingsEvent | null}
   */
  readings() {
    const lock = this.lock;
    if (!lock) return null;
    const from = Math.max(this.lockedFrom, this.count - this.averagingSpan());
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
    return { type: 'readings', t: this.toSeconds(this.count), window: [this.toSeconds(inside[0].p), this.toSeconds(inside[inside.length - 1].p)], signal, irregular: lock.irregular, ...r };
  }

  emitReadings() {
    const r = this.readings();
    if (r) this.events.push(r);
  }
}
