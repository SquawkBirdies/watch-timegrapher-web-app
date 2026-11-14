// Command-line check: node tools/run-analysis.js <file.wav> [startSeconds] [endSeconds] [bph]
// Prints the readings the offline pipeline produces for a recording.

import { readWav } from '../tests/helpers/wav.js';
import { analyze } from '../js/dsp/offline.js';

const [path, start, end, bph] = process.argv.slice(2);
if (!path) {
  console.error('usage: node tools/run-analysis.js <file.wav> [startSeconds] [endSeconds] [bph]');
  process.exit(1);
}
const wav = readWav(path);
const t0 = performance.now();
const r = analyze(wav.channels, wav.sampleRate, {
  startSeconds: start ? Number(start) : 0,
  endSeconds: end ? Number(end) : undefined,
  bph: bph ? Number(bph) : undefined,
});
const elapsed = (performance.now() - t0) / 1000;
for (const a of r.acquisition) console.log(`  candidate ${a.bph} bph: best ${a.ppm.toFixed(1)} ppm, stat ${a.stat.toFixed(1)}, z ${a.z.toFixed(1)}, second cluster z ${a.secondZ.toFixed(1)}`);
console.log(`beat rate ${r.bph} bph, period error ${r.periodPpm.toFixed(2)} ppm, locked ${r.locked}`);
r.beats.forEach((b, j) => {
  const f = r.fits[j];
  console.log(`  ${j === 0 ? 'tick' : 'tock'}: averaged ${b.K} cycle(s), ${(100 * b.confidentFraction).toFixed(0)}% confident` + (f ? `, rate ${f.rate.toFixed(2)} +- ${f.rateSd.toFixed(2)} s/d, scatter ${f.jitterMs.toFixed(3)} ms, ${f.count} dots` : ', not trackable'));
});
console.log(`rate ${r.rate === null ? 'n/a' : r.rate.toFixed(2)} s/d (+- ${r.rateSd === null ? 'n/a' : r.rateSd.toFixed(2)}), beat error ${r.beatErrorMs === null ? 'not reported' : r.beatErrorMs.toFixed(3) + ' ms'}` + (r.beatErrorDetail ? ` (offset ${r.beatErrorDetail.offsetMs.toFixed(3)} +- ${r.beatErrorDetail.offsetSdMs.toFixed(3)} ms, similarity ${r.beatErrorDetail.similarity.toFixed(2)})` : ''));
console.log(`elapsed ${elapsed.toFixed(1)} s`);
