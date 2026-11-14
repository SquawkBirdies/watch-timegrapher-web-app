// Web Worker entry point. Runs the pipeline off the main thread so that drawing and touch stay
// smooth while audio is analysed.
//
// Messages in:
//   {type: 'start', sampleRate, channelCount, options}   begin a session
//   {type: 'chunk', channels}                             audio for the session
//   {type: 'stop'}                                        end the session
//   {type: 'benchmark', options}                          time the pipeline on simulated audio
// Messages out:
//   {type: 'events', events, load}                        what the pipeline reported for a chunk
//   {type: 'benchmark', result}
//   {type: 'error', message}

import { Session, benchmark } from './session.js';

/** @typedef {{postMessage: (message: unknown) => void, onmessage: ((event: MessageEvent) => void) | null}} WorkerScope */
const scope = /** @type {WorkerScope} */ (/** @type {unknown} */ (self));

/** @type {Session|null} */
let session = null;

scope.onmessage = (event) => {
  const m = event.data;
  try {
    if (m.type === 'start') {
      session = new Session(m.sampleRate, m.channelCount, m.options || {});
    } else if (m.type === 'chunk') {
      if (!session) return;
      const events = session.push(m.channels);
      scope.postMessage({ type: 'events', events, load: session.load() });
    } else if (m.type === 'stop') {
      session = null;
    } else if (m.type === 'benchmark') {
      scope.postMessage({ type: 'benchmark', result: benchmark(m.options || {}) });
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
