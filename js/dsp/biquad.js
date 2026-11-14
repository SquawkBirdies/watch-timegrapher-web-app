// Second-order filter sections and a fourth-order Butterworth band-pass built from them.

/**
 * @typedef {{b0: number, b1: number, b2: number, a1: number, a2: number}} Section
 */

/** Q values of the two sections of a fourth-order Butterworth filter. */
export const BUTTERWORTH4_Q = [1 / (2 * Math.cos(Math.PI / 8)), 1 / (2 * Math.cos((3 * Math.PI) / 8))];

/**
 * Second-order low-pass section.
 * @param {number} fs sample rate in hertz
 * @param {number} fc corner frequency in hertz
 * @param {number} q quality factor
 * @returns {Section}
 */
export function lowpass(fs, fc, q) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/**
 * Second-order high-pass section.
 * @param {number} fs sample rate in hertz
 * @param {number} fc corner frequency in hertz
 * @param {number} q quality factor
 * @returns {Section}
 */
export function highpass(fs, fc, q) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/**
 * Band-pass made of a fourth-order Butterworth high-pass followed by a fourth-order low-pass.
 * @param {number} fs sample rate in hertz
 * @param {number} lo lower corner in hertz
 * @param {number} hi upper corner in hertz
 * @returns {Section[]}
 */
export function bandpassSections(fs, lo, hi) {
  return [
    highpass(fs, lo, BUTTERWORTH4_Q[0]),
    highpass(fs, lo, BUTTERWORTH4_Q[1]),
    lowpass(fs, hi, BUTTERWORTH4_Q[0]),
    lowpass(fs, hi, BUTTERWORTH4_Q[1]),
  ];
}

/**
 * A cascade of second-order sections that keeps its state between calls, so audio can be
 * processed in chunks of any size.
 */
export class Cascade {
  /** @param {Section[]} sections */
  constructor(sections) {
    this.sections = sections;
    /** @type {Float64Array} two state values per section */
    this.state = new Float64Array(2 * sections.length);
  }

  /** Clear the filter memory. */
  reset() {
    this.state.fill(0);
  }

  /**
   * Filter `input` into `output` (which may be the same length or longer).
   * @param {ArrayLike<number>} input
   * @param {Float64Array} output
   * @param {number} [n] number of samples to process
   */
  process(input, output, n = input.length) {
    const st = this.state;
    for (let s = 0; s < this.sections.length; s++) {
      const { b0, b1, b2, a1, a2 } = this.sections[s];
      let z1 = st[2 * s];
      let z2 = st[2 * s + 1];
      const src = s === 0 ? input : output;
      for (let i = 0; i < n; i++) {
        const x = src[i];
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        output[i] = y;
      }
      st[2 * s] = z1;
      st[2 * s + 1] = z2;
    }
  }
}
