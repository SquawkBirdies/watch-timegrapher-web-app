// WAV encoding for saved captures. The file holds only the audio format and the samples, with
// no other metadata, as 32-bit floating point so that nothing the microphone delivered is
// rounded away.

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
