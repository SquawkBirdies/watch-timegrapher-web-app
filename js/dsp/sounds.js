// Stage 10 of the pipeline, first half: the sounds inside a beat. The timestamps of stage 7 mark
// each beat's loudest part. Here the envelope around every timestamp of a beat type is averaged
// into one beat, and the separate sounds in it are found: for a Swiss lever the unlock, the
// impulse and the drop. js/dsp/amplitude.js pairs them between the tick and the tock.
//
// A port of tools/prototype/coaxial/events.py (`stack`, `band_means`, `energy_weights`,
// `portrait`, `find_sounds`), whose README gives the evidence for each choice.

import { median, robustSd } from './mathutil.js';

/** Lowest band, in hertz, whose envelope is read. Below it the sounds are too blurred to part. */
export const SOUND_BANDS_FROM_HZ = 5000;
/** How long before its timestamp a beat's stretch starts, in seconds. */
export const STRETCH_BEFORE_S = 0.040;
/** How long after its timestamp a beat's stretch ends, in seconds. */
export const STRETCH_AFTER_S = 0.012;
/** Share of the beats left out at each end, at each instant, when the beats are averaged. */
export const TRIM = 0.05;
/** How long the averaged beat is smoothed over before its sounds are found, in milliseconds. */
export const SMOOTH_MS = 0.25;
/** A sound stands at least this many decibels above the valley beside it. */
export const MIN_PROMINENCE_DB = 2.5;
/** Two sounds are at least this far apart, in milliseconds. */
export const MIN_SPACING_MS = 0.3;
/** A sound stands at least this many times the quiet stretch's scatter above zero. */
export const MIN_OVER_NOISE = 5;
/** A sound stands at least this many times the quiet stretch's highest point. */
export const QUIET_GUARD = 1.5;
/** How far up its rising edge a sound is taken to start, as a share of the rise in energy. */
export const RISE = 0.5;

/**
 * Every beat's stretch of envelope, band by band.
 * @typedef {Object} BeatStack
 * @property {Float32Array[]} bands one array per band: the beats' stretches, one after another
 * @property {number} count beats held
 * @property {number} length samples in a stretch
 * @property {number} before samples of a stretch that lie before the beat's timestamp
 * @property {Int32Array} kept which of the positions given each beat came from
 */

/**
 * One sound of an averaged beat.
 * @typedef {Object} Sound
 * @property {number} index sample of the averaged beat at which the sound is loudest
 * @property {number} peakMs when it is loudest, in milliseconds from the beat's timestamp
 * @property {number} onsetMs when it starts: where its rising edge is half way, in energy
 * @property {number} level its loudest level in the smoothed averaged beat
 * @property {number} levelDb that level over the quiet stretch's scatter, in decibels
 */

/**
 * The envelope rows the sounds are read from, out of a filter bank's output: the first
 * channel's bands from SOUND_BANDS_FROM_HZ up. The first channel is the one the prototype was
 * checked on; Safari delivers the iPhone's microphone there.
 * @param {import('./filterbank.js').FilterBank} bank
 * @param {Float32Array[]} rows the bank's output, before Cleanup
 * @returns {Float32Array[]}
 */
export function soundRows(bank, rows) {
  return rows.filter((_, i) => bank.rows[i].channel === 0 && bank.bands[bank.rows[i].band][0] >= SOUND_BANDS_FROM_HZ);
}

/**
 * Cut every beat's stretch out of the envelope rows, read at the timestamp's fraction of a
 * sample by linear interpolation. A beat whose stretch does not lie wholly inside the rows is
 * left out.
 * @param {Float32Array[]} rows one envelope per band, all the same length
 * @param {ArrayLike<number>} positions each beat's timestamp as a position in the rows, in
 *   samples and fractions of one
 * @param {number} before samples to keep before each timestamp
 * @param {number} after samples to keep after it
 * @returns {BeatStack}
 */
export function stackBeats(rows, positions, before, after) {
  const length = before + after + 1;
  const total = rows.length ? rows[0].length : 0;
  /** @type {number[]} */
  const kept = [];
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] - before >= 0 && positions[i] + after < total - 1) kept.push(i);
  }
  const bands = rows.map((row) => {
    const out = new Float32Array(kept.length * length);
    for (let b = 0; b < kept.length; b++) {
      const pos = positions[kept[b]];
      const whole = Math.floor(pos);
      const frac = pos - whole;
      const from = whole - before;
      for (let k = 0; k < length; k++) out[b * length + k] = row[from + k] * (1 - frac) + row[from + k + 1] * frac;
    }
    return out;
  });
  return { bands, count: kept.length, length, before, kept: Int32Array.from(kept) };
}

/**
 * Time of each sample of a stretch, in milliseconds from the beat's timestamp.
 * @param {number} before samples before the timestamp
 * @param {number} length samples in the stretch
 * @param {number} envelopeRate envelope sample rate in hertz
 * @returns {Float64Array}
 */
export function stretchMs(before, length, envelopeRate) {
  const ms = new Float64Array(length);
  for (let k = 0; k < length; k++) ms[k] = ((k - before) / envelopeRate) * 1e3;
  return ms;
}

/**
 * Number of leading samples of a stretch that lie before `untilMs`.
 * @param {Float64Array} ms from `stretchMs`
 * @param {number} untilMs
 * @returns {number}
 */
export function samplesBefore(ms, untilMs) {
  let n = 0;
  while (n < ms.length && ms[n] < untilMs) n++;
  return n;
}

/**
 * The averaged beat of each band: at each instant the mean over the beats with the highest and
 * lowest TRIM of them left out, as an excess over the band's level in the quiet stretch before
 * the beat. A plain mean let one click in a single beat dominate the average; with the ends
 * left out it does not show.
 * @param {BeatStack} stack
 * @param {number} quiet samples at the start of the stretch that lie before any of the beat's sounds
 * @param {ArrayLike<number>} [draw] the beats to average, by their place in the stack; all when absent
 * @returns {{excess: Float64Array[], levels: Float64Array}} each band's averaged beat, divided
 *   by its quiet level and less 1, and those quiet levels
 */
export function bandMeans(stack, quiet, draw) {
  const { length } = stack;
  const n = draw ? draw.length : stack.count;
  const cut = Math.floor(TRIM * n);
  const column = new Float64Array(n);
  const levels = new Float64Array(stack.bands.length);
  /** @type {Float64Array[]} */
  const excess = [];
  for (let b = 0; b < stack.bands.length; b++) {
    const band = stack.bands[b];
    const m = new Float64Array(length);
    for (let k = 0; k < length; k++) {
      for (let i = 0; i < n; i++) column[i] = band[(draw ? draw[i] : i) * length + k];
      column.sort();
      let sum = 0;
      for (let i = cut; i < n - cut; i++) sum += column[i];
      m[k] = sum / (n - 2 * cut);
    }
    const level = median(m.subarray(0, quiet));
    levels[b] = level;
    for (let k = 0; k < length; k++) m[k] = m[k] / level - 1;
    excess.push(m);
  }
  return { excess, levels };
}

/**
 * One set of band weights for both beat types: each band by its own quiet level, averaged over
 * the two types. The averaged beat is then the sounds' excess energy summed over the bands, in
 * units of the summed quiet level, as one filter over the whole range would hear it. Weighting
 * each band by how far its beats stand over its own noise is more precise, but lets the noise
 * choose the mixture: a watch's sounds do not start at one moment in every band, and noise
 * unlike the recording's own background moved the ETA 2836-2's beat error by up to 0.18 ms.
 *
 * The prototype divides each band by its median over the recording first and multiplies that
 * back here; the two cancel, so this port leaves the envelopes as they are.
 * @param {Float64Array} tickLevels each band's quiet level in the ticks
 * @param {Float64Array} tockLevels and in the tocks
 * @returns {Float64Array} weights that sum to 1
 */
export function energyWeights(tickLevels, tockLevels) {
  const w = new Float64Array(tickLevels.length);
  let sum = 0;
  for (let b = 0; b < w.length; b++) {
    w[b] = 0.5 * (tickLevels[b] + tockLevels[b]);
    sum += w[b];
  }
  for (let b = 0; b < w.length; b++) w[b] /= sum;
  return w;
}

/**
 * The bands' averaged beats added into one with their weights.
 * @param {Float64Array[]} excess from `bandMeans`
 * @param {Float64Array} weights from `energyWeights`
 * @returns {Float64Array}
 */
export function mixBands(excess, weights) {
  const out = new Float64Array(excess[0].length);
  for (let b = 0; b < excess.length; b++) {
    const e = excess[b];
    const w = weights[b];
    for (let k = 0; k < out.length; k++) out[k] += w * e[k];
  }
  return out;
}

/**
 * Smooth with a raised-cosine window of k samples (a Hann window without its zero ends), the
 * curve taken as zero beyond its ends.
 * @param {Float64Array} curve
 * @param {number} k
 * @returns {Float64Array}
 */
export function smooth(curve, k) {
  if (k <= 1) return Float64Array.from(curve);
  const w = new Float64Array(k);
  let sum = 0;
  for (let i = 0; i < k; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (k + 1));
    sum += w[i];
  }
  const n = curve.length;
  const centre = (k - 1) >> 1;
  const out = new Float64Array(n);
  for (let m = 0; m < n; m++) {
    let v = 0;
    for (let i = 0; i < k; i++) {
      const at = m + centre - i;
      if (at >= 0 && at < n) v += w[i] * curve[at];
    }
    out[m] = v / sum;
  }
  return out;
}

/**
 * The peaks of a curve: its local maxima that stand at least `prominence` above the higher of
 * the lowest points between them and the nearest higher ground on either side, the lower of two
 * closer than `distance` samples left out first. A flat top counts once, at its middle. As
 * SciPy's find_peaks with `prominence` and `distance`.
 * @param {ArrayLike<number>} x
 * @param {number} prominence
 * @param {number} distance fewest samples between two peaks
 * @returns {number[]} positions, in rising order
 */
export function findPeaks(x, prominence, distance) {
  /** @type {number[]} */
  const maxima = [];
  const last = x.length - 1;
  for (let i = 1; i < last; i++) {
    if (!(x[i - 1] < x[i])) continue;
    let ahead = i + 1;
    while (ahead < last && x[ahead] === x[i]) ahead++;
    if (x[ahead] < x[i]) {
      maxima.push((i + ahead - 1) >> 1);
      i = ahead;
    }
  }

  // The highest peak first: each one kept removes its neighbours closer than `distance`.
  const keep = new Uint8Array(maxima.length).fill(1);
  const byHeight = maxima.map((_, j) => j).sort((a, b) => x[maxima[a]] - x[maxima[b]] || a - b);
  for (let i = byHeight.length - 1; i >= 0; i--) {
    const j = byHeight[i];
    if (!keep[j]) continue;
    for (let k = j - 1; k >= 0 && maxima[j] - maxima[k] < distance; k--) keep[k] = 0;
    for (let k = j + 1; k < maxima.length && maxima[k] - maxima[j] < distance; k++) keep[k] = 0;
  }

  /** @type {number[]} */
  const peaks = [];
  for (let j = 0; j < maxima.length; j++) {
    if (!keep[j]) continue;
    const p = maxima[j];
    let left = x[p];
    for (let i = p; i >= 0 && x[i] <= x[p]; i--) if (x[i] < left) left = x[i];
    let right = x[p];
    for (let i = p; i <= last && x[i] <= x[p]; i++) if (x[i] < right) right = x[i];
    if (x[p] - Math.max(left, right) >= prominence) peaks.push(p);
  }
  return peaks;
}

/**
 * The sounds in an averaged beat. Each is a peak of the smoothed curve that stands above the
 * valley before it and above anything the quiet stretch before the beat shows. A sound starts
 * where its rising edge is half way, in energy, from that valley to its loudest point; the
 * first sound's rise is measured from zero.
 * @param {Float64Array} curve the averaged beat, from `mixBands`
 * @param {Float64Array} ms time of each sample, from `stretchMs`
 * @param {number} quiet samples at the start that lie before any of the beat's sounds
 * @returns {{sounds: Sound[], noise: number}} the sounds in order of time, and the quiet
 *   stretch's scatter
 */
export function findSounds(curve, ms, quiet) {
  const dt = ms[1] - ms[0];
  const s = smooth(curve, Math.max(1, Math.round(SMOOTH_MS / dt)));
  const still = s.subarray(0, quiet);
  const noise = robustSd(still);
  // A stretch with no noise at all is not a recording of anything.
  if (!(noise > 0)) return { sounds: [], noise: 0 };
  let highest = -Infinity;
  for (let k = 0; k < quiet; k++) if (still[k] > highest) highest = still[k];
  const threshold = Math.max(MIN_OVER_NOISE * noise, QUIET_GUARD * highest);
  // In decibels over three times the scatter, so that the noise itself has no peaks to find.
  const floor = 3 * noise;
  const db = new Float64Array(s.length);
  for (let k = 0; k < s.length; k++) db[k] = 10 * Math.log10(Math.max(s[k], floor) / floor);
  /** @type {Sound[]} */
  const sounds = [];
  for (const p of findPeaks(db, MIN_PROMINENCE_DB, Math.max(1, Math.floor(MIN_SPACING_MS / dt)))) {
    if (s[p] < threshold || p < quiet) continue;
    // The lowest point since the sound before, or since the quiet stretch.
    let valley = sounds.length ? sounds[sounds.length - 1].index : quiet;
    for (let k = valley + 1; k <= p; k++) if (s[k] < s[valley]) valley = k;
    const from = sounds.length ? Math.max(s[valley], 0) : 0;
    const level = from + RISE * (s[p] - from);
    let i = p;
    while (i > valley && s[i] > level) i--;
    const frac = (level - s[i]) / (s[i + 1] - s[i] + 1e-30);
    sounds.push({ index: p, peakMs: ms[p], onsetMs: ms[i] + frac * dt, level: s[p], levelDb: 10 * Math.log10(s[p] / noise) });
  }
  return { sounds, noise };
}
