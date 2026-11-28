// Test helper: a simulated watch built from the motion of its balance. The simulator in
// js/audio/simulator.js places each beat's sounds at fixed times around the beat. Here the
// balance swings as a sine with a given amplitude and rest position, the unlock and the lock of
// each beat happen when it passes given angles, and the sounds follow from those events. So the
// truth is known for the readings that depend on the events inside a beat: the beat error as
// Witschi's instruments define it (from the unlocks), the time from unlock to lock, and the
// amplitude.
// The two beats can have different sounds and different angles, as a co-axial escapement does.
// The app's simulator streams a co-axial built the same way (js/audio/balance.js); this helper
// makes whole recordings, with options the app does not need, and keeps its own random draws so
// that the tests' watches stay as they were.

import { seededRandom, gaussianFrom } from '../../js/audio/simulator.js';
import { soundSamples, coaxialEscapement } from '../../js/audio/balance.js';

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
 * @property {BandArrival[]} [arrival] when given, the sound is made of these parts, one per
 *   band, each starting at its own time and level, instead of starting at once in its whole band.
 *   A real watch's sounds do not start at the same moment at every frequency: in the ETA 2836-2's
 *   capture the top band starts the unlock 0.14 ms (tick) and 0.33 ms (tock) after the middle ones
 */

/**
 * One band of a sound that starts at different moments in different bands.
 * @typedef {Object} BandArrival
 * @property {[number, number]} band lowest and highest frequency of this part, in hertz; it keeps
 *   only what lies within the sound's own band
 * @property {number} [delayMs] how much later than the sound this part starts; 0 when absent
 * @property {number} [db] this part's level over the background in its band; the sound's when
 *   absent
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
 * @property {number} [lockJitterMs] standard deviation of each lock's time from beat to beat, in
 *   milliseconds. The variation averages zero, so the mean time from unlock to lock is the one
 *   the amplitude and the angles give, and a method that times the lock reads the true amplitude
 * @property {number} [levelJitterDb] standard deviation of each sound's loudness from beat to
 *   beat, in decibels; 1.5 when absent
 * @property {number} [beatJitterMs] standard deviation of each beat's time from the regular
 *   grid, in milliseconds, drawn afresh for every beat: the whole beat, its events and its
 *   sounds, comes early or late together, as in an irregular watch; 0 when absent
 * @property {number} [amplitudeJitterDeg] standard deviation of each beat's amplitude from the
 *   set one, in degrees, drawn afresh for every beat; 0 when absent
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
  const { bph, seconds, rate = 0, amplitude, restOffsetDeg = 0, unlockDeg, lockDeg, sounds, lockJitterMs = 0, levelJitterDb = 1.5, beatJitterMs = 0, amplitudeJitterDeg = 0, sampleRate = 48000, seed = 1 } = options;
  const fs = sampleRate;
  const n = Math.floor(seconds * fs);
  const randn = gaussianFrom(seededRandom(seed));
  const vary = gaussianFrom(seededRandom(seed + 0x3c6ef372));
  // The irregularity has a random stream of its own, so that a watch without it is the same to
  // the last sample as before, and the same watch with it differs only by the irregularity.
  const irregular = gaussianFrom(seededRandom(seed + 0x5bd1e995));
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
  /** @type {number[]} */
  const unlocks = [];
  /** @type {number[]} */
  const locks = [];
  let amplitudeSum = 0;

  /**
   * Add one sound: band-limited noise under a rise-and-decay envelope.
   * @param {number} time start of the sound in seconds
   * @param {BeatSound} s
   * @param {number} [jitterDb] how far this sound's level is off its set one; drawn here when absent
   */
  const addSound = (time, s, jitterDb) => {
    // The app's simulator makes its sounds the same way (js/audio/balance.js).
    const samples = soundSamples(s, fs, randn, white * Math.pow(10, (s.db + (jitterDb ?? levelJitterDb * vary())) / 20));
    const pos = time * fs;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      if (i0 + i >= 0 && i0 + i < n) out[i0 + i] += v * (1 - frac);
      if (i0 + i + 1 >= 0 && i0 + i + 1 < n) out[i0 + i + 1] += v * frac;
    }
  };

  for (let k = 0; ; k++) {
    // The balance passes its rest position at tCentre, in alternating directions. Measured from
    // the line of centres its angle is rest + A sin(phase) on even beats and rest - A sin(phase)
    // on odd ones.
    const tGrid = 0.137 + k * halfPeriod;
    if (tGrid >= seconds - 0.06) break;
    // An irregular beat moves off the grid, and its amplitude off the set one, by itself: the
    // next beat is drawn afresh, so the irregularity does not build up into a rate change.
    const tCentre = beatJitterMs > 0 ? tGrid + beatJitterMs * irregular() * 1e-3 : tGrid;
    const j = k % 2;
    const A = amplitudeAt(tGrid) + (amplitudeJitterDeg > 0 ? amplitudeJitterDeg * irregular() : 0);
    const rest = j === 0 ? restOffsetDeg : -restOffsetDeg;
    const tUnlock = tCentre + Math.asin((-unlockDeg[j] - rest) / A) / omega;
    const tLock = tCentre + Math.asin((lockDeg[j] - rest) / A) / omega + lockJitterMs * vary() * 1e-3;
    unlocks.push(tUnlock);
    locks.push(tLock);
    amplitudeSum += A;
    for (const s of sounds[j]) {
      const base = s.after === 'unlock' ? tUnlock : tLock;
      const start = base + ((s.delayMs || 0) + (s.delayJitterMs || 0) * vary()) * 1e-3;
      if (!s.arrival) {
        addSound(start, s);
        continue;
      }
      // The parts are one sound: they come early or late together and are louder or quieter
      // together, by one draw of each.
      const jitterDb = levelJitterDb * vary();
      for (const part of arrivalParts(s)) addSound(start + (part.delayMs || 0) * 1e-3, part, jitterDb);
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

/**
 * A co-axial watch with the pattern found in the Omega 3861's Safari capture
 * (`coaxialEscapement` in js/audio/balance.js, which the app's simulator makes too). Even beats
 * take the impulse on the balance itself: a faint unlock, one loud impact, the lock. Odd beats
 * take it through the lever: a faint unlock, a faint and then a moderate impact, the lock. The
 * time from unlock to lock is about 8% longer in the even beats; the two beats' lift angles
 * average 36°, the lift angle the prototype reads the Omega at.
 * @param {Partial<BalanceWatchOptions> & {unlockDb?: number}} [overrides] `unlockDb` sets how
 *   far the unlock stands over the noise; the capture's stood about 5 dB over it
 * @returns {BalanceWatchOptions}
 */
export function coaxialWatch(overrides = {}) {
  const { unlockDb = 5, ...rest } = overrides;
  const { unlockDeg, lockDeg, lockJitterMs, sounds } = coaxialEscapement(unlockDb);
  return {
    bph: 21600,
    seconds: 60,
    rate: 0.4,
    amplitude: 285,
    restOffsetDeg: 0,
    unlockDeg,
    lockDeg,
    lockJitterMs,
    sounds,
    ...rest,
  };
}

/**
 * The parts of a sound that starts at different moments in different bands, each a sound of its
 * own: its band cut to the sound's, its delay its own relative to the sound's, and its level its
 * own or the sound's. A part that lies outside the sound's band is left out.
 * @param {BeatSound} s
 * @returns {BeatSound[]}
 */
export function arrivalParts(s) {
  /** @type {BeatSound[]} */
  const parts = [];
  for (const a of s.arrival || []) {
    const lo = Math.max(a.band[0], s.band[0]);
    const hi = Math.min(a.band[1], s.band[1]);
    if (hi <= lo) continue;
    parts.push({ after: s.after, delayMs: a.delayMs || 0, db: a.db ?? s.db, riseMs: s.riseMs, decayMs: s.decayMs, band: [lo, hi] });
  }
  return parts;
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
