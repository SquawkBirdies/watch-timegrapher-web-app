// Recordings as a source of audio: a file is decoded once, then handed out in chunks, just as
// the microphone hands them out. WAV files are decoded here and keep their own sample rate;
// other formats (such as the .m4a files Voice Memos makes) go through the browser's decoder,
// which resamples them to 48 kHz.

import { decodeWav } from './wav.js';

/**
 * @typedef {Object} Recording
 * @property {number} sampleRate
 * @property {Float32Array[]} channels at most two
 * @property {number} duration seconds
 */

/** The pipeline was tested on recordings with up to two channels; any others are ignored. */
const MAX_CHANNELS = 2;

/**
 * @param {ArrayBuffer} buffer the whole file
 * @returns {Promise<Recording>}
 */
export async function decodeRecording(buffer) {
  let audio = decodeWav(buffer);
  if (!audio) {
    const Offline = window.OfflineAudioContext || /** @type {any} */ (window).webkitOfflineAudioContext;
    if (!Offline) throw new Error('This browser cannot decode audio files.');
    const context = new Offline(1, 1, 48000);
    // decodeAudioData takes the buffer over, so it gets a copy.
    const decoded = await context.decodeAudioData(buffer.slice(0));
    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(new Float32Array(decoded.getChannelData(c)));
    audio = { sampleRate: decoded.sampleRate, channels };
  }
  const channels = audio.channels.slice(0, MAX_CHANNELS);
  if (channels.length === 0 || channels[0].length === 0) throw new Error('The file holds no audio.');
  return { sampleRate: audio.sampleRate, channels, duration: channels[0].length / audio.sampleRate };
}

/** Hands out a recording from start to end. */
export class RecordingSource {
  /** @param {Recording} recording */
  constructor(recording) {
    this.recording = recording;
    this.sampleRate = recording.sampleRate;
    this.channelCount = recording.channels.length;
    this.position = 0;
    this.length = recording.channels[0].length;
  }

  /**
   * @param {number} frames
   * @returns {Float32Array[]|null} copies of the next samples, or null at the end
   */
  next(frames) {
    if (this.position >= this.length) return null;
    const end = Math.min(this.length, this.position + frames);
    const out = this.recording.channels.map((c) => c.slice(this.position, end));
    this.position = end;
    return out;
  }
}
