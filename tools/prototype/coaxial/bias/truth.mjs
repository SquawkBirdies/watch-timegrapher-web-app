// Swing-bias check: the true time of every beat's unlock and lock in a simulated watch.
//
//   node tools/prototype/coaxial/bias/truth.mjs <coaxial|lever> <prefix> ['<json overrides>']
//
// Makes the same watch as `beats.mjs sim` with the same overrides and seed, and writes
// <prefix>.events.json: the unlock and lock times of every beat, in seconds, with each beat
// type's mean lift time and the mean amplitude. `beats.mjs sim` keeps only their averages in <prefix>.truth.json,
// which is not enough to see where in a swing each beat's sounds fell. The audio is not written
// again: run `beats.mjs sim` with the same prefix for the audio and the app's timestamps.

import { writeFileSync } from 'node:fs';
import { synthesizeBalanceWatch, coaxialWatch, leverWatch } from '../../../../tests/helpers/balance.js';

const [kind, prefix, json] = process.argv.slice(2);
if (!prefix || (kind !== 'coaxial' && kind !== 'lever')) {
  console.error("usage: node tools/prototype/coaxial/bias/truth.mjs <coaxial|lever> <prefix> ['<json overrides>']");
  process.exit(1);
}
const over = json ? JSON.parse(json) : {};
// The amplitude overrides are read as beats.mjs reads them, so that the same overrides make the
// same watch.
if (over.amplitudeSwing) {
  const { base, swing, period } = over.amplitudeSwing;
  over.amplitude = (/** @type {number} */ t) => base + swing * Math.sin((2 * Math.PI * t) / period);
  delete over.amplitudeSwing;
}
if (over.amplitudeRamp) {
  const { from, to, t0, t1 } = over.amplitudeRamp;
  over.amplitude = (/** @type {number} */ t) => (t <= t0 ? from : t >= t1 ? to : from + ((to - from) * (t - t0)) / (t1 - t0));
  delete over.amplitudeRamp;
}
const options = kind === 'lever' ? leverWatch(over) : coaxialWatch(over);
const { truth } = synthesizeBalanceWatch(options);
writeFileSync(`${prefix}.events.json`, JSON.stringify({
  unlock: Array.from(truth.unlock),
  lock: Array.from(truth.lock),
  liftMs: truth.liftMs,
  meanAmplitude: truth.meanAmplitude,
}));
console.log(`${prefix}.events.json: ${truth.unlock.length} beats, mean lift ${truth.liftMs.map((v) => v.toFixed(3)).join(' and ')} ms, ` +
  `mean amplitude ${truth.meanAmplitude.toFixed(1)} degrees`);
