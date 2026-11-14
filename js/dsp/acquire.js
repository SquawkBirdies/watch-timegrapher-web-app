// Stage 4 of the pipeline: find the beat rate and the exact beat period by folding the cleaned
// envelopes at trial periods ("epoch folding"). A watch produces a sharp tick and a sharp tock
// half a period apart; noise and mains hum do not.

import { median, std, parabolicOffset } from './mathutil.js';

/**
 * @typedef {Object} Candidate
 * @property {number} bph beat rate in beats per hour
 * @property {number} ppm period error of the best trial, in parts per million
 * @property {number} stat strength of the best trial (first cluster plus second cluster)
 * @property {number} z how far the best trial stands above the other trials
 * @property {number} first strength of the strongest cluster
 * @property {number} second strength of the cluster half a period away
 * @property {number} secondZ how far the second cluster stands above the background
 * @property {number[]} rivals period errors of other trials almost as strong as the best one
 */

/** Standard beat rates, in beats per hour. */
export const STANDARD_RATES = [18000, 19800, 21600, 25200, 28800, 36000];

/**
 * Average consecutive groups of `d` samples of each row.
 * @param {Float32Array[]} rows
 * @param {number} d
 * @returns {Float32Array[]}
 */
export function decimateRows(rows, d) {
  return rows.map((row) => {
    const n = Math.floor(row.length / d);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += row[i * d + j];
      out[i] = s / d;
    }
    return out;
  });
}

/**
 * Phase-bin index of every sample for a fold at `period` samples into `nb` bins.
 * @param {number} n number of samples
 * @param {number} period fold period in samples
 * @param {number} nb number of phase bins
 * @param {Int32Array} idx output, length >= n
 * @param {Float64Array} count output, samples per bin, length nb
 */
export function phaseIndex(n, period, nb, idx, count) {
  count.fill(0);
  const inc = nb / period;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    if (ph >= nb) ph -= nb;
    let b = ph | 0;
    if (b >= nb) b = nb - 1;
    idx[i] = b;
    count[b]++;
    ph += inc;
  }
}

/**
 * Other local maxima of the search that come within 15% of the best one. A sound with several
 * parts can fold almost as sharply at a neighbouring period; the finer search decides.
 * @param {number[]} stats
 * @param {number[]} trials
 * @param {number} k index of the best trial
 * @returns {number[]} period errors of up to three rivals, strongest first
 */
function findRivals(stats, trials, k) {
  /** @type {number[]} */
  const peaks = [];
  for (let i = 1; i < stats.length - 1; i++) {
    if (Math.abs(i - k) > 3 && stats[i] >= 0.85 * stats[k] && stats[i] >= stats[i - 1] && stats[i] >= stats[i + 1]) peaks.push(i);
  }
  peaks.sort((a, b) => stats[b] - stats[a]);
  return peaks.slice(0, 3).map((i) => trials[i]);
}

/**
 * Search the standard beat rates and a range of rate errors for the strongest tick-and-tock
 * pair. Works on envelopes reduced to about 1 kHz, folded into 1 ms phase bins at the two-beat
 * period.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {{candidates?: number[], ppmRange?: number}} [options]
 * @returns {Candidate[]} best trial for each candidate
 */
export function acquire(rows, envelopeRate, options = {}) {
  const { candidates = STANDARD_RATES, ppmRange = 3500 } = options;
  const d = Math.max(1, Math.round(envelopeRate / 1000));
  const coarse = decimateRows(rows, d);
  const fc = envelopeRate / d;
  const n = coarse[0].length;
  const duration = n / fc;
  const sigma = coarse.map((row) => std(row));
  const idx = new Int32Array(n);
  /** @type {Candidate[]} */
  const results = [];
  for (const bph of candidates) {
    const period2 = (2 * 3600) / bph; // seconds for one tick and one tock
    const nb = Math.round(period2 / 1e-3);
    const binSeconds = period2 / nb;
    const step = (1e6 * binSeconds) / duration / 2;
    const count = new Float64Array(nb);
    const sums = new Float64Array(nb);
    const comb = new Float64Array(nb);
    const win3 = new Float64Array(nb);
    const half = nb >> 1;
    const w = Math.round(0.01 / binSeconds);
    const noiseScale = Math.sqrt(n / nb);
    /** @type {number[]} */
    const stats = [];
    /** @type {number[]} */
    const trials = [];
    let top = { stat: -Infinity, first: 0, second: 0, secondZ: 0 };
    for (let ppm = -ppmRange; ppm <= ppmRange + 1e-9; ppm += step) {
      phaseIndex(n, period2 * fc * (1 + ppm * 1e-6), nb, idx, count);
      comb.fill(0);
      for (let r = 0; r < coarse.length; r++) {
        const row = coarse[r];
        sums.fill(0);
        for (let i = 0; i < n; i++) sums[idx[i]] += row[i];
        const scale = noiseScale / sigma[r];
        for (let b = 0; b < nb; b++) {
          const z = (sums[b] / (count[b] || 1)) * scale;
          if (z > 0) comb[b] += z * z;
        }
      }
      // Strongest 3 ms cluster, plus the strongest cluster half a period away from it.
      let best = -Infinity;
      let bestAt = 0;
      for (let b = 0; b < nb; b++) {
        const v = comb[b] + comb[(b + 1) % nb] + comb[(b + 2) % nb];
        win3[b] = v;
        if (v > best) {
          best = v;
          bestAt = b;
        }
      }
      let other = -Infinity;
      for (let j = -w; j <= w; j++) {
        const v = win3[(((bestAt + half + j) % nb) + nb) % nb];
        if (v > other) other = v;
      }
      stats.push(best + other);
      trials.push(ppm);
      if (best + other > top.stat) {
        // Background level of the cluster statistic, to judge whether the second cluster is real.
        const bg = median(win3);
        const bgSd = 1.4826 * median(Array.from(win3, (v) => Math.abs(v - bg))) + 1e-12;
        top = { stat: best + other, first: best, second: other, secondZ: (other - bg) / bgSd };
      }
    }
    let k = 0;
    for (let i = 1; i < stats.length; i++) if (stats[i] > stats[k]) k = i;
    const med = median(stats);
    const mad = 1.4826 * median(stats.map((s) => Math.abs(s - med))) + 1e-12;
    results.push({ bph, ppm: trials[k], stat: stats[k], z: (stats[k] - med) / mad, first: top.first, second: top.second, secondZ: top.secondZ, rivals: findRivals(stats, trials, k) });
  }
  return results;
}

/**
 * Pick the beat rate from the candidates. The strongest wins, with one exception: a watch
 * whose ticks and tocks are evenly spaced looks the same when folded at twice its true rate,
 * except that the second cluster is then missing. If the winner has no clear second cluster and
 * a candidate at half its rate exists, the slower rate is chosen.
 * @param {Candidate[]} candidates
 * @returns {Candidate}
 */
export function chooseCandidate(candidates) {
  let best = candidates[0];
  for (const c of candidates) if (c.stat > best.stat) best = c;
  if (best.secondZ < 5) {
    const slower = candidates.find((c) => c.bph * 2 === best.bph);
    if (slower) return slower;
  }
  return best;
}

/**
 * Refine the period around a coarse estimate, using the full-rate envelopes and finer bins.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {number} period2 nominal two-beat period in seconds
 * @param {number} ppm0 coarse estimate of the period error in parts per million
 * @param {{span?: number, binSeconds?: number}} [options]
 * @returns {{ppm: number, stat: number}} refined period error in parts per million, and how sharp the fold is there
 */
export function refinePeriod(rows, envelopeRate, period2, ppm0, options = {}) {
  const { span = 30, binSeconds = 1 / 6000 } = options;
  const n = rows[0].length;
  const nb = Math.round(period2 / binSeconds);
  const duration = n / envelopeRate;
  const step = (1e6 * binSeconds) / duration / 3;
  const sigma = rows.map((row) => std(row));
  const idx = new Int32Array(n);
  const count = new Float64Array(nb);
  const sums = new Float64Array(nb);
  const noiseScale = Math.sqrt(n / nb);
  /** @type {number[]} */
  const stats = [];
  /** @type {number[]} */
  const trials = [];
  for (let ppm = ppm0 - span; ppm <= ppm0 + span + 1e-9; ppm += step) {
    phaseIndex(n, period2 * envelopeRate * (1 + ppm * 1e-6), nb, idx, count);
    let stat = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      sums.fill(0);
      for (let i = 0; i < n; i++) sums[idx[i]] += row[i];
      const scale = noiseScale / sigma[r];
      for (let b = 0; b < nb; b++) {
        const z = (sums[b] / (count[b] || 1)) * scale;
        if (z > 0) stat += z * z;
      }
    }
    stats.push(stat);
    trials.push(ppm);
  }
  let k = 0;
  for (let i = 1; i < stats.length; i++) if (stats[i] > stats[k]) k = i;
  const offset = k > 0 && k < stats.length - 1 ? parabolicOffset(stats[k - 1], stats[k], stats[k + 1]) : 0;
  return { ppm: trials[k] + offset * step, stat: stats[k] };
}

/**
 * The same search as `acquire`, several times faster on long windows. The window is cut into
 * segments of a few seconds. Each segment is folded once per group of neighbouring trial
 * periods; the trials inside a group then only shift and add the segment profiles.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {{candidates?: number[], ppmRange?: number}} [options]
 * @returns {Candidate[]} best trial for each candidate
 */
export function acquireFast(rows, envelopeRate, options = {}) {
  const { candidates = STANDARD_RATES, ppmRange = 3500 } = options;
  const d = Math.max(1, Math.round(envelopeRate / 1000));
  const coarse = decimateRows(rows, d);
  const fc = envelopeRate / d;
  const n = coarse[0].length;
  const duration = n / fc;
  const sigma = coarse.map((row) => std(row));
  const idx = new Int32Array(n);
  const segLength = Math.round((duration >= 20 ? 4 : 2) * fc);
  const nSeg = Math.ceil(n / segLength);
  const R = coarse.length;
  /** @type {Candidate[]} */
  const results = [];
  for (const bph of candidates) {
    const period2 = (2 * 3600) / bph;
    const nb = Math.round(period2 / 1e-3);
    const binSeconds = period2 / nb;
    const step = (1e6 * binSeconds) / duration / 2;
    // Within a group, a trial may slip by at most a quarter of a bin across half a segment.
    const groupWidth = (1e6 * binSeconds) / (segLength / fc);
    const perGroup = Math.max(1, Math.floor(groupWidth / step));
    const count = new Float64Array(nb);
    const sums = new Float64Array(nb);
    const comb = new Float64Array(nb);
    const win3 = new Float64Array(nb);
    const profiles = new Float32Array(nSeg * R * nb);
    const half = nb >> 1;
    const w = Math.round(0.01 / binSeconds);
    const norm = Math.sqrt(n / nb);
    /** @type {number[]} */
    const stats = [];
    /** @type {number[]} */
    const trials = [];
    let top = { stat: -Infinity, first: 0, second: 0, secondZ: 0 };
    const nTrials = Math.floor((2 * ppmRange) / step + 1e-9) + 1;
    for (let g0 = 0; g0 < nTrials; g0 += perGroup) {
      const g1 = Math.min(nTrials, g0 + perGroup);
      const centrePpm = -ppmRange + step * (g0 + g1 - 1) / 2;
      const centrePeriod = period2 * fc * (1 + centrePpm * 1e-6);
      phaseIndex(n, centrePeriod, nb, idx, count);
      profiles.fill(0);
      for (let r = 0; r < R; r++) {
        const row = coarse[r];
        for (let s = 0; s < nSeg; s++) {
          const base = (s * R + r) * nb;
          const end = Math.min(n, (s + 1) * segLength);
          for (let i = s * segLength; i < end; i++) profiles[base + idx[i]] += row[i];
        }
      }
      for (let t = g0; t < g1; t++) {
        const ppm = -ppmRange + step * t;
        // A longer trial period makes later samples fall in earlier bins than at the group centre.
        const slipPerSample = ((ppm - centrePpm) * 1e-6 * nb) / centrePeriod;
        comb.fill(0);
        for (let r = 0; r < R; r++) {
          sums.fill(0);
          for (let s = 0; s < nSeg; s++) {
            const mid = Math.min(n, (s + 0.5) * segLength);
            let k = Math.round(slipPerSample * mid) % nb;
            if (k < 0) k += nb;
            const base = (s * R + r) * nb;
            for (let b = 0; b < nb - k; b++) sums[b] += profiles[base + b + k];
            for (let b = nb - k; b < nb; b++) sums[b] += profiles[base + b + k - nb];
          }
          const scale = 1 / (sigma[r] * norm);
          for (let b = 0; b < nb; b++) {
            const z = sums[b] * scale;
            if (z > 0) comb[b] += z * z;
          }
        }
        let best = -Infinity;
        let bestAt = 0;
        for (let b = 0; b < nb; b++) {
          const v = comb[b] + comb[(b + 1) % nb] + comb[(b + 2) % nb];
          win3[b] = v;
          if (v > best) {
            best = v;
            bestAt = b;
          }
        }
        let other = -Infinity;
        for (let j = -w; j <= w; j++) {
          const v = win3[(((bestAt + half + j) % nb) + nb) % nb];
          if (v > other) other = v;
        }
        stats.push(best + other);
        trials.push(ppm);
        if (best + other > top.stat) {
          const bg = median(win3);
          const bgSd = 1.4826 * median(Array.from(win3, (v) => Math.abs(v - bg))) + 1e-12;
          top = { stat: best + other, first: best, second: other, secondZ: (other - bg) / bgSd };
        }
      }
    }
    let k = 0;
    for (let i = 1; i < stats.length; i++) if (stats[i] > stats[k]) k = i;
    const med = median(stats);
    const mad = 1.4826 * median(stats.map((s) => Math.abs(s - med))) + 1e-12;
    results.push({ bph, ppm: trials[k], stat: stats[k], z: (stats[k] - med) / mad, first: top.first, second: top.second, secondZ: top.secondZ, rivals: findRivals(stats, trials, k) });
  }
  return results;
}
