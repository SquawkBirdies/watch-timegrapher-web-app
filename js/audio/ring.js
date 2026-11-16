// The most recent stretch of audio, kept in a fixed amount of memory so that a live
// measurement can be saved as a recording at any moment.

export class AudioRing {
  /**
   * @param {number} seconds how much audio to keep
   * @param {number} sampleRate
   */
  constructor(seconds, sampleRate) {
    this.sampleRate = sampleRate;
    this.capacity = Math.max(1, Math.round(seconds * sampleRate));
    this.data = new Float32Array(this.capacity);
    /** Samples written since the last clear. */
    this.written = 0;
  }

  /** Samples held: everything written, up to the capacity. */
  get length() {
    return Math.min(this.written, this.capacity);
  }

  /** @returns {number} seconds of audio held */
  get seconds() {
    return this.length / this.sampleRate;
  }

  /** @param {ArrayLike<number>} samples */
  push(samples) {
    const n = samples.length;
    const cap = this.capacity;
    // Only the last `cap` samples of a long push can survive it.
    const skip = Math.max(0, n - cap);
    let at = (this.written + skip) % cap;
    for (let i = skip; i < n; ) {
      const run = Math.min(n - i, cap - at);
      if (samples instanceof Float32Array) this.data.set(samples.subarray(i, i + run), at);
      else for (let k = 0; k < run; k++) this.data[at + k] = samples[i + k];
      i += run;
      at = (at + run) % cap;
    }
    this.written += n;
  }

  clear() {
    this.written = 0;
  }

  /** @returns {Float32Array} a copy of the audio held, oldest first */
  read() {
    const n = this.length;
    const out = new Float32Array(n);
    if (n === 0) return out;
    const start = (this.written - n) % this.capacity;
    const first = Math.min(n, this.capacity - start);
    out.set(this.data.subarray(start, start + first), 0);
    if (first < n) out.set(this.data.subarray(0, n - first), first);
    return out;
  }
}
