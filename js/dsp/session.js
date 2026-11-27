// A measuring session: the real-time pipeline plus a record of how much computing time it
// needs. The worker runs one of these; the tests run it directly.

import { Pipeline } from './pipeline.js';
import { synthesizeWatch } from '../audio/simulator.js';

/**
 * @typedef {Object} Load
 * @property {number} audioSeconds audio processed so far
 * @property {number} busySeconds computing time spent on it, stage 10's readings included
 * @property {number} longestSeconds longest time spent on a single chunk of audio; the finish
 *   where the audio ends is not one
 * @property {import('./soundstage.js').StageLoad|null} stage the part of the computing spent on
 *   stage 10's readings, the sounds inside each beat; null when that stage is not running
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

  /**
   * The audio has ended: what the pipeline still has to report (see `Pipeline.finish`). Its
   * computing counts in the time spent, but not as the longest step: that figure tells how long
   * the analysis can hold up the audio while it comes, and once the audio has ended there is
   * none to hold up. Finishing a reading whole there takes a second or two on the iPhone, and
   * until 27 November 2026 it was counted, so that the audio diagnostic's longest step showed
   * the finish (2126 ms on Lawrence's phone) instead of the recording.
   * @returns {import('./pipeline.js').PipelineEvent[]}
   */
  finish() {
    const t0 = performance.now();
    const events = this.pipeline.finish();
    this.busySeconds += (performance.now() - t0) / 1000;
    return events;
  }

  /** @returns {Load} */
  load() {
    return { audioSeconds: this.audioSeconds, busySeconds: this.busySeconds, longestSeconds: this.longestSeconds, stage: this.pipeline.sounds ? this.pipeline.sounds.load() : null };
  }
}

/**
 * @typedef {Object} BenchmarkResult
 * @property {number} channelCount
 * @property {number} audioSeconds
 * @property {number} busySeconds
 * @property {number} longestSeconds
 * @property {import('./soundstage.js').StageLoad|null} stage
 * @property {number} speed audio seconds per computing second
 * @property {number|null} lockedAt seconds of audio before the first lock
 * @property {number|null} rate final rate reading
 * @property {number|null} beatErrorMs final beat-error reading
 */

/**
 * Time the real-time pipeline on simulated audio of a clear 28,800 vph watch at +12 s/day with
 * a 0.30 ms beat error. Generating the audio is not timed. The pipeline runs as the app runs
 * it, stage 10 included, which takes its share of the time while it has a reading to work out.
 * @param {{seconds?: number, sampleRate?: number, channelCount?: number, chunk?: number, liftAngle?: number}} [options]
 * @returns {BenchmarkResult}
 */
export function benchmark(options = {}) {
  const { seconds = 60, sampleRate = 48000, channelCount = 1, chunk = 4096, liftAngle = 52 } = options;
  const watch = synthesizeWatch({ bph: 28800, rate: 12, beatOffsetMs: 0.3, gain: 1.6, seconds, sampleRate, seed: 1 });
  const channels = watch.channels.slice(0, channelCount);
  const session = new Session(sampleRate, channels.length, { liftAngle });
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
