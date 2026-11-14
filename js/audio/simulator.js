// Synthetic watch audio with known rate and beat error. Used by the automated tests now and by
// the in-app simulator later. Deterministic for a given seed.

import { Cascade, bandpassSections } from '../dsp/biquad.js';

/**
 * Small seeded random number generator (mulberry32).
 * @param {number} seed
 * @returns {() => number} uniform values in [0, 1)
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal generator built on a uniform generator.
 * @param {() => number} uniform
 * @returns {() => number}
 */
export function gaussianFrom(uniform) {
  return () => {
    const u = Math.max(uniform(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
}

/**
 * @typedef {Object} WatchOptions
 * @property {number} bph beat rate in beats per hour
 * @property {number} seconds length of the recording
 * @property {number} [rate] seconds per day, positive when gaining
 * @property {number} [beatOffsetMs] displacement of the tocks from the midpoint between ticks
 * @property {number} [gain] tick loudness relative to the background noise; 0 gives noise only
 * @property {number} [sampleRate]
 * @property {number} [seed]
 * @property {number} [buzzHz] repetition rate of the mains-locked buzz; 0 disables it
 * @property {number} [buzzLevel] amplitude of the buzz
 */

/**
 * Generate two channels of background noise, watch ticks and mains-locked buzz.
 * Each beat has three sounds 7, 4.5 and 0 ms before its nominal time, the last one loudest.
 * @param {WatchOptions} options
 * @returns {{sampleRate: number, channels: Float32Array[], truePeriod: number}}
 */
export function synthesizeWatch(options) {
  const { bph, seconds, rate = 0, beatOffsetMs = 0, gain = 1, sampleRate = 48000, seed = 1, buzzHz = 59.994, buzzLevel = 1.5e-3 } = options;
  const fs = sampleRate;
  const n = Math.floor(seconds * fs);
  const randn = gaussianFrom(seededRandom(seed));
  const channels = [new Float32Array(n), new Float32Array(n)];

  // Background: low-frequency-heavy noise plus a little white noise, independent per channel.
  const K = Math.tan((Math.PI * 300) / fs);
  const lb = K / (1 + K);
  const la = (K - 1) / (K + 1);
  for (const ch of channels) {
    let x1 = 0;
    let y1 = 0;
    for (let i = 0; i < n; i++) {
      const w = randn();
      const y = lb * w + lb * x1 - la * y1;
      x1 = w;
      y1 = y;
      ch[i] = (0.6 * 8 * y + 0.25 * w) * 1e-3;
    }
  }

  // Ticks: three short noise bursts per beat, band-limited to 3-14 kHz.
  const truePeriod = 3600 / bph / (1 + rate / 86400);
  const burstLength = Math.floor(0.006 * fs);
  const raw = new Float32Array(burstLength);
  const shaped = new Float64Array(burstLength);
  const sounds = [
    { dt: -0.007, amp: 0.25, decayMs: 0.3 },
    { dt: -0.0045, amp: 0.45, decayMs: 0.4 },
    { dt: 0, amp: 1.0, decayMs: 0.5 },
  ];
  if (gain > 0) {
    for (let k = 0; ; k++) {
      const t = 0.137 + k * truePeriod;
      if (t >= seconds - 0.05) break;
      const odd = k % 2 === 1;
      const offset = odd ? beatOffsetMs * 1e-3 : 0;
      for (const s of sounds) {
        const level = s.amp * gain * 1e-3 * (odd ? 0.8 : 1);
        for (let i = 0; i < burstLength; i++) raw[i] = randn() * Math.exp(-i / (s.decayMs * 1e-3 * fs));
        new Cascade(bandpassSections(fs, 3000, 14000)).process(raw, shaped);
        const pos = (t + offset + s.dt) * fs;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        for (let c = 0; c < 2; c++) {
          const g = level * (c === 0 ? 1 : 0.8);
          const ch = channels[c];
          for (let i = 0; i < burstLength; i++) {
            const v = g * shaped[i];
            if (i0 + i >= 0 && i0 + i < n) ch[i0 + i] += v * (1 - frac);
            if (i0 + i + 1 >= 0 && i0 + i + 1 < n) ch[i0 + i + 1] += v * frac;
          }
        }
      }
    }
  }

  // Mains-locked buzz on the second channel: 1 ms bursts of a 3.5 kHz tone.
  if (buzzHz > 0 && buzzLevel > 0) {
    const m = Math.floor(0.001 * fs);
    for (let i = 0; i < Math.floor(seconds * buzzHz); i++) {
      const p = Math.floor((i / buzzHz) * fs);
      if (p + m >= n) break;
      for (let j = 0; j < m; j++) {
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (m - 1)));
        channels[1][p + j] += buzzLevel * Math.sin((2 * Math.PI * 3500 * j) / fs) * hann;
      }
    }
  }
  return { sampleRate: fs, channels, truePeriod };
}
