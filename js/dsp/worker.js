// Web Worker entry point. Runs the pipeline off the main thread so that drawing and touch stay
// smooth while audio is analysed.
//
// Messages in:
//   {type: 'start', id, sampleRate, channelCount, options}
//                                                         begin a session; id is optional
//   {type: 'chunk', channels}                             audio for the session
//   {type: 'settings', changes}                           averaging window, escapement or lift
//                                                         angle changed
//   {type: 'stop'}                                        end the session
//   {type: 'finish', id}                                  end the session once the reading of the
//                                                         beats' sounds in progress is done; id
//                                                         is optional, and another session's is
//                                                         answered without ending this one
//   {type: 'benchmark', options}                          time the pipeline on simulated audio
// Messages out:
//   {type: 'events', id, events, load}                    what the pipeline reported for a chunk,
//                                                         with the id of the session that heard it
//   {type: 'events', id, events, load, last: true}        the answer to 'finish': always sent,
//                                                         with no events when nothing was left
//   {type: 'benchmark', result}
//   {type: 'error', message}

import { Session, benchmark } from './session.js';

/** @typedef {{postMessage: (message: unknown) => void, onmessage: ((event: MessageEvent) => void) | null}} WorkerScope */
const scope = /** @type {WorkerScope} */ (/** @type {unknown} */ (self));

/** @type {Session|null} */
let session = null;
/** @type {unknown} */
let sessionId = null;

scope.onmessage = (event) => {
  const m = event.data;
  try {
    if (m.type === 'start') {
      session = new Session(m.sampleRate, m.channelCount, m.options || {});
      sessionId = m.id === undefined ? null : m.id;
    } else if (m.type === 'chunk') {
      if (!session) return;
      const events = session.push(m.channels);
      scope.postMessage({ type: 'events', id: sessionId, events, load: session.load() });
    } else if (m.type === 'settings') {
      if (session) session.pipeline.setOptions(m.changes || {});
    } else if (m.type === 'stop') {
      session = null;
    } else if (m.type === 'finish') {
      // The page counts on this answer, so it is sent whether or not a session is left to end.
      const id = m.id === undefined ? sessionId : m.id;
      const ending = id === sessionId ? session : null;
      if (ending) session = null;
      const events = ending ? ending.finish() : [];
      scope.postMessage({ type: 'events', id, events, load: ending ? ending.load() : null, last: true });
    } else if (m.type === 'benchmark') {
      scope.postMessage({ type: 'benchmark', result: benchmark(m.options || {}) });
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
