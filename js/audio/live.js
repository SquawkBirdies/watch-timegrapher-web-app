// The live microphone as a source for the timegrapher screen. It opens the capture, keeps the
// last minute of audio so that it can be saved, and notices interruptions: a phone call, another
// app taking the audio, the screen locking or the app going to the background. Audio from an
// interruption is not passed on. When sound returns, a new segment begins, placed on the run's
// timeline after the gap, so that the pipeline starts afresh and the trace shows the gap.
//
// The run's timeline is in seconds from the start of the run: audio time within a segment, and
// clock time across an interruption, when no audio arrives or the audio is silence.

import { openMicrophone } from './capture.js';
import { AudioRing } from './ring.js';

/** Seconds of the most recent audio kept for saving. */
export const KEEP_SECONDS = 60;
/** Exact digital silence lasting this long means the microphone has been cut off: a real
 *  microphone always hears some noise. */
export const SILENCE_SECONDS = 0.3;

/**
 * @typedef {Object} LiveHandlers
 * @property {(channels: Float32Array[]) => void} onAudio audio of the current segment, already
 *   kept for saving; the receiver may transfer the arrays
 * @property {(reason: string) => void} onInterrupt the audio stopped; nothing more is passed on
 *   until `onResume`
 * @property {() => void} onResume sound is back; a new segment starts at `segmentStart`
 * @property {(message: string) => void} onEnd the microphone could not be recovered
 */

/**
 * @typedef {Object} LiveDeps for the tests
 * @property {typeof openMicrophone} [open]
 * @property {() => number} [now] milliseconds
 * @property {() => boolean} [visible] whether the page is on screen
 */

/** @param {Float32Array} samples */
function isSilent(samples) {
  for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) return false;
  return true;
}

export class LiveInput {
  /**
   * @param {LiveHandlers} handlers
   * @param {LiveDeps} [deps]
   */
  constructor(handlers, deps = {}) {
    this.handlers = handlers;
    this.openCapture = deps.open || openMicrophone;
    this.now = deps.now || (() => performance.now());
    this.visible = deps.visible || (() => typeof document === 'undefined' || document.visibilityState === 'visible');
    /** @type {import('./capture.js').Capture|null} */
    this.capture = null;
    this.sampleRate = 0;
    /** @type {AudioRing|null} */
    this.ring = null;
    /** Why the audio is interrupted, or '' while it flows. */
    this.interrupted = '';
    this.interruptions = 0;
    this.muted = false;
    this.closed = false;
    /** Run timeline seconds where the current segment starts. */
    this.segmentStart = 0;
    /** Frames passed on in the current segment. */
    this.segmentFrames = 0;
    /** Run timeline seconds and clock milliseconds when the interruption began. */
    this.interruptedAt = 0;
    this.interruptedClock = 0;
    /** Exact-silence frames in a row. */
    this.silentFrames = 0;
    /** The current segment has had sound; silence before the first sound is not an interruption. */
    this.heard = false;
    this.deviceId = '';
  }

  /**
   * Open the microphone. Call from a tap or click handler: the audio context is created before
   * anything waits.
   * @param {string} [deviceId] input chosen by the user, if any; the default input is used when
   *   it is no longer there
   */
  async open(deviceId = '') {
    this.deviceId = deviceId;
    const capture = await this.openCapture(
      { deviceId: deviceId || undefined, deviceExact: false },
      (chunk) => this.chunk(chunk.channels),
      (what) => this.change(what),
    );
    if (this.closed) {
      await capture.stop();
      return;
    }
    this.capture = capture;
    this.sampleRate = capture.context.sampleRate;
    this.ring = new AudioRing(KEEP_SECONDS, this.sampleRate);
  }

  /** @returns {string} the input's name as the browser gives it */
  get label() {
    return this.capture ? this.capture.label : '';
  }

  /** @returns {number|null} the input's own sample rate, when the browser reports it */
  get inputSampleRate() {
    return this.capture && this.capture.settings.sampleRate ? this.capture.settings.sampleRate : null;
  }

  /** @returns {number} seconds on the run's timeline */
  position() {
    if (this.interrupted) return this.interruptedAt + Math.max(0, this.now() - this.interruptedClock) / 1000;
    return this.segmentStart + (this.sampleRate ? this.segmentFrames / this.sampleRate : 0);
  }

  /** @returns {number} seconds of audio that `recording` would return */
  get recordedSeconds() {
    return this.ring ? this.ring.seconds : 0;
  }

  /**
   * The audio since the last interruption or restart, up to the last minute of it, exactly as
   * it was passed on.
   * @returns {{sampleRate: number, channels: Float32Array[]}|null}
   */
  recording() {
    if (!this.ring || this.ring.length === 0) return null;
    return { sampleRate: this.sampleRate, channels: [this.ring.read()] };
  }

  /** @param {Float32Array[]} channels */
  chunk(channels) {
    if (this.closed || !this.capture || !this.ring) return;
    const samples = channels[0];
    const silent = isSilent(samples);
    if (this.interrupted) {
      if (silent || this.muted || this.capture.context.state !== 'running') return;
      this.resume();
    }
    if (silent) {
      this.silentFrames += samples.length;
      if (this.heard && this.silentFrames >= SILENCE_SECONDS * this.sampleRate) {
        this.interrupt('silence');
        return;
      }
    } else {
      this.silentFrames = 0;
      this.heard = true;
    }
    this.ring.push(samples);
    this.segmentFrames += samples.length;
    this.handlers.onAudio(channels);
  }

  /** @param {string} what as reported by the capture */
  change(what) {
    if (this.closed) return;
    if (what === 'microphone muted') {
      this.muted = true;
      this.interrupt('muted');
    } else if (what === 'microphone unmuted') {
      this.muted = false;
    } else if (what === 'microphone ended') {
      this.interrupt('ended');
      if (this.visible()) this.wake();
    } else if (what === 'audio closed') {
      // Closed by the system, not by `close`: there is no reopening it from here.
      this.interrupt('closed');
      this.handlers.onEnd('The audio was shut down by the system. Press Start to measure again.');
      this.close();
    } else if (what.startsWith('audio ') && what !== 'audio running') {
      this.interrupt(what.slice(6));
    }
    // 'audio running' needs nothing: the next chunk with sound resumes.
  }

  /** @param {string} reason */
  interrupt(reason) {
    if (this.interrupted || this.closed) return;
    this.interruptedAt = this.position();
    this.interruptedClock = this.now();
    this.interrupted = reason;
    this.interruptions++;
    this.silentFrames = 0;
    this.handlers.onInterrupt(reason);
  }

  resume() {
    this.segmentStart = this.position();
    this.segmentFrames = 0;
    this.interrupted = '';
    this.silentFrames = 0;
    this.heard = true;
    if (this.ring) this.ring.clear();
    this.handlers.onResume();
  }

  /**
   * The page is back on screen: reopen a microphone that was taken away and restart audio that
   * was suspended. Audio that the system is still holding (a call in progress) comes back by
   * itself when the system releases it.
   */
  async wake() {
    const capture = this.capture;
    if (this.closed || !capture) return;
    if (capture.track.readyState === 'ended') {
      try {
        await capture.replaceStream({ deviceId: this.deviceId || undefined, deviceExact: false });
        this.muted = false;
      } catch {
        if (this.closed) return;
        this.handlers.onEnd('The microphone was closed and could not be reopened. Press Start to measure again.');
        this.close();
        return;
      }
    }
    if (capture.context.state !== 'running') capture.context.resume().catch(() => {});
  }

  /**
   * Use another input. The timeline and the kept audio start again.
   * @param {string} deviceId '' for the default input
   */
  async switchInput(deviceId) {
    if (this.closed || !this.capture) return;
    this.deviceId = deviceId;
    await this.capture.replaceStream({ deviceId: deviceId || undefined, deviceExact: false });
    this.muted = false;
    this.restart();
  }

  /** Start the timeline and the kept audio again, as for a fresh measurement. */
  restart() {
    this.segmentStart = 0;
    this.segmentFrames = 0;
    this.silentFrames = 0;
    this.heard = false;
    if (this.ring) this.ring.clear();
    if (this.interrupted) {
      this.interruptedAt = 0;
      this.interruptedClock = this.now();
    }
  }

  /** Stop listening. The kept audio stays available for saving. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.capture) this.capture.stop().catch(() => {});
  }
}
