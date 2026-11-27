// Command-line check:
//   node tools/run-analysis.js <file.wav> [startSeconds] [endSeconds] [bph] [liftAngle] [lineUp] [resamples] [placement]
// Prints the readings the offline pipeline produces for a recording. With a lift angle in
// degrees it also prints what the sounds inside each beat give: the beat error from the unlocks
// and the amplitude, with their scatter over the resamples and whether each may be shown. Give
// 0 for endSeconds to read to the end, and 0 for bph to have the beat rate detected. lineUp is
// `moved` (the default: beats are lined up again on the sounds whose 10 s blocks show them
// moving), `always` or `never`; resamples is 200 unless given, and 0 gives the reading alone.
// placement is `check` (the default: the beat error is read a second time with every beat on the
// trend of its timestamps, and the difference added to its scatter) or `none`.

import { readWav } from '../tests/helpers/wav.js';
import { analyze } from '../js/dsp/offline.js';
import { MIN_BEATS, BLOCK_SECONDS, MAX_SHIFT_SCATTER_MS } from '../js/dsp/amplitude.js';

const [path, start, end, bph, liftAngle, lineUp, resamples, placement] = process.argv.slice(2);
if (!path || (lineUp && !['moved', 'always', 'never'].includes(lineUp))) {
  console.error('usage: node tools/run-analysis.js <file.wav> [startSeconds] [endSeconds] [bph] [liftAngle] [moved|always|never] [resamples] [check|none]');
  process.exit(1);
}

/**
 * What the sounds inside the beats gave, as lines of text.
 * @param {import('../js/dsp/amplitude.js').SoundsReading} s
 * @returns {string[]}
 */
function describeSounds(s) {
  const [lo, hi] = s.liftLimitsMs;
  const lines = [`sounds inside the beats at ${s.liftAngle} degrees of lift`];
  /** @type {Record<import('../js/dsp/amplitude.js').NoReading, string>} */
  const reasons = {
    'few-beats': `too few beats timed: ${s.counts[0]} ticks and ${s.counts[1]} tocks, against at least ${MIN_BEATS} of each`,
    averaged: 'the timestamps average several cycles, so no single beat can be placed',
    'short-stretch': 'at this beat rate and lift angle the unlock could lie before the stretch read around each beat',
    'few-sounds': 'fewer than two sounds in a beat',
    'no-pair': 'no two sounds the same time after the first in both beats',
    'lift-range': `time from first sound to lock (${(s.refusedLiftMs || []).map((v) => v.toFixed(1)).join(' and ')} ms) outside ${lo.toFixed(1)} to ${hi.toFixed(1)} ms`,
    'no-middle-sound': 'nothing between the first sound and the lock in a beat, so the first may be the impulse',
    'lined-few-blocks': 'lined up, a sound was placed in fewer than two blocks',
    'lined-lost': 'a sound was lost in the lined-up average',
    'lined-far': 'a lined-up sound is too far from where the plain average put it',
  };
  /** @type {Record<import('../js/dsp/amplitude.js').Held, string>} */
  const held = {
    unchecked: 'no resamples to check it',
    failing: 'too many resamples do not find the sounds',
    irregular: 'the watch runs irregularly',
    halfway: 'a beat lies halfway between the tick and the tock, so the beat rate is half the watch\'s own',
    scatter: 'the resamples scatter too far',
    unplaced: 'with the beats on the trend of their timestamps the sounds were not found',
    placement: 'it moves too far with the beats on the trend of their timestamps',
  };
  if (s.beats && s.weights && s.timestampGapMs !== null) {
    lines.push(`  ${s.counts[0]} ticks and ${s.counts[1]} tocks averaged; the tocks' timestamps ${signed(s.timestampGapMs, 3)} ms from midway; believable unlock to lock ${lo.toFixed(1)} to ${hi.toFixed(1)} ms`);
    lines.push(`  band weights ${Array.from(s.weights, (w) => w.toFixed(2)).join(' ')}`);
    s.beats.forEach((b, j) => {
      for (const e of b.sounds) lines.push(`  ${j === 0 ? 'tick' : 'tock'} sound: starts ${signed(e.onsetMs, 2)} ms, loudest ${signed(e.peakMs, 2)} ms, ${e.levelDb.toFixed(1)} dB over the noise of the average`);
    });
  }
  const lining = s.lining;
  if (lining) {
    const tests = lining.moved
      ? ': ' + lining.moved.map((type, j) => type.map((m, k) => `${j === 0 ? 'tick' : 'tock'} ${k === 0 ? 'unlock' : 'lock'} ` +
        (Number.isNaN(m.chi2) ? 'not tested' : `${m.moved ? 'moves' : 'steady'} (${m.chi2.toFixed(1)} against ${m.limit.toFixed(1)} on ${m.dof})`)).join(', ')).join(', ')
      : '';
    if (lining.state === 'steady') lines.push(`  not lined up again, no sound moved over ${lining.blocks} blocks of ${BLOCK_SECONDS} s${tests}`);
    else if (lining.state === 'few-blocks') lines.push(`  not lined up again, a sound was placed in fewer than two blocks of ${BLOCK_SECONDS} s${tests}`);
    else lines.push(`  lined up again on ${lining.blocks} blocks of ${BLOCK_SECONDS} s` + (lining.leftOut ? `, leaving out ${lining.leftOut} shift${lining.leftOut === 1 ? '' : 's'} that scattered by more than ${MAX_SHIFT_SCATTER_MS} ms` : '') + tests);
  }
  if (s.why !== null) {
    lines.push(`  no reading: ${reasons[s.why]}`);
    return lines;
  }
  if (s.unlockGapMs === null || s.lockGapMs === null || !s.liftMs || s.amplitude === null || !s.amplitudes || s.unlockDb === null) return lines;
  const sd = s.scatter;
  /** @param {number|undefined} v @param {number} digits */
  const pm = (v, digits) => (v === undefined ? '' : ` +- ${v.toFixed(digits)}`);
  /** @param {import('../js/dsp/amplitude.js').Held|null} why */
  const back = (why) => (why === null ? '' : `  [held back: ${held[why]}]`);
  lines.push(`  beat error from the unlocks ${Math.abs(s.unlockGapMs).toFixed(2)}${pm(sd?.unlockGapMs, 2)} ms (the tock's unlock ${signed(s.unlockGapMs, 3)} ms from midway)${back(s.beatErrorHeld)}`);
  const placed = s.placement;
  if (placed && placed.unlockGapMs !== null && placed.differenceMs !== null && sd) {
    lines.push(`    with the beats on the trend of their timestamps: ${signed(placed.unlockGapMs, 3)} ms, ${signed(-placed.differenceMs, 3)} ms from the reading; scatter ${placed.resampledScatterMs.toFixed(3)} ms over the resamples, ${sd.unlockGapMs.toFixed(3)} ms with that difference`);
  } else if (placed && placed.why !== null) {
    lines.push(`    with the beats on the trend of their timestamps: no reading (${reasons[placed.why]})`);
  }
  lines.push(`  gap between the locks ${signed(s.lockGapMs, 2)}${pm(sd?.lockGapMs, 2)} ms`);
  lines.push(`  unlock to lock: tick ${s.liftMs[0].toFixed(2)}${pm(sd?.liftMs[0], 2)} ms, tock ${s.liftMs[1].toFixed(2)}${pm(sd?.liftMs[1], 2)} ms, ratio ${(s.liftMs[0] / s.liftMs[1]).toFixed(3)}`);
  lines.push(`  amplitude ${s.amplitude.toFixed(0)}${pm(sd?.amplitude, 0)} degrees (tick alone ${s.amplitudes[0].toFixed(0)}, tock alone ${s.amplitudes[1].toFixed(0)})${back(s.amplitudeHeld)}`);
  lines.push((s.failing === null || s.otherSound === null ? '  ' : `  resamples in which the sounds were not found: ${(100 * s.failing).toFixed(1)}% (another sound in ${(100 * s.otherSound).toFixed(1)}%); `) +
    `the weaker unlock stands ${s.unlockDb.toFixed(1)} dB over the noise of the average`);
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
  liftAngle: Number(liftAngle) ? Number(liftAngle) : undefined,
  sounds: { lineUp: /** @type {'moved'|'always'|'never'|undefined} */ (lineUp || undefined), resamples: resamples === undefined ? undefined : Number(resamples), placementCheck: placement !== 'none' },
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
