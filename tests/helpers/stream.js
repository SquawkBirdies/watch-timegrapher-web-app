// Test helper: feed audio to the real-time pipeline in small chunks and collect what it reports.

import { Pipeline } from '../../js/dsp/pipeline.js';
import { robustLine, median } from '../../js/dsp/mathutil.js';
import { runningMedian } from '../../js/dsp/timing.js';

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

/**
 * How tightly the confident beats of one type keep to their own trend. The trend is a robust
 * line through the trace plus a running median over 15 beats of what the line leaves, so that
 * neither a steady rate nor a slow change of rate counts as scatter.
 * @param {Beat[]} beats
 * @param {number} bph
 * @param {0|1} type
 * @returns {{count: number, total: number, cycles: number[], far: number, spreadMs: number, sdMs: number}}
 *   the number of confident beats and of all beats; the numbers of cycles averaged, in order of
 *   first use; how many confident beats lie more than 1 ms from the trend; their scatter about
 *   it as a scaled median absolute deviation; and as a standard deviation
 */
export function traceScatter(beats, bph, type) {
  const all = beats.filter((b) => b.type === type);
  const own = all.filter((b) => b.ok);
  const cycles = [...new Set(all.map((b) => b.cycles))];
  if (own.length < 8) return { count: own.length, total: all.length, cycles, far: 0, spreadMs: NaN, sdMs: NaN };
  const period = 3600 / bph;
  const ts = own.map((b) => b.t);
  const ys = own.map((b) => (b.n * period - b.t) * 1000);
  const fit = robustLine(ts, ys);
  const left = Float64Array.from(ys, (y, i) => y - fit.a - fit.b * ts[i]);
  const trend = runningMedian(left, 15);
  const off = Array.from(left, (y, i) => Math.abs(y - trend[i]));
  return {
    count: own.length,
    total: all.length,
    cycles,
    far: off.filter((d) => d > 1).length,
    spreadMs: 1.4826 * median(off),
    sdMs: Math.sqrt(off.reduce((sum, d) => sum + d * d, 0) / off.length),
  };
}

/**
 * How closely the timestamps of one beat type follow when the beats really fell, for a
 * synthetic watch whose true beat times are known. Each timestamp is compared with the mean
 * true time of the cycles it averages; the comparison takes out one constant, the distance
 * between the beat's timing point and its sound at `dt` 0.
 * @param {Beat[]} beats
 * @param {Float64Array} beatTimes true time of every beat, ticks and tocks alternating
 * @param {number} truePeriod true beat period in seconds
 * @param {0|1} type
 * @returns {{count: number, errorMs: number, wrong: number, follows: number}} the number of
 *   confident timestamps compared; their root-mean-square error; how many are off by more than
 *   0.5 ms; and the slope of their displacements against the true displacements, which is 1
 *   when the trace shows the watch's irregularity in full and 0 when it hides it
 */
export function againstTruth(beats, beatTimes, truePeriod, type) {
  /** @type {{error: number, shown: number, real: number}[] | null} */
  let best = null;
  let bestRms = Infinity;
  // Which parity of the true beats is this type: the one that fits.
  for (const parity of [0, 1]) {
    const times = beatTimes.filter((_, k) => k % 2 === parity);
    const start = 0.137 + parity * truePeriod;
    /** @type {{measured: number, real: number}[]} */
    const pairs = [];
    for (const b of beats) {
      if (b.type !== type || !b.ok) continue;
      const centre = (b.t - start) / (2 * truePeriod);
      const lo = Math.round(centre - (b.cycles - 1) / 2);
      const hi = lo + b.cycles - 1;
      if (lo < 0 || hi >= times.length) continue;
      let real = 0;
      let nominal = 0;
      for (let i = lo; i <= hi; i++) {
        real += times[i];
        nominal += start + 2 * i * truePeriod;
      }
      pairs.push({ measured: b.t - nominal / b.cycles, real: real / b.cycles - nominal / b.cycles });
    }
    if (pairs.length === 0) continue;
    const shift = median(pairs.map((p) => p.measured - p.real));
    const list = pairs.map((p) => ({ error: (p.measured - shift - p.real) * 1000, shown: (p.measured - shift) * 1000, real: p.real * 1000 }));
    const rms = Math.sqrt(list.reduce((sum, p) => sum + p.error ** 2, 0) / list.length);
    if (rms < bestRms) {
      bestRms = rms;
      best = list;
    }
  }
  if (!best) return { count: 0, errorMs: NaN, wrong: 0, follows: NaN };
  const mx = best.reduce((sum, p) => sum + p.real, 0) / best.length;
  const my = best.reduce((sum, p) => sum + p.shown, 0) / best.length;
  let sxy = 0;
  let sxx = 0;
  for (const p of best) {
    sxy += (p.real - mx) * (p.shown - my);
    sxx += (p.real - mx) ** 2;
  }
  return { count: best.length, errorMs: bestRms, wrong: best.filter((p) => Math.abs(p.error) > 0.5).length, follows: sxx > 0 ? sxy / sxx : NaN };
}
