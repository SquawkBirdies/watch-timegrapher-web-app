// Command-line check: node tools/run-analysis.js <file.wav> [startSeconds] [endSeconds] [bph] [liftAngle]
// Prints the readings the offline pipeline produces for a recording. With a lift angle in
// degrees it also prints what the sounds inside each beat give: the beat error from the unlocks
// and the amplitude. Give 0 for endSeconds to read to the end, and 0 for bph to have the beat
// rate detected.

import { readWav } from '../tests/helpers/wav.js';
import { analyze } from '../js/dsp/offline.js';
import { MIN_BEATS } from '../js/dsp/amplitude.js';

const [path, start, end, bph, liftAngle] = process.argv.slice(2);
if (!path) {
  console.error('usage: node tools/run-analysis.js <file.wav> [startSeconds] [endSeconds] [bph] [liftAngle]');
  process.exit(1);
}

/**
 * What the sounds inside the beats gave, as lines of text.
 * @param {import('../js/dsp/amplitude.js').SoundsReading} s
 * @returns {string[]}
 */
function describeSounds(s) {
  const [lo, hi] = s.liftLimitsMs;
  const lines = [`sounds inside the beats at ${s.liftAngle} degrees of lift (plain average: no scatter, no gates yet)`];
  /** @type {Record<import('../js/dsp/amplitude.js').NoReading, string>} */
  const reasons = {
    'few-beats': `too few beats timed: ${s.counts[0]} ticks and ${s.counts[1]} tocks, against at least ${MIN_BEATS} of each`,
    averaged: 'the timestamps average several cycles, so no single beat can be placed',
    'short-stretch': 'at this beat rate and lift angle the unlock could lie before the stretch read around each beat',
    'few-sounds': 'fewer than two sounds in a beat',
    'no-pair': 'no two sounds the same time after the first in both beats',
    'lift-range': `time from first sound to lock (${(s.refusedLiftMs || []).map((v) => v.toFixed(1)).join(' and ')} ms) outside ${lo.toFixed(1)} to ${hi.toFixed(1)} ms`,
    'no-middle-sound': 'nothing between the first sound and the lock in a beat, so the first may be the impulse',
  };
  if (s.beats && s.weights && s.timestampGapMs !== null) {
    lines.push(`  ${s.counts[0]} ticks and ${s.counts[1]} tocks averaged; the tocks' timestamps ${signed(s.timestampGapMs, 3)} ms from midway; believable unlock to lock ${lo.toFixed(1)} to ${hi.toFixed(1)} ms`);
    lines.push(`  band weights ${Array.from(s.weights, (w) => w.toFixed(2)).join(' ')}`);
    s.beats.forEach((b, j) => {
      for (const e of b.sounds) lines.push(`  ${j === 0 ? 'tick' : 'tock'} sound: starts ${signed(e.onsetMs, 2)} ms, loudest ${signed(e.peakMs, 2)} ms, ${e.levelDb.toFixed(1)} dB over the noise of the average`);
    });
  }
  if (s.why !== null) {
    lines.push(`  no reading: ${reasons[s.why]}`);
    return lines;
  }
  if (s.unlockGapMs === null || s.lockGapMs === null || !s.liftMs || s.amplitude === null || !s.amplitudes || s.unlockDb === null) return lines;
  lines.push(`  beat error from the unlocks ${Math.abs(s.unlockGapMs).toFixed(2)} ms (the tock's unlock ${signed(s.unlockGapMs, 3)} ms from midway); the locks ${signed(s.lockGapMs, 2)} ms`);
  lines.push(`  unlock to lock: tick ${s.liftMs[0].toFixed(2)} ms, tock ${s.liftMs[1].toFixed(2)} ms, ratio ${(s.liftMs[0] / s.liftMs[1]).toFixed(3)}`);
  lines.push(`  amplitude ${s.amplitude.toFixed(0)} degrees (tick alone ${s.amplitudes[0].toFixed(0)}, tock alone ${s.amplitudes[1].toFixed(0)}); the weaker unlock stands ${s.unlockDb.toFixed(1)} dB over the noise of the average`);
  return lines;
}

/** @param {number} v @param {number} digits */
const signed = (v, digits) => (v < 0 ? '' : '+') + v.toFixed(digits);

const wav = readWav(path);
const t0 = performance.now();
const r = analyze(wav.channels, wav.sampleRate, {
  startSeconds: start ? Number(start) : 0,
  endSeconds: Number(end) ? Number(end) : undefined,
  bph: Number(bph) ? Number(bph) : undefined,
  liftAngle: liftAngle ? Number(liftAngle) : undefined,
});
const elapsed = (performance.now() - t0) / 1000;
for (const a of r.acquisition) console.log(`  candidate ${a.bph} bph: best ${a.ppm.toFixed(1)} ppm, stat ${a.stat.toFixed(1)}, z ${a.z.toFixed(1)}, second cluster z ${a.secondZ.toFixed(1)}`);
console.log(`beat rate ${r.bph} bph, period error ${r.periodPpm.toFixed(2)} ppm, locked ${r.locked}`);
r.beats.forEach((b, j) => {
  const f = r.fits[j];
  console.log(`  ${j === 0 ? 'tick' : 'tock'}: averaged ${b.K} cycle(s), ${(100 * b.confidentFraction).toFixed(0)}% confident` + (f ? `, rate ${f.rate.toFixed(2)} +- ${f.rateSd.toFixed(2)} s/d, scatter ${f.jitterMs.toFixed(3)} ms, ${f.count} dots` : ', not trackable'));
});
console.log(`rate ${r.rate === null ? 'n/a' : r.rate.toFixed(2)} s/d (+- ${r.rateSd === null ? 'n/a' : r.rateSd.toFixed(2)}), beat error ${r.beatErrorMs === null ? 'not reported' : r.beatErrorMs.toFixed(3) + ' ms'}` + (r.beatErrorDetail ? ` (offset ${r.beatErrorDetail.offsetMs.toFixed(3)} +- ${r.beatErrorDetail.offsetSdMs.toFixed(3)} ms, similarity ${r.beatErrorDetail.similarity.toFixed(2)})` : ''));
if (r.sounds) for (const line of describeSounds(r.sounds)) console.log(line);
console.log(`elapsed ${elapsed.toFixed(1)} s`);
