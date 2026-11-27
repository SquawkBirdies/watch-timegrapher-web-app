// Rule B of the co-axial investigation's issue 36: the amplitude and the beat error start their
// stretch of beats again when the watch has changed.
//
// Both are read from up to a minute of beats, so after an adjustment their reading rests on a
// mixture of old and new beats until the old ones have left the stretch: on simulated watches
// the old beat error stayed on the screen for 44 to 54 s after a change of 0.6 ms, shown as if
// it were right. The timed beats show such a change at once, beat by beat. For each tick-tock
// cycle the gap between the timed tock and the midpoint of its ticks is the cycle's beat error;
// when the gaps of the last few seconds disagree with those of the beats the shown reading
// rests on, for a few seconds running, the stretch starts again from where the gaps stepped,
// as at a new lock. The amplitude starts again with it: both come from the same reading of the
// sounds.
//
// How readily it starts again, and how long the stretch is, come from the sensitivity setting.
// The presets were chosen by Lawrence Fan on 27 November 2026 from an experiment on 26
// recordings, real and simulated (the investigation's "Option 1 experiment").

/**
 * The sensitivity setting for the amplitude and the beat error. `windowSeconds` is how far back
 * a reading's beats reach, `firstSeconds` how long the beats must reach back before a first
 * reading, after a lock or a restart, and `K` how far apart the recent and the earlier gaps must
 * be, in standard errors of their difference, before the stretch starts again.
 *
 * High finds a change of 0.1 ms of beat error and shows the right value about 16 s after it; on
 * the five-minute captures of real watches it started again 9 times in 15 minutes. Medium finds
 * 0.1 ms too, more slowly, and started again twice; Low finds changes of about 0.2 ms and more,
 * and started again once. A 45 s stretch reads a little less precisely than 60 s and computes
 * for about 0.6 of the time; 30 s was too short for the Omega 3861 and the simulated co-axial.
 * @typedef {'high'|'medium'|'low'} Sensitivity
 * @typedef {{windowSeconds: number, firstSeconds: number, K: number}} Preset
 */

/** @type {Readonly<Record<Sensitivity, Readonly<Preset>>>} */
export const SENSITIVITY = Object.freeze({
  high: Object.freeze({ windowSeconds: 45, firstSeconds: 15, K: 4 }),
  medium: Object.freeze({ windowSeconds: 60, firstSeconds: 15, K: 6 }),
  low: Object.freeze({ windowSeconds: 60, firstSeconds: 15, K: 8 }),
});

/** @type {Sensitivity} */
export const DEFAULT_SENSITIVITY = 'medium';

/** Seconds of the latest gaps compared with the earlier ones. */
const RECENT_SECONDS = 5;
/** Seconds the two must disagree, judged once a second, before the stretch starts again. */
const HOLD_SECONDS = 3;
/**
 * Smallest difference that counts, in milliseconds, whatever the scatter: a clean simulated
 * watch's gaps scatter by a few microseconds, and differences below this are not worth a dash.
 */
const FLOOR_MS = 0.03;
/** Seconds of the latest gaps searched for where they stepped. */
const SPLIT_SECONDS = 20;
/** Fewest gaps on each side of a split, and in the earlier stretch compared. */
const MIN_BEFORE = 10;
const MIN_AFTER = 5;

/**
 * One tick-tock cycle's gap.
 * @typedef {Object} Gap
 * @property {number} t seconds from the start of the audio, at the tock
 * @property {number} p the tock's cleaned position
 * @property {number} g the tock less the midpoint of the ticks either side, in milliseconds
 */

/**
 * The gaps of the cycles whose three beats were each timed alone and confidently. A beat timed
 * from several cycles averaged together, or not confidently, gives none.
 * @param {{n: number, p: number, type: 0|1, ok: boolean, K: number}[]} beats in any order
 * @param {(p: number) => number} toSeconds seconds from the start of the audio at a position
 * @param {number} since positions before this give no gaps
 * @returns {Gap[]} in order of time
 */
export function timedGaps(beats, toSeconds, since = -Infinity) {
  /** @type {Map<number, {n: number, p: number, type: 0|1, ok: boolean, K: number}>} */
  const byN = new Map();
  for (const b of beats) if (b.ok && b.K === 1 && b.p >= since) byN.set(b.n, b);
  /** @type {Gap[]} */
  const gaps = [];
  for (const b of byN.values()) {
    if (b.type !== 1) continue;
    const a = byN.get(b.n - 1);
    const c = byN.get(b.n + 1);
    if (!a || !c || a.type !== 0 || c.type !== 0) continue;
    const t = toSeconds(b.p);
    gaps.push({ t, p: b.p, g: 1e3 * (t - (toSeconds(a.p) + toSeconds(c.p)) / 2) });
  }
  return gaps.sort((x, y) => x.t - y.t);
}

/**
 * A robust centre and scatter: the median absolute deviation gives the scatter, and the mean of
 * what lies within four of it the centre, so that a beat timed on the wrong sound does not move
 * either.
 * @param {number[]} xs
 * @returns {{m: number, sd: number, n: number}}
 */
function centre(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const dev = xs.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const sd = 1.4826 * dev[Math.floor(dev.length / 2)];
  const kept = xs.filter((v) => Math.abs(v - med) <= 4 * Math.max(sd, 1e-3));
  return { m: kept.reduce((s, v) => s + v, 0) / kept.length, sd, n: kept.length };
}

/** Rule B, judged once a second while the pipeline is locked. */
export class StepWatch {
  /** @param {number} K threshold, as in the presets */
  constructor(K) {
    this.K = K;
    /** Seconds running that the recent gaps have disagreed. */
    this.held = 0;
    /** @type {number|null} seconds at which the stretch last started again, until a reading from it */
    this.from = null;
  }

  /** A new lock or a lost one: nothing earlier is compared. */
  clear() {
    this.held = 0;
    this.from = null;
  }

  /**
   * Whether the stretch should start again, and from where.
   * @param {Gap[]} gaps the latest gaps, reaching back over `rests` and the last SPLIT_SECONDS
   * @param {[number, number]|null} rests seconds spanned by the beats of the reading the stage
   *   last made, or null when it has none
   * @returns {Gap|null} the first cycle after the step, or null to go on as before
   */
  judge(gaps, rests) {
    // With no reading since the last start, the beats since then are what a reading will rest on.
    const from = rests ? rests[0] : this.from;
    if (from === null || gaps.length === 0) {
      this.held = 0;
      return null;
    }
    const last = gaps[gaps.length - 1].t;
    const to = rests ? rests[1] : last - RECENT_SECONDS;
    const earlier = gaps.filter((x) => x.t >= from && x.t <= to).map((x) => x.g);
    const recent = gaps.filter((x) => x.t >= last - RECENT_SECONDS).map((x) => x.g);
    let differ = false;
    if (earlier.length >= MIN_BEFORE && recent.length >= MIN_AFTER) {
      const e = centre(earlier);
      const r = centre(recent);
      const se = Math.max(e.sd, 1e-3) * Math.sqrt(1 / r.n + 1 / e.n);
      differ = Math.abs(r.m - e.m) > Math.max(this.K * se, FLOOR_MS);
    }
    this.held = differ ? this.held + 1 : 0;
    if (this.held < HOLD_SECONDS) return null;
    this.held = 0;
    // Where the gaps stepped: the split of the latest ones that best separates two levels.
    const span = gaps.filter((x) => x.t >= last - SPLIT_SECONDS);
    let best = -1;
    let split = -1;
    let levels = { before: 0, after: 0 };
    for (let i = MIN_BEFORE; i < span.length - MIN_AFTER; i++) {
      const a = centre(span.slice(0, i).map((x) => x.g));
      const b = centre(span.slice(i).map((x) => x.g));
      const score = Math.abs(a.m - b.m) * Math.sqrt((a.n * b.n) / (a.n + b.n));
      if (score > best) {
        best = score;
        split = i;
        levels = { before: a.m, after: b.m };
      }
    }
    let at;
    if (split < 0) {
      // Too few gaps to search: where the disagreement began, as near as it is known.
      at = span.find((x) => x.t >= last - HOLD_SECONDS - RECENT_SECONDS / 2) || span[span.length - 1];
    } else {
      // The best split can fall a few cycles early, when a new gap is trimmed from the later
      // side as if it were a stray: on a simulated lever stepped from 0.4 to 1.0 ms it fell
      // 1 s early, and the first reading took in four old cycles. The gaps just after the split
      // that lie nearer the earlier level are passed over, which can drop new cycles but never
      // takes in old ones.
      while (split < span.length - 1 && Math.abs(span[split].g - levels.before) < Math.abs(span[split].g - levels.after)) split++;
      at = span[split];
    }
    this.from = at.t;
    return at;
  }
}
