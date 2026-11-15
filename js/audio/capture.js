// Microphone capture: choosing an input, asking the browser for raw audio, and delivering it
// in chunks from an audio worklet. Runs on the main thread.

/**
 * @typedef {Object} CaptureOptions
 * @property {string} [deviceId] input to use; the browser's default when absent
 * @property {boolean} [echoCancellation]
 * @property {boolean} [noiseSuppression]
 * @property {boolean} [autoGainControl]
 * @property {number} [chunkFrames] frames per chunk delivered to `onChunk`
 */

/**
 * @typedef {Object} Chunk
 * @property {number} startFrame audio-clock frame of the first sample
 * @property {Float32Array[]} channels one array per channel
 * @property {number} silentBlocks 128-frame blocks of exact silence so far
 * @property {number} blocks 128-frame blocks so far
 */

/**
 * @typedef {Object} Capture
 * @property {AudioContext} context
 * @property {MediaStream} stream
 * @property {MediaStreamTrack} track
 * @property {MediaTrackConstraints} requested what was asked for
 * @property {MediaTrackSettings} settings what the browser says it applied
 * @property {string} label the input's name, once permission is granted
 * @property {() => Promise<void>} stop
 */

/**
 * Inputs the browser offers. Their names are only filled in after microphone permission has
 * been granted once.
 * @returns {Promise<MediaDeviceInfo[]>}
 */
export async function listMicrophones() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/**
 * Open the microphone and start delivering audio. Call from a tap or click handler: iOS only
 * lets audio start in response to the user.
 * @param {CaptureOptions} options
 * @param {(chunk: Chunk) => void} onChunk
 * @param {(what: string) => void} [onChange] called when the audio is interrupted, resumed or ends
 * @returns {Promise<Capture>}
 */
export async function openMicrophone(options, onChunk, onChange = () => {}) {
  // Create the audio context inside the user's tap, before any waiting.
  const context = new AudioContext({ latencyHint: 'interactive' });
  /** @type {MediaTrackConstraints} */
  const requested = {
    echoCancellation: options.echoCancellation ?? false,
    noiseSuppression: options.noiseSuppression ?? false,
    autoGainControl: options.autoGainControl ?? false,
  };
  if (options.deviceId) requested.deviceId = { exact: options.deviceId };
  /** @type {MediaStream} */
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: requested, video: false });
  } catch (error) {
    await context.close();
    throw error;
  }
  const track = stream.getAudioTracks()[0];
  try {
    await context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    if (context.state !== 'running') await context.resume();
  } catch (error) {
    track.stop();
    await context.close();
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  // Only the first channel is kept. Safari on the iPhone delivers the mono microphone as two
  // channels with the second one silent; analysing that silent channel doubled the work.
  const node = new AudioWorkletNode(context, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
    processorOptions: { chunkFrames: options.chunkFrames ?? 4096 },
  });
  // Some browsers only run a node that leads to the speakers, so it is connected through a
  // silent gain stage.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(context.destination);
  node.port.onmessage = (event) => {
    if (event.data && event.data.type === 'chunk') onChunk(event.data);
  };
  context.onstatechange = () => onChange(`audio ${context.state}`);
  track.onmute = () => onChange('microphone muted');
  track.onunmute = () => onChange('microphone unmuted');
  track.onended = () => onChange('microphone ended');

  let stopped = false;
  return {
    context,
    stream,
    track,
    requested,
    settings: track.getSettings(),
    label: track.label,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      node.port.postMessage('stop');
      // Give the worklet one render quantum to post what it holds.
      await new Promise((resolve) => setTimeout(resolve, 50));
      track.stop();
      source.disconnect();
      node.disconnect();
      mute.disconnect();
      await context.close();
    },
  };
}
