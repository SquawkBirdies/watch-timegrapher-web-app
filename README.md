# Watch Timegrapher Web App

A mechanical watch timegrapher that runs in a phone's web browser and listens through the
microphone. It measures rate (seconds per day) and beat error (milliseconds) and draws a
real-time trace.

**Status: milestone 5 of 9.** The timegrapher screen works, driven by a simulated watch, by
three demo recordings or by a recording of your own. The live microphone comes to it in
milestone 6; until then the audio diagnostic records and measures it.

Tested in Safari on an iPhone 17 Pro Max with iOS 27.2 (the audio diagnostic in milestone 4,
and the timegrapher replaying the three demo recordings in milestone 5), and in Chrome on a
computer at phone size.

Site: <https://squawkbirdies.github.io/watch-timegrapher-web-app/>

**This project was written with generative AI.** See [Use of generative AI](#use-of-generative-ai)
for who did what and what has been checked.

## What works today

`js/dsp/pipeline.js` takes audio chunks of any size and reports status, beats and readings as
events. It listens until it finds a beat rate, tracks each beat with a Kalman tracker, and
blanks the readings when the ticking stops. `js/dsp/offline.js` analyses a whole recording with
the same stages. Both are checked against synthetic watches with known values, against three
real recordings of watches, and against a recording with no watch.

| Test | Expected | Whole recording | Real time, 128-sample chunks, 40 s window |
| --- | --- | --- | --- |
| Synthetic, 28,800 vph, clear ticks | +12.0 s/day, 0.30 ms | +12.00 s/day, 0.31 ms | +12.00 s/day, 0.31 ms, locked at 8 s |
| Synthetic, 21,600 vph, with mains buzz | -8.0 s/day, 0.80 ms | -7.96 s/day, 0.82 ms | -7.94 s/day, 0.81 ms |
| Synthetic, 18,000 vph, faint ticks | +45.0 s/day | +45.13 s/day | +45.11 s/day, locked at 57 s with an 80 s history |
| Synthetic, each of the six beat rates | set rate, 0.50 ms | not run | within 0.06 s/day and 0.01 ms |
| Synthetic, noise only | no lock | no lock | no lock in 120 s |
| ETA 2836-2 recording | 28,800 vph, about +6.5 s/day, about 0.43 ms | +6.43 s/day, 0.42 ms | +6.40 s/day, 0.41 ms |
| Omega 3861 recording | 21,600 vph, about +0.2 s/day, no beat error | +0.54 s/day | +0.54 s/day, locked at 52 s |
| Omega 3861, second recording | 21,600 vph, no reference value | -2.07 s/day | -2.13 s/day, locked at 12 s |
| No watch, Safari capture of a quiet room | no lock | no lock | no lock, with the beat rate detected or given as any of the six |

The real-time column uses a 40 s averaging window (60 s for the ETA, 80 s for the faint
synthetic watch). The expected values for the first two recordings come from the Python
prototype in `tools/prototype/`. No recording has been compared with a bench timegrapher. On an iPhone 17
Pro Max the real-time pipeline ran 22.6 times faster than real time on two channels. That was
measured before the filter bank gained its two bands above 14.5 kHz, which cost about a quarter
of the speed in tests on a computer; the app now uses one channel, which halves the work.

The filter bank covers 1.5 to 22.5 kHz in nine bands. The two top bands were added after the
first captures from Safari, which carry tick sound up to 22.5 kHz: on those captures they made
the ticks 1.2 to 2.2 times clearer against the noise and cut the Omega's timestamp scatter by
about 30%. On the compressed Voice Memos recordings, which carry little above 19 kHz, they left
the readings unchanged and raised the scatter slightly. At 44.1 kHz the top band is dropped.

The beat rate can be given instead of detected: pass `{ bph: 21600 }` to `Pipeline`, or a beat
rate as the last argument of either command-line tool. Only that rate is then searched. In
tests this did not make the lock arrive sooner, but it cut the computing spent while listening
to noise to between 30% and 40%. A wrong rate unrelated to the true one gives no lock. A mix-up
between 18,000 and 36,000 vph can still lock; the rate in seconds per day is then still right
and no beat error is shown.

The escapement can be set to Swiss lever (the default) or co-axial: pass
`{ escapement: 'coaxial' }` to `Pipeline` or `analyze`. A co-axial escapement's tick and tock
are different sounds, so the gap between them is not the beat error. In co-axial mode the rate
is still measured from both beats, and no beat error is reported. The Omega 3861 captured
through Safari showed why: in Swiss-lever mode it read a steady 3.4 ms beat error that does not
describe the watch, and the beat-error checks passed it.

Readings are averaged over 20 s by default, which follows the watch's own changes sooner but
reads less steadily. The last readings at 20 s were +6.92 s/day for the ETA, +1.08 s/day for the
first Omega recording and -1.54 s/day for the second, and after their first 20 s of lock the ETA's
readings ranged from +6.30 to +6.98 s/day and the second Omega's from -3.11 to -1.30 s/day. On
synthetic watches every 20 s reading lay within three times its stated uncertainty of the true
rate. When faint ticks must be averaged over several cycles, the window is lengthened until each
beat type has at least 12 independent timestamps: on the first Omega recording, to 27 s.

A beat's timestamp is the moment one point of its sound arrives, and each analysis picks that
point afresh, as the loudest part of the averaged beat. When a beat is made of two sounds of
similar loudness, the loudest part can change from one analysis to the next. The second Omega
recording showed it: its tock is two sounds 3.7 ms apart, and a repeat analysis 64 s in moved
the tock timestamps by 3.8 ms, which put a step in the trace. Each repeat analysis now measures
how far its timestamps lie from the ones already reported for the same beats, and reports its
own moved back by that much, so a beat type keeps the reference point it had when the lock
began. On that recording the tock trace is now one line, with no step above 0.4 ms between
neighbouring 5 s stretches. The rate and beat-error readings of the three recordings are
unchanged at the default window: all the timestamps of a beat type inside the window move
together, and the beat error is still judged between the template's own loudest points.

Known limits of the real-time pipeline:

- A faint watch is found only once enough of its ticking is in the history buffer. The default
  history is 40 s, which uses about 30 MB for stereo audio. The faint synthetic case needs 80 s.
- The first Omega recording takes 52 s to lock, because its first 14 s are poor and its ticks
  are faint.
- A beat error is shown only when both beat types are timed to within 0.2 ms of scatter. A
  watch with a genuinely ragged trace will therefore show no beat error.
- The escapement is not detected automatically. A co-axial watch measured in Swiss-lever mode
  can show a large, steady beat error that is wrong.
- A single faint beat made of several sounds can still be timed on a neighbouring sound. On
  the second Omega recording 20 of the 93 confident tick timestamps lie more than 1 ms off the
  tick line. The line fit sets them aside, so they scatter the trace without moving the rate.
- A beat type that stops being timed and is found again later starts from a fresh reference
  point, so its trace line can resume a few milliseconds from where it stopped.

## Hosting

The app is a folder of static files with no build step, served by GitHub Pages over HTTPS.
Browsers allow the microphone only on secure pages, so the app cannot be opened from a local
file. [docs/hosting.md](docs/hosting.md) explains how to set up the site, how to host your own
copy, and how to test on a computer.

`index.html` is the timegrapher. Its header shows rate, beat error and (once it is measured)
amplitude, with the beat rate, lift angle and averaging window under them, and dashes instead of
stale numbers when there is no lock. Below are the trace, one dot per beat in milliseconds ahead
of an ideal clock with low-confidence beats dimmed; a signal meter with advice; and the averaged
tick and tock. The source can be a simulated watch whose rate, beat error and loudness can be
changed while it runs, one of the three test recordings, or a recording chosen from the phone,
replayed at real speed or faster. Settings (beat rate, escapement, lift angle, mains frequency,
averaging window) are kept on the device.

`check.html` checks the browser: secure connection, microphone access, audio worklets, screen
wake lock, and whether the signal pipeline loads.

`diagnostic.html` is the audio diagnostic. It records up to 60 s from the first channel of a
chosen microphone with the browser's echo cancellation, noise suppression and automatic gain
off (or on, to compare), shows the waveform above 2 kHz, and runs the real-time pipeline on the
audio as it arrives in a background worker. Afterwards it reports what the browser actually
applied, the levels, any dropouts or interruptions, the readings and the pipeline's load. The
recording can be saved as a 32-bit float WAV file holding nothing but the audio. A speed test
times the pipeline on 60 s of a simulated watch.

## Running the tests

Requires Node 22 or later. There is nothing to install.

```
npm test             # about nine minutes
npm run typecheck    # needs TypeScript (tsc) on the path
node tools/run-analysis.js tests/fixtures/eta-2836-2.wav 2 54    # whole recording
node tools/run-stream.js tests/fixtures/eta-2836-2.wav 2 54      # real time, in chunks
node tools/run-stream.js tests/fixtures/omega-3861.wav 2 60 0 0 21600   # beat rate given
```

## Layout

```
index.html             the timegrapher (script in js/main.js, styles in css/app.css)
check.html             browser check
diagnostic.html        audio diagnostic (script in js/diagnostic.js)
docs/hosting.md        setting up GitHub Pages
js/dsp/filterbank.js   band-pass filter bank, 1.5 to 22.5 kHz, and energy envelopes
js/dsp/cleanup.js      noise levelling, click clipping, mains-hum comb filter
js/dsp/acquire.js      beat-rate search by folding, exact and fast
js/dsp/template.js     averaged tick-tock cycle
js/dsp/timing.js       matched-filter beat timing, with averaging for faint watches
js/dsp/estimate.js     rate and beat error from the timestamps; the escapement setting
js/dsp/offline.js      runs all stages over a whole recording or a window of it
js/dsp/tracker.js      Kalman beat tracker
js/dsp/pipeline.js     real-time pipeline: listening, tracking, lock lost
js/dsp/session.js      the pipeline plus a record of its computing time; the speed test
js/dsp/worker.js       runs a session in a background worker
js/audio/capture.js    microphone choice, raw-audio request, interruptions
js/audio/capture-worklet.js  audio-thread chunker
js/audio/wav.js        WAV reader for recordings, writer for saved captures
js/audio/simulator.js  synthetic watch, as whole recordings or endless and adjustable
js/audio/file-source.js  decodes a recording and hands it out in chunks
js/audio/player.js     paces a source in real time, or faster
js/ui/model.js         what the screen shows, worked out from the pipeline's events
js/ui/trace.js         the trace
js/ui/waveform.js      the averaged tick and tock
js/ui/canvas.js        drawing helpers and chart colours
js/store.js            settings kept on the device
tests/                 automated tests and the four recordings
tools/                 command-line runners, and the Python prototype kept for reference
```

The code is plain JavaScript modules with no build step and no runtime dependencies. The files
in `js/dsp/` use only standard JavaScript and `performance.now()`, so the same code runs in the
tests and in the app's background worker.

## Test recordings

`tests/fixtures/` holds four iPhone recordings of about a minute each. The three watch
recordings were made with Voice Memos and converted to 16-bit WAV with 24 dB of gain. In the
first two, the watch lay dial-down with the crown against the phone's USB-C port. In
`omega-3861-b.wav` the phone was held over the dial with the USB-C port facing it, in a
different room. `no-watch-safari.wav` is the null case: 60 s of a quiet room with no watch near
the phone, saved by the audio diagnostic in Safari. It is the capture exactly as saved, in
32-bit floating point, mono. Like the others, it holds only the audio format and the samples,
with no other metadata.

## Use of generative AI

Most of this project was produced by Claude, an AI model made by Anthropic, working in a chat
with the project's owner. The models used were Claude Fable 5.2 and Claude Opus 5.5.

Written by Claude:

- all the code in this repository: the JavaScript signal pipeline, the Kalman beat tracker, the
  synthetic watch generator, the interface, the tests and the command-line tools
- the Python prototype in `tools/prototype/`
- this README and the project's design plan
- the choice of signal-processing methods, and the expected values the tests check against

Done by Lawrence Fan:

- the idea, the goals and the requirements
- the design decisions recorded in the plan, including the magnetism warning, the minimum iOS
  version and the choice of plain JavaScript
- suggestions taken into the design, including the Kalman beat tracker and the beat-rate override
- the four recordings in `tests/fixtures/` (three of watches, one with no watch), which are the
  only test data not produced by AI-written code

What this means for the readings: every result above comes from AI-written code, tested
against AI-written synthetic signals and against the four real recordings. The expected values
for the first two recordings also come from AI-written code. No reading has yet been compared
with a bench timegrapher, so treat rates and beat errors from this project as unverified.

## Licence

MIT. See `LICENSE`.
