// Offline analysis of a whole recording: runs every pipeline stage once over the full audio.
// The real-time pipeline (js/dsp/pipeline.js) runs the same stages on a sliding
// window.

import { FilterBank } from './filterbank.js';
import { Cleanup } from './cleanup.js';
import { acquire, chooseCandidate, refinePeriod, STANDARD_RATES } from './acquire.js';
import { buildTemplate, buildSplitTemplates, findClusters } from './template.js';
import { trackBeats, medianZ, LAG_MS } from './timing.js';
import { alignBeats, continueBeats } from './irregular.js';
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
 * @property {boolean} irregular true when single beats fall at scattered times; every timestamp
 *   is then one beat, and beats too faint to be timed alone are left out
 * @property {(number|null)[] | null} scatterMs with `irregular`: scatter of the single beats of
 *   each beat type in milliseconds
 * @property {number} lagMs how far either side of its expected position each beat was looked for
 * @property {BeatSeries[]} beats timestamps of the ticks and of the tocks
 * @property {(BeatFit|null)[]} fits rate fit of each beat type
 * @property {number|null} rate seconds per day, positive when gaining
 * @property {number|null} rateSd statistical uncertainty of the rate
 * @property {number|null} jitterMs scatter of the timestamps about the fitted line
 * @property {number|null} beatErrorMs gap between the tick and tock trace lines; null when unreliable
 * @property {number|null} beatOffsetMs signed offset of the tocks from the midpoint between ticks
 * @property {{offsetMs: number, offsetSdMs: number, similarity: number, halfway: boolean}|null} beatErrorDetail
 *   the raw tick-tock comparison, kept even when the beat error is judged unreliable; `halfway`
 *   when a beat lies halfway between the tick and the tock
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
 * @param {{bph?: number, acquireWith?: typeof acquire, accept?: (c: import('./acquire.js').Candidate) => boolean, periodPpm?: number, refineSpan?: number, escapement?: import('./estimate.js').Escapement, timing?: TimingOptions, irregular?: import('./irregular.js').KnownIrregular | null}} [options]
 *   `irregular`, with `bph`, is set when the last analysis of the same watch found it irregular;
 *   `accept` can reject the chosen beat rate before the costly stages run; `periodPpm` with `bph`
 *   skips the beat-rate search when the period is already known approximately; `timing` as in
 *   `trackBeats`
 * @returns {(Omit<Analysis, 'sampleRate'> & {period: number, split: [Float32Array[], Float32Array[]] | null, tracks: import('./timing.js').BeatTrack[]}) | null}
 *   `split` holds the folded half templates, and is null when the analysis did not fold
 *   null when `accept` rejected the candidate
 */
export function analyzeRows(rows, fe, toSeconds, options = {}) {
  const { bph: forcedBph, acquireWith = acquire, accept, periodPpm: knownPpm, refineSpan = 30, escapement = 'lever', timing = {}, irregular: known = null } = options;
  const follow = timing.followScatter !== false;
  let bph = forcedBph || 0;
  /** @type {import('./acquire.js').Candidate[]} */
  let acquisition = [];
  let periodPpm = knownPpm || 0;
  let period = 0;
  /** @type {Float32Array[]} */
  let template = [];
  /** @type {[number, number]} */
  let clusters = [0, 0];
  /** @type {[Float32Array[], Float32Array[]] | null} */
  let split = null;
  /** @type {import('./timing.js').BeatTrack[]} */
  let tracks = [];
  let lagMs = LAG_MS;
  /** @type {(number|null)[] | null} */
  let scatterMs = null;

  // A watch already known to be irregular is taken up from the beats timed so far.
  const continued = follow && known && forcedBph ? continueBeats(rows, fe, known, timing) : null;
  if (continued) {
    ({ period, clusters, template, tracks, lagMs, scatterMs } = continued);
    periodPpm = (period / (2 * (3600 / bph) * fe) - 1) * 1e6;
  } else {
    // Stage 4.
    /** @type {number[]} */
    let starts = [knownPpm || 0];
    if (!(forcedBph && knownPpm !== undefined)) {
      acquisition = acquireWith(rows, fe, { candidates: forcedBph ? [forcedBph] : STANDARD_RATES });
      const best = chooseCandidate(acquisition);
      if (accept && !accept(best)) return null;
      bph = best.bph;
      starts = [best.ppm, ...best.rivals];
    }
    // The finer search settles any near-tie between neighbouring periods.
    let refined = { ppm: starts[0], stat: -Infinity };
    for (const ppm0 of starts) {
      const r = refinePeriod(rows, fe, 2 * (3600 / bph), ppm0, { span: refineSpan });
      if (r.stat > refined.stat) refined = r;
    }
    periodPpm = refined.ppm;
    period = 2 * (3600 / bph) * fe * (1 + periodPpm * 1e-6);

    // Stages 5 to 7. If both beat types can be timed almost beat by beat, rebuild the template
    // with every cycle aligned on its own measured timing, then time the beats again.
    // The full template locates the tick and the tock. Timing uses two half templates so that
    // no cycle is matched against a template containing its own noise.
    template = buildTemplate(rows, period);
    clusters = findClusters(template, fe);
    split = buildSplitTemplates(rows, period);
    const halves = split;
    tracks = clusters.map((c) => trackBeats(rows, fe, period, halves, c, timing));
    if (tracks.every((tr) => tr.K <= 2 && tr.lag.length > 9)) {
      const n0 = Math.min(tracks[0].lag.length, tracks[1].lag.length);
      const meanLag = new Float64Array(n0);
      for (let i = 0; i < n0; i++) meanLag[i] = 0.5 * (tracks[0].lag[i] + tracks[1].lag[i]);
      const shifts = medfilt(meanLag, 9);
      const length = Math.floor(n0 * period + template[0].length);
      template = buildTemplate(rows, period, shifts, length);
      clusters = findClusters(template, fe);
      const aligned = buildSplitTemplates(rows, period, shifts, length);
      split = aligned;
      tracks = clusters.map((c) => trackBeats(rows, fe, period, aligned, c, timing));
    }

    // A watch whose beats fall at scattered times is timed beat by beat instead.
    if (follow) {
      const aligned = alignBeats(rows, fe, period, { template, clusters, split, tracks }, timing);
      if (aligned) ({ template, tracks, lagMs, scatterMs } = aligned);
    }
  }
  const nominalPeriod = 3600 / bph;

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
  const readings = summarize(beats, nominalPeriod, template, clusters, fe, escapement, 0, scatterMs !== null);
  return {
    envelopeRate: fe,
    acquisition,
    bph,
    periodPpm,
    locked: readings.fits.some((f) => f !== null),
    irregular: scatterMs !== null,
    scatterMs,
    lagMs,
    beats,
    ...readings,
    template,
    clusters,
    period,
    split,
    tracks,
  };
}
