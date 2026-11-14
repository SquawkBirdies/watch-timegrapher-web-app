// A measuring session: the real-time pipeline plus a record of how much computing time it
// needs. The worker runs one of these; the tests run it directly.

import { Pipeline } from './pipeline.js';
import { synthesizeWatch } from '../audio/simulator.js';

/**
 * @typedef {Object} Load
 * @property {number} audioSeconds audio processed so far
 * @property {number} busySeconds computing time spent on it
 * @property {number} longestSeconds longest time spent on a single chunk
 */

export class Session {
  /**
   * @param {number} sampleRate
   * @param {number} channelCount
   * @param {import('./pipeline.js').PipelineOptions} [options]
   */
  constructor(sampleRate, channelCount, options = {}) {
    this.sampleRate = sampleRate;
    this.pipeline = new Pipeline(sampleRate, channelCount, options);
    this.audioSeconds = 0;
    this.busySeconds = 0;
    this.longestSeconds = 0;
  }

  /**
   * @param {ArrayLike<number>[]} channels
   * @returns {import('./pipeline.js').PipelineEvent[]}
   */
  push(channels) {
    const t0 = performance.now();
    const events = this.pipeline.push(channels);
    const busy = (performance.now() - t0) / 1000;
    this.busySeconds += busy;
    this.longestSeconds = Math.max(this.longestSeconds, busy);
    this.audioSeconds += channels[0].length / this.sampleRate;
    return events;
  }

  /** @returns {Load} */
  load() {
    return { audioSeconds: this.audioSeconds, busySeconds: this.busySeconds, longestSeconds: this.longestSeconds };
  }
}

/**
 * @typedef {Object} BenchmarkResult
 * @property {number} channelCount
 * @property {number} audioSeconds
 * @property {number} busySeconds
 * @property {number} longestSeconds
 * @property {number} speed audio seconds per computing second
 * @property {number|null} lockedAt seconds of audio before the first lock
 * @property {number|null} rate final rate reading
 * @property {number|null} beatErrorMs final beat-error reading
 */

/**
 * Time the real-time pipeline on simulated audio of a clear 28,800 vph watch at +12 s/day with
 * a 0.30 ms beat error. Generating the audio is not timed.
 * @param {{seconds?: number, sampleRate?: number, channelCount?: number, chunk?: number}} [options]
 * @returns {BenchmarkResult}
 */
export function benchmark(options = {}) {
  const { seconds = 60, sampleRate = 48000, channelCount = 1, chunk = 4096 } = options;
  const watch = synthesizeWatch({ bph: 28800, rate: 12, beatOffsetMs: 0.3, gain: 1.6, seconds, sampleRate, seed: 1 });
  const channels = watch.channels.slice(0, channelCount);
  const session = new Session(sampleRate, channels.length);
  /** @type {number|null} */
  let lockedAt = null;
  /** @type {import('./pipeline.js').ReadingsEvent|null} */
  let last = null;
  const n = channels[0].length;
  for (let i = 0; i < n; i += chunk) {
    for (const e of session.push(channels.map((c) => c.subarray(i, Math.min(n, i + chunk))))) {
      if (e.type === 'status' && e.state === 'tracking' && lockedAt === null) lockedAt = e.t;
      if (e.type === 'readings') last = e;
    }
  }
  const load = session.load();
  return {
    channelCount: channels.length,
    ...load,
    speed: load.audioSeconds / load.busySeconds,
    lockedAt,
    rate: last ? last.rate : null,
    beatErrorMs: last ? last.beatErrorMs : null,
  };
}
