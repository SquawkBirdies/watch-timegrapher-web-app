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
 * Locate the tick and the tock in a template: the strongest half-millisecond cluster, and the
 * strongest one about half a period away from it.
 * @param {Float32Array[]} template
 * @param {number} envelopeRate envelope sample rate in hertz
 * @returns {[number, number]} the two cluster positions in samples, earlier one first
 */
export function findClusters(template, envelopeRate) {
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
