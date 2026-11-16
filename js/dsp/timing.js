// Stages 6 and 7 of the pipeline: time each beat with a matched filter, averaging several
// consecutive cycles first when single beats are too faint.
//
// A beat made of several sounds gives a correlation curve with several peaks. When the beat is
// faint, the highest of them is not always the same one, and the timestamp jumps by the
// distance between two sounds. So a peak close to where the beat is expected is preferred to a
// higher one elsewhere, as long as it stands above the noise and is not much lower. This only
// chooses among the positions one beat could have; it never mixes beats together.

import { percentile, mean, std, median, parabolicOffset } from './mathutil.js';

/** Numbers of cycles tried for averaging, smallest first. */
export const AVERAGING_STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** How far either side of the expected position a beat is looked for, in milliseconds. */
export const LAG_MS = 4;
/** How close to the expected position a peak must be to be preferred, in milliseconds. */
export const NEAR_MS = 1;
/** A peak near the expected position is preferred if it is at least this share of the highest. */
export const NEAR_FRACTION = 0.6;

/**
 * Matched-filter weights for one cluster: the positive part of the template around the cluster,
 * zero mean per row, scaled to unit energy overall.
 * @param {Float32Array[]} template one cycle per row
 * @param {number} centre cluster position in the template, in samples
 * @param {number} pre samples before the cluster
 * @param {number} nTau filter length in samples
 * @returns {Float64Array[]} one weight vector per row
 */
export function buildWeights(template, centre, pre, nTau) {
  const nb = template[0].length;
  /** @type {Float64Array[]} */
  const weights = [];
  let energy = 0;
  for (const t of template) {
    const g = new Float64Array(nTau);
    let m = 0;
    for (let i = 0; i < nTau; i++) {
      const v = t[(((centre - pre + i) % nb) + nb) % nb];
      g[i] = v > 0 ? v : 0;
      m += g[i];
    }
    m /= nTau;
    for (let i = 0; i < nTau; i++) {
      g[i] -= m;
      energy += g[i] * g[i];
    }
    weights.push(g);
  }
  const norm = 1 / Math.sqrt(energy || 1);
  for (const g of weights) for (let i = 0; i < nTau; i++) g[i] *= norm;
  return weights;
}

/**
 * Correlate the data starting at `start` (which may fall between samples) with the weights,
 * for `nLag` consecutive lags, and add the result to `acc`.
 * @param {Float32Array[]} rows
 * @param {number} start position of lag 0, in samples
 * @param {Float64Array[]} weights
 * @param {number} nLag
 * @param {Float64Array} acc output, length nLag
 * @param {Float64Array} seg scratch, length weights[0].length + nLag - 1
 */
export function correlateAt(rows, start, weights, nLag, acc, seg) {
  const nTau = weights[0].length;
  const segLen = nTau + nLag - 1;
  const i0 = Math.floor(start);
  const frac = start - i0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const g = weights[r];
    for (let i = 0; i < segLen; i++) seg[i] = row[i0 + i] * (1 - frac) + row[i0 + i + 1] * frac;
    for (let L = 0; L < nLag; L++) {
      let sum = 0;
      for (let i = 0; i < nTau; i++) sum += seg[L + i] * g[i];
      acc[L] += sum;
    }
  }
}

/**
 * Peak of one correlation curve, interpolated between lags.
 * @param {Float64Array} c
 * @param {Int32Array} lags
 * @returns {{lag: number, value: number}}
 */
export function pickPeak(c, lags) {
  let best = 0;
  for (let L = 1; L < c.length; L++) if (c[L] > c[best]) best = L;
  return { lag: lags[best] + (best > 0 && best < c.length - 1 ? parabolicOffset(c[best - 1], c[best], c[best + 1]) : 0), value: c[best] };
}

/**
 * Peak of one correlation curve, preferring a peak near the expected lag to a higher one
 * elsewhere. The nearer peak is taken when it stands above the noise threshold and reaches
 * `NEAR_FRACTION` of the highest; a beat that truly arrived elsewhere leaves only noise, or a
 * weak side peak, at the expected lag, and keeps its highest peak.
 * @param {Float64Array} c
 * @param {Int32Array} lags
 * @param {number} expected lag at which the beat is expected
 * @param {number} halfWidth how far from it a peak may lie, in lags
 * @param {number} threshold noise threshold of the peak height
 * @returns {{lag: number, value: number}}
 */
export function pickPeakNear(c, lags, expected, halfWidth, threshold) {
  const top = pickPeak(c, lags);
  if (Math.abs(top.lag - expected) <= halfWidth) return top;
  const centre = Math.round(expected) - lags[0];
  let best = -1;
  for (let L = Math.max(1, centre - halfWidth); L <= Math.min(c.length - 2, centre + halfWidth); L++) {
    if (c[L] >= c[L - 1] && c[L] >= c[L + 1] && (best < 0 || c[L] > c[best])) best = L;
  }
  if (best < 0 || c[best] <= threshold || c[best] < NEAR_FRACTION * top.value) return top;
  return { lag: lags[best] + parabolicOffset(c[best - 1], c[best], c[best + 1]), value: c[best] };
}

/**
 * Running median over the values available on each side, without padding at the ends.
 * @param {Float64Array} values
 * @param {number} width window length, odd
 * @returns {Float64Array}
 */
export function runningMedian(values, width) {
  const half = width >> 1;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = median(values.subarray(Math.max(0, i - half), Math.min(values.length, i + half + 1)));
  return out;
}

/**
 * Correlate every cycle with the template around one cluster, over a range of time lags.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {number} period two-beat period in envelope samples
 * @param {[Float32Array[], Float32Array[]]} templates templates built from the even-numbered
 *   and from the odd-numbered cycles; each cycle is matched against the one it is not part of
 * @param {number} centre cluster position in the template, in samples
 * @param {{dataOffset?: number, preMs?: number, postMs?: number, lagMs?: number}} [options]
 *   dataOffset moves the data window away from the beat, to measure noise with the same filter
 * @returns {{corr: Float64Array[], lags: Int32Array}} one correlation curve per cycle
 */
export function matchedFilter(rows, envelopeRate, period, templates, centre, options = {}) {
  const { dataOffset = 0, preMs = 8, postMs = 12, lagMs = LAG_MS } = options;
  const n = rows[0].length;
  const nb = templates[0][0].length;
  const pre = Math.floor(preMs * 1e-3 * envelopeRate);
  const post = Math.floor(postMs * 1e-3 * envelopeRate);
  const maxLag = Math.floor(lagMs * 1e-3 * envelopeRate);
  const nTau = pre + post + 1;
  const nLag = 2 * maxLag + 1;
  const segLen = nTau + 2 * maxLag;
  const lags = new Int32Array(nLag);
  for (let i = 0; i < nLag; i++) lags[i] = i - maxLag;

  const weightSets = templates.map((template) => buildWeights(template, centre, pre, nTau));

  const ncyc = Math.max(0, Math.floor((n - nb - 2 * segLen) / period));
  const seg = new Float64Array(segLen);
  /** @type {Float64Array[]} */
  const corr = [];
  for (let k = 0; k < ncyc; k++) {
    const acc = new Float64Array(nLag);
    const start = k * period + centre + dataOffset - pre - maxLag;
    if (start >= 0 && Math.floor(start) + segLen + 1 < n) {
      // Even cycles use the template built from odd cycles, and the reverse.
      const weights = weightSets[1 - (k % 2)];
      correlateAt(rows, start, weights, nLag, acc, seg);
    }
    corr.push(acc);
  }
  return { corr, lags };
}

/**
 * Average the correlation curves of K consecutive cycles.
 * @param {Float64Array[]} corr
 * @param {number} K
 * @returns {Float64Array[]} corr.length - K + 1 averaged curves
 */
export function averageCycles(corr, K) {
  if (K <= 1) return corr;
  const nLag = corr.length ? corr[0].length : 0;
  /** @type {Float64Array[]} */
  const out = [];
  const sum = new Float64Array(nLag);
  for (let k = 0; k < corr.length; k++) {
    for (let L = 0; L < nLag; L++) sum[L] += corr[k][L];
    if (k >= K) for (let L = 0; L < nLag; L++) sum[L] -= corr[k - K][L];
    if (k >= K - 1) {
      const avg = new Float64Array(nLag);
      for (let L = 0; L < nLag; L++) avg[L] = sum[L] / K;
      out.push(avg);
    }
  }
  return out;
}

/**
 * Peak of each correlation curve, interpolated between lags.
 * @param {Float64Array[]} corr
 * @param {Int32Array} lags
 * @returns {{lag: Float64Array, value: Float64Array}}
 */
export function pickPeaks(corr, lags) {
  const lag = new Float64Array(corr.length);
  const value = new Float64Array(corr.length);
  for (let k = 0; k < corr.length; k++) {
    const c = corr[k];
    let best = 0;
    for (let L = 1; L < c.length; L++) if (c[L] > c[best]) best = L;
    value[k] = c[best];
    lag[k] = lags[best] + (best > 0 && best < c.length - 1 ? parabolicOffset(c[best - 1], c[best], c[best + 1]) : 0);
  }
  return { lag, value };
}

/**
 * @typedef {Object} BeatTrack
 * @property {number} K cycles averaged per estimate
 * @property {Float64Array} lag estimated lag of each (averaged) cycle, in envelope samples
 * @property {Float64Array} value correlation peak height
 * @property {number} threshold 99th percentile of the off-beat (noise) peaks
 * @property {number} noiseMean mean of the off-beat peaks
 * @property {number} noiseSd standard deviation of the off-beat peaks
 * @property {Float64Array} z peak height in noise standard deviations above the noise mean
 * @property {number} confidentFraction share of estimates above the threshold
 */

/**
 * Switch for the peak preference, for tests and comparisons.
 * @typedef {Object} TimingOptions
 * @property {boolean} [preferNear] false always takes the highest peak of a correlation curve
 * @property {boolean} [followScatter] false keeps averaging and the folded template even when
 *   single beats are scattered (see irregular.js)
 */

/**
 * Time the beats of one type (tick or tock), choosing the smallest amount of averaging that
 * makes at least `target` of the estimates stand above the noise.
 * @param {Float32Array[]} rows
 * @param {number} envelopeRate
 * @param {number} period
 * @param {[Float32Array[], Float32Array[]]} templates even-cycle and odd-cycle templates
 * @param {number} centre
 * @param {{target?: number, steps?: number[], lagMs?: number} & TimingOptions} [options]
 *   `lagMs` is how far either side of its expected position a beat is looked for
 * @returns {BeatTrack}
 */
export function trackBeats(rows, envelopeRate, period, templates, centre, options = {}) {
  const { target = 0.85, steps = AVERAGING_STEPS, preferNear = true, lagMs = LAG_MS } = options;
  const signal = matchedFilter(rows, envelopeRate, period, templates, centre, { lagMs });
  const noise = matchedFilter(rows, envelopeRate, period, templates, centre, { lagMs, dataOffset: period / 4 });
  const ms = 1000 / envelopeRate;
  const near = Math.round(NEAR_MS / ms);

  /**
   * @param {number} K
   * @returns {BeatTrack}
   */
  const timeWith = (K) => {
    const curves = averageCycles(signal.corr, K);
    const s = pickPeaks(curves, signal.lags);
    const nz = pickPeaks(averageCycles(noise.corr, K), noise.lags);
    const threshold = percentile(nz.value, 99);
    const nMean = mean(nz.value);
    const nSd = std(nz.value) + 1e-12;
    // Where each beat is expected: the trend of the highest peaks, over about eight
    // independent estimates either way.
    const trend = runningMedian(s.lag, Math.max(21, 8 * K + 1));
    if (preferNear) {
      for (let i = 0; i < curves.length; i++) {
        if (Math.abs(s.lag[i] - trend[i]) <= near) continue;
        const peak = pickPeakNear(curves[i], signal.lags, trend[i], near, threshold);
        s.lag[i] = peak.lag;
        s.value[i] = peak.value;
      }
    }
    let above = 0;
    const z = new Float64Array(s.value.length);
    for (let i = 0; i < s.value.length; i++) {
      z[i] = (s.value[i] - nMean) / nSd;
      if (s.value[i] > threshold) above++;
    }
    return { K, lag: s.lag, value: s.value, threshold, noiseMean: nMean, noiseSd: nSd, z, confidentFraction: above / s.value.length };
  };

  /** @type {BeatTrack | null} */
  let track = null;
  for (const K of steps) {
    if (signal.corr.length < K + 2) break;
    track = timeWith(K);
    if (track.confidentFraction >= target) break;
  }
  if (!track) {
    track = { K: 1, lag: new Float64Array(0), value: new Float64Array(0), threshold: Infinity, noiseMean: 0, noiseSd: 1, z: new Float64Array(0), confidentFraction: 0 };
  }
  return track;
}

/**
 * Median of the z values of a track (0 for an empty track).
 * @param {BeatTrack} track
 * @returns {number}
 */
export function medianZ(track) {
  return track.z.length ? median(track.z) : 0;
}

/**
 * How far the beats that can be timed one at a time fall from their own trend. A watch that
 * runs regularly keeps them within about 0.1 ms.
 * @param {BeatTrack} track a track of single cycles (K = 1)
 * @param {number} envelopeRate
 * @returns {{count: number, fraction: number, ms: number}} the number of confident beats, their
 *   share of all beats, and their robust scatter in milliseconds (NaN with fewer than eight)
 */
export function singleBeatScatter(track, envelopeRate) {
  /** @type {number[]} */
  const own = [];
  for (let i = 0; i < track.lag.length; i++) if (track.value[i] > track.threshold) own.push(track.lag[i]);
  const fraction = track.lag.length ? own.length / track.lag.length : 0;
  if (own.length < 8) return { count: own.length, fraction, ms: NaN };
  const lags = Float64Array.from(own);
  const trend = runningMedian(lags, 21);
  const away = Array.from(lags, (v, i) => Math.abs(v - trend[i]));
  return { count: own.length, fraction, ms: (1.4826 * median(away) * 1000) / envelopeRate };
}
