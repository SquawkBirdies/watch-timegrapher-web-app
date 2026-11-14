// Kalman beat tracker. It predicts when each beat is due, so the matched filter knows where to
// look, and it corrects itself only with timestamps it trusts. It never alters a timestamp: the
// trace and the displayed rate are computed from the raw timestamps.
//
// State, at beat number n:
//   phase   when beat n is due on the tick line
//   period  time from one beat to the next
//   offset  how far the tocks sit from midway between the ticks
// Model, per beat:  phase += period;  period and offset carry over, with slow random drift.
// Measurement:      timestamp of beat n = phase + (tock ? offset : 0) + noise.
//
// A timestamp averaged over several cycles carries the beat number of the middle of the
// average, which can fall between two beats of its own type. The caller therefore says which
// line a timestamp belongs to; it is not inferred from the beat number.
//
// Any time unit can be used, as long as every argument uses the same one.

import { median } from './mathutil.js';

/**
 * @typedef {Object} TrackerUpdate
 * @property {boolean} accepted false when the timestamp was too far from the prediction
 * @property {number} innovation timestamp minus expected arrival
 * @property {number} sigma standard deviation expected for the innovation
 */

export class BeatTracker {
  /**
   * @param {Object} init
   * @param {number} init.n beat number the starting state refers to
   * @param {number} init.phase
   * @param {number} init.period
   * @param {number} [init.offset]
   * @param {number} init.phaseSd starting uncertainty of the phase
   * @param {number} init.periodSd starting uncertainty of the period
   * @param {number} [init.offsetSd] starting uncertainty of the offset
   * @param {number} [init.phasePeriodCov] starting covariance of phase and period
   * @param {number} init.periodDrift drift tolerance: standard deviation of the change in period
   *   from one beat to the next
   * @param {number} [init.offsetDrift] the same for the offset
   * @param {[number, number]} init.scatter starting timestamp scatter of the ticks and of the tocks
   * @param {number} [init.minScatter] smallest scatter the tracker will assume
   * @param {number} [init.gate] largest accepted innovation, in standard deviations
   */
  constructor(init) {
    this.n = init.n;
    this.phase = init.phase;
    this.period = init.period;
    this.offset = init.offset ?? 0;
    const sf = init.phaseSd;
    const sp = init.periodSd;
    const so = init.offsetSd ?? 0;
    /** Covariance, upper triangle: [pp, pT, po, TT, To, oo]. */
    this.P = new Float64Array([sf * sf, init.phasePeriodCov ?? 0, 0, sp * sp, 0, so * so]);
    this.q = init.periodDrift * init.periodDrift;
    this.qOffset = (init.offsetDrift ?? 0) ** 2;
    this.gate = init.gate ?? 3;
    this.minScatter = init.minScatter ?? 0;
    this.initialScatter = init.scatter;
    /** Recent innovations of the ticks and of the tocks, for the scatter estimate. */
    this.recent = [/** @type {number[]} */ ([]), /** @type {number[]} */ ([])];
    /** Recent squared innovations in units of their expected variance; about 1 when the model fits. */
    this.consistency = /** @type {number[]} */ ([]);
  }

  /**
   * Expected arrival of beat `n`, without changing the state.
   * @param {number} n
   * @param {0|1} type 0 for the tick line, 1 for the tock line
   * @returns {{arrival: number, variance: number}} variance excludes the measurement noise
   */
  expect(n, type) {
    const dn = n - this.n;
    const b = type;
    const [pp, pT, po, TT, To, oo] = this.P;
    const arrival = this.phase + dn * this.period + b * this.offset;
    let variance = pp + 2 * dn * pT + dn * dn * TT + b * (2 * po + 2 * dn * To + oo);
    if (dn > 0) variance += this.q * phaseGrowth(dn);
    return { arrival, variance: Math.max(variance, 0) };
  }

  /**
   * Timestamp scatter currently assumed for one beat type: the watch's own beat-to-beat scatter
   * together with the timing noise of the matched filter, estimated from recent innovations.
   * @param {0|1} type 0 for ticks, 1 for tocks
   * @returns {number}
   */
  scatter(type) {
    const r = this.recent[type];
    if (r.length < 8) return Math.max(this.minScatter, this.initialScatter[type]);
    const m = median(r);
    return Math.max(this.minScatter, 1.4826 * median(r.map((v) => Math.abs(v - m))));
  }

  /**
   * Move the state forward to beat `n` (no effect when `n` is not ahead of the state).
   * @param {number} n
   */
  advance(n) {
    const dn = n - this.n;
    if (dn <= 0) return;
    const P = this.P;
    this.phase += dn * this.period;
    P[0] += 2 * dn * P[1] + dn * dn * P[3] + this.q * phaseGrowth(dn);
    P[1] += dn * P[3] + (this.q * dn * Math.max(dn - 1, 0)) / 2;
    P[2] += dn * P[4];
    P[3] += this.q * dn;
    P[5] += this.qOffset * dn;
    this.n = n;
  }

  /**
   * Offer the timestamp of beat `n` to the tracker.
   * @param {number} n beat number
   * @param {0|1} type 0 for a tick, 1 for a tock
   * @param {number} timestamp
   * @param {number} [quality] how the match compares with a typical one for this beat type;
   *   below 1 the timestamp is trusted less
   * @returns {TrackerUpdate}
   */
  update(n, type, timestamp, quality = 1) {
    this.advance(n);
    const dn = n - this.n; // zero, or negative for a timestamp slightly older than the state
    const P = this.P;
    const h1 = dn;
    const h2 = type;
    // P times h, with h = [1, h1, h2]
    const g0 = P[0] + h1 * P[1] + h2 * P[2];
    const g1 = P[1] + h1 * P[3] + h2 * P[4];
    const g2 = P[2] + h1 * P[4] + h2 * P[5];
    const sd = this.scatter(type) / Math.min(1, Math.max(quality, 1 / 3));
    const s = g0 + h1 * g1 + h2 * g2 + sd * sd;
    const innovation = timestamp - (this.phase + h1 * this.period + h2 * this.offset);
    const sigma = Math.sqrt(s);
    const r = this.recent[type];
    r.push(innovation);
    if (r.length > 32) r.shift();
    if (Math.abs(innovation) > this.gate * sigma) return { accepted: false, innovation, sigma };
    this.consistency.push((innovation * innovation) / s);
    if (this.consistency.length > 200) this.consistency.shift();
    const k0 = g0 / s;
    const k1 = g1 / s;
    const k2 = g2 / s;
    this.phase += k0 * innovation;
    this.period += k1 * innovation;
    this.offset += k2 * innovation;
    P[0] -= k0 * g0;
    P[1] -= k0 * g1;
    P[2] -= k0 * g2;
    P[3] -= k1 * g1;
    P[4] -= k1 * g2;
    P[5] -= k2 * g2;
    return { accepted: true, innovation, sigma };
  }
}

/**
 * How much phase variance one unit of period drift builds up over `dn` beats, when the period
 * takes a random step after every beat.
 * @param {number} dn
 * @returns {number}
 */
function phaseGrowth(dn) {
  return dn > 1 ? ((dn - 1) * dn * (2 * dn - 1)) / 6 : 0;
}
