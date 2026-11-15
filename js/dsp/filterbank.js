// Stage 2 of the pipeline: split the audio into frequency bands and reduce each band to an
// energy envelope at a lower sample rate.

import { Cascade, bandpassSections } from './biquad.js';

/**
 * Default band edges in hertz. Bands that do not fit below the Nyquist limit are dropped, so at
 * 44.1 kHz the top band goes, and at 48 kHz all nine are used. The two bands above 14.5 kHz
 * were added after the first iPhone captures: Safari delivers tick sound up to 22.5 kHz, and
 * using it made the ticks 1.2 to 2.2 times clearer.
 */
export const DEFAULT_BANDS = [
  [1500, 2500],
  [2500, 3500],
  [3500, 5000],
  [5000, 7000],
  [7000, 9000],
  [9000, 11500],
  [11500, 14500],
  [14500, 18000],
  [18000, 22500],
];

/**
 * Streaming filter bank. Each call to `process` accepts the next chunk of audio and returns the
 * envelope samples that chunk completes. One output row per (band, channel) pair.
 */
export class FilterBank {
  /**
   * @param {number} sampleRate audio sample rate in hertz
   * @param {number} channelCount number of audio channels
   * @param {{bands?: number[][], envelopeRate?: number}} [options]
   */
  constructor(sampleRate, channelCount, options = {}) {
    const { bands = DEFAULT_BANDS, envelopeRate = 12000 } = options;
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    /** Audio samples averaged into one envelope sample. */
    this.decimation = Math.max(1, Math.round(sampleRate / envelopeRate));
    /** Envelope sample rate in hertz. */
    this.envelopeRate = sampleRate / this.decimation;
    /** Bands in use. */
    this.bands = bands.filter(([, hi]) => hi < 0.47 * sampleRate);
    /** @type {{band: number, channel: number, filter: Cascade, acc: number}[]} */
    this.rows = [];
    for (let b = 0; b < this.bands.length; b++) {
      for (let c = 0; c < channelCount; c++) {
        const [lo, hi] = this.bands[b];
        this.rows.push({ band: b, channel: c, filter: new Cascade(bandpassSections(sampleRate, lo, hi)), acc: 0 });
      }
    }
    /** Audio samples already folded into the envelope sample in progress. */
    this.phase = 0;
    /** @type {Float64Array} */
    this.scratch = new Float64Array(0);
  }

  /** Number of output rows. */
  get rowCount() {
    return this.rows.length;
  }

  /**
   * @param {ArrayLike<number>[]} channels one array of samples per channel, all the same length
   * @returns {Float32Array[]} one envelope array per row, all the same length
   */
  process(channels) {
    const n = channels[0].length;
    if (this.scratch.length < n) this.scratch = new Float64Array(n);
    const y = this.scratch;
    const dec = this.decimation;
    const nOut = Math.floor((this.phase + n) / dec);
    /** @type {Float32Array[]} */
    const out = [];
    for (const row of this.rows) {
      row.filter.process(channels[row.channel], y, n);
      const env = new Float32Array(nOut);
      let acc = row.acc;
      let phase = this.phase;
      let k = 0;
      for (let i = 0; i < n; i++) {
        acc += y[i] * y[i];
        if (++phase === dec) {
          env[k++] = acc / dec;
          acc = 0;
          phase = 0;
        }
      }
      row.acc = acc;
      out.push(env);
    }
    this.phase = (this.phase + n) % dec;
    return out;
  }
}
