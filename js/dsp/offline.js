// Offline analysis of a whole recording: runs every pipeline stage once over the full audio.
// The real-time pipeline (js/dsp/pipeline.js) runs the same stages on a sliding
// window.

import { FilterBank } from './filterbank.js';
import { Cleanup } from './cleanup.js';
import { acquire, chooseCandidate, refinePeriod, STANDARD_RATES } from './acquire.js';
import { buildTemplate, buildSplitTemplates, findClusters } from './template.js';
import { trackBeats, medianZ } from './timing.js';
import { summarize } from './estimate.js';
import { medfilt } from './mathutil.js';

/**
 * @typedef {import('./estimate.js').BeatSeries} BeatSeries
 * @typedef {import('./estimate.js').BeatFit} BeatFit
 */

/**
 * @typedef {Object} Analysis
 * @property {number} sampleRate audio sample rate in hertz
 * @property {number} envelopeRate envelope sample rate in hertz
 * @property {import('./acquire.js').Candidate[]} acquisition best trial per beat rate
 * @property {number} bph detected (or forced) beat rate
 * @property {number} periodPpm refined period error in parts per million
 * @property {boolean} locked true when at least one beat type could be timed
 * @property {BeatSeries[]} beats timestamps of the ticks and of the tocks
 * @property {(BeatFit|null)[]} fits rate fit of each beat type
 * @property {number|null} rate seconds per day, positive when gaining
 * @property {number|null} rateSd statistical uncertainty of the rate
 * @property {number|null} jitterMs scatter of the timestamps about the fitted line
 * @property {number|null} beatErrorMs gap between the tick and tock trace lines; null when unreliable
 * @property {number|null} beatOffsetMs signed offset of the tocks from the midpoint between ticks
 * @property {{offsetMs: number, offsetSdMs: number, similarity: number}|null} beatErrorDetail
 *   the raw tick-tock comparison, kept even when the beat error is judged unreliable
 * @property {Float32Array[]} template averaged tick-tock cycle per band and channel
 * @property {[number, number]} clusters tick and tock positions in the template, in samples
 */

export { MAX_OFFSET_SD_MS, MIN_SIMILARITY, MAX_SCATTER_MS } from './estimate.js';

/** @typedef {import('./timing.js').TimingOptions} TimingOptions */

/**
 * Analyse a recording.
 * @param {ArrayLike<number>[]} channels one array of samples per channel
 * @param {number} sampleRate
 * @param {{humHz?: number, bph?: number, startSeconds?: number, endSeconds?: number, bands?: number[][], escapement?: import('./estimate.js').Escapement, timing?: TimingOptions}} [options]
 *   `bands` replaces the filter bank's band edges in hertz; `escapement` as in `summarize`;
 *   `timing` as in `trackBeats`
 * @returns {Analysis}
 */
export function analyze(channels, sampleRate, options = {}) {
  const { humHz = 60, bph: forcedBph, startSeconds = 0, endSeconds, bands, escapement, timing } = options;
  const from = Math.max(0, Math.round(startSeconds * sampleRate));
  const to = Math.min(channels[0].length, endSeconds === undefined ? Infinity : Math.round(endSeconds * sampleRate));
  const audio = channels.map((c) => Float32Array.from(/** @type {any} */ (c).subarray ? /** @type {any} */ (c).subarray(from, to) : Array.prototype.slice.call(c, from, to)));

  // Stages 2 and 3.
  const bank = new FilterBank(sampleRate, audio.length, bands ? { bands } : {});
  const cleanup = new Cleanup(bank.envelopeRate, bank.rowCount, { humHz });
  const rows = cleanup.process(bank.process(audio));
  const fe = bank.envelopeRate;

  const dec = bank.decimation;
  /** @param {number} p position in cleaned-envelope samples */
  const toSeconds = (p) => ((p + cleanup.delay) * dec + (dec - 1) / 2 + from) / sampleRate;
  const result = analyzeRows(rows, fe, toSeconds, { bph: forcedBph, escapement, timing });
  if (!result) throw new Error('unreachable: no accept filter was given');
  return { sampleRate, ...result };
}

/**
 * Stages 4 to 8 on a stretch of cleaned envelope rows. The real-time pipeline calls this on
 * its history buffer when it looks for a lock.
 * @param {Float32Array[]} rows cleaned envelope rows
 * @param {number} fe envelope sample rate in hertz
 * @param {(p: number) => number} toSeconds converts a position in `rows` to seconds
 * @param {{bph?: number, acquireWith?: typeof acquire, accept?: (c: import('./acquire.js').Candidate) => boolean, periodPpm?: number, refineSpan?: number, escapement?: import('./estimate.js').Escapement, timing?: TimingOptions}} [options]
 *   `accept` can reject the chosen beat rate before the costly stages run; `periodPpm` with `bph`
 *   skips the beat-rate search when the period is already known approximately; `timing` as in
 *   `trackBeats`
 * @returns {(Omit<Analysis, 'sampleRate'> & {period: number, split: [Float32Array[], Float32Array[]], tracks: import('./timing.js').BeatTrack[]}) | null}
 *   null when `accept` rejected the candidate
 */
export function analyzeRows(rows, fe, toSeconds, options = {}) {
  const { bph: forcedBph, acquireWith = acquire, accept, periodPpm: knownPpm, refineSpan = 30, escapement = 'lever', timing = {} } = options;
  // Stage 4.
  /** @type {import('./acquire.js').Candidate[]} */
  let acquisition = [];
  let bph = forcedBph || 0;
  /** @type {number[]} */
  let starts = [knownPpm || 0];
  if (!(forcedBph && knownPpm !== undefined)) {
    acquisition = acquireWith(rows, fe, { candidates: forcedBph ? [forcedBph] : STANDARD_RATES });
    const best = chooseCandidate(acquisition);
    if (accept && !accept(best)) return null;
    bph = best.bph;
    starts = [best.ppm, ...best.rivals];
  }
  const nominalPeriod = 3600 / bph;
  // The finer search settles any near-tie between neighbouring periods.
  let refined = { ppm: starts[0], stat: -Infinity };
  for (const ppm0 of starts) {
    const r = refinePeriod(rows, fe, 2 * nominalPeriod, ppm0, { span: refineSpan });
    if (r.stat > refined.stat) refined = r;
  }
  const periodPpm = refined.ppm;
  const period = 2 * nominalPeriod * fe * (1 + periodPpm * 1e-6);

  // Stages 5 to 7. If both beat types can be timed almost beat by beat, rebuild the template
  // with every cycle aligned on its own measured timing, then time the beats again.
  // The full template locates the tick and the tock. Timing uses two half templates so that no
  // cycle is matched against a template containing its own noise.
  let template = buildTemplate(rows, period);
  let clusters = findClusters(template, fe);
  let split = buildSplitTemplates(rows, period);
  let tracks = clusters.map((c) => trackBeats(rows, fe, period, split, c, timing));
  if (tracks.every((tr) => tr.K <= 2 && tr.lag.length > 9)) {
    const n0 = Math.min(tracks[0].lag.length, tracks[1].lag.length);
    const meanLag = new Float64Array(n0);
    for (let i = 0; i < n0; i++) meanLag[i] = 0.5 * (tracks[0].lag[i] + tracks[1].lag[i]);
    const shifts = medfilt(meanLag, 9);
    const length = Math.floor(n0 * period + template[0].length);
    template = buildTemplate(rows, period, shifts, length);
    clusters = findClusters(template, fe);
    split = buildSplitTemplates(rows, period, shifts, length);
    tracks = clusters.map((c) => trackBeats(rows, fe, period, split, c, timing));
  }

  /** @type {BeatSeries[]} */
  const beats = tracks.map((tr, j) => {
    const count = tr.lag.length;
    const t = new Float64Array(count);
    const n = new Float64Array(count);
    const ok = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const cycle = i + (tr.K - 1) / 2;
      t[i] = toSeconds(cycle * period + clusters[j] + tr.lag[i]);
      n[i] = 2 * cycle + j;
      ok[i] = tr.value[i] > tr.threshold ? 1 : 0;
    }
    return { type: /** @type {0|1} */ (j), K: tr.K, t, n, ok, z: tr.z, confidentFraction: tr.confidentFraction, zMedian: medianZ(tr) };
  });

  // Stage 8.
  const readings = summarize(beats, nominalPeriod, template, clusters, fe, escapement);
  return {
    envelopeRate: fe,
    acquisition,
    bph,
    periodPpm,
    locked: readings.fits.some((f) => f !== null),
    beats,
    ...readings,
    template,
    clusters,
    period,
    split,
    tracks,
  };
}
