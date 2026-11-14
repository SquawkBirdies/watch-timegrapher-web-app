// Minimal WAV reader for the test recordings (16-bit PCM or 32-bit float).

import { readFileSync } from 'node:fs';

/**
 * @param {string} path
 * @returns {{sampleRate: number, channels: Float32Array[]}}
 */
export function readWav(path) {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`);
  let format = 1;
  let channelCount = 1;
  let sampleRate = 48000;
  let bits = 16;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytes * channelCount));
      const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channelCount; c++) {
          const p = body + (i * channelCount + c) * bytes;
          channels[c][i] = format === 3 ? view.getFloat32(p, true) : view.getInt16(p, true) / 32768;
        }
      }
      return { sampleRate, channels };
    }
    offset = body + size + (size & 1);
  }
  throw new Error(`${path} has no data chunk`);
}
