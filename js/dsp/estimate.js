// Stage 8 of the pipeline: turn beat timestamps into readings.

import { robustLine, median, parabolicOffset } from './mathutil.js';
import { clusterStrength } from './template.js';

/**
 * @typedef {Object} BeatSeries
 * @property {0|1} type 0 for the earlier beat of each cycle ("tick"), 1 for the other ("tock")
 * @property {number} K cycles averaged per estimate
 * @property {Float64Array} t time of each estimate in seconds
 * @property {Float64Array} n beat number of each estimate (even for ticks, odd for tocks)
 * @property {Uint8Array} ok 1 where the estimate stands above the noise
 * @property {Float64Array} z confidence of each estimate
 * @property {number} confidentFraction share of estimates above the noise threshold
 * @property {number} zMedian median confidence of the estimates
 */

/**
 * @typedef {Object} BeatFit
 * @property {0|1} type
 * @property {number} period measured beat period in seconds
 * @property {number} rate seconds per day, positive when the watch gains
 * @property {number} rateSd statistical uncertainty of the rate in seconds per day
 * @property {number} jitterMs robust scatter of the timestamps about the fitted line
 * @property {number} count independent confident estimates used
 */

/**
 * Indices of the estimates that are both confident and statistically independent (estimates
 * averaged over K cycles overlap, so only every K-th is independent).
 * @param {BeatSeries} series
 * @returns {number[]}
 */
export function independentConfident(series) {
  /** @type {number[]} */
  const idx = [];
  for (let i = 0; i < series.t.length; i += series.K) if (series.ok[i]) idx.push(i);
  return idx;
}

/**
 * Fit the rate of one beat type.
 * @param {BeatSeries} series
 * @param {number} nominalPeriod nominal beat period in seconds
 * @returns {BeatFit | null} null when fewer than five usable estimates exist
 */
export function fitSeries(series, nominalPeriod) {
  const idx = independentConfident(series);
  if (idx.length < 5) return null;
  const n = idx.map((i) => series.n[i]);
  const t = idx.map((i) => series.t[i]);
  const { b, residualSd } = robustLine(n, t);
  const nMean = n.reduce((s, v) => s + v, 0) / n.length;
  const spread = Math.sqrt(n.reduce((s, v) => s + (v - nMean) * (v - nMean), 0));
  const periodSd = residualSd / spread;
  return {
    type: series.type,
    period: b,
    rate: 86400 * (nominalPeriod / b - 1),
    rateSd: (86400 * nominalPeriod * periodSd) / (b * b),
    jitterMs: residualSd * 1e3,
    count: idx.length,
  };
}

/**
 * Offset of the tocks from the midpoint between ticks, in seconds, given a common beat period.
 * @param {BeatSeries} ticks
 * @param {BeatSeries} tocks
 * @param {number} period common beat period in seconds
 * @returns {number}
 */
export function tockOffset(ticks, tocks, period) {
  /** @param {BeatSeries} s */
  const intercept = (s) => {
    /** @type {number[]} */
    const v = [];
    for (let i = 0; i < s.t.length; i++) if (s.ok[i]) v.push(s.t[i] - period * s.n[i]);
    return median(v);
  };
  return intercept(tocks) - intercept(ticks);
}

/**
 * Compare the tick half and the tock half of the template. If the two reference points do not
 * sit on the same feature of the beat, the best-matching shift says by how much.
 * @param {Float32Array[]} template
 * @param {number} c1 tick position in samples
 * @param {number} c2 tock position in samples
 * @param {number} envelopeRate
 * @returns {{shiftSeconds: number, similarity: number}}
 */
export function templateAlignment(template, c1, c2, envelopeRate) {
  const nb = template[0].length;
  const half = Math.floor(0.01 * envelopeRate);
  const maxShift = Math.floor(0.002 * envelopeRate);
  /** @param {Float32Array} t @param {number} i */
  const at = (t, i) => {
    const v = t[((i % nb) + nb) % nb];
    return v > 0 ? v : 0;
  };
  let aa = 0;
  for (const t of template) for (let tau = -half; tau <= half; tau++) aa += at(t, c1 + tau) ** 2;
  /** @type {number[]} */
  const cc = [];
  for (let s = -maxShift; s <= maxShift; s++) {
    let ab = 0;
    let bb = 0;
    for (const t of template) {
      for (let tau = -half; tau <= half; tau++) {
        const a = at(t, c1 + tau);
        const b = at(t, c2 + tau + s);
        ab += a * b;
        bb += b * b;
      }
    }
    cc.push(ab / (Math.sqrt(aa * bb) + 1e-30));
  }
  let k = 0;
  for (let i = 1; i < cc.length; i++) if (cc[i] > cc[k]) k = i;
  const off = k > 0 && k < cc.length - 1 ? parabolicOffset(cc[k - 1], cc[k], cc[k + 1]) : 0;
  return { shiftSeconds: (k - maxShift + off) / envelopeRate, similarity: cc[k] };
}

/**
 * One rate from both beat types together: the tocks are moved onto the tick line, then a
 * single robust line is fitted.
 * @param {BeatSeries} ticks
 * @param {BeatSeries} tocks
 * @param {number} tockShift seconds to subtract from the tock times
 * @param {number} nominalPeriod nominal beat period in seconds
 * @returns {{rate: number, rateSd: number, jitterMs: number, count: number}}
 */
export function jointRate(ticks, tocks, tockShift, nominalPeriod) {
  /** @type {{n: number, t: number}[]} */
  const pts = [];
  for (const i of independentConfident(ticks)) pts.push({ n: ticks.n[i], t: ticks.t[i] });
  for (const i of independentConfident(tocks)) pts.push({ n: tocks.n[i], t: tocks.t[i] - tockShift });
  pts.sort((p, q) => p.n - q.n);
  const n = pts.map((p) => p.n);
  const t = pts.map((p) => p.t);
  const { b, residualSd } = robustLine(n, t);
  const nMean = n.reduce((s, v) => s + v, 0) / n.length;
  const spread = Math.sqrt(n.reduce((s, v) => s + (v - nMean) * (v - nMean), 0));
  return {
    rate: 86400 * (nominalPeriod / b - 1),
    rateSd: (86400 * nominalPeriod * (residualSd / spread)) / (b * b),
    jitterMs: residualSd * 1e3,
    count: pts.length,
  };
}

/**
 * The kind of escapement. 'lever' is the Swiss lever escapement used by most watches;
 * 'coaxial' is Omega's co-axial escapement.
 * @typedef {'lever'|'coaxial'} Escapement
 */

/** Largest uncertainty of the tick-tock offset, in milliseconds, for a beat error to be reported. */
export const MAX_OFFSET_SD_MS = 0.1;
/** Smallest tick-tock template similarity for a beat error to be reported. */
export const MIN_SIMILARITY = 0.35;
/** Largest timestamp scatter of either beat type, in milliseconds, for a beat error to be reported. */
export const MAX_SCATTER_MS = 0.2;
/**
 * A cluster halfway between the tick and the tock counts as a beat when it is at least this
 * share of the weaker of the two, in the units of `clusterStrength`, and at least
 * HALFWAY_OF_BACKGROUND times the template's background.
 */
export const HALFWAY_OF_BEAT = 0.1;
/** See HALFWAY_OF_BEAT. */
export const HALFWAY_OF_BACKGROUND = 100;

/**
 * @typedef {Object} Readings
 * @property {(BeatFit|null)[]} fits rate fit of each beat type
 * @property {number|null} rate seconds per day, positive when gaining
 * @property {number|null} rateSd statistical uncertainty of the rate
 * @property {number|null} jitterMs scatter of the timestamps about the fitted line
 * @property {number|null} beatErrorMs gap between the tick and tock trace lines; null when unreliable
 * @property {number|null} beatOffsetMs signed offset of the tocks from the midpoint between ticks
 * @property {{offsetMs: number, offsetSdMs: number, similarity: number, halfway: boolean}|null} beatErrorDetail
 *   the raw tick-tock comparison, kept even when the beat error is judged unreliable; `halfway`
 *   when a beat lies halfway between the tick and the tock (see `halfwayBeat`)
 */

/**
 * Whether the template holds a beat halfway between its tick and its tock, on both sides. It
 * does when the beat rate given is half the watch's own: given 18,000 vph, a 36,000 vph watch is
 * folded at four of its beats, the tick and the tock found are two of its ticks (or two of its
 * tocks), and its other beats fall halfway between them. Their gap is then not the beat error,
 * though the rate in seconds per day is still right. Between a true tick and tock there is only
 * background. The halfway cluster must stand out both against the beats, so that a template
 * with weak beats does not pass for one with an extra beat, and against the background, so
 * that a noisy template, whose beats barely stand out, does not either.
 * @param {Float32Array[]} template
 * @param {[number, number]} clusters tick and tock positions in samples
 * @param {number} envelopeRate
 * @returns {{ofBeat: number, ofBackground: number, found: boolean}} the weaker halfway cluster
 *   against the weaker beat and against the background (the 90th percentile of the template
 *   more than 15 ms from the beats and the halfway points)
 */
export function halfwayBeat(template, clusters, envelopeRate) {
  const cs = clusterStrength(template, envelopeRate);
  const nb = cs.length;
  const [c1, c2] = clusters;
  const at = (/** @type {number} */ g) => cs[((g % nb) + nb) % nb];
  const halfway = [Math.round((c1 + c2) / 2), Math.round((c1 + c2 + nb) / 2)];
  // The tock is found within 12 ms of half a period from the tick; a halfway beat is looked for
  // as widely.
  const w = Math.floor(0.012 * envelopeRate);
  let weakest = Infinity;
  for (const m of halfway) {
    let best = 0;
    for (let j = -w; j <= w; j++) best = Math.max(best, at(m + j));
    weakest = Math.min(weakest, best);
  }
  const ex = Math.floor(0.015 * envelopeRate);
  /** @type {number[]} */
  const away = [];
  for (let g = 0; g < nb; g++) {
    const far = [c1, c2, ...halfway].every((c) => {
      const d = Math.abs(g - c) % nb;
      return Math.min(d, nb - d) > ex;
    });
    if (far) away.push(cs[g]);
  }
  away.sort((a, b) => a - b);
  const background = away.length ? away[Math.floor(0.9 * (away.length - 1))] : 0;
  const beat = Math.min(cs[c1], cs[c2]);
  const ofBeat = beat > 0 ? weakest / beat : 0;
  const ofBackground = weakest / (background + 1e-30);
  return { ofBeat, ofBackground, found: ofBeat >= HALFWAY_OF_BEAT && ofBackground >= HALFWAY_OF_BACKGROUND };
}

/**
 * The rate from two independent fits, weighted by their uncertainties. When the two disagree by
 * more than those uncertainties allow, the combined uncertainty is widened by the same factor.
 * The scatter is the two fits' pooled scatter.
 * @param {BeatFit} a
 * @param {BeatFit} b
 * @returns {{rate: number, rateSd: number, jitterMs: number}}
 */
export function combineFits(a, b) {
  const wa = 1 / (a.rateSd * a.rateSd);
  const wb = 1 / (b.rateSd * b.rateSd);
  const rate = (a.rate * wa + b.rate * wb) / (wa + wb);
  const disagreement = Math.abs(a.rate - b.rate) / Math.hypot(a.rateSd, b.rateSd);
  const rateSd = Math.max(1, disagreement) / Math.sqrt(wa + wb);
  const jitterMs = Math.sqrt((a.count * a.jitterMs ** 2 + b.count * b.jitterMs ** 2) / (a.count + b.count));
  return { rate, rateSd, jitterMs };
}

/**
 * Stage 8 in one call: rate, beat error and the checks that decide whether a beat error may be
 * shown. The beat error is reported only when both beat types are timed precisely and the tick
 * and tock look alike, so the two timestamps refer to the same event in each beat. Otherwise
 * the rate comes from the better-timed beat type alone; for a watch that runs irregularly, from
 * both (see `irregular`).
 * @param {BeatSeries[]} beats the ticks and the tocks
 * @param {number} nominalPeriod nominal beat period in seconds
 * @param {Float32Array[]} template averaged tick-tock cycle
 * @param {[number, number]} clusters tick and tock positions in the template, in samples
 * @param {number} envelopeRate
 * @param {Escapement} [escapement] with 'coaxial' the rate still uses both beats, but no beat
 *   error is reported: a co-axial escapement's tick and tock are different sounds, so the gap
 *   between them does not measure the beat error
 * @param {number} [referenceGap] seconds by which the gap between the tock and tick timestamps
 *   exceeds the gap that timestamps taken at `clusters` would have. The real-time pipeline
 *   keeps each beat type's reference point across repeat analyses, while `clusters` are the
 *   current template's own
 * @param {boolean} [irregular] true when the watch's beats fall at scattered times. Both beat
 *   types then scatter alike, and when one looks tighter than the other in a reading, that is
 *   chance: choosing it would flatter the watch. So the rate combines the two, its uncertainty
 *   widens when they disagree by more than their uncertainties allow, and the scatter reading
 *   pools them
 * @returns {Readings}
 */
export function summarize(beats, nominalPeriod, template, clusters, envelopeRate, escapement = 'lever', referenceGap = 0, irregular = false) {
  const fits = beats.map((s) => fitSeries(s, nominalPeriod));
  /** @type {Readings} */
  const result = { fits, rate: null, rateSd: null, jitterMs: null, beatErrorMs: null, beatOffsetMs: null, beatErrorDetail: null };
  const [fitTick, fitTock] = fits;
  let both = false;
  if (fitTick && fitTock) {
    // Common period from the two fits, weighted by their uncertainties.
    const w0 = 1 / (fitTick.rateSd * fitTick.rateSd);
    const w1 = 1 / (fitTock.rateSd * fitTock.rateSd);
    const rate = (fitTick.rate * w0 + fitTock.rate * w1) / (w0 + w1);
    const commonPeriod = nominalPeriod / (1 + rate / 86400);
    const raw = tockOffset(beats[0], beats[1], commonPeriod);
    const align = templateAlignment(template, clusters[0], clusters[1], envelopeRate);
    // The beat error is judged between the template's own clusters, where the tick and the
    // tock can be compared.
    const offset = raw - referenceGap + align.shiftSeconds;
    const offsetSdMs = Math.hypot(fitTick.jitterMs / Math.sqrt(fitTick.count), fitTock.jitterMs / Math.sqrt(fitTock.count));
    const halfway = escapement === 'coaxial' ? false : halfwayBeat(template, clusters, envelopeRate).found;
    result.beatErrorDetail = { offsetMs: offset * 1e3, offsetSdMs, similarity: align.similarity, halfway };
    const precise = offsetSdMs <= MAX_OFFSET_SD_MS && Math.max(fitTick.jitterMs, fitTock.jitterMs) <= MAX_SCATTER_MS;
    both = precise && (escapement === 'coaxial' || align.similarity >= MIN_SIMILARITY);
    if (both) {
      const joint = jointRate(beats[0], beats[1], raw, nominalPeriod);
      result.rate = joint.rate;
      result.rateSd = joint.rateSd;
      result.jitterMs = joint.jitterMs;
      // With a beat halfway between them, the tick and the tock are the same kind of beat: the
      // rate stands, but their gap is not the beat error.
      if (escapement !== 'coaxial' && !halfway) {
        result.beatOffsetMs = offset * 1e3;
        result.beatErrorMs = Math.abs(offset) * 1e3;
      }
    }
  }
  if (!both && irregular && fitTick && fitTock) {
    const combined = combineFits(fitTick, fitTock);
    result.rate = combined.rate;
    result.rateSd = combined.rateSd;
    result.jitterMs = combined.jitterMs;
  } else if (!both) {
    const only = fitTick && fitTock ? (fitTick.rateSd <= fitTock.rateSd ? fitTick : fitTock) : fitTick || fitTock;
    if (only) {
      result.rate = only.rate;
      result.rateSd = only.rateSd;
      result.jitterMs = only.jitterMs;
    }
  }
  return result;
}
