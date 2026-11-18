# Watch Timegrapher Web App

A mechanical watch timegrapher that runs in a phone's web browser and listens through the
microphone. It measures rate (seconds per day) and beat error (milliseconds) and draws a
real-time trace.

**Status: milestone 6 of 9.** The timegrapher listens to the phone's microphone. It can also be
driven by a simulated watch, by three demo recordings or by a recording of your own.

Tested in Safari on an iPhone 17 Pro Max with iOS 27.2 (the audio diagnostic in milestone 4,
the timegrapher replaying the three demo recordings in milestone 5, and a live measurement of
the Omega in milestone 6), and in Chrome on a computer at phone size, where the microphone was
also tested with a recording played in as a simulated microphone.

Site: <https://squawkbirdies.github.io/watch-timegrapher-web-app/>

**This project was written with generative AI.** See [Use of generative AI](#use-of-generative-ai)
for who did what and what has been checked.

## What works today

`js/dsp/pipeline.js` takes audio chunks of any size and reports status, beats and readings as
events. It listens until it finds a beat rate, tracks each beat with a Kalman tracker, and
blanks the readings when the ticking stops. `js/dsp/offline.js` analyses a whole recording with
the same stages. The pipeline is checked against synthetic watches with known values, and both
are checked against five real recordings of watches and against a recording with no watch.

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
| ETA 2836-2, Safari capture | 28,800 vph, about +1.7 s/day, about 0.3 ms | +1.69 s/day, 0.31 ms | +1.69 s/day, 0.31 ms, locked at 8 s |
| Omega 3861, Safari capture | 21,600 vph, about +0.4 s/day, no beat error | +0.41 s/day | +0.21 s/day, locked at 8 s, every beat timed on its own |
| No watch, Safari capture of a quiet room | no lock | no lock | no lock, with the beat rate detected or given as any of the six |

The real-time column uses a 40 s averaging window (60 s for the ETA; the faint synthetic watch's
lengthens by itself to 91 s). The whole-recording figures for the synthetic watches were measured
in milestone 1. The tests now hold those watches to their expected values in real time only,
because each analysis the real-time pipeline makes runs the same stages. The expected values for
the first two recordings come from the Python prototype in `tools/prototype/`. Those for the two
Safari captures are the pipeline's own, cross-checked with a simple timing of each beat's loudest
moment above 5 kHz that shares no code with it: +1.64 s/day for the ETA and +0.49 s/day for the
Omega. The Safari captures are analysed from their first channel, as the app does, and the Omega
in co-axial mode. Over its minute the Omega's 20 s readings move smoothly between -0.2 and
+1.6 s/day, far more than their stated ±0.09 s/day, which points to the watch's own rate changing
over the minute. No recording has been compared with a bench timegrapher. On an iPhone 17
Pro Max the real-time pipeline ran 22.6 times faster than real time on two channels. That was
measured before the filter bank gained its two bands above 14.5 kHz, which cost about a quarter
of the speed in tests on a computer; the app now uses one channel, which halves the work.

The filter bank covers 1.5 to 22.5 kHz in nine bands. The two top bands were added after the
first captures from Safari, which carry tick sound up to 22.5 kHz: on those captures they made
the ticks 1.2 to 2.2 times clearer against the noise and cut the Omega's timestamp scatter by
about 30%. On the compressed Voice Memos recordings, which carry little above 19 kHz, they left
the readings unchanged and raised the scatter slightly. At 44.1 kHz the top band is dropped. A
test holds the Omega's capture to this: over its first 30 s, the top bands make its beats 2.3 and
2.2 times clearer and halve their scatter.

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

A prototype in `tools/prototype/coaxial/` measures a co-axial watch's beat error and amplitude
from the sounds inside each beat: the first, the unlock, and the last, the lock, which both
beats share. It is not part of the app. On the Omega's Safari capture it read 0.30 ms and, at a
36° lift angle, 285°; on the ETA's, 0.15 ms and 263° at 50°. Neither has been compared with a
timing machine. On the simulated watches of the unit tests it showed no wrong reading, but it
showed a reading for only 1 of the 35 that tick: the first sound of their weaker beat stands 0.3
to 1.9 dB over the background, against 3.8 dB in the Omega's capture and 11.8 dB in the ETA's,
and watches like them read only after 2 to 4 minutes. Its README gives the method, its checks,
and its limits.

Readings are averaged over 20 s by default, which follows the watch's own changes sooner but
reads less steadily. The last readings at 20 s were +6.91 s/day for the ETA, +0.45 s/day for the
first Omega recording and -1.58 s/day for the second, and after their first 20 s of lock the ETA's
readings ranged from +6.31 to +6.99 s/day and the second Omega's from -3.12 to -1.28 s/day. On
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

A beat made of several sounds gives a correlation curve with several peaks, and on a faint
beat the highest was not always the same one. On the second Omega recording, 19 of the 93
confident tick timestamps lay more than 1 ms from the tick line. A peak within 1 ms of where the
beat is expected is now preferred to a higher one elsewhere, if it stands above the noise and
reaches 60% of the highest. In an analysis, the expected place is the trend of the neighbouring
beats; while tracking, it is the tracker's prediction. This only chooses among the positions one
beat could have; it never mixes beats together. On that recording 6 of the 93 confident tick
timestamps now lie more than 1 ms from the line, and their scatter fell from 0.46 ms to 0.35 ms.
The rate readings moved by at most 0.05 s/day, except the first Omega recording's 20 s
readings, which ended on +0.45 instead of +1.08 s/day, against +0.54 for the whole recording.
On simulated watches heard clearly whose beats are displaced at random by 0.5 ms or 1 ms, the
timestamps still follow each beat's true displacement, by a factor of 0.88 to 1.01. They are as
close to it as before at 0.5 ms, and closer at 1 ms: 0.38 to 0.41 ms rms instead of 0.45 to 0.52.

A watch that runs badly does not keep its beats on a regular grid: each beat falls a little
early or late, by an amount that changes from beat to beat. The pipeline used to take such a
watch for a faint one, because scattered beats match an averaged beat poorly, and it averaged
several cycles per timestamp, which hid most of the scatter. Now each analysis also times the
beats one at a time. When single beats of both types scatter by more than 0.5 ms, the watch
counts as irregular (`js/dsp/irregular.js`). A regular watch keeps its single beats within about
0.1 ms. A wide sound scatters only its own beat type: in short windows the second Omega
recording's tick scattered by up to 1.4 ms while its tock kept within 0.32 ms. For an irregular
watch:

- the beat's shape is rebuilt from beats each lined up on its own position, three times over;
- each beat is looked for as far from where it is expected as three times the scatter, up to
  16 ms, and the peak nearest the expected place is not preferred;
- every timestamp is one beat; beats too faint to be timed alone are left out, never averaged;
- repeat analyses start from the beats already timed instead of folding the audio again, because
  scattered beats do not give the beat period away precisely enough for a fold;
- the rate combines both beat types, with its uncertainty widened when they disagree, and the
  scatter reading pools them, so the beat type that happens to look tighter cannot flatter the
  watch. Readings carry `irregular: true`.

A regular watch never takes this path: the three recordings and the two Safari captures give
the same readings as before. On a clearly audible simulated 28,800 vph watch whose beats scatter
by 2 ms, one beat type used to be averaged over 3 cycles, 171 of 281 confident timestamps lay
more than 0.5 ms from where their beats fell, and the lock was lost once; now every beat has its
own timestamp, 4 of 419 are that far off, and the lock holds. At 5 ms of scatter the lock used to
be lost twice, one beat type was not timed, and the rate was 153 s/day off against a stated
±12 s/day; now 4 of 356 timestamps are off and the lock holds. Over twelve 60 s runs each, the
final rate reading lay within twice its stated uncertainty of the true rate every time, at 2 ms
and at 5 ms. The ETA recording with every beat moved by a random 3 ms (the audio is stretched
and squeezed between beats) used to be averaged over 2 and 4 cycles with 111 of 151 timestamps
more than 0.5 ms off; now 2 of 284 are.

The tests include a "basket case", after the snowstorm trace in the collector guide on reading
timegrapher results: an 18,000 vph watch gaining 60 s/day whose beats scatter by 2 ms, whose rate
wanders, with one beat in thirty knocked up to 8 ms out, beats of uneven loudness, a rattle
between them and a real 2 ms beat error. Once the watch is recognised as irregular, the trace
must show each beat where it fell, with all of its scatter, and the scatter reading must stay
above 1.5 ms. No beat error may ever be shown (a confused timegrapher shows 0.0 ms). The rate
readings' errors, against the rate the watch actually ran at over each 20 s window, must stay
below 1.5 times their stated uncertainty, rms, with no more than 1 in 20 beyond 3 times it. On
three such watches the app on
the main branch averaged up to 8 cycles per timestamp, put 233 of 323 timestamps more than
0.5 ms from their beats, showed a scatter as low as 0.25 ms, and its rate readings were off by
3.3 times their stated uncertainty, rms, and by up to 15.6 times. Now 19 of 506 timestamps are
that far off, 14 of them on the quieter tock, and the rate readings are off by 1.2 times their
stated uncertainty, rms.

Known limits of the real-time pipeline:

- A faint watch is found only once enough of its ticking is in the history buffer. The default
  history is 40 s, which uses about 30 MB for stereo audio. The faint synthetic case needs 80 s.
- The first Omega recording takes 52 s to lock, because its first 14 s are poor and its ticks
  are faint.
- A beat error is shown only when both beat types are timed to within 0.2 ms of scatter. A
  watch with a genuinely ragged trace will therefore show no beat error.
- An irregular watch is recognised only once single beats of both types have been heard. When
  one beat type is too faint for that in the first short analysis, the first readings are made
  as for a regular watch, averaged and sometimes flattering: one simulated basket case read
  +163 ± 18 s/day for 4 s while it ran at +62. Of twelve simulated basket cases, eight were
  recognised at their first lock and three within 10 s of it; the twelfth lost its first lock
  and was recognised 28 s after it. A watch that is faint and irregular may not be recognised at
  all.
- A stray beat on an otherwise regular watch, more than 4 ms out, is not found.
- When an irregular watch's beat is two sounds of similar loudness, like the co-axial tock, the
  timestamps jump between them: on a simulated watch with 1.5 ms of scatter, 87 of 224 tocks
  were on the wrong sound.
- When a watch starts or stops running irregularly while it is measured, the pipeline notices
  the change in the scatter of the beats it tracks and re-analyses the last 8 s at once. On the
  simulator, the warning came 7 to 10 s after beat variability was turned up, and went 4 to 9 s
  after it was turned off, where scheduled analyses took 40 s. The readings then start afresh
  from the change, so for a while they rest on fewer beats and state a wider uncertainty. In the
  seconds before the change is confirmed, the readings can still flatter: one read
  +7.4 ± 0.2 s/day, 8 s after 2 ms of variability came on, for a watch at +8. Both beat types
  must be timed for a change to be noticed; otherwise the scheduled analyses decide. On the
  simulator, beat variability of 0.8 ms or more brings the warning at the first lock.
- The escapement is not detected automatically. A co-axial watch measured in Swiss-lever mode
  can show a large, steady beat error that is wrong.
- A blurred beat still scatters. The second Omega recording's ticks, a sound several
  milliseconds wide, scatter by 0.35 ms about their line against 0.08 ms for its tocks. A
  shorter matching window and single frequency bands both timed them worse.
- A quartz clock ticking once a second can be taken for a watch. With its clicks peaking at
  −46 dBFS in a quiet room, a simulated one locked at 21,600 vph.
- A beat type that stops being timed and is found again later starts from a fresh reference
  point, so its trace line can resume a few milliseconds from where it stopped.

## Live microphone

The Microphone tab is the first source and the default. Start asks for the microphone. The
first time, a notice explains that a phone's magnets can magnetise a watch: only an antimagnetic
watch should rest against the phone, and any other should be heard through a wired earbud
microphone held against the crown. The same advice stays above the input picker. The picker
lists the inputs the browser offers, named once the microphone has been allowed, and remembers
the choice. When the chosen input is gone, the default input is used. The active input's name
and sample rate are shown, and Bluetooth inputs are marked experimental. The audio is requested
with echo cancellation, noise suppression and automatic gain off, and only its first channel is
used, as in the audio diagnostic.

While it measures, the app keeps the screen on, because iOS stops the microphone when the screen
locks. Where the browser cannot keep the screen on, the panel suggests turning Auto-Lock off.

A call, another app taking the audio, the screen locking or the app going to the background
interrupts the microphone. The app notices when the browser reports the audio suspended or the
microphone muted or ended, or when the audio is exact digital silence for 0.3 s, which a working
microphone never delivers. The readings blank at once, the screen says so, and nothing heard
during the interruption is analysed. When sound comes back, the pipeline starts afresh and must
lock again, which takes 8 to 20 s as at the start, and the trace continues after a gap as long
as the interruption. A microphone closed while the app was in the background is reopened when
the app returns. Changing the input, the beat rate or the mains frequency while measuring
starts the measurement again without closing the microphone.

The last 60 s of what the microphone heard since the last interruption are kept in memory, about
11 MB at 48 kHz. "Save the last minute" hands them over as a 32-bit float WAV file, through the
share sheet where there is one (on the iPhone, Save to Files) or as a download. Replayed under
Your file, the saved minute is the very audio that was analysed.

In Chrome on a computer, with the ETA recording played in as a simulated microphone (Chrome
delivers it at 44.1 kHz), the live reading after 50 s was +6.9 s/day and 0.40 ms. The recording
itself, streamed through the pipeline, reads +6.88 s/day and 0.38 ms at the same point, and the
saved minute replayed under Your file read +6.9 s/day and 0.40 ms. With 3 s of digital silence
inserted into the recording at 40 s, the app showed the interruption, resumed when the sound
came back and locked again 9 s later. The automated tests drive the same code with a stand-in
for the microphone: a simulated watch cut off for 2 s gives no readings during the gap, no
confident dots in it and a fresh lock after it, and its saved minute matches the analysed audio
sample for sample and replays to the same reading within 0.1 s/day.

On the iPhone 17 Pro Max with iOS 27.2, on 17 November 2026, the Omega was measured live in
co-axial mode and the run stopped before a minute. The live reading was +0.8 ± 0.09 s/day over
20 s, and the 58.5 s saved from that run, replayed under Your file, read the same +0.8 ± 0.09 with
the same trace. On a computer the saved file reads +0.81 ± 0.09 s/day, with every tick and tock
timed on its own, standing 40 and 18 times the noise spread above the noise.

Not yet tested on the iPhone: the interruptions as iOS reports them (calls, Siri, other apps,
locking the screen, switching apps, a Home Screen app sent to the background), the screen
staying on, and wired earbud and Bluetooth inputs.

Known limits of the live microphone:

- After an interruption the measurement starts over, and its readings use only the audio since
  the gap. The tick and tock lines can trade places across the gap, as after any lost lock.
- If iOS does not give the audio back when the app returns, the app keeps waiting; press Stop,
  then Start.
- In the 0.3 s before digital silence counts as an interruption, the trace may show a dim dot or
  two where beats were due.
- Saving keeps only the audio since the last interruption.
- The microphone cannot wait for the analysis. If the analysis falls more than 8 s behind, the
  measurement stops with a message. The iPhone ran the pipeline 22.6 times faster than real time.

## Hosting

The app is a folder of static files with no build step, served by GitHub Pages over HTTPS.
Browsers allow the microphone only on secure pages, so the app cannot be opened from a local
file. [docs/hosting.md](docs/hosting.md) explains how to set up the site, how to host your own
copy, and how to test on a computer.

`index.html` is the timegrapher. Its header shows rate, beat error and (once it is measured)
amplitude, with the beat rate, lift angle and averaging window under them, and dashes instead of
stale numbers when there is no lock or the microphone is interrupted. When the watch runs irregularly, a warning below them says
by how much its beats wander from one to the next. Below are the trace, one dot per beat in milliseconds ahead
of an ideal clock with low-confidence beats dimmed; a signal meter with advice; and the averaged
tick and tock. The source can be the microphone, a simulated watch whose rate, beat error, beat
variability and loudness can be changed while it runs, one of the three test recordings, or a
recording chosen from the phone, replayed at real speed or faster. Settings (beat rate,
escapement, lift angle, mains frequency, averaging window), the chosen microphone and whether
the magnetism notice has been read are kept on the device.

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
npm test             # about eight minutes on a fast computer
npm run typecheck    # needs TypeScript (tsc) on the path
node tools/run-analysis.js tests/fixtures/eta-2836-2.wav 2 54    # whole recording
node tools/run-stream.js tests/fixtures/eta-2836-2.wav 2 54      # real time, in chunks
node tools/run-stream.js tests/fixtures/omega-3861.wav 2 60 0 0 21600   # beat rate given
```

## Layout

```
CLAUDE.md              guidance for AI agents working in this repository
index.html             the timegrapher (script in js/main.js, styles in css/app.css)
check.html             browser check
diagnostic.html        audio diagnostic (script in js/diagnostic.js)
docs/hosting.md        setting up GitHub Pages
js/dsp/filterbank.js   band-pass filter bank, 1.5 to 22.5 kHz, and energy envelopes
js/dsp/cleanup.js      noise levelling, click clipping, mains-hum comb filter
js/dsp/acquire.js      beat-rate search by folding, exact and fast
js/dsp/template.js     averaged tick-tock cycle
js/dsp/timing.js       matched-filter beat timing, with averaging for faint watches
js/dsp/irregular.js    irregular watches: every beat timed on its own
js/dsp/estimate.js     rate and beat error from the timestamps; the escapement setting
js/dsp/offline.js      runs all stages over a whole recording or a window of it
js/dsp/tracker.js      Kalman beat tracker
js/dsp/pipeline.js     real-time pipeline: listening, tracking, lock lost
js/dsp/session.js      the pipeline plus a record of its computing time; the speed test
js/dsp/worker.js       runs a session in a background worker
js/audio/capture.js    microphone choice, raw-audio request, interruptions
js/audio/capture-worklet.js  audio-thread chunker
js/audio/live.js       the microphone as a source: interruptions, resuming, the last minute
js/audio/ring.js       the most recent stretch of audio, in fixed memory
js/audio/wav.js        WAV reader for recordings, writer for saved captures
js/audio/simulator.js  synthetic watch, as whole recordings or endless and adjustable
js/audio/file-source.js  decodes a recording and hands it out in chunks
js/audio/player.js     paces a source in real time, or faster
js/ui/model.js         what the screen shows, worked out from the pipeline's events
js/ui/trace.js         the trace
js/ui/waveform.js      the averaged tick and tock
js/ui/canvas.js        drawing helpers and chart colours
js/ui/wake.js          keeps the screen on while measuring
js/ui/save.js          hands a saved file to the share sheet or a download
js/store.js            settings kept on the device
tests/                 automated tests and the six recordings
tools/                 command-line runners, the Python prototype kept for reference, and the
                       co-axial prototype (tools/prototype/coaxial/)
```

The code is plain JavaScript modules with no build step and no runtime dependencies. The files
in `js/dsp/` use only standard JavaScript and `performance.now()`, so the same code runs in the
tests and in the app's background worker.

## Test recordings

`tests/fixtures/` holds six iPhone recordings.

- `eta-2836-2.wav`, `omega-3861.wav` and `omega-3861-b.wav` were made with Voice Memos, about a
  minute each, and converted to 16-bit WAV with 24 dB of gain. In the first two, the watch lay
  dial-down with the crown against the phone's USB-C port. In `omega-3861-b.wav` the phone was
  held over the dial with the USB-C port facing it, in a different room.
- `eta-2836-2-safari.wav` (30 s) and `omega-3861-safari.wav` (60 s) were saved by the audio
  diagnostic in Safari on an iPhone 17 Pro Max with iOS 27.2, on 14 November 2026, with the
  browser's voice processing off. They are stereo with a silent second channel, as Safari
  delivered the phone's mono microphone.
- `no-watch-safari.wav` is the null case: 60 s of a quiet room with no watch near the phone,
  saved the same way later, by which time the diagnostic kept only the first channel.

The Safari captures are 32-bit floating point at 48 kHz, exactly as saved. Every file holds only
the audio format and the samples, with no other metadata. The automated tests use all six.

## Use of generative AI

Most of this project was produced by Claude, an AI model made by Anthropic, working in a chat
with the project's owner. The models used were Claude Fable 5.2 and Claude Opus 5.5.

Written by Claude:

- all the code in this repository: the JavaScript signal pipeline, the Kalman beat tracker, the
  synthetic watch generator, the interface, the tests and the command-line tools
- the Python prototype in `tools/prototype/`
- this README, `CLAUDE.md` and the project's design plan
- the choice of signal-processing methods, and the expected values the tests check against

Done by Lawrence Fan:

- the idea, the goals and the requirements
- the design decisions recorded in the plan, including the magnetism warning, the minimum iOS
  version and the choice of plain JavaScript
- suggestions taken into the design, including the Kalman beat tracker and the beat-rate override
- the six recordings in `tests/fixtures/` (five of watches, one with no watch), which are the
  only test data not produced by AI-written code

What this means for the readings: every result above comes from AI-written code, tested
against AI-written synthetic signals and against the real recordings. The expected values
for the first two recordings also come from AI-written code. No reading has yet been compared
with a bench timegrapher, so treat rates and beat errors from this project as unverified.

## Licence

MIT. See `LICENSE`.
