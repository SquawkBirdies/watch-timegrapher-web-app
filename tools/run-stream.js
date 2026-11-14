// Command-line check of the real-time pipeline:
//   node tools/run-stream.js <file.wav> [startSeconds] [endSeconds] [chunkSamples] [historySeconds] [bph]
// Give 0 for chunkSamples or historySeconds to keep the default. bph overrides the beat-rate search.
// Feeds a recording to the pipeline in small chunks and prints what it reports.

import { readWav } from '../tests/helpers/wav.js';
import { Pipeline } from '../js/dsp/pipeline.js';

const [path, start, end, chunk, history, bph] = process.argv.slice(2);
if (!path) {
  console.error('usage: node tools/run-stream.js <file.wav> [startSeconds] [endSeconds] [chunkSamples] [historySeconds] [bph]');
  process.exit(1);
}
const wav = readWav(path);
const from = Math.round(Number(start || 0) * wav.sampleRate);
const to = end ? Math.min(wav.channels[0].length, Math.round(Number(end) * wav.sampleRate)) : wav.channels[0].length;
const size = Number(chunk) || 128;
/** @type {import('../js/dsp/pipeline.js').PipelineOptions} */
const options = {};
if (Number(history)) Object.assign(options, { historySeconds: Number(history), averagingSeconds: Number(history) });
if (Number(bph)) options.bph = Number(bph);
const pipeline = new Pipeline(wav.sampleRate, wav.channels.length, options);
const t0 = performance.now();
let beats = 0;
/** @type {import('../js/dsp/pipeline.js').ReadingsEvent | null} */
let last = null;
let lastPrinted = -Infinity;
for (let i = from; i < to; i += size) {
  const events = pipeline.push(wav.channels.map((c) => c.subarray(i, Math.min(to, i + size))));
  for (const e of events) {
    if (e.type === 'status') console.log(`${e.t.toFixed(1).padStart(6)} s  ${e.state}${e.bph ? `, ${e.bph} bph, cycles averaged ${e.cyclesAveraged?.map((k) => k ?? '-').join('/')}` : ''} (${e.reason})`);
    if (e.type === 'beats') beats += e.beats.length;
    if (e.type === 'readings') {
      last = e;
      if (e.t - lastPrinted >= 5 || e.rate === null) {
        lastPrinted = e.t;
        console.log(`${e.t.toFixed(1).padStart(6)} s  rate ${e.rate === null ? 'blank' : e.rate.toFixed(2) + ' +- ' + (e.rateSd ?? 0).toFixed(2) + ' s/d'}, beat error ${e.beatErrorMs === null ? 'blank' : e.beatErrorMs.toFixed(2) + ' ms'}, scatter ${e.jitterMs === null ? '-' : e.jitterMs.toFixed(3) + ' ms'}`);
      }
    }
  }
}
const elapsed = (performance.now() - t0) / 1000;
const audio = (to - from) / wav.sampleRate;
if (last) console.log(`final: rate ${last.rate === null ? 'blank' : last.rate.toFixed(2) + ' +- ' + (last.rateSd ?? 0).toFixed(2)}, beat error ${last.beatErrorMs === null ? 'blank' : last.beatErrorMs.toFixed(3)}, dots ${last.fits.map((f) => (f ? f.count : 0)).join('/')}`);
const consistency = pipeline.tracker ? pipeline.tracker.consistency : [];
console.log(`${beats} beats reported; tracker consistency ${consistency.length ? (consistency.reduce((s, v) => s + v, 0) / consistency.length).toFixed(2) : 'n/a'}`);
console.log(`${audio.toFixed(1)} s of audio in ${elapsed.toFixed(1)} s (${(audio / elapsed).toFixed(1)}x real time; ${pipeline.analysisSeconds.toFixed(1)} s in lock analyses)`);
