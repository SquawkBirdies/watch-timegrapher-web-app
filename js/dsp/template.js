// Stage 5 of the pipeline: the average shape of one tick-tock cycle in every band. The template
// is the matched filter used to time individual beats.

import { medianInPlace } from './mathutil.js';

/**
 * Median over cycles of each row, folded at `period` samples.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} period two-beat period in envelope samples (not necessarily an integer)
 * @param {ArrayLike<number>} [shifts] optional time shift of each cycle, in samples
 * @param {number} [length] number of leading samples of each row to use
 * @param {0|1} [parity] use only even-numbered (0) or odd-numbered (1) cycles
 * @returns {Float32Array[]} one template per row, `Math.round(period)` samples long
 */
export function buildTemplate(rows, period, shifts, length = rows[0].length, parity) {
  const nb = Math.round(period);
  const ncyc = Math.floor(length / period) - 1;
  const matrix = new Float32Array(ncyc * nb);
  const column = new Float64Array(ncyc);
  /** @type {Float32Array[]} */
  const template = [];
  for (const row of rows) {
    let used = 0;
    for (let k = 0; k < ncyc; k++) {
      if (parity !== undefined && k % 2 !== parity) continue;
      const start = k * period + (shifts ? shifts[k] : 0);
      const i0 = Math.floor(start);
      const frac = start - i0;
      if (i0 < 0 || i0 + nb + 1 >= row.length) continue;
      const base = used * nb;
      for (let g = 0; g < nb; g++) matrix[base + g] = row[i0 + g] * (1 - frac) + row[i0 + g + 1] * frac;
      used++;
    }
    const t = new Float32Array(nb);
    for (let g = 0; g < nb; g++) {
      for (let k = 0; k < used; k++) column[k] = matrix[k * nb + g];
      t[g] = medianInPlace(column, used);
    }
    template.push(t);
  }
  return template;
}

/**
 * Two templates for timing: one built from the even-numbered cycles and one from the odd.
 * Each cycle is then timed with the template it did not contribute to. A template that
 * contains a little of a cycle's own noise would match that cycle too well, which makes faint
 * beats look more certain than they are.
 * @param {Float32Array[]} rows
 * @param {number} period
 * @param {ArrayLike<number>} [shifts]
 * @param {number} [length]
 * @returns {[Float32Array[], Float32Array[]]} templates from even cycles and from odd cycles
 */
export function buildSplitTemplates(rows, period, shifts, length = rows[0].length) {
  return [buildTemplate(rows, period, shifts, length, 0), buildTemplate(rows, period, shifts, length, 1)];
}

/**
 * How strongly each half-millisecond stretch of a template stands out: the squared positive
 * values of every band, summed over the bands and over the half millisecond that starts there.
 * @param {Float32Array[]} template
 * @param {number} envelopeRate envelope sample rate in hertz
 * @returns {Float64Array} one value per template sample
 */
export function clusterStrength(template, envelopeRate) {
  const nb = template[0].length;
  const comb = new Float64Array(nb);
  for (const t of template) for (let g = 0; g < nb; g++) if (t[g] > 0) comb[g] += t[g] * t[g];
  const k = Math.max(1, Math.round(0.5e-3 * envelopeRate));
  const cs = new Float64Array(nb);
  for (let g = 0; g < nb; g++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += comb[(g + j) % nb];
    cs[g] = s;
  }
  return cs;
}

/**
 * Locate the tick and the tock in a template: the strongest half-millisecond cluster, and the
 * strongest one about half a period away from it.
 * @param {Float32Array[]} template
 * @param {number} envelopeRate envelope sample rate in hertz
 * @returns {[number, number]} the two cluster positions in samples, earlier one first
 */
export function findClusters(template, envelopeRate) {
  const nb = template[0].length;
  const cs = clusterStrength(template, envelopeRate);
  let c1 = 0;
  for (let g = 1; g < nb; g++) if (cs[g] > cs[c1]) c1 = g;
  const half = nb >> 1;
  const w = Math.floor(0.012 * envelopeRate);
  let c2 = (c1 + half) % nb;
  for (let j = -w; j <= w; j++) {
    const g = (((c1 + half + j) % nb) + nb) % nb;
    if (cs[g] > cs[c2]) c2 = g;
  }
  return c1 < c2 ? [c1, c2] : [c2, c1];
}

/**
 * The average shape of one beat, from cycles that are each moved by their own shift before the
 * median is taken. `buildTemplate` moves a whole cycle, tick and tock together; a watch whose
 * beats fall at irregular times needs the tick and the tock of each cycle lined up separately.
 * Only the stretch around the beat is computed.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} period two-beat period in envelope samples
 * @param {number} centre the beat's position in the cycle, in samples
 * @param {ArrayLike<number>} shifts time shift of each cycle, in samples
 * @param {number} length number of leading samples of each row to use
 * @param {number} before samples computed before `centre`
 * @param {number} after samples computed after `centre`
 * @param {0|1} [parity] use only even-numbered (0) or odd-numbered (1) cycles
 * @returns {Float32Array[]} one cycle per row, zero outside the computed stretch
 */
export function buildBeatTemplate(rows, period, centre, shifts, length, before, after, parity) {
  const nb = Math.round(period);
  const ncyc = Math.floor(length / period) - 1;
  const width = before + after + 1;
  const matrix = new Float32Array(Math.max(1, ncyc) * width);
  const column = new Float64Array(Math.max(1, ncyc));
  /** @type {Float32Array[]} */
  const template = [];
  for (const row of rows) {
    let used = 0;
    for (let k = 0; k < ncyc; k++) {
      if (parity !== undefined && k % 2 !== parity) continue;
      const start = k * period + (shifts[k] || 0) + centre - before;
      const i0 = Math.floor(start);
      const frac = start - i0;
      if (i0 < 0 || i0 + width + 1 >= row.length) continue;
      const base = used * width;
      for (let g = 0; g < width; g++) matrix[base + g] = row[i0 + g] * (1 - frac) + row[i0 + g + 1] * frac;
      used++;
    }
    const t = new Float32Array(nb);
    if (used > 0) {
      for (let g = 0; g < width; g++) {
        for (let k = 0; k < used; k++) column[k] = matrix[k * width + g];
        t[(((centre - before + g) % nb) + nb) % nb] = medianInPlace(column, used);
      }
    }
    template.push(t);
  }
  return template;
}

/**
 * How much later the second template shows a beat than the first, judged by their shapes.
 * @param {Float32Array[]} a
 * @param {Float32Array[]} b
 * @param {number} centre the beat's position in the cycle, in samples
 * @param {number} before samples compared before `centre`
 * @param {number} after samples compared after `centre`
 * @param {number} maxShift largest shift tried, in samples
 * @returns {number} shift in samples, interpolated
 */
export function templateShift(a, b, centre, before, after, maxShift) {
  const nb = a[0].length;
  /** @param {Float32Array} t @param {number} i */
  const at = (t, i) => {
    const v = t[((i % nb) + nb) % nb];
    return v > 0 ? v : 0;
  };
  /** @type {number[]} */
  const cc = [];
  let k = 0;
  for (let s = -maxShift; s <= maxShift; s++) {
    let ab = 0;
    let bb = 0;
    for (let r = 0; r < a.length; r++) {
      for (let tau = -before; tau <= after; tau++) {
        const x = at(a[r], centre + tau);
        const y = at(b[r], centre + tau + s);
        ab += x * y;
        bb += y * y;
      }
    }
    cc.push(ab / (Math.sqrt(bb) + 1e-30));
    if (cc[cc.length - 1] > cc[k]) k = cc.length - 1;
  }
  const curve = k > 0 && k < cc.length - 1 ? cc[k - 1] - 2 * cc[k] + cc[k + 1] : 0;
  const off = curve < 0 ? (0.5 * (cc[k - 1] - cc[k + 1])) / curve : 0;
  return k - maxShift + off;
}

/**
 * A template moved earlier by `shift` samples, which need not be a whole number.
 * @param {Float32Array[]} template
 * @param {number} shift
 * @returns {Float32Array[]}
 */
export function shiftTemplate(template, shift) {
  const nb = template[0].length;
  const i0 = Math.floor(shift);
  const frac = shift - i0;
  return template.map((t) => {
    const out = new Float32Array(nb);
    for (let g = 0; g < nb; g++) {
      const x = t[(((g + i0) % nb) + nb) % nb];
      const y = t[(((g + i0 + 1) % nb) + nb) % nb];
      out[g] = x * (1 - frac) + y * frac;
    }
    return out;
  });
}
