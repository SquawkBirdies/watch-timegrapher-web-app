// Synthetic watch audio with known rate and beat error. `synthesizeWatch` makes a whole
// recording for the automated tests; `WatchStream` makes endless audio, chunk by chunk, for the
// in-app simulator. Both are deterministic for a given seed.

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
 * @property {{dt: number, amp: number, decayMs: number}[]} [tickSounds] sounds of the tick, with
 *   times in seconds relative to its nominal time; three sounds 7, 4.5 and 0 ms before it when
 *   absent
 * @property {{dt: number, amp: number, decayMs: number}[]} [tockSounds] sounds of the tock; the
 *   tick's sounds at 0.8 times the loudness when absent. Together these let a test give the tick
 *   and tock different sounds, as a co-axial escapement does
 */

/**
 * Generate two channels of background noise, watch ticks and mains-locked buzz.
 * Each beat has three sounds 7, 4.5 and 0 ms before its nominal time, the last one loudest.
 * @param {WatchOptions} options
 * @returns {{sampleRate: number, channels: Float32Array[], truePeriod: number}}
 */
export function synthesizeWatch(options) {
  const { bph, seconds, rate = 0, beatOffsetMs = 0, gain = 1, sampleRate = 48000, seed = 1, buzzHz = 59.994, buzzLevel = 1.5e-3, tickSounds, tockSounds } = options;
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
  const sounds = tickSounds || [
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
      for (const s of odd && tockSounds ? tockSounds : sounds) {
        const level = s.amp * gain * 1e-3 * (odd && !tockSounds ? 0.8 : 1);
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

/** The three sounds of a simulated beat: time before the beat's nominal time, loudness, decay. */
const BEAT_SOUNDS = [
  { dt: -0.007, amp: 0.25, decayMs: 0.3 },
  { dt: -0.0045, amp: 0.45, decayMs: 0.4 },
  { dt: 0, amp: 1.0, decayMs: 0.5 },
];

/**
 * @typedef {Object} StreamOptions
 * @property {number} bph beat rate in beats per hour
 * @property {number} [rate] seconds per day, positive when gaining
 * @property {number} [beatOffsetMs] displacement of the tocks from the midpoint between ticks
 * @property {number} [gain] tick loudness relative to the background noise
 * @property {number} [sampleRate]
 * @property {number} [seed]
 */

/**
 * A simulated watch that runs for as long as audio is asked of it, in one channel. The rate,
 * beat offset and loudness are plain properties: a change applies from the next beat, as when
 * a watchmaker turns the regulator while the watch is on the timegrapher. The background and
 * the ticks are the same kind as `synthesizeWatch` makes, without the mains buzz. The output
 * does not depend on the chunk sizes asked for.
 */
export class WatchStream {
  /** @param {StreamOptions} options */
  constructor(options) {
    const { bph, rate = 0, beatOffsetMs = 0, gain = 1, sampleRate = 48000, seed = 1 } = options;
    this.bph = bph;
    this.rate = rate;
    this.beatOffsetMs = beatOffsetMs;
    this.gain = gain;
    this.sampleRate = sampleRate;
    // Separate generators for the background and the ticks keep the output independent of
    // the chunk sizes: each is used in the same order whatever the chunks.
    this.noise = gaussianFrom(seededRandom(seed));
    this.burstNoise = gaussianFrom(seededRandom(seed + 0x9e3779b9));
    const K = Math.tan((Math.PI * 300) / sampleRate);
    this.lb = K / (1 + K);
    this.la = (K - 1) / (K + 1);
    this.x1 = 0;
    this.y1 = 0;
    /** Samples produced so far. */
    this.position = 0;
    /** Nominal time of the next beat, in seconds. */
    this.nextBeat = 0.137;
    this.beatIndex = 0;
    /** Longest piece made in one go; the tick buffer holds twice this. */
    this.piece = Math.round(0.25 * sampleRate);
    /** Tick sounds already made but not yet output; element 0 is sample `position`. */
    this.future = new Float32Array(2 * this.piece);
    this.burstLength = Math.floor(0.006 * sampleRate);
    this.raw = new Float32Array(this.burstLength);
    this.shaped = new Float64Array(this.burstLength);
  }

  /**
   * The next stretch of audio.
   * @param {number} frames
   * @returns {Float32Array[]} one channel
   */
  next(frames) {
    const out = new Float32Array(frames);
    for (let done = 0; done < frames; done += this.piece) this.fill(out.subarray(done, Math.min(frames, done + this.piece)));
    return [out];
  }

  /** @param {Float32Array} out at most `piece` samples */
  fill(out) {
    const fs = this.sampleRate;
    const m = out.length;
    // Every beat whose sounds start before the end of this piece is made now. The 20 ms margin
    // keeps a beat's earliest sound (7 ms early) from falling before the current position.
    const horizon = (this.position + m) / fs + 0.02;
    while (this.nextBeat < horizon) this.beat();
    for (let i = 0; i < m; i++) {
      const w = this.noise();
      const y = this.lb * w + this.lb * this.x1 - this.la * this.y1;
      this.x1 = w;
      this.y1 = y;
      out[i] = (0.6 * 8 * y + 0.25 * w) * 1e-3 + this.future[i];
    }
    this.future.copyWithin(0, m);
    this.future.fill(0, this.future.length - m);
    this.position += m;
  }

  /** Add the next beat's sounds to the tick buffer and schedule the beat after it. */
  beat() {
    const fs = this.sampleRate;
    const odd = this.beatIndex % 2 === 1;
    const t = this.nextBeat + (odd ? this.beatOffsetMs * 1e-3 : 0);
    if (this.gain > 0) {
      for (const s of BEAT_SOUNDS) {
        const level = s.amp * this.gain * 1e-3 * (odd ? 0.8 : 1);
        for (let i = 0; i < this.burstLength; i++) this.raw[i] = this.burstNoise() * Math.exp(-i / (s.decayMs * 1e-3 * fs));
        new Cascade(bandpassSections(fs, 3000, 14000)).process(this.raw, this.shaped);
        const pos = (t + s.dt) * fs - this.position;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        for (let i = 0; i < this.burstLength; i++) {
          const v = level * this.shaped[i];
          const a = i0 + i;
          if (a >= 0 && a < this.future.length) this.future[a] += v * (1 - frac);
          if (a + 1 >= 0 && a + 1 < this.future.length) this.future[a + 1] += v * frac;
        }
      }
    }
    this.beatIndex++;
    this.nextBeat += 3600 / this.bph / (1 + this.rate / 86400);
  }
}
