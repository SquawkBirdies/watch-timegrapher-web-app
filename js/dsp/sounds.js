// Stage 10 of the pipeline, first half: the sounds inside a beat. The timestamps of stage 7 mark
// each beat's loudest part. Here the envelope around every timestamp of a beat type is averaged
// into one beat, and the separate sounds in it are found: for a Swiss lever the unlock, the
// impulse and the drop. js/dsp/amplitude.js pairs them between the tick and the tock.
//
// A port of tools/prototype/coaxial/events.py (`stack`, `band_means`, `energy_weights`,
// `portrait`, `find_sounds`, `shift_of`, `shift_rows`), whose README gives the evidence for each
// choice.

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
/** How long an averaged beat is smoothed over before a sound is matched in it, in milliseconds. */
export const MATCH_SMOOTH_MS = 0.15;
/** Furthest a sound is looked for from its place in the template, in milliseconds. */
export const MAX_SHIFT_MS = 1.5;
/** A match counts when it is at least this share of the template's match with itself. */
export const STRONG_MATCH = 0.5;

/**
 * Every beat's stretch of envelope, band by band. The beats lie side by side, as averaging
 * reads them: sample k of beat i is at k * count + i.
 * @typedef {Object} BeatStack
 * @property {Float32Array[]} bands one array per band: instant after instant of the stretch,
 *   each with every beat's value there
 * @property {number} count beats held
 * @property {number} length samples in a stretch
 * @property {number} before samples of a stretch that lie before the beat's timestamp
 * @property {Int32Array} kept which of the positions given each beat came from
 */

/**
 * Beats to average: at each instant of the stretch, every beat's value side by side, and
 * perhaps their ranking.
 * @typedef {Object} BeatColumns
 * @property {Float32Array[]} bands one array per band: instant after instant, each with `count` values
 * @property {number} count beats held
 * @property {number} length samples in a stretch
 * @property {Uint16Array[]|null} order when the beats were ranked: one array per band, holding
 *   at each instant the beats in rising order of their value there
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
 * Which of a filter bank's output rows the sounds are read from: the first channel's bands from
 * SOUND_BANDS_FROM_HZ up. The first channel is the one the prototype was checked on; Safari
 * delivers the iPhone's microphone there.
 * @param {import('./filterbank.js').FilterBank} bank
 * @returns {number[]} places in the bank's output
 */
export function soundRowIndices(bank) {
  /** @type {number[]} */
  const picked = [];
  bank.rows.forEach((row, i) => {
    if (row.channel === 0 && bank.bands[row.band][0] >= SOUND_BANDS_FROM_HZ) picked.push(i);
  });
  return picked;
}

/**
 * The envelope rows the sounds are read from, out of a filter bank's output (see
 * `soundRowIndices`).
 * @param {import('./filterbank.js').FilterBank} bank
 * @param {Float32Array[]} rows the bank's output, before Cleanup
 * @returns {Float32Array[]}
 */
export function soundRows(bank, rows) {
  return soundRowIndices(bank).map((i) => rows[i]);
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
  const count = kept.length;
  const bands = rows.map((row) => {
    const out = new Float32Array(count * length);
    for (let b = 0; b < count; b++) {
      const pos = positions[kept[b]];
      const whole = Math.floor(pos);
      const frac = pos - whole;
      const from = whole - before;
      for (let k = 0; k < length; k++) out[k * count + b] = row[from + k] * (1 - frac) + row[from + k + 1] * frac;
    }
    return out;
  });
  return { bands, count, length, before, kept: Int32Array.from(kept) };
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
 * One band's beats ranked at each instant.
 * @param {Pick<BeatStack, 'bands'|'count'|'length'>} stack at most 65,535 beats
 * @param {number} b the band
 * @returns {Uint16Array} at each instant, the beats in rising order of their value there
 */
export function rankBand(stack, b) {
  const { count, length } = stack;
  const band = stack.bands[b];
  const current = new Uint16Array(count);
  const ranked = new Uint16Array(count * length);
  for (let i = 0; i < count; i++) current[i] = i;
  for (let k = 0; k < length; k++) {
    const base = k * count;
    // An insertion sort that starts from the instant before's ranking: an envelope changes
    // little from one sample to the next, so most beats are already near their place.
    for (let i = 1; i < count; i++) {
      const beat = current[i];
      const v = band[base + beat];
      let p = i;
      while (p > 0 && band[base + current[p - 1]] > v) {
        current[p] = current[p - 1];
        p--;
      }
      current[p] = beat;
    }
    ranked.set(current, base);
  }
  return ranked;
}

/**
 * Stacked beats ranked at each instant. The ranking is made once and serves every resample of
 * the same beats: the values a draw leaves out are then found at the two ends of the ranking.
 * @param {BeatStack} stack at most 65,535 beats
 * @returns {BeatColumns} the stack's own values, with their ranking
 */
export function toColumns(stack) {
  return { bands: stack.bands, count: stack.count, length: stack.length, order: stack.bands.map((_, b) => rankBand(stack, b)) };
}

/**
 * Where each beat taken is read from when it is read a little later: for each, the whole
 * samples and the fraction of one it is read later by, and the instants of the stretch whose
 * two neighbours both lie inside it. Before them the beat's first value stands, after them its
 * last.
 * @param {number} length samples in a stretch
 * @param {number} count beats taken
 * @param {ArrayLike<number>} shiftMs how much later each is read, in milliseconds
 * @param {number} envelopeRate envelope sample rate in hertz
 * @returns {{whole: Int32Array, frac: Float64Array, inside: Int32Array, until: Int32Array}}
 */
function readLater(length, count, shiftMs, envelopeRate) {
  const whole = new Int32Array(count);
  const frac = new Float64Array(count);
  const inside = new Int32Array(count);
  const until = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const samples = (shiftMs[i] * envelopeRate) / 1e3;
    whole[i] = Math.floor(samples);
    frac[i] = samples - whole[i];
    inside[i] = Math.min(length, Math.max(0, -whole[i]));
    until[i] = Math.max(inside[i], Math.min(length, length - 1 - whole[i]));
  }
  return { whole, frac, inside, until };
}

/**
 * Chosen beats of a stack, each read a little later. A beat read s milliseconds later has a
 * sound that comes s late in it lined up with the others. Past either end of its stretch a beat
 * keeps its end value.
 * @param {BeatStack} stack
 * @param {ArrayLike<number>|null} draw the beats to take, by their place in the stack; all when null
 * @param {ArrayLike<number>} shiftMs how much later each beat taken is read, in milliseconds
 * @param {number} envelopeRate envelope sample rate in hertz
 * @returns {BeatColumns}
 */
export function shiftedColumns(stack, draw, shiftMs, envelopeRate) {
  const { length } = stack;
  const all = stack.count;
  const count = draw ? draw.length : all;
  const last = length - 1;
  const { whole, frac, inside, until } = readLater(length, count, shiftMs, envelopeRate);
  const bands = stack.bands.map((rows) => {
    const out = new Float32Array(count * length);
    for (let i = 0; i < count; i++) {
      const beat = draw ? draw[i] : i;
      const first = rows[beat];
      const end = rows[last * all + beat];
      const at = whole[i] * all + beat;
      const f = frac[i];
      let k = 0;
      for (; k < inside[i]; k++) out[k * count + i] = first;
      for (; k < until[i]; k++) out[k * count + i] = rows[k * all + at] * (1 - f) + rows[(k + 1) * all + at] * f;
      for (; k < length; k++) out[k * count + i] = end;
    }
    return out;
  });
  return { bands, count, length, order: null };
}

/**
 * The averaged beat of each band, as `bandMeans` gives it, of chosen beats each read a little
 * later: `bandMeans(shiftedColumns(...), quiet)` without the copy of every beat in between. Each
 * resample of a lined-up sound reads every one of its beats at a new place, and that copy with
 * its average was most of the computing of such a reading. A resample draws about a third of
 * its beats more than once, and a beat drawn again is read at the same place, so each beat is
 * read once and counted as often as it was drawn.
 * @param {BeatStack} stack
 * @param {ArrayLike<number>|null} draw the beats to take, by their place in the stack, any of
 *   them more than once; all when null
 * @param {ArrayLike<number>} shiftMs how much later each beat taken is read, in milliseconds; a
 *   beat taken more than once has the same shift each time
 * @param {number} envelopeRate envelope sample rate in hertz
 * @param {number} quiet samples at the start of the stretch that lie before any of the beat's sounds
 * @returns {{excess: Float64Array[], levels: Float64Array}} as from `bandMeans`
 */
export function shiftedBandMeans(stack, draw, shiftMs, envelopeRate, quiet) {
  const { length } = stack;
  const all = stack.count;
  const n = draw ? draw.length : all;
  const cut = Math.floor(TRIM * n);
  const kept = n - 2 * cut;
  // Each beat taken, once, with how often it was drawn and the shift it is read at.
  const seen = new Int32Array(all).fill(-1);
  const beats = new Int32Array(Math.min(n, all));
  const times = new Int32Array(Math.min(n, all));
  const shifts = new Float64Array(Math.min(n, all));
  let unique = 0;
  for (let i = 0; i < n; i++) {
    const beat = draw ? draw[i] : i;
    if (seen[beat] < 0) {
      seen[beat] = unique;
      beats[unique] = beat;
      shifts[unique] = shiftMs[i];
      unique++;
    }
    times[seen[beat]]++;
  }
  const { whole, frac, inside, until } = readLater(length, unique, shifts, envelopeRate);
  // The instants at which every beat is read between two of its own samples.
  let allFrom = 0;
  let allUntil = length;
  const at = new Int32Array(unique);
  for (let u = 0; u < unique; u++) {
    if (inside[u] > allFrom) allFrom = inside[u];
    if (until[u] < allUntil) allUntil = until[u];
    at[u] = whole[u] * all + beats[u];
  }
  if (allUntil < allFrom) allUntil = allFrom;
  const rest = Float64Array.from(frac, (f) => 1 - f);
  // The `cut` lowest values seen so far, and the `cut` highest, each rising.
  const low = new Float64Array(cut);
  const high = new Float64Array(cut);
  const levels = new Float64Array(stack.bands.length);
  /** @type {Float64Array[]} */
  const excess = [];
  for (let b = 0; b < stack.bands.length; b++) {
    const rows = stack.bands[b];
    const lastRow = (length - 1) * all;
    const m = new Float64Array(length);
    for (let k = 0; k < length; k++) {
      const base = k * all;
      const plain = k >= allFrom && k < allUntil;
      let sum = 0;
      let held = 0;
      // With nothing to leave out, no value is ever below the one or above the other.
      let lowTop = cut > 0 ? Infinity : -Infinity;
      let highFloor = cut > 0 ? -Infinity : Infinity;
      for (let u = 0; u < unique; u++) {
        // The value is rounded as `shiftedColumns` stores it, so the two agree to the last digit.
        let v;
        if (plain || (k >= inside[u] && k < until[u])) v = Math.fround(rows[base + at[u]] * rest[u] + rows[base + all + at[u]] * frac[u]);
        else v = k < inside[u] ? rows[beats[u]] : rows[lastRow + beats[u]];
        const c = times[u];
        sum += c * v;
        if (held < cut) {
          // The first `cut` values are both the lowest and the highest seen so far.
          let again = 0;
          for (; again < c && held < cut; again++) {
            let p = held;
            while (p > 0 && low[p - 1] > v) {
              low[p] = low[p - 1];
              high[p] = high[p - 1];
              p--;
            }
            low[p] = v;
            high[p] = v;
            held++;
          }
          if (held < cut) continue;
          lowTop = low[cut - 1];
          highFloor = high[0];
          // What is left of this value's draws is weighed like any later value.
          for (; again < c; again++) {
            if (v < lowTop) {
              let p = cut - 1;
              while (p > 0 && low[p - 1] > v) {
                low[p] = low[p - 1];
                p--;
              }
              low[p] = v;
              lowTop = low[cut - 1];
            }
            if (v > highFloor) {
              let p = 0;
              while (p + 1 < cut && high[p + 1] < v) {
                high[p] = high[p + 1];
                p++;
              }
              high[p] = v;
              highFloor = high[0];
            }
          }
          continue;
        }
        if (v < lowTop) {
          for (let again = 0; again < c && v < lowTop; again++) {
            let p = cut - 1;
            while (p > 0 && low[p - 1] > v) {
              low[p] = low[p - 1];
              p--;
            }
            low[p] = v;
            lowTop = low[cut - 1];
          }
        }
        if (v > highFloor) {
          for (let again = 0; again < c && v > highFloor; again++) {
            let p = 0;
            while (p + 1 < cut && high[p + 1] < v) {
              high[p] = high[p + 1];
              p++;
            }
            high[p] = v;
            highFloor = high[0];
          }
        }
      }
      for (let j = 0; j < cut; j++) sum -= low[j] + high[j];
      m[k] = sum / kept;
    }
    const level = median(m.subarray(0, quiet));
    levels[b] = level;
    for (let k = 0; k < length; k++) m[k] = m[k] / level - 1;
    excess.push(m);
  }
  return { excess, levels };
}

/**
 * The averaged beat of each band: at each instant the mean over the beats with the highest and
 * lowest TRIM of them left out, as an excess over the band's level in the quiet stretch before
 * the beat. A plain mean let one click in a single beat dominate the average; with the ends
 * left out it does not show.
 *
 * Most of the stage's computing is spent here, since every resample averages every beat again,
 * so the values to leave out are never found by sorting each instant's values afresh. Ranked
 * columns give them at the two ends of the ranking; unranked ones in a single pass that keeps
 * the few lowest and highest values seen.
 * @param {BeatColumns} columns
 * @param {number} quiet samples at the start of the stretch that lie before any of the beat's sounds
 * @param {ArrayLike<number>} [draw] the beats to average, by their place in the columns, any of
 *   them more than once; all when absent
 * @param {Uint8Array} [only] when given, the instants to work out: 1 for each one wanted, which
 *   must include the quiet stretch. The others are left as they are, at -1, and must not be read
 * @returns {{excess: Float64Array[], levels: Float64Array}} each band's averaged beat, divided
 *   by its quiet level and less 1, and those quiet levels
 */
export function bandMeans(columns, quiet, draw, only) {
  const { length, count, order } = columns;
  const n = draw ? draw.length : count;
  const cut = Math.floor(TRIM * n);
  const kept = n - 2 * cut;
  const levels = new Float64Array(columns.bands.length);
  /** @type {Float64Array[]} */
  const excess = [];
  // How often each beat is drawn.
  const times = new Uint16Array(order ? count : 0);
  if (order) {
    if (draw) for (let i = 0; i < n; i++) times[draw[i]]++;
    else times.fill(1);
  }
  // Without a ranking: the `cut` lowest values seen so far, and the `cut` highest, each rising.
  const low = new Float64Array(order ? 0 : cut);
  const high = new Float64Array(order ? 0 : cut);
  for (let b = 0; b < columns.bands.length; b++) {
    const band = columns.bands[b];
    const m = new Float64Array(length);
    if (order) {
      const ranked = order[b];
      // A few beats out of many are summed one by one; most of them, in one sweep with their counts.
      const sparse = 2 * n < count;
      for (let k = 0; k < length; k++) {
        if (only && !only[k]) continue;
        const base = k * count;
        let sum = 0;
        if (sparse && draw) for (let i = 0; i < n; i++) sum += band[base + draw[i]];
        else for (let i = 0; i < count; i++) sum += times[i] * band[base + i];
        for (let need = cut, r = base; need > 0; r++) {
          const beat = ranked[r];
          const take = Math.min(need, times[beat]);
          sum -= take * band[base + beat];
          need -= take;
        }
        for (let need = cut, r = base + count - 1; need > 0; r--) {
          const beat = ranked[r];
          const take = Math.min(need, times[beat]);
          sum -= take * band[base + beat];
          need -= take;
        }
        m[k] = sum / kept;
      }
    } else {
      for (let k = 0; k < length; k++) {
        if (only && !only[k]) continue;
        const base = k * count;
        let sum = 0;
        let i = 0;
        for (; i < cut; i++) {
          const v = band[base + (draw ? draw[i] : i)];
          sum += v;
          let p = i;
          while (p > 0 && low[p - 1] > v) {
            low[p] = low[p - 1];
            p--;
          }
          low[p] = v;
          p = i;
          while (p > 0 && high[p - 1] > v) {
            high[p] = high[p - 1];
            p--;
          }
          high[p] = v;
        }
        if (cut > 0) {
          let lowTop = low[cut - 1];
          let highFloor = high[0];
          for (; i < n; i++) {
            const v = band[base + (draw ? draw[i] : i)];
            sum += v;
            if (v < lowTop) {
              let p = cut - 1;
              while (p > 0 && low[p - 1] > v) {
                low[p] = low[p - 1];
                p--;
              }
              low[p] = v;
              lowTop = low[cut - 1];
            }
            if (v > highFloor) {
              let p = 0;
              while (p + 1 < cut && high[p + 1] < v) {
                high[p] = high[p + 1];
                p++;
              }
              high[p] = v;
              highFloor = high[0];
            }
          }
          for (let j = 0; j < cut; j++) sum -= low[j] + high[j];
        } else {
          for (; i < n; i++) sum += band[base + (draw ? draw[i] : i)];
        }
        m[k] = sum / kept;
      }
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

/**
 * An averaged beat smoothed for matching.
 * @param {Float64Array} curve
 * @param {Float64Array} ms time of each sample, from `stretchMs`
 * @returns {Float64Array}
 */
export function smoothForMatching(curve, ms) {
  return smooth(curve, Math.max(1, Math.round(MATCH_SMOOTH_MS / (ms[1] - ms[0]))));
}

/**
 * How much later, in milliseconds, a sound comes in `curve` than in `template`, looked for
 * within MAX_SHIFT_MS. The match at each shift is the product of the template's stretch from
 * `fromMs` to `toMs` and the curve's, each with its mean taken off: a matched filter, which
 * suits a faint sound in noise. Of the peaks in the match that reach STRONG_MATCH of the
 * template's match with itself, the one nearest no shift is taken, so that a louder sound
 * reaching into the search cannot win.
 * @param {Float64Array} template a smoothed averaged beat holding the sound
 * @param {Float64Array} curve the smoothed averaged beat to find it in
 * @param {Float64Array} ms time of each sample, from `stretchMs`
 * @param {number} fromMs where the sound's stretch of the template starts
 * @param {number} toMs and ends
 * @returns {number|null} null when no peak qualifies, or the search would leave the stretch
 */
export function shiftOf(template, curve, ms, fromMs, toMs) {
  const dt = ms[1] - ms[0];
  const i0 = samplesBefore(ms, fromMs);
  const i1 = samplesBefore(ms, toMs);
  const width = i1 - i0;
  const reach = Math.round(MAX_SHIFT_MS / dt);
  if (width <= 0 || i0 - reach < 0 || i1 + reach > curve.length) return null;
  let mean = 0;
  for (let i = i0; i < i1; i++) mean += template[i];
  mean /= width;
  const g = new Float64Array(width);
  let own = 0;
  for (let i = 0; i < width; i++) {
    g[i] = template[i0 + i] - mean;
    own += g[i] * g[i];
  }
  const score = new Float64Array(2 * reach + 1);
  for (let k = -reach; k <= reach; k++) {
    let m = 0;
    for (let i = 0; i < width; i++) m += curve[i0 + k + i];
    m /= width;
    let dot = 0;
    for (let i = 0; i < width; i++) dot += g[i] * (curve[i0 + k + i] - m);
    score[k + reach] = dot;
  }
  const floor = STRONG_MATCH * own;
  let best = -1;
  for (let k = 1; k < score.length - 1; k++) {
    if (score[k] >= Math.max(score[k - 1], score[k + 1], floor) && (best < 0 || Math.abs(k - reach) < Math.abs(best - reach))) best = k;
  }
  if (best < 0) return null;
  const [a, b, c] = [score[best - 1], score[best], score[best + 1]];
  const curvature = a - 2 * b + c;
  const frac = curvature !== 0 ? (0.5 * (a - c)) / curvature : 0;
  return (best - reach + frac) * dt;
}
