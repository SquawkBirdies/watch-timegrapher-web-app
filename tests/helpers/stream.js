// Test helper: feed audio to the real-time pipeline in small chunks and collect what it reports.

import { Pipeline } from '../../js/dsp/pipeline.js';
import { robustLine, median } from '../../js/dsp/mathutil.js';

/**
 * @typedef {import('../../js/dsp/pipeline.js').StatusEvent} StatusEvent
 * @typedef {import('../../js/dsp/pipeline.js').ReadingsEvent} ReadingsEvent
 * @typedef {import('../../js/dsp/pipeline.js').Beat} Beat
 */

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{options?: import('../../js/dsp/pipeline.js').PipelineOptions, chunk?: number, from?: number, to?: number, each?: (pipeline: Pipeline) => void}} [how]
 *   `each` is called after every chunk, to watch the pipeline's state as it goes
 * @returns {{status: StatusEvent[], readings: ReadingsEvent[], last: ReadingsEvent|null, beats: Beat[], audioSeconds: number, elapsedSeconds: number, pipeline: Pipeline}}
 */
export function stream(channels, sampleRate, how = {}) {
  const { options = {}, chunk = 128, from = 0, to = channels[0].length, each } = how;
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
      else if (e.type === 'beats') {
        const cut = e.replaceFrom;
        if (cut !== null) beats = beats.filter((b) => b.t < cut);
        beats.push(...e.beats);
      }
    }
    if (each) each(pipeline);
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

/**
 * How well the confident beats of one type keep to a single trace line. A timing reference
 * that moved partway through shows as a step.
 * @param {Beat[]} beats
 * @param {number} bph
 * @param {0|1} type
 * @returns {{count: number, cycles: number, slope: number, step: number}} the number of
 *   confident beats; the most cycles averaged in one; the slope of a robust line through the
 *   trace, in seconds per day; and the largest difference between the medians of neighbouring
 *   5 s stretches, in milliseconds, after that line is taken out
 */
export function traceLine(beats, bph, type) {
  const own = beats.filter((b) => b.type === type && b.ok);
  if (own.length < 5) return { count: own.length, cycles: 0, slope: 0, step: 0 };
  const period = 3600 / bph;
  const ts = own.map((b) => b.t);
  const ys = own.map((b) => (b.n * period - b.t) * 1000);
  const fit = robustLine(ts, ys);
  /** @type {Map<number, number[]>} */
  const stretches = new Map();
  own.forEach((b, i) => {
    const k = Math.floor(b.t / 5);
    const list = stretches.get(k) || [];
    list.push(ys[i] - fit.a - fit.b * b.t);
    stretches.set(k, list);
  });
  const medians = [...stretches.entries()].sort((p, q) => p[0] - q[0]).map(([, list]) => median(list));
  let step = 0;
  for (let i = 1; i < medians.length; i++) step = Math.max(step, Math.abs(medians[i] - medians[i - 1]));
  return { count: own.length, cycles: Math.max(...own.map((b) => b.cycles)), slope: fit.b * 86.4, step };
}
