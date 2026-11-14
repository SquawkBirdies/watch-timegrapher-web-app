// Stage 3 of the pipeline: make every band comparable and remove what is not the watch.
//   1. divide by the band's running noise level
//   2. clip loud outliers (clicks, handling noise)
//   3. subtract anything that repeats at the mains frequency (comb filter)

import { medianInPlace } from './mathutil.js';

/**
 * Streaming clean-up of the envelope rows. Output is delayed by `delay` envelope samples: the
 * k-th cleaned sample belongs to envelope sample k + delay.
 */
export class Cleanup {
  /**
   * @param {number} envelopeRate envelope sample rate in hertz
   * @param {number} rowCount number of envelope rows
   * @param {{humHz?: number, blockSeconds?: number, clip?: number}} [options]
   */
  constructor(envelopeRate, rowCount, options = {}) {
    const { humHz = 60, blockSeconds = 0.5, clip = 30 } = options;
    this.envelopeRate = envelopeRate;
    this.rowCount = rowCount;
    this.clip = clip;
    /** Mains period in envelope samples (may be fractional). */
    this.humPeriod = envelopeRate / humHz;
    /** Delay of the output, in envelope samples. */
    this.delay = Math.ceil(2 * this.humPeriod) + 1;
    this.blockLength = Math.max(8, Math.round(blockSeconds * envelopeRate));
    const histLength = 2 * this.delay + 1;
    /** @type {{floor: number, block: Float32Array, blockFill: number, pending: number[], hist: Float32Array, histPos: number, histCount: number}[]} */
    this.rows = [];
    for (let r = 0; r < rowCount; r++) {
      this.rows.push({
        floor: NaN,
        block: new Float32Array(this.blockLength),
        blockFill: 0,
        pending: [],
        hist: new Float32Array(histLength),
        histPos: 0,
        histCount: 0,
      });
    }
    this.scratch = new Float64Array(this.blockLength);
  }

  /**
   * @param {Float32Array[]} rows the next chunk of each envelope row, all the same length
   * @returns {Float32Array[]} cleaned samples completed by this chunk, all the same length
   */
  process(rows) {
    /** @type {Float32Array[]} */
    const out = [];
    for (let r = 0; r < this.rowCount; r++) out.push(this.processRow(this.rows[r], rows[r]));
    return out;
  }

  /**
   * @param {{floor: number, block: Float32Array, blockFill: number, pending: number[], hist: Float32Array, histPos: number, histCount: number}} st
   * @param {Float32Array} x
   * @returns {Float32Array}
   */
  processRow(st, x) {
    /** @type {number[]} */
    const produced = [];
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      // Collect samples for the next noise-level estimate.
      st.block[st.blockFill++] = v;
      const blockDone = st.blockFill === this.blockLength;
      if (Number.isNaN(st.floor)) {
        // No noise level yet: hold the samples until the first block is complete.
        st.pending.push(v);
        if (blockDone) {
          st.floor = this.blockMedian(st);
          for (const p of st.pending) this.pushNormalised(st, p, produced);
          st.pending = [];
        }
      } else {
        this.pushNormalised(st, v, produced);
        if (blockDone) st.floor = this.blockMedian(st);
      }
      if (blockDone) st.blockFill = 0;
    }
    return Float32Array.from(produced);
  }

  /**
   * @param {{block: Float32Array}} st
   * @returns {number}
   */
  blockMedian(st) {
    this.scratch.set(st.block);
    return Math.max(medianInPlace(this.scratch, this.blockLength), 1e-30);
  }

  /**
   * Normalise and clip one sample, add it to the comb history, and emit the comb output for the
   * sample `delay` positions back once enough history exists.
   * @param {{floor: number, hist: Float32Array, histPos: number, histCount: number}} st
   * @param {number} v raw envelope sample
   * @param {number[]} produced
   */
  pushNormalised(st, v, produced) {
    const L = st.hist.length;
    st.hist[st.histPos] = Math.min(v / st.floor, this.clip);
    st.histPos = (st.histPos + 1) % L;
    if (st.histCount < L) st.histCount++;
    if (st.histCount < L) return;
    // The oldest sample sits at histPos; the centre is `delay` samples after it.
    const base = st.histPos;
    const centre = this.delay;
    const M = this.humPeriod;
    let neighbours = 0;
    for (let k = -2; k <= 2; k++) {
      if (k === 0) continue;
      const pos = centre + k * M;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = st.hist[(base + i0) % L];
      const b = st.hist[(base + i0 + 1) % L];
      neighbours += a * (1 - frac) + b * frac;
    }
    produced.push(st.hist[(base + centre) % L] - neighbours / 4);
  }
}
