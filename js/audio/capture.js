// Microphone capture: choosing an input, asking the browser for raw audio, and delivering it
// in chunks from an audio worklet. Runs on the main thread.

/**
 * @typedef {Object} CaptureOptions
 * @property {string} [deviceId] input to use; the browser's default when absent
 * @property {boolean} [deviceExact] true (the default) to fail when that input is missing; false
 *   to fall back to the default input, for an input remembered from an earlier visit. (Asking
 *   for the input as merely preferred does not work: Chrome then keeps to an input it already
 *   has open.)
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
 * @property {(options: CaptureOptions) => Promise<void>} replaceStream open the microphone again,
 *   or another input, and feed it into the same audio context and worklet. The fields above
 *   then describe the new input.
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
  let requested;
  /** @type {MediaStream} */
  let stream;
  try {
    ({ stream, requested } = await getStream(options));
  } catch (error) {
    await context.close();
    throw error;
  }
  let track = stream.getAudioTracks()[0];
  try {
    await context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    if (context.state !== 'running') await context.resume();
  } catch (error) {
    track.stop();
    await context.close();
    throw error;
  }
  let source = context.createMediaStreamSource(stream);
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
  /** @param {MediaStreamTrack} t */
  const watch = (t) => {
    t.onmute = () => onChange('microphone muted');
    t.onunmute = () => onChange('microphone unmuted');
    t.onended = () => onChange('microphone ended');
  };
  watch(track);

  let stopped = false;
  /** @type {Capture} */
  const capture = {
    context,
    stream,
    track,
    requested,
    settings: track.getSettings(),
    label: track.label,
    replaceStream: async (next) => {
      const { stream: fresh, requested: wanted } = await getStream(next);
      const freshTrack = fresh.getAudioTracks()[0];
      if (stopped) {
        freshTrack.stop();
        return;
      }
      const old = track;
      old.onmute = old.onunmute = old.onended = null;
      source.disconnect();
      old.stop();
      stream = fresh;
      track = freshTrack;
      requested = wanted;
      source = context.createMediaStreamSource(stream);
      source.connect(node);
      watch(track);
      Object.assign(capture, { stream, track, requested, settings: track.getSettings(), label: track.label });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      node.port.postMessage('stop');
      // Give the worklet one render quantum to post what it holds.
      await new Promise((resolve) => setTimeout(resolve, 50));
      track.onmute = track.onunmute = track.onended = null;
      track.stop();
      source.disconnect();
      node.disconnect();
      mute.disconnect();
      await context.close();
    },
  };
  return capture;
}

/**
 * What to ask the browser for: raw audio unless told otherwise.
 * @param {CaptureOptions} options
 * @returns {MediaTrackConstraints}
 */
function constraints(options) {
  /** @type {MediaTrackConstraints} */
  const requested = {
    echoCancellation: options.echoCancellation ?? false,
    noiseSuppression: options.noiseSuppression ?? false,
    autoGainControl: options.autoGainControl ?? false,
  };
  if (options.deviceId) requested.deviceId = { exact: options.deviceId };
  return requested;
}

/**
 * Ask for the microphone, falling back to the default input when the chosen one is missing and
 * the options allow it.
 * @param {CaptureOptions} options
 * @returns {Promise<{stream: MediaStream, requested: MediaTrackConstraints}>}
 */
async function getStream(options) {
  const requested = constraints(options);
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: requested, video: false }), requested };
  } catch (error) {
    const missing = error instanceof Error && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError');
    if (!options.deviceId || options.deviceExact !== false || !missing) throw error;
    const fallback = constraints({ ...options, deviceId: undefined });
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: fallback, video: false }), requested: fallback };
  }
}
