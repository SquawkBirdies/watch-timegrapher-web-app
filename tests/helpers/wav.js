// WAV reader for the test recordings: the app's own decoder, reading from a file.

import { readFileSync } from 'node:fs';
import { decodeWav } from '../../js/audio/wav.js';

/**
 * @param {string} path
 * @returns {{sampleRate: number, channels: Float32Array[]}}
 */
export function readWav(path) {
  const buf = readFileSync(path);
  const audio = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (!audio) throw new Error(`${path} is not a WAV file this reader can decode`);
  return audio;
}
