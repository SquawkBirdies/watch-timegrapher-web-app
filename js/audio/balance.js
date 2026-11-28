// A simulated watch built from the motion of its balance, made chunk by chunk for the app's
// simulator. The balance swings as a sine with the amplitude set, its unlock and its lock in
// each beat happen as it passes given angles about the line of centres, and the sounds follow
// those events. Each beat can have sounds and angles of its own, as a co-axial escapement's do.
// The tests build whole recordings the same way (tests/helpers/balance.js), and share the
// co-axial's pattern and the making of each sound with this module.

import { Cascade, bandpassSections } from '../dsp/biquad.js';
import { seededRandom, gaussianFrom, liftSeconds } from './simulator.js';

/**
 * One sound of a beat.
 * @typedef {Object} BalanceSound
 * @property {'unlock'|'lock'} after the event the sound follows
 * @property {number} [delayMs] how long after that event the sound starts; 0 when absent
 * @property {number} [delayJitterMs] standard deviation of that delay from beat to beat
 * @property {number} db loudest level of the sound over the background noise, within the
 *   sound's own band, in decibels
 * @property {number} riseMs time constant of the sound's rise
 * @property {number} decayMs time constant of its decay
 * @property {[number, number]} band lowest and highest frequency of the sound, in hertz
 */

/**
 * The pattern of an escapement: where in its swing the balance unlocks and locks in each beat,
 * and the sounds of each beat.
 * @typedef {Object} BalanceEscapement
 * @property {[number, number]} unlockDeg angle before the line of centres at which the unlock
 *   happens, for the even and for the odd beats
 * @property {[number, number]} lockDeg angle after the line of centres at which the lock
 *   happens, for the even and for the odd beats
 * @property {number} lockJitterMs standard deviation of each lock's time from beat to beat
 * @property {[BalanceSound[], BalanceSound[]]} sounds the sounds of the even and of the odd beats
 * @property {number} liftAngle the mean of the two beats' lift angles (unlock plus lock), in
 *   degrees
 * @property {{bph: number, amplitude: number}} reference the beat rate and amplitude the
 *   sounds' delays were measured at
 */

/** White noise in the background, which the sounds' levels are given against. */
export const BACKGROUND_WHITE = 0.25e-3;

/** Length of the band filter's start, made and dropped before each sound. */
const PRE_ROLL_SECONDS = 0.002;

/**
 * The samples of one sound: noise in the sound's band under a rise-and-decay envelope whose
 * highest point is `peak`.
 * @param {{riseMs: number, decayMs: number, band: [number, number]}} s
 * @param {number} fs sample rate
 * @param {() => number} noise standard normal generator, drawn once for each sample made
 * @param {number} peak highest point of the envelope
 * @returns {Float64Array}
 */
export function soundSamples(s, fs, noise, peak) {
  const preRoll = Math.floor(PRE_ROLL_SECONDS * fs);
  const length = Math.floor((4 * s.riseMs + 7 * s.decayMs) * 1e-3 * fs);
  const raw = new Float32Array(preRoll + length);
  const shaped = new Float64Array(preRoll + length);
  for (let i = 0; i < raw.length; i++) raw[i] = noise();
  new Cascade(bandpassSections(fs, s.band[0], s.band[1])).process(raw, shaped);
  const rise = s.riseMs * 1e-3 * fs;
  const decay = s.decayMs * 1e-3 * fs;
  // The envelope's highest point, to scale it to 1.
  const iTop = rise * Math.log(1 + decay / rise);
  const top = (1 - Math.exp(-iTop / rise)) * Math.exp(-iTop / decay);
  const level = peak / top;
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = level * shaped[preRoll + i] * (1 - Math.exp(-i / rise)) * Math.exp(-i / decay);
  return out;
}

/** Sounds across the top of the band a phone's microphone delivers, in hertz. */
const HIGH = /** @type {[number, number]} */ ([9000, 22000]);
/** The faint sounds, above 14 kHz. */
const TOP = /** @type {[number, number]} */ ([14000, 22000]);

/** Lift angle of the simulated co-axial when none is given, in degrees. */
export const COAXIAL_LIFT_ANGLE = 36;

/**
 * A co-axial escapement with the pattern found in the Omega 3861's Safari capture. Even beats
 * take the impulse on the balance itself: a faint unlock, one loud impact, the lock. Odd beats
 * take it through the lever: a faint unlock, a faint and then a moderate impact, the lock. The
 * time from unlock to lock is about 8% longer in the even beats; the two beats' lift angles
 * average 36°, the lift angle the prototype reads the Omega at.
 * @param {number} [unlockDb] how far the unlock stands over the noise; the capture's stood about
 *   5 dB over it
 * @returns {BalanceEscapement}
 */
export function coaxialEscapement(unlockDb = 5) {
  return {
    unlockDeg: [18, 18],
    lockDeg: [19.45, 16.55],
    lockJitterMs: 0.06,
    sounds: [
      [
        { after: 'unlock', db: unlockDb, riseMs: 0.2, decayMs: 0.35, band: TOP },
        { after: 'unlock', delayMs: 3.25, delayJitterMs: 0.08, db: 27, riseMs: 0.08, decayMs: 0.6, band: HIGH },
        { after: 'lock', db: 17, riseMs: 0.12, decayMs: 0.6, band: HIGH },
        { after: 'lock', delayMs: 2.7, delayJitterMs: 0.1, db: 3, riseMs: 0.15, decayMs: 0.4, band: TOP },
      ],
      [
        { after: 'unlock', db: unlockDb + 1, riseMs: 0.25, decayMs: 0.4, band: TOP },
        { after: 'unlock', delayMs: 3.1, delayJitterMs: 0.1, db: 4, riseMs: 0.15, decayMs: 0.4, band: TOP },
        { after: 'unlock', delayMs: 4.15, delayJitterMs: 0.12, db: 17, riseMs: 0.12, decayMs: 0.5, band: HIGH },
        { after: 'lock', db: 17, riseMs: 0.12, decayMs: 0.6, band: HIGH },
        { after: 'lock', delayMs: 2.6, delayJitterMs: 0.1, db: 3, riseMs: 0.15, decayMs: 0.4, band: TOP },
      ],
    ],
    liftAngle: COAXIAL_LIFT_ANGLE,
    reference: { bph: 21600, amplitude: 285 },
  };
}

/**
 * The rest position of the balance, in degrees off the line of centres, that puts the odd
 * beats' unlocks `gapMs` later than midway between the even beats' unlocks: the beat error as a
 * timing machine measures it, from the unlocks.
 * @param {number} gapMs
 * @param {number} amplitude degrees
 * @param {[number, number]} unlockDeg the even and odd beats' unlock angles
 * @param {number} omega radians per second of the balance's phase
 * @returns {number}
 */
export function restOffsetFor(gapMs, amplitude, unlockDeg, omega) {
  const A = amplitude;
  const [u0, u1] = unlockDeg;
  const target = gapMs * 1e-3 * omega;
  // The gap grows steadily with the offset, so Newton's method finds it in a few steps: the
  // offset for 2 ms at 36,000 vph and 150 degrees, the farthest the simulator reaches, to
  // within 1e-12 degrees in three.
  let rest = 0;
  for (let i = 0; i < 6; i++) {
    const f = Math.asin((u0 + rest) / A) - Math.asin((u1 - rest) / A) - target;
    const slope = 1 / Math.sqrt(A * A - (u0 + rest) ** 2) + 1 / Math.sqrt(A * A - (u1 - rest) ** 2);
    rest -= f / slope;
  }
  return rest;
}

/** Standard deviation of each sound's loudness from beat to beat, in decibels. */
const LEVEL_JITTER_DB = 1.5;

/** The loudness setting at which the sounds stand over the background as the pattern gives. */
const PATTERN_GAIN = 3;

/**
 * @typedef {Object} BalanceStreamOptions
 * @property {number} bph beat rate in beats per hour
 * @property {number} [rate] seconds per day, positive when gaining
 * @property {number} [beatOffsetMs] beat error as a timing machine measures it, from the
 *   unlocks: how much later than midway between the even beats' unlocks the odd beats' unlocks
 *   fall. It comes from the balance's rest position, set off the line of centres by the angle
 *   that gives it at each beat's amplitude, as in a real watch
 * @property {number} [gain] loudness of the sounds. At 3 they stand over the background as the
 *   pattern gives, which for the co-axial is as in the Omega 3861's capture; each step from there
 *   makes every sound 20 log10(gain / 3) dB louder or quieter. At 0 there are none
 * @property {number} [jitterMs] standard deviation of a random displacement given to every beat,
 *   its events and its sounds together, for a watch that runs irregularly; 0 when absent.
 *   Displacements beyond four standard deviations are cut back to four
 * @property {number} [amplitude] swing of the balance in degrees; the pattern's reference when
 *   absent
 * @property {number} [liftAngle] the watch's lift angle in degrees, the mean of its two beats':
 *   the pattern's angles are scaled to it. The pattern's own when absent
 * @property {BalanceEscapement} [escapement] the pattern; the co-axial when absent
 * @property {number} [sampleRate]
 * @property {number} [seed]
 * @property {boolean} [record] keep every beat's unlock and lock times, and when each of its
 *   sounds starts, in `events`, for the tests; an endless run would keep them without end
 */

/**
 * A simulated watch built from its balance that runs for as long as audio is asked of it, in
 * one channel. The rate, beat error, loudness, beat variability, amplitude and lift angle are
 * plain properties, as in `WatchStream`: a change applies from the next beat. The background is
 * the same kind as `WatchStream` makes. Each sound that follows the unlock comes after it by its
 * pattern's delay stretched in proportion to the time the balance takes to cross the lift angle,
 * against that time at the pattern's reference: at the reference the delays are the pattern's,
 * and elsewhere every sound keeps its place within the lift, as the sounds of `WatchStream` do.
 * The output does not depend on the chunk sizes asked for, and is the same for the same seed.
 */
export class BalanceStream {
  /** @param {BalanceStreamOptions} options */
  constructor(options) {
    const escapement = options.escapement || coaxialEscapement();
    const { bph, rate = 0, beatOffsetMs = 0, gain = PATTERN_GAIN, jitterMs = 0, amplitude = escapement.reference.amplitude, liftAngle = escapement.liftAngle, sampleRate = 48000, seed = 1, record = false } = options;
    this.bph = bph;
    this.rate = rate;
    this.beatOffsetMs = beatOffsetMs;
    this.gain = gain;
    this.jitterMs = jitterMs;
    this.amplitude = amplitude;
    this.liftAngle = liftAngle;
    this.escapement = escapement;
    this.sampleRate = sampleRate;
    // Separate generators for the background, the sounds' noise, the displacement of each beat
    // and the variations within it keep the output independent of the chunk sizes, since each is
    // drawn in the same order whatever the chunks. The variations within a beat are drawn even
    // when the watch is silent, so that a change of loudness changes nothing else.
    this.noise = gaussianFrom(seededRandom(seed));
    this.burstNoise = gaussianFrom(seededRandom(seed + 0x9e3779b9));
    this.displace = gaussianFrom(seededRandom(seed + 0x51ed270b));
    this.vary = gaussianFrom(seededRandom(seed + 0x3c6ef372));
    const K = Math.tan((Math.PI * 300) / sampleRate);
    this.lb = K / (1 + K);
    this.la = (K - 1) / (K + 1);
    this.x1 = 0;
    this.y1 = 0;
    /** Samples produced so far. */
    this.position = 0;
    /** Time the balance would pass its rest position in the next beat, without displacement. */
    this.nextBeat = 0.137;
    this.beatIndex = 0;
    /** Longest piece made in one go. */
    this.piece = Math.round(0.25 * sampleRate);
    // Sounds already made but not yet output; element 0 is sample `position`. A beat is made
    // up to a quarter of a period before its centre (below), and its last sound ends less than
    // a quarter of a period and 10 ms after its centre, displaced late by up to four standard
    // deviations: half a second at 18,000 vph with 5 ms of variability, so a second beyond the
    // piece holds them at every standard beat rate.
    this.future = new Float32Array(this.piece + sampleRate);
    /** @type {{unlock: number[], lock: number[], starts: number[][]} | null} */
    this.events = record ? { unlock: [], lock: [], starts: [] } : null;
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
    // Every beat whose sounds can start before the end of this piece is made now. A beat's
    // unlock comes before its centre by less than a quarter of a period, whatever the amplitude
    // and the angles, since the balance turns back at its amplitude; the margin adds as far as a
    // beat can be displaced early.
    const halfPeriod = 3600 / this.bph / (1 + this.rate / 86400);
    const horizon = (this.position + m) / fs + halfPeriod / 2 + 4e-3 * this.jitterMs + 0.002;
    while (this.nextBeat < horizon) this.beat();
    for (let i = 0; i < m; i++) {
      const w = this.noise();
      const y = this.lb * w + this.lb * this.x1 - this.la * this.y1;
      this.x1 = w;
      this.y1 = y;
      out[i] = 0.6 * 8 * y * 1e-3 + BACKGROUND_WHITE * w + this.future[i];
    }
    this.future.copyWithin(0, m);
    this.future.fill(0, this.future.length - m);
    this.position += m;
  }

  /** Add the next beat's sounds to the buffer and schedule the beat after it. */
  beat() {
    const fs = this.sampleRate;
    const e = this.escapement;
    const j = this.beatIndex % 2;
    const halfPeriod = 3600 / this.bph / (1 + this.rate / 86400);
    const omega = Math.PI / halfPeriod;
    const A = this.amplitude;
    const scatter = Math.max(-4, Math.min(4, this.displace())) * this.jitterMs * 1e-3;
    const tCentre = this.nextBeat + scatter;
    const scale = this.liftAngle / e.liftAngle;
    const unlockDeg = /** @type {[number, number]} */ ([e.unlockDeg[0] * scale, e.unlockDeg[1] * scale]);
    // Measured from the line of centres, the balance's angle is rest + A sin(phase) on even
    // beats and rest - A sin(phase) on odd ones, so its rest position counts the other way in
    // the odd beats.
    const rest = restOffsetFor(this.beatOffsetMs, A, unlockDeg, omega) * (j === 0 ? 1 : -1);
    const tUnlock = tCentre + Math.asin((-unlockDeg[j] - rest) / A) / omega;
    const tLock = tCentre + Math.asin((e.lockDeg[j] * scale - rest) / A) / omega + e.lockJitterMs * this.vary() * 1e-3;
    /** @type {number[]} */
    const starts = [];
    if (this.events) {
      this.events.unlock.push(tUnlock);
      this.events.lock.push(tLock);
      this.events.starts.push(starts);
    }
    const stretch = liftSeconds(A, this.bph, this.liftAngle) / liftSeconds(e.reference.amplitude, e.reference.bph, e.liftAngle);
    const louder = this.gain > 0 ? 20 * Math.log10(this.gain / PATTERN_GAIN) : 0;
    for (const s of e.sounds[j]) {
      const delayMs = (s.delayMs || 0) * (s.after === 'unlock' ? stretch : 1);
      const start = (s.after === 'unlock' ? tUnlock : tLock) + (delayMs + (s.delayJitterMs || 0) * this.vary()) * 1e-3;
      const jitterDb = LEVEL_JITTER_DB * this.vary();
      starts.push(start);
      if (this.gain <= 0) continue;
      const samples = soundSamples(s, fs, this.burstNoise, BACKGROUND_WHITE * Math.pow(10, (s.db + jitterDb + louder) / 20));
      const pos = start * fs - this.position;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        const a = i0 + i;
        if (a >= 0 && a < this.future.length) this.future[a] += v * (1 - frac);
        if (a + 1 >= 0 && a + 1 < this.future.length) this.future[a + 1] += v * frac;
      }
    }
    this.beatIndex++;
    this.nextBeat += halfPeriod;
  }
}
