// Paces a source in time: every few tens of milliseconds it takes the audio that is due and
// passes it on, so a recording or the simulator reaches the pipeline as the microphone would.
// Recordings can also be replayed faster than real time.

/**
 * @typedef {Object} PacedSource
 * @property {number} sampleRate
 * @property {(frames: number) => Float32Array[] | null} next audio, or null when there is no more
 */

/** Time between deliveries. */
const TICK_MS = 40;
/** Most audio delivered at once, in seconds of real time; a page left in the background does
 *  not catch up in one burst when it returns, it simply continues. */
const MAX_CATCH_UP_SECONDS = 1;

export class Player {
  /**
   * @param {PacedSource} source
   * @param {{speed?: number, onChunk: (channels: Float32Array[]) => void, onEnd: () => void, busy?: () => boolean}} handlers
   *   busy: when it returns true, delivery waits, so that a replay never runs ahead of the
   *   pipeline
   */
  constructor(source, handlers) {
    this.source = source;
    this.speed = handlers.speed || 1;
    this.onChunk = handlers.onChunk;
    this.onEnd = handlers.onEnd;
    this.busy = handlers.busy || (() => false);
    /** Frames delivered. */
    this.sent = 0;
    /** Frames that were due when the clock was last set. */
    this.base = 0;
    this.t0 = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
  }

  start() {
    this.base = this.sent;
    this.t0 = performance.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return this.timer !== null;
  }

  /** @param {number} speed */
  setSpeed(speed) {
    this.base = this.sent;
    this.t0 = performance.now();
    this.speed = speed;
  }

  tick() {
    const fs = this.source.sampleRate;
    if (this.busy()) {
      // The receiver has not caught up: the clock waits with it.
      this.base = this.sent;
      this.t0 = performance.now();
      return;
    }
    let due = this.base + Math.floor(((performance.now() - this.t0) / 1000) * fs * this.speed) - this.sent;
    const most = Math.round(MAX_CATCH_UP_SECONDS * fs * this.speed);
    if (due > most) {
      // Fell behind (the page was hidden, or the phone was busy): skip the gap in time.
      this.base -= due - most;
      due = most;
    }
    if (due <= 0) return;
    const channels = this.source.next(due);
    if (!channels || channels[0].length === 0) {
      this.stop();
      this.onEnd();
      return;
    }
    // The receiver may transfer the arrays to a worker, which empties them, so the length is
    // read first.
    const frames = channels[0].length;
    this.sent += frames;
    this.onChunk(channels);
    if (frames < due) {
      this.stop();
      this.onEnd();
    }
  }
}
