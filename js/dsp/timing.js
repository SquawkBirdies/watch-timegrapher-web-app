// Stages 6 and 7 of the pipeline: time each beat with a matched filter, averaging several
// consecutive cycles first when single beats are too faint.

import { percentile, mean, std, median, parabolicOffset } from './mathutil.js';

/** Numbers of cycles tried for averaging, smallest first. */
export const AVERAGING_STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

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
  const { dataOffset = 0, preMs = 8, postMs = 12, lagMs = 4 } = options;
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
 * Time the beats of one type (tick or tock), choosing the smallest amount of averaging that
 * makes at least `target` of the estimates stand above the noise.
 * @param {Float32Array[]} rows
 * @param {number} envelopeRate
 * @param {number} period
 * @param {[Float32Array[], Float32Array[]]} templates even-cycle and odd-cycle templates
 * @param {number} centre
 * @param {{target?: number, steps?: number[]}} [options]
 * @returns {BeatTrack}
 */
export function trackBeats(rows, envelopeRate, period, templates, centre, options = {}) {
  const { target = 0.85, steps = AVERAGING_STEPS } = options;
  const signal = matchedFilter(rows, envelopeRate, period, templates, centre);
  const noise = matchedFilter(rows, envelopeRate, period, templates, centre, { dataOffset: period / 4 });
  /** @type {BeatTrack | null} */
  let track = null;
  for (const K of steps) {
    if (signal.corr.length < K + 2) break;
    const s = pickPeaks(averageCycles(signal.corr, K), signal.lags);
    const nz = pickPeaks(averageCycles(noise.corr, K), noise.lags);
    const threshold = percentile(nz.value, 99);
    const nMean = mean(nz.value);
    const nSd = std(nz.value) + 1e-12;
    let above = 0;
    const z = new Float64Array(s.value.length);
    for (let i = 0; i < s.value.length; i++) {
      if (s.value[i] > threshold) above++;
      z[i] = (s.value[i] - nMean) / nSd;
    }
    track = { K, lag: s.lag, value: s.value, threshold, noiseMean: nMean, noiseSd: nSd, z, confidentFraction: above / s.value.length };
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
