import { test } from 'node:test';
import assert from 'node:assert/strict';

import { median, percentile, medfilt, robustLine, quickselect, parabolicOffset } from '../js/dsp/mathutil.js';
import { Cascade, bandpassSections } from '../js/dsp/biquad.js';
import { FilterBank, DEFAULT_BANDS, fittedBands } from '../js/dsp/filterbank.js';
import { Cleanup } from '../js/dsp/cleanup.js';
import { chooseCandidate, acquire, acquireFast } from '../js/dsp/acquire.js';
import { synthesizeWatch } from '../js/audio/simulator.js';
import { seededRandom, gaussianFrom } from '../js/audio/simulator.js';

test('median, percentile and quickselect', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 99) - 4.96) < 1e-12);
  const a = Float64Array.from([9, 2, 7, 4, 5, 1]);
  assert.equal(quickselect(a, 2), 4);
});

test('median filter pads the edges with zeros', () => {
  assert.deepEqual(Array.from(medfilt([1, 5, 2, 8, 3], 3)), [1, 2, 5, 3, 3]);
});

test('parabolic peak offset', () => {
  assert.equal(parabolicOffset(1, 2, 1), 0);
  assert.ok(parabolicOffset(1, 2, 1.5) > 0);
  assert.equal(parabolicOffset(1, 0, 1), 0);
});

test('robust line fit ignores outliers', () => {
  const x = [];
  const y = [];
  for (let i = 0; i < 50; i++) {
    x.push(i);
    y.push(3 + 0.5 * i + (i % 10 === 7 ? 40 : 0));
  }
  const fit = robustLine(x, y);
  assert.ok(Math.abs(fit.b - 0.5) < 1e-9);
  assert.ok(Math.abs(fit.a - 3) < 1e-9);
});

/**
 * Gain of a filter at one frequency, measured with a sine wave.
 * @param {number} fs @param {number} lo @param {number} hi @param {number} f
 */
function gainAt(fs, lo, hi, f) {
  const n = 9600;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * f * i) / fs);
  const y = new Float64Array(n);
  new Cascade(bandpassSections(fs, lo, hi)).process(x, y);
  let e = 0;
  for (let i = n / 2; i < n; i++) e += y[i] * y[i];
  return Math.sqrt((2 * e) / (n / 2));
}

test('band-pass filter passes its band and rejects low frequencies', () => {
  const pass = 20 * Math.log10(gainAt(48000, 3500, 5000, 4200));
  const low = 20 * Math.log10(gainAt(48000, 3500, 5000, 300));
  const high = 20 * Math.log10(gainAt(48000, 3500, 5000, 12000));
  assert.ok(pass > -3 && pass < 0.5, `pass-band gain ${pass.toFixed(1)} dB`);
  assert.ok(low < -70, `300 Hz gain ${low.toFixed(1)} dB`);
  assert.ok(high < -25, `12 kHz gain ${high.toFixed(1)} dB`);
});

test('the filter bank keeps the bands below 0.47 of the sample rate, and cuts the top one to fit at 44.1 kHz', () => {
  const full = new FilterBank(48000, 2);
  assert.equal(full.rowCount, 18, 'all nine bands at 48 kHz, two channels');
  assert.deepEqual(full.bands, DEFAULT_BANDS, 'as they are');
  // Until milestone 8 the band to 22.5 kHz was dropped at 44.1 kHz. The Omega 3861's unlock
  // sounds mostly above 18 kHz, so the band is kept there as far as it fits.
  const cd = new FilterBank(44100, 1);
  assert.equal(cd.rowCount, 9);
  assert.deepEqual(cd.bands.slice(0, 8), DEFAULT_BANDS.slice(0, 8));
  assert.deepEqual(cd.bands[8], [18000, 0.47 * 44100], '18 to 20.7 kHz');
  // Less than half of a band left is not worth a band: at 16 kHz, 7 to 7.5 kHz.
  assert.equal(new FilterBank(16000, 1).rowCount, 4, 'Bluetooth-rate audio keeps the bands below 7.5 kHz');
  assert.deepEqual(fittedBands([[1000, 2000], [2000, 4000], [4000, 8000]], 10000), [[1000, 2000], [2000, 4000]], '0.7 of 4 kHz left: dropped');
  assert.deepEqual(fittedBands([[1000, 2000], [2000, 4000], [4000, 8000]], 13000), [[1000, 2000], [2000, 4000], [4000, 6110]], '2.1 of 4 kHz left: cut');
  assert.equal(new FilterBank(48000, 1).envelopeRate, 12000);
});

test('filter bank and clean-up give the same output for any chunk size', () => {
  const fs = 48000;
  const n = fs * 3;
  const randn = gaussianFrom(seededRandom(7));
  const x = Float32Array.from({ length: n }, () => randn());
  const whole = (() => {
    const bank = new FilterBank(fs, 1);
    const clean = new Cleanup(bank.envelopeRate, bank.rowCount);
    return clean.process(bank.process([x]));
  })();
  const bank = new FilterBank(fs, 1);
  const clean = new Cleanup(bank.envelopeRate, bank.rowCount);
  /** @type {number[][]} */
  const pieces = Array.from({ length: bank.rowCount }, () => []);
  for (let p = 0; p < n; p += 997) {
    const out = clean.process(bank.process([x.subarray(p, Math.min(n, p + 997))]));
    out.forEach((row, r) => pieces[r].push(...row));
  }
  assert.equal(pieces[0].length, whole[0].length);
  assert.ok(whole[0].length > 20000);
  for (let r = 0; r < bank.rowCount; r++) {
    for (let i = 0; i < whole[r].length; i++) assert.equal(pieces[r][i], whole[r][i]);
  }
});

test('clean-up removes mains-locked pulses and keeps an isolated one', () => {
  const fe = 12000;
  const n = fe * 3;
  const mains = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i += 200) mains[i] += 20; // one pulse every 1/60 s
  const lone = new Float32Array(n).fill(1);
  lone[18000] += 20;
  const a = new Cleanup(fe, 1).process([mains])[0];
  const b = new Cleanup(fe, 1);
  const bOut = b.process([lone])[0];
  let maxMains = 0;
  for (let i = 1000; i < a.length - 1000; i++) maxMains = Math.max(maxMains, Math.abs(a[i]));
  assert.ok(maxMains < 1e-3, `mains residue ${maxMains}`);
  assert.ok(Math.abs(bOut[18000 - b.delay] - 20) < 1e-3);
});

test('an evenly spaced watch is not mistaken for one at twice its rate', () => {
  const base = { ppm: 0, z: 10, first: 100 };
  const slow = { ...base, bph: 18000, stat: 100, second: 50, secondZ: 20 };
  const fast = { ...base, bph: 36000, stat: 104, second: 4, secondZ: 1.5 };
  assert.equal(chooseCandidate([slow, fast]).bph, 18000);
  assert.equal(chooseCandidate([slow, { ...fast, stat: 200, secondZ: 30 }]).bph, 36000);
});

test('the fast beat-rate search agrees with the exact one', () => {
  const w = synthesizeWatch({ bph: 25200, rate: -40, beatOffsetMs: 0.4, gain: 0.9, seconds: 24, seed: 21 });
  const bank = new FilterBank(w.sampleRate, w.channels.length);
  const cleanup = new Cleanup(bank.envelopeRate, bank.rowCount);
  const rows = cleanup.process(bank.process(w.channels));
  const exact = chooseCandidate(acquire(rows, bank.envelopeRate));
  const fast = chooseCandidate(acquireFast(rows, bank.envelopeRate));
  assert.equal(exact.bph, 25200);
  assert.equal(fast.bph, 25200);
  // -40 s/day is a period 463 ppm longer than nominal; the search step here is about 21 ppm.
  assert.ok(Math.abs(exact.ppm - 463) < 30, `exact search: ${exact.ppm.toFixed(0)} ppm`);
  assert.ok(Math.abs(fast.ppm - exact.ppm) < 30, `fast search: ${fast.ppm.toFixed(0)} ppm, exact: ${exact.ppm.toFixed(0)} ppm`);
  assert.ok(fast.stat > 0.8 * exact.stat, 'almost as sharp');
});
