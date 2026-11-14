// Test helper: feed audio to the real-time pipeline in small chunks and collect what it reports.

import { Pipeline } from '../../js/dsp/pipeline.js';

/**
 * @typedef {import('../../js/dsp/pipeline.js').StatusEvent} StatusEvent
 * @typedef {import('../../js/dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 * @typedef {import('../../js/dsp/pipeline.js').Beat} Beat
 */

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{options?: import('../../js/dsp/pipeline.js').PipelineOptions, chunk?: number, from?: number, to?: number}} [how]
 * @returns {{status: StatusEvent[], readings: ReadingsEvent[], last: ReadingsEvent|null, beats: Beat[], audioSeconds: number, elapsedSeconds: number, pipeline: Pipeline}}
 */
export function stream(channels, sampleRate, how = {}) {
  const { options = {}, chunk = 128, from = 0, to = channels[0].length } = how;
  const pipeline = new Pipeline(sampleRate, channels.length, options);
  /** @type {StatusEvent[]} */
  const status = [];
  /** @type {ReadingsEvent[]} */
  const readings = [];
  /** @type {Beat[]} */
  let beats = [];
  const t0 = performance.now();
  for (let i = from; i < to; i += chunk) {
    for (const e of pipeline.push(channels.map((c) => c.subarray(i, Math.min(to, i + chunk))))) {
      if (e.type === 'status') status.push(e);
      else if (e.type === 'readings') readings.push(e);
      else {
        const cut = e.replaceFrom;
        if (cut !== null) beats = beats.filter((b) => b.t < cut);
        beats.push(...e.beats);
      }
    }
  }
  return { status, readings, last: readings.length ? readings[readings.length - 1] : null, beats, audioSeconds: (to - from) / sampleRate, elapsedSeconds: (performance.now() - t0) / 1000, pipeline };
}

/**
 * Join pieces of audio end to end.
 * @param {{channels: Float32Array[]}[]} parts
 * @returns {Float32Array[]}
 */
export function join(parts) {
  return parts[0].channels.map((_, c) => {
    const out = new Float32Array(parts.reduce((s, p) => s + p.channels[c].length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p.channels[c], at);
      at += p.channels[c].length;
    }
    return out;
  });
}
