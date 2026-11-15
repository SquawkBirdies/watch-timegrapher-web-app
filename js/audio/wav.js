// WAV files. Saved captures hold only the audio format and the samples, with no other
// metadata, as 32-bit floating point so that nothing the microphone delivered is rounded away.
// Recordings opened in the app are decoded here when they are WAV files, so that they keep
// their own sample rate; other formats go through the browser's decoder.

/**
 * @param {Float32Array[]} channels one array per channel, all the same length
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate) {
  const channelCount = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = 4;
  const dataBytes = frames * channelCount * bytesPerSample;
  // RIFF header 12, fmt chunk 8 + 18, fact chunk 8 + 4, data chunk 8 + data
  const total = 12 + 26 + 12 + 8 + dataBytes;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  /** @param {number} at @param {string} text */
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, total - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 18, true);
  view.setUint16(20, 3, true); // IEEE floating point
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  view.setUint16(36, 0, true); // no extension
  ascii(38, 'fact');
  view.setUint32(42, 4, true);
  view.setUint32(46, frames, true);
  ascii(50, 'data');
  view.setUint32(54, dataBytes, true);
  let at = 58;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      view.setFloat32(at, channels[c][i], true);
      at += 4;
    }
  }
  return buffer;
}

/**
 * Decode a WAV file holding 16-bit or 24-bit integer or 32-bit floating-point samples.
 * @param {ArrayBuffer} buffer the whole file
 * @returns {{sampleRate: number, channels: Float32Array[]} | null} null when the file is not a
 *   WAV file this function can read
 */
export function decodeWav(buffer) {
  const view = new DataView(buffer);
  /** @param {number} at */
  const tag = (at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      const integer = format === 1 && (bits === 16 || bits === 24);
      const float = format === 3 && bits === 32;
      if (!(integer || float) || channelCount < 1 || sampleRate < 1) return null;
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, buffer.byteLength - body) / (bytes * channelCount));
      const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channelCount; c++) {
          const p = body + (i * channelCount + c) * bytes;
          let v;
          if (float) v = view.getFloat32(p, true);
          else if (bits === 16) v = view.getInt16(p, true) / 32768;
          else v = ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 8388608);
          channels[c][i] = v;
        }
      }
      return { sampleRate, channels };
    }
    offset = body + size + (size & 1);
  }
  return null;
}
