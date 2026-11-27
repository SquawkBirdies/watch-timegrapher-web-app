// Command-line check of the real-time pipeline:
//   node tools/run-stream.js <file.wav> [startSeconds] [endSeconds] [chunkSamples] [historySeconds] [bph] [liftAngle] [share]
// Give 0 for endSeconds, chunkSamples, historySeconds or bph to keep the default. bph overrides
// the beat-rate search. With a lift angle, in degrees, the sounds inside each beat are read too,
// for the beat error from the unlocks and the amplitude; each reading then takes `share` of real
// time, or is finished at once when no share is given, so that the output is the same on every
// computer. One still in progress where the audio ends is finished there, as in the app.
// Feeds a recording to the pipeline in small chunks and prints what it reports.

import { readWav } from '../tests/helpers/wav.js';
import { Pipeline } from '../js/dsp/pipeline.js';

const [path, start, end, chunk, history, bph, liftAngle, share] = process.argv.slice(2);
if (!path) {
  console.error('usage: node tools/run-stream.js <file.wav> [startSeconds] [endSeconds] [chunkSamples] [historySeconds] [bph] [liftAngle] [share]');
  process.exit(1);
}
const wav = readWav(path);
const from = Math.round(Number(start || 0) * wav.sampleRate);
const to = Number(end) ? Math.min(wav.channels[0].length, Math.round(Number(end) * wav.sampleRate)) : wav.channels[0].length;
const size = Number(chunk) || 128;
/** @type {import('../js/dsp/pipeline.js').PipelineOptions} */
const options = {};
if (Number(history)) Object.assign(options, { historySeconds: Number(history), averagingSeconds: Number(history) });
if (Number(bph)) options.bph = Number(bph);
if (Number(liftAngle)) Object.assign(options, { liftAngle: Number(liftAngle), sounds: { share: Number(share) || Infinity } });
const pipeline = new Pipeline(wav.sampleRate, wav.channels.length, options);
const t0 = performance.now();
let beats = 0;
/** @type {import('../js/dsp/pipeline.js').ReadingsEvent | null} */
let last = null;
let lastPrinted = -Infinity;
/** The end of the latest reading of the sounds that was printed. */
let soundsPrinted = -Infinity;
/** Which beat type the pipeline last said was the tick; undefined before any reading. */
let tick = /** @type {0|1|null|undefined} */ (undefined);
/** @param {number|null} v @param {number} digits */
const fixed = (v, digits) => (v === null ? '-' : v.toFixed(digits));
/** @param {import('../js/dsp/pipeline.js').PipelineEvent[]} events */
const show = (events) => {
  for (const e of events) {
    if (e.type === 'status') console.log(`${e.t.toFixed(1).padStart(6)} s  ${e.state}${e.bph ? `, ${e.bph} bph, cycles averaged ${e.cyclesAveraged?.map((k) => k ?? '-').join('/')}` : ''} (${e.reason})`);
    if (e.type === 'beats') beats += e.beats.length;
    if (e.type === 'readings') {
      last = e;
      if (e.window !== null && e.tick !== tick) {
        tick = e.tick;
        console.log(`${e.t.toFixed(1).padStart(6)} s  ${tick === null ? 'the beats have no names' : `the tick is beat type ${tick}`}`);
      }
      if (e.t - lastPrinted >= 5 || e.rate === null) {
        lastPrinted = e.t;
        console.log(`${e.t.toFixed(1).padStart(6)} s  rate ${e.rate === null ? 'blank' : e.rate.toFixed(2) + ' +- ' + (e.rateSd ?? 0).toFixed(2) + ' s/d'}, beat error ${e.beatErrorMs === null ? 'blank' : e.beatErrorMs.toFixed(2) + ' ms'}, scatter ${e.jitterMs === null ? '-' : e.jitterMs.toFixed(3) + ' ms'}`);
      }
      const s = e.sounds;
      if (s && s.window && s.detail && s.window[1] !== soundsPrinted) {
        soundsPrinted = s.window[1];
        const d = s.detail;
        console.log(
          `${e.t.toFixed(1).padStart(6)} s  sounds of the beats from ${s.window[0].toFixed(1)} to ${s.window[1].toFixed(1)} s (${d.counts.join(' and ')}): ` +
            (d.why !== null
              ? `no reading (${d.why})`
              : `beat error ${s.beatErrorMs === null ? `held (${s.beatErrorWhy})` : 'shown'} ${fixed(d.beatOffsetMs, 3)} +- ${fixed(d.beatErrorSd, 3)} ms, amplitude ${s.amplitude === null ? `held (${s.amplitudeWhy})` : 'shown'} ${fixed(d.amplitude, 1)} +- ${fixed(d.amplitudeSd, 1)} deg, ` +
                `unlock to lock ${d.liftMs ? d.liftMs.map((v) => v.toFixed(2)).join(' and ') : '-'} ms, ${d.lining}, failing ${fixed(d.failing, 3)}, unlock ${fixed(d.unlockDb, 1)} dB`) +
            `; ${d.computeSeconds.toFixed(2)} s of computing over ${d.audioSeconds.toFixed(1)} s of audio`,
        );
      }
    }
  }
};
for (let i = from; i < to; i += size) show(pipeline.push(wav.channels.map((c) => c.subarray(i, Math.min(to, i + size)))));
// As the app does where a recording ends: a reading of the sounds still in progress is finished.
show(pipeline.finish());
const elapsed = (performance.now() - t0) / 1000;
const audio = (to - from) / wav.sampleRate;
if (last) console.log(`final: rate ${last.rate === null ? 'blank' : last.rate.toFixed(2) + ' +- ' + (last.rateSd ?? 0).toFixed(2)}, beat error ${last.beatErrorMs === null ? 'blank' : last.beatErrorMs.toFixed(3)}, dots ${last.fits.map((f) => (f ? f.count : 0)).join('/')}`);
const consistency = pipeline.tracker ? pipeline.tracker.consistency : [];
console.log(`${beats} beats reported; tracker consistency ${consistency.length ? (consistency.reduce((s, v) => s + v, 0) / consistency.length).toFixed(2) : 'n/a'}`);
const stage = pipeline.sounds ? pipeline.sounds.load() : null;
console.log(
  `${audio.toFixed(1)} s of audio in ${elapsed.toFixed(1)} s (${(audio / elapsed).toFixed(1)}x real time; ${pipeline.analysisSeconds.toFixed(1)} s in lock analyses` +
    (stage ? `; ${stage.seconds.toFixed(1)} s in ${stage.readings} readings of the sounds, longest step ${(1e3 * stage.longestStepSeconds).toFixed(0)} ms` : '') +
    ')',
);
