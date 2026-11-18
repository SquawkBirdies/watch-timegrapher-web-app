// Test helper: a simulated watch built from the motion of its balance. The simulator in
// js/audio/simulator.js places each beat's sounds at fixed times around the beat. Here the
// balance swings as a sine with a given amplitude and rest position, the unlock and the lock of
// each beat happen when it passes given angles, and the sounds follow from those events. So the
// truth is known for the readings that depend on the events inside a beat: the beat error as
// Witschi's instruments define it (from the unlocks), the time from unlock to lock, and the
// amplitude.
// The two beats can have different sounds and different angles, as a co-axial escapement does.

import { Cascade, bandpassSections } from '../../js/dsp/biquad.js';
import { seededRandom, gaussianFrom } from '../../js/audio/simulator.js';

/**
 * One sound of a beat.
 * @typedef {Object} BeatSound
 * @property {'unlock'|'lock'} after the event the sound follows
 * @property {number} [delayMs] how long after that event the sound starts; 0 when absent. A
 *   sound made by the escape wheel catching up with a pallet comes a few milliseconds after the
 *   unlock, by a time that depends on the wheel, not on the balance
 * @property {number} [delayJitterMs] standard deviation of that delay from beat to beat
 * @property {number} db loudest level of the sound over the background noise, within the
 *   sound's own band, in decibels
 * @property {number} riseMs time constant of the sound's rise
 * @property {number} decayMs time constant of its decay
 * @property {[number, number]} band lowest and highest frequency of the sound, in hertz
 */

/**
 * @typedef {Object} BalanceWatchOptions
 * @property {number} bph beat rate in beats per hour
 * @property {number} seconds length of the recording
 * @property {number} [rate] seconds per day, positive when gaining
 * @property {number | ((time: number) => number)} amplitude amplitude of the balance in degrees,
 *   or a function of time for an amplitude that changes
 * @property {number} [restOffsetDeg] how far the balance's rest position lies from the line of
 *   centres, in degrees; this is what makes a beat error
 * @property {[number, number]} unlockDeg angle before the line of centres at which the unlock
 *   happens, for the even and for the odd beats
 * @property {[number, number]} lockDeg angle after the line of centres at which the lock
 *   happens, for the even and for the odd beats
 * @property {[BeatSound[], BeatSound[]]} sounds the sounds of the even and of the odd beats
 * @property {number} [lockJitterMs] scale of a random delay of each lock: the delay is the size
 *   of a normal draw with this standard deviation, so it is never negative and averages about
 *   0.8 times this. The true amplitude does not count it, so a method that times the lock reads
 *   the amplitude slightly low
 * @property {number} [levelJitterDb] standard deviation of each sound's loudness from beat to
 *   beat, in decibels; 1.5 when absent
 * @property {number} [sampleRate]
 * @property {number} [seed]
 */

/**
 * @typedef {Object} BalanceTruth
 * @property {Float64Array} unlock time of each beat's unlock, in seconds
 * @property {Float64Array} lock time of each beat's lock, in seconds
 * @property {number} unlockGapMs how much later than midway between the even beats' unlocks
 *   the odd beats' unlocks fall, on average; its size is the beat error as Witschi defines it
 * @property {number} lockGapMs the same for the locks
 * @property {[number, number]} liftMs mean time from unlock to lock in the even and odd beats
 * @property {number} meanAmplitude amplitude averaged over the recording, in degrees
 */

/**
 * @param {BalanceWatchOptions} options
 * @returns {{sampleRate: number, channels: Float32Array[], truth: BalanceTruth}}
 */
export function synthesizeBalanceWatch(options) {
  const { bph, seconds, rate = 0, amplitude, restOffsetDeg = 0, unlockDeg, lockDeg, sounds, lockJitterMs = 0, levelJitterDb = 1.5, sampleRate = 48000, seed = 1 } = options;
  const fs = sampleRate;
  const n = Math.floor(seconds * fs);
  const randn = gaussianFrom(seededRandom(seed));
  const vary = gaussianFrom(seededRandom(seed + 0x3c6ef372));
  const out = new Float32Array(n);

  // The same background as the other simulator: low-frequency-heavy noise plus white noise.
  const white = 0.25e-3;
  const K = Math.tan((Math.PI * 300) / fs);
  const lb = K / (1 + K);
  const la = (K - 1) / (K + 1);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < n; i++) {
    const w = randn();
    const y = lb * w + lb * x1 - la * y1;
    x1 = w;
    y1 = y;
    out[i] = 0.6 * 8 * y * 1e-3 + white * w;
  }

  const halfPeriod = 3600 / bph / (1 + rate / 86400);
  const omega = Math.PI / halfPeriod; // radians per second of the balance's phase
  /** @param {number} t */
  const amplitudeAt = (t) => (typeof amplitude === 'function' ? amplitude(t) : amplitude);
  const preRoll = Math.floor(0.002 * fs);
  /** @type {number[]} */
  const unlocks = [];
  /** @type {number[]} */
  const locks = [];
  let amplitudeSum = 0;

  /**
   * Add one sound: band-limited noise under a rise-and-decay envelope.
   * @param {number} time start of the sound in seconds
   * @param {BeatSound} s
   */
  const addSound = (time, s) => {
    const length = Math.floor((4 * s.riseMs + 7 * s.decayMs) * 1e-3 * fs);
    const raw = new Float32Array(preRoll + length);
    const shaped = new Float64Array(preRoll + length);
    for (let i = 0; i < raw.length; i++) raw[i] = randn();
    new Cascade(bandpassSections(fs, s.band[0], s.band[1])).process(raw, shaped);
    const rise = s.riseMs * 1e-3 * fs;
    const decay = s.decayMs * 1e-3 * fs;
    // The envelope's highest point, to scale it to 1.
    const iTop = rise * Math.log(1 + decay / rise);
    const top = (1 - Math.exp(-iTop / rise)) * Math.exp(-iTop / decay);
    const level = white * Math.pow(10, (s.db + levelJitterDb * vary()) / 20) / top;
    const pos = time * fs;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    for (let i = 0; i < length; i++) {
      const v = level * shaped[preRoll + i] * (1 - Math.exp(-i / rise)) * Math.exp(-i / decay);
      if (i0 + i >= 0 && i0 + i < n) out[i0 + i] += v * (1 - frac);
      if (i0 + i + 1 >= 0 && i0 + i + 1 < n) out[i0 + i + 1] += v * frac;
    }
  };

  for (let k = 0; ; k++) {
    // The balance passes its rest position at tCentre, in alternating directions. Measured from
    // the line of centres its angle is rest + A sin(phase) on even beats and rest - A sin(phase)
    // on odd ones.
    const tCentre = 0.137 + k * halfPeriod;
    if (tCentre >= seconds - 0.06) break;
    const j = k % 2;
    const A = amplitudeAt(tCentre);
    const rest = j === 0 ? restOffsetDeg : -restOffsetDeg;
    const tUnlock = tCentre + Math.asin((-unlockDeg[j] - rest) / A) / omega;
    const tLock = tCentre + Math.asin((lockDeg[j] - rest) / A) / omega + Math.abs(lockJitterMs * vary()) * 1e-3;
    unlocks.push(tUnlock);
    locks.push(tLock);
    amplitudeSum += A;
    for (const s of sounds[j]) {
      const base = s.after === 'unlock' ? tUnlock : tLock;
      addSound(base + ((s.delayMs || 0) + (s.delayJitterMs || 0) * vary()) * 1e-3, s);
    }
  }

  /** @param {number[]} t mean offset of the odd entries from midway between the even ones */
  const gapMs = (t) => {
    let sum = 0;
    let count = 0;
    for (let k = 1; k + 1 < t.length; k += 2) {
      sum += t[k] - 0.5 * (t[k - 1] + t[k + 1]);
      count++;
    }
    return (1e3 * sum) / count;
  };
  /** @param {0|1} j */
  const lift = (j) => {
    let sum = 0;
    let count = 0;
    for (let k = j; k < unlocks.length; k += 2) {
      sum += locks[k] - unlocks[k];
      count++;
    }
    return (1e3 * sum) / count;
  };
  return {
    sampleRate: fs,
    channels: [out],
    truth: {
      unlock: Float64Array.from(unlocks),
      lock: Float64Array.from(locks),
      unlockGapMs: gapMs(unlocks),
      lockGapMs: gapMs(locks),
      liftMs: [lift(0), lift(1)],
      meanAmplitude: amplitudeSum / unlocks.length,
    },
  };
}

/** Sounds across the top of the band a phone's microphone delivers, in hertz. */
const HIGH = /** @type {[number, number]} */ ([9000, 22000]);

/**
 * A co-axial watch with the pattern found in the Omega 3861's Safari capture. Even beats take
 * the impulse on the balance itself: a faint unlock, one loud impact, the lock. Odd beats take
 * it through the lever: a faint unlock, a faint and then a moderate impact, the lock. The time
 * from unlock to lock is about 8% longer in the even beats.
 * @param {Partial<BalanceWatchOptions> & {unlockDb?: number}} [overrides] `unlockDb` sets how
 *   far the unlock stands over the noise; the capture's stood about 5 dB over it
 * @returns {BalanceWatchOptions}
 */
export function coaxialWatch(overrides = {}) {
  const { unlockDb = 5, ...rest } = overrides;
  return {
    bph: 21600,
    seconds: 60,
    rate: 0.4,
    amplitude: 285,
    restOffsetDeg: 0,
    unlockDeg: [18, 18],
    lockDeg: [19.55, 16.65],
    lockJitterMs: 0.06,
    sounds: [
      [
        { after: 'unlock', db: unlockDb, riseMs: 0.2, decayMs: 0.35, band: [14000, 22000] },
        { after: 'unlock', delayMs: 3.25, delayJitterMs: 0.08, db: 27, riseMs: 0.08, decayMs: 0.6, band: HIGH },
        { after: 'lock', db: 17, riseMs: 0.12, decayMs: 0.6, band: HIGH },
        { after: 'lock', delayMs: 2.7, delayJitterMs: 0.1, db: 3, riseMs: 0.15, decayMs: 0.4, band: [14000, 22000] },
      ],
      [
        { after: 'unlock', db: unlockDb + 1, riseMs: 0.25, decayMs: 0.4, band: [14000, 22000] },
        { after: 'unlock', delayMs: 3.1, delayJitterMs: 0.1, db: 4, riseMs: 0.15, decayMs: 0.4, band: [14000, 22000] },
        { after: 'unlock', delayMs: 4.15, delayJitterMs: 0.12, db: 17, riseMs: 0.12, decayMs: 0.5, band: HIGH },
        { after: 'lock', db: 17, riseMs: 0.12, decayMs: 0.6, band: HIGH },
        { after: 'lock', delayMs: 2.6, delayJitterMs: 0.1, db: 3, riseMs: 0.15, decayMs: 0.4, band: [14000, 22000] },
      ],
    ],
    ...rest,
  };
}

/**
 * A Swiss-lever watch: both beats make the same three sounds, an unlock, an impulse about
 * 2.4 ms later and the drop, which is the loudest.
 * @param {Partial<BalanceWatchOptions>} [overrides]
 * @returns {BalanceWatchOptions}
 */
export function leverWatch(overrides = {}) {
  /** @type {BeatSound[]} */
  const beat = [
    { after: 'unlock', db: 12, riseMs: 0.12, decayMs: 0.5, band: [7000, 22000] },
    { after: 'unlock', delayMs: 2.4, delayJitterMs: 0.08, db: 18, riseMs: 0.1, decayMs: 0.5, band: [5000, 22000] },
    { after: 'lock', db: 25, riseMs: 0.08, decayMs: 0.7, band: [5000, 22000] },
  ];
  return {
    bph: 28800,
    seconds: 40,
    rate: -3,
    amplitude: 270,
    restOffsetDeg: 0,
    unlockDeg: [25, 25],
    lockDeg: [25, 25],
    lockJitterMs: 0.03,
    sounds: [beat, beat],
    ...overrides,
  };
}
