# Watch Timegrapher Web App

A mechanical watch timegrapher that runs in a phone's web browser and listens through the
microphone. It measures rate (seconds per day), beat error (milliseconds) and, as an experimental
reading, amplitude (degrees), and draws a real-time trace.

**Status: milestone 8 of 9, in progress.** The timegrapher listens to the phone's microphone. It can
also be driven by a simulated watch, by two demo recordings or by a recording of your own. It
measures continuously, or saves a reading for each of the six positions a watch is checked in.
Milestone 8, amplitude and a beat error measured from the unlock, is under way: the first four of
its six steps are in the code. Since the fourth, the screen shows both, for Swiss-lever and co-axial
escapements alike, each with its scatter or with a dash and the reason; the beat error first appears
15 s or more after the lock and the amplitude 20 s or more, and both start again when the beat error
steps, as after an adjustment, at a sensitivity set in Settings. Following the amplitude over time
and telling the escapement from the sound are the two steps left. Neither reading has been compared
with a timing machine.

Tested in Safari on an iPhone 17 Pro Max with iOS 27.2 (the audio diagnostic in milestone 4, the
timegrapher replaying its three demo recordings of the time, all made with Voice Memos, in milestone
5, a live measurement of the Omega in milestone 6, a six-position run of the Omega and the theme
setting in milestone 7, and the two demos of today with the cost of reading the Omega's amplitude in
milestone 8), and in Chrome on a computer at phone size, where the microphone was also tested with a
recording played in as a simulated microphone. The screen of milestone 8's fourth step, which shows
the amplitude and the beat error from the unlock, was checked on the iPhone on 27 November with the
Omega demo, the simulator, the audio diagnostic and the Omega live; the ETA has not yet been
measured live with it.

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

The beat errors in this table are the gap between the timed beats: half the difference between the
two intervals from each beat's loudest sound to the next one's. It was the beat error the app showed
for Swiss levers until 26 November 2026. The pipeline still reports it, and it names the tick on a
Swiss lever, but the screen now shows the beat error measured from each beat's first sound, the
unlock, which is given further down. The real-time column uses a 40 s averaging window (60 s for the
ETA; the faint synthetic watch's lengthens by itself to 91 s). The whole-recording figures for the
synthetic watches were measured in milestone 1. The tests now hold those watches to their expected
values in real time only, because each analysis the real-time pipeline makes runs the same stages.
The expected values for the first two recordings come from the Python prototype in
`tools/prototype/`. Those for the two Safari captures are the pipeline's own, cross-checked with a
simple timing of each beat's loudest moment above 5 kHz that shares no code with it: +1.64 s/day for
the ETA and +0.49 s/day for the Omega. The Safari captures are analysed from their first channel, as
the app does, and the Omega in co-axial mode. Over its minute the Omega's 20 s readings move
smoothly between -0.2 and +1.6 s/day, far more than their stated ±0.09 s/day, which points to the
watch's own rate changing over the minute. No recording has been compared with a bench timegrapher.
On an iPhone 17 Pro Max the real-time pipeline ran 22.6 times faster than real time on two channels.
That was measured before the filter bank gained its two bands above 14.5 kHz, which cost about a
quarter of the speed in tests on a computer; the app now uses one channel, which halves the work.

The filter bank covers 1.5 to 22.5 kHz in nine bands. The two top bands were added after the
first captures from Safari, which carry tick sound up to 22.5 kHz: on those captures they made
the ticks 1.2 to 2.2 times clearer against the noise and cut the Omega's timestamp scatter by
about 30%. On the compressed Voice Memos recordings, which carry little above 19 kHz, they left
the readings unchanged and raised the scatter slightly. At 44.1 kHz the top band is dropped. A
test holds the Omega's capture to this: over its first 30 s, the top bands make its beats 2.3 and
2.2 times clearer and halve their scatter.

The beat rate can be given instead of detected: pass `{ bph: 21600 }` to `Pipeline`, or a beat rate
as the last argument of either command-line tool. Only that rate is then searched. In tests this did
not make the lock arrive sooner, but it cut the computing spent while listening to noise to between
30% and 40%. A wrong rate unrelated to the true one gives no lock. A mix-up between 18,000 and
36,000 vph can still lock; the rate in seconds per day is then still right and neither a beat error
nor an amplitude is shown. Told 18,000 vph, a 36,000 vph watch has its every other beat taken, so
the tick and the tock found are both its ticks, and its tocks fall halfway between them. Until 18
November that went unnoticed: run for 60 s, such a watch showed a beat error of about 0.005 ms in
every reading, against a true 0.50 ms. The pipeline now looks for a beat halfway between the tick
and the tock, and shows no beat error when it finds one. The screen then says "check the beat rate"
under both dashes.

Left to find the beat rate itself, the pipeline can take a 36,000 vph watch whose tock is much
quieter than its tick for an 18,000 vph watch, and the halfway check does not see a tock that
faint. Of 36 simulated 36,000 vph watches run for 60 s, with the tock at 0.1 to 0.8 of the tick,
16 were taken for 18,000 vph: the rate stayed within 0.4 s/day, but the beat error read 0.008 to
0.023 ms against a true 0.50 ms. None of them had the tock at 0.8 of the tick, and the ETA's two
captures have it at 0.79 and 0.91. None of 24 simulated 18,000 vph watches was taken for
36,000. In 9 of the 16 the tock is clear over the whole 60 s, but the lock was taken on the first
8 to 32 s and the rate was not checked again; in the other 7 nothing in the sound tells the watch
from an 18,000 vph one. Checking the rate again would hold back the beat error of a true
18,000 vph watch by about a minute, and on 18 November it was decided not to. Choosing
36,000 vph in the settings avoids the wrong beat error: of the 16, two then read it right, six
give the rate alone and eight give nothing within 60 s.

The escapement can be set to Swiss lever (the default) or co-axial: pass `{ escapement: 'coaxial' }`
to `Pipeline` or `analyze`. A co-axial escapement's tick and tock are different sounds, so the gap
between their timed beats is not the beat error. In co-axial mode the rate is still measured from
both beats, that gap is not reported, and the tick is named by another rule (see The screen, below).
The Omega 3861 captured through Safari showed why: in Swiss-lever mode the gap between its timed
beats read a steady 3.4 ms that does not describe the watch, and the checks on that gap passed it.
Since milestone 8's fourth step the beat error on the screen is measured from the unlocks for both
escapements, so it no longer depends on this setting; the amplitude depends on the lift angle, which
a co-axial needs set lower.

A prototype in `tools/prototype/coaxial/` measures a co-axial watch's beat error and amplitude
from the sounds inside each beat: the first, the unlock, and the last, the lock, which both
beats share. It is not part of the app. It adds its frequency bands by their energy, so that a
noisier room does not move its readings. On the Omega's Safari capture it read 0.35 ms and, at a
36° lift angle, 287°; on the ETA's, 0.30 ms and 267° at 50°. Neither has been compared with a
timing machine. On the simulated watches of the unit tests it shows no reading for any of the 35
that tick: the first sound of their weaker beat stands 0.3 to 1.9 dB over the background,
against 3.8 dB in the Omega's capture and 11.8 dB in the ETA's. Made as loud as the Omega and
60 s long, 22 of them read within 0.05 ms, and the two 36,000 vph watches given as 18,000 vph
read about 0 ms against 0.50, as the app's own Swiss-lever reading does. Its README gives the
method, its checks, and its limits.

Milestone 8 brings that method into the app, for both escapements, in six steps. The first four
are in. `js/dsp/sounds.js` averages each beat type's envelopes around its timestamps and finds
the sounds in the averaged beat. `js/dsp/amplitude.js` takes the first as the unlock, chooses the
lock for both beats together, and gives the beat error from the unlocks and the amplitude, each
with a scatter and a verdict on whether it may be shown. `js/dsp/soundstage.js` does the same in
the real-time pipeline, on the beats heard since the lock. Each runs when a lift angle is given:
`analyze` with `{ liftAngle: 36 }` (a fifth argument to `tools/run-analysis.js`), the pipeline
with the same option (a seventh argument to `tools/run-stream.js`). The app gives its pipeline
the lift angle from the settings, so the readings are made while it measures, and since the fourth
step its screen shows them (see The screen, below).

| Recording, first channel, whole | Beat error from the unlocks | Amplitude | Unlock to lock, tick and tock | May be shown |
| --- | --- | --- | --- | --- |
| Omega 3861, Safari capture, at 36° | 0.343 ± 0.045 ms | 287.7 ± 1.2° | 6.96 ± 0.03 and 6.33 ± 0.04 ms | both; lined up again on its two locks |
| ETA 2836-2, Safari capture, at 50° | 0.275 ± 0.028 ms | 265.9 ± 0.6° | 7.49 ± 0.01 and 7.50 ± 0.03 ms | both; nothing moved |
| The three Voice Memos recordings | none | none | timestamps that each average several cycles | |
| No watch, Safari capture | none | none | no beats timed | |

How a reading is made and judged:

- **Its scatter.** The beats of each type are drawn again with their timestamps, 200 times, and
  the whole procedure is repeated on each draw. The standard deviation over the draws is the ±
  above. The draws are seeded, so a recording always gives the same reading.
- **The gates.** A reading may be shown when at most 5% of the draws fail to find the sounds and
  the rest scatter by no more than 0.1 ms for the beat error, 5° for the amplitude. A draw that
  puts any of the four sounds more than 0.5 ms from where all the beats put it has found another
  sound and counts as failing. The beat error is also held back when the pipeline finds the
  watch irregular, and the amplitude kept. Both are held back when it finds a beat halfway
  between the tick and the tock, which means the beat rate in use is half the watch's own.
- **The placement check.** Each beat is averaged where its timestamp puts it. Timestamps that
  scatter smear the averaged sounds, and when the unlock helps to time a beat they also line its
  noise up, so the beat error moves one way. Timestamps that are wrong for many beats of one type
  can even put another sound where the unlock is looked for. The draws cannot see either: they draw
  the beats with their timestamps. So both readings are made a second time from the same envelopes,
  without draws, with every beat placed on the trend of its type's timestamps: a straight line, and
  the median of each 15 timestamps' distances from it. The difference between the two readings of
  the beat error is added to its stated scatter, as the root of the sum of the squares, before the
  0.1 ms gate, and the amplitude's to its scatter before the 5° gate (the amplitude since 26
  November). When the second reading finds no sounds neither can be checked and both are held back.
  The readings themselves are not changed: the trend is no place for the beats of a watch whose
  beats really scatter. On the Omega's capture the second reading is 0.357 ms and 288.1°, and the
  scatters go from 0.043 to 0.045 ms and from 1.15 to 1.24°; on the ETA's, 0.270 ms and 265.7°,
  from 0.027 to 0.028 ms and from 0.51 to 0.55°. `{ sounds: { placementCheck: false } }` leaves the
  check out.
- **Lining up.** An average of beats is biased when the amplitude changes while they are taken:
  the timestamps follow each beat's loudest sound, and the other sounds move against it. So the
  beats are cut into 10 s blocks, each sound is matched in each block, and a sound whose blocks
  show it moving, beyond what 40 draws of each block's beats allow by chance (1%), has its beats
  lined up again on it before they are averaged. A block's shift that scatters by more than
  0.3 ms over those draws is left out. On a simulated lever whose amplitude falls from 290° to
  250° in 40 s the plain average reads 264.6°, 5.4° low, and would show it; lined up, 269.8°.
  `{ sounds: { lineUp: 'never' } }` gives the plain average and `'always'` lines every sound up.

In real time the stage works like this:

- **What it keeps.** The envelopes of the six bands from 5 kHz up, as the filter bank made them
  and before the clean-up, for the last 60 to 64 s: 18.5 MB. When a reading starts, each
  confident beat's stretch is cut out of them at its timestamp's own place, and every beat's
  again at its place on the trend, for the placement check.
- **Which beats.** Those heard since the lock appeared, at most the last 60 s of them (45 s at High
  sensitivity, below), and only beats that were timed alone. The beats of the 8 s of audio a lock is
  found in are left out, so that a reading rests on nothing from before the watch was placed, as the
  six-position log asks. A lost lock clears everything.
- **When.** The first reading starts when each beat type has 15 s of beats; until 27 November it
  waited for 30 s (below). The next start 5 s apart while the beats still reach back less than the
  stretch, and 10 s apart after that.
- **When the watch changes.** Once a second the gap of each tick-tock cycle between its timed
  beats is compared with the gaps of the beats the latest reading rests on. When the last 5 s
  disagree with them for 3 s running, by more than a threshold, the stretch starts again from where
  the gaps stepped, as at a new lock, and both readings show a dash until the next reading
  (`js/dsp/steps.js`, rule B of issue 36). See [Following an
  adjustment](#following-an-adjustment-27-november).
- **How its computing is spread.** A reading with its 200 draws takes from half a second to
  several seconds of computing, and the same thread has audio to keep up with. So a reading is
  taken a few milliseconds at a time, for at most half of the time that passes, and after it the
  stage rests for half as long as the reading took. A reading that costs 3 s of computing appears
  6 s after it started, and describes the beats up to its start. The draws come in the same
  order however the steps are spread, so the reading is the same.
- **What it reports,** with the readings every second: the amplitude and the beat error from the
  unlocks, each with its scatter, or nothing and the reason: waiting for beats, timestamps that
  average several cycles, no reading, or held back by a gate. A watch the pipeline finds
  irregular loses its beat error at once and keeps its amplitude; a beat halfway between the tick
  and the tock blanks both. A new lift angle blanks both until they have been read again with it,
  which starts in the next audio block. The averaged beat sent to the screen carries marks where
  the unlock and the lock start, while an amplitude is shown.

| In real time, each reading finished at once | Lock | First reading | Read |
| --- | --- | --- | --- |
| Omega 3861, Safari capture, co-axial, 36° | 8.1 s | 23.4 s, from 15 s of beats, held back with those at 20 and 25 s | first shown at 38.8 s, from 30 s of beats, as before; reliably shown from 49 s, with 41 s of beats; at the end 0.31 ± 0.04 ms and 288.4 ± 1.0° from 51 s of beats |
| Simulated lever, 28,800 vph, 0.50 ms and 270°, at 50°, loudness 3 | 8.1 s | 23.4 s | 0.51 ± 0.03 ms shown from the first reading, its amplitude held back for want of a second block; 0.52 ± 0.02 ms and 268.7 ± 1.1° from 20 s of beats, at 28.6 s; 38.8 s with a first reading at 30 s |
| ETA 2836-2, Safari capture | 8.1 s | 23.4 s | 0.23 ± 0.03 ms, the amplitude held back; then 0.27 ± 0.04 ms and 265.8 ± 0.7° from 20 s of beats; none before 27 November, the capture being 30 s long |
| ETA 2836-2, Voice Memos recording | 8.1 s | 23.4 s | no reading for its first minute: the first sound found comes at no believable time before the lock (`lift-range`), 0.05 s of computing a try; then its timestamps average cycles |
| The two Omega 3861 Voice Memos recordings | 52 s and 12 s | none: timestamps that each average several cycles | a dash, with that reason |

The times are those of the readings event that first carried the reading. In the app a reading
appears later by twice its computing, as below.

With 15, 20 and 25 s of its beats, 72%, 51% and 22% of the Omega's draws lose its faint unlock, so a
first reading at 15 s shows it nothing sooner and nothing different. With 30 to 40 s of its beats, 4
to 10% of them do, against the 5% a reading is allowed: read every second, it was shown twice in ten
and held back eight times, then shown every time from 41 s of beats on. So the first number of a
watch like it can appear, give way to a dash and come back. What was read was 0.30 to 0.34 ms and
288° to 290° throughout. The placement check takes the first reading's stated scatter from 0.056 to
0.074 ms, the two readings being 0.05 ms apart with 30 s of beats, and the later ones' by 0.001 to
0.006 ms. The amplitude's goes from 1.45 to 1.49° for the first reading and by 0.03° at most for the
others. Read from the beats before the lock as well, with the first reading at 30 s of beats, the
same capture would have had its first reading at 30.6 s instead of 38.8 s, and been reliably shown
from 37.8 s instead of 49 s (`sounds: { sinceLock: false }`).

What has been checked, on a computer:

- **The real-time stage against the whole-recording one.** Fed a made-up watch block by block,
  it gives the reading the whole-recording stage gives of the same beats, to rounding, also once
  the envelopes it keeps have been moved up in their buffer. Spread over the audio by a clock the
  test keeps, a reading with every sound lined up is the same to the last digit as one finished
  at once. In the pipeline, a simulated lever's events are the same whether the audio comes in
  chunks of 1,024 or 4,096 samples, and its timestamps, rate and beat error are the same with
  the stage as without. So are those of the six recordings.
- **Against the prototype.** Given each beat where the prototype puts it, and the prototype's own
  draws, the port gives every one of the 200 resampled readings within 2 hundred-millionths of a
  millisecond of the prototype's on envelopes made as the app makes them (`analyze.py --app`),
  which is rounding: on the two captures, lined up where a sound moves and with every sound lined
  up, and on 59 simulated watches, with the same share of draws failing and the same verdicts. The
  prototype reads the captures at 0.340 ± 0.044 ms and 287.6 ± 1.2°, and 0.273 ± 0.026 ms and 265.7
  ± 0.5°. The port puts each beat at its timestamp's own place in the envelope instead, three
  eighths of an envelope sample (0.03 ms) earlier, the same for every beat, and makes its own
  draws. The placement check was compared the same way, on the same two captures and 59 watches:
  the trend's beat times agree to a hundred-million-millionth of a second, the second reading and
  the widened scatter to 5 billionths of a millisecond, and the verdicts on the beat error are the
  same. The prototype does not check the amplitude this way; there the app goes further.
- **Against the truth, on the 46 simulated watches the prototype was judged on,** 42 co-axials on
  the Omega's pattern and 4 levers. 31 beat errors are shown, as the prototype shows on the same
  envelopes, with the placement check as without it: it holds none of them back. Every one lies
  within 3 times its own stated scatter of the truth, the worst 2.2 times (2.4 times the scatter of
  its draws alone), and within 0.15 ms, the worst a co-axial in beat shown 0.14 ms off at a stated
  ±0.09 ms (±0.07 from its draws). Over the 31 the errors are 0.89 times the stated scatter, rms,
  and 1.06 times that of the draws alone. The check holds no amplitude back either. A co-axial's
  two readings of the amplitude differ by up to 1.3°, the one on the trend mostly the higher, which
  takes the stated scatter of the 27 shown from 0.4 to 1.4° to 0.5 to 1.9°. Their errors are 0.68
  times the stated scatter, rms, and 0.89 times the draws' alone, so a co-axial's amplitude is now
  stated about a third less precisely than its errors would allow. The four levers' scatter stays
  at 0.2 to 0.3°. The 31 amplitudes shown lie within 1.6°. Nothing is shown for the 6 whose unlock
  is set 2 dB over the background or level with it, or for the 3 of 20 s; one of the 6 took another
  sound for an unlock and read 3.05 ms off, and 95% of its draws disagree with it.
- **The watches the placement check is for.** Six simulated co-axials whose unlock is as loud as
  their lock, 20 dB over the background where the Omega-like ones' is 5, with every sound then made
  5 dB quieter so that their timestamps scatter by 0.1 ms; three in beat and three 0.5 ms out.
  Their beat errors read 0.017 to 0.075 ms off, all one way: 3.3 times the scatter of their draws,
  rms, the worst 5.3 times. The second reading lies on the truth's side of the first each time, and
  with the difference added the errors are 1.3 times the stated scatter, rms, the worst 1.8 times;
  all six are still shown. Of the 16 such watches the investigation used, 14 are read here (two
  have timestamps that average cycles): 3.1 times the draws' scatter, 1.2 times the stated one, all
  14 shown. A made-up watch with one tock timestamp in three 0.2 ms late reads 0.042 ms off at
  ±0.013 ms from its draws and ±0.045 ms stated. With that timestamp 1.2 ms late the early copy of
  the unlock is taken for the unlock: the beat error reads on the wrong side of zero and the
  amplitude 20° low, the draws agree on both, to 0.01 ms and 0.1°, and the check holds both back.
- **Levers.** The 4 among the 46 and 8 whose impulse is as loud as the drop or up to 9 dB
  louder are all shown, within 0.011 ms at a stated ±0.008 to ±0.011 ms, and within 0.3°. The 5
  whose unlock is lost or whose impulse cannot be heard give no reading.
- **Watches that do not hold still.** A simulated lever with each beat 0.5 ms off the grid, which
  the pipeline finds irregular, keeps its amplitude, 269.7° against 270°, stated at ±0.8° where its
  draws alone say ±0.2°, and shows no beat error. One swinging by 30° either way every 40 s, too
  fast for 10 s blocks to follow, reads its amplitude 10° high; a quarter of its draws take another
  sound, and nothing is shown.

The limits so far:

- **The gates limit a reading's scatter, not its error,** as the co-axial shown 0.14 ms off
  says. A stated scatter counts how the beats differ within the reading, and nothing else.
- **The placement check counts the shift it can see, and cannot tell beats that scatter from
  timestamps that do.** It compares two ways of placing the beats, not a reading with the truth: on
  the six faint co-axials above the worst beat error is still 1.8 times its stated scatter off. A
  watch whose beats really scatter has its two readings apart too, so they are stated less
  precisely than its draws say, though they are right. The irregular simulated lever's amplitude,
  0.3° from the truth, is stated at ±0.8° instead of ±0.2°, and a made-up watch's whose beats
  scatter by 0.6 ms at ±2.6° instead of ±0.03°. On the simulated co-axials the amplitude's stated
  scatter grows by a third at the median and by up to 2.2 times, with the errors as they were. A
  watch that scatters too little for the pipeline to call it irregular has its beat error stated
  less precisely or held back: the two readings were 0.12 ms apart with 0.3 ms of scatter in the
  prototype. Over the first and last seven beats of a stretch the trend has timestamps on one side
  only and lags a rate that is changing, by up to 0.03 ms in the tests.
- **A stretch under 20 s has one block and nothing to line up on.** A made-up watch of 15 s
  whose amplitude falls by 36° reads it 6.5° low, at a scatter of 2.0°. Since 27 November the
  first reading in real time, after a lock or a restart, has 15 s of beats, so its amplitude is
  held back, "needs 20 s of beats", until a reading has two blocks, 5 s later (decided by
  Lawrence Fan on 27 November). Its beat error is judged by its own scatter, which the smearing
  raises: this watch's was held back for it. No reading of a steady simulated watch was off its
  truth by more than 3 times its scatter at any length tried.
- **Nothing for the first 15 s after a lock,** or after a restart, and no amplitude for 20 s; for a
  watch whose unlock is as faint as the Omega's, nothing before about 31 s and nothing steady before
  about 40 s. Each
  lost lock starts that wait again.
- **A reading is not quick, and it is not fresh.** On a computer, in Node, a reading of 60 s of
  beats takes 0.4 to 0.9 s of computing when no sound moves, 4 s when two are lined up (the
  Omega's capture) and 8 s when three are, at 28,800 vph, since every draw then lines its own
  beats up again; about 30% less than before this step, with the same numbers. In Chrome on the
  same computer a steady lever's readings took 1.0 to 1.2 s of computing every 10 s, and a
  simulated co-axial with two sounds lined up 4 to 6 s over 9 to 12 s, with a reading every 18 s.
  The whole pipeline then used about 20% and about 40% of real time, against 8% without the
  stage. The Omega's capture had its first reading, 2.8 s of computing, 6 s after it started. A
  reading describes the beats up to the moment it started. On an iPhone 17 Pro Max on 26 November,
  the Omega demo was read four times in its minute, the last in 1.4 s of computing over 2.9 s, with
  the whole analysis at 16% of real time; this computer takes about 3 s for such a reading, though
  on the pipeline alone the phone takes 1.1 to 1.45 times as long as this computer. That is one
  recording and the cost of one reading; the heavier cases have not been timed on a phone.
- **The placement check's cost.** In Node a reading of 60 s of beats takes 0.1 to 0.5 s longer with
  it: 1.26 s against 0.93 s for a steady lever and 0.53 s against 0.41 s for the ETA's capture, a
  third more; 4.6 s against 4.3 s for the Omega's capture and 9.1 s against 8.6 s with three sounds
  lined up, a twentieth more. In Chrome, measured one after the other, a steady lever's readings
  took 1.5 to 1.6 s of computing against 1.1 to 1.3 s without the check, and the whole analysis 20
  to 21% of real time against 17 to 18%; a simulated co-axial with two sounds lined up, 6.3 to 6.5 s
  against 6.1 s, and 27 to 30% either way; the Omega demo, 2.9 and 3.4 s against 2.8 and 3.2 s, and
  20% either way. Cutting the beats out a second time adds 4 to 6 ms to the audio block a reading
  starts in, which is not spread like the rest. On an iPhone 17 Pro Max on 26 November, with the
  check, the Omega demo was read four times, the last in 1.4 s of computing over 2.8 s, with the
  whole analysis at 15% of real time, against 1.4 s over 2.9 s and 16% without it: on that recording
  the check costs under 0.1 s a reading on the phone.
- **Its memory:** 18.5 MB for the envelopes kept, and 8 to 14 MB more while a reading is worked
  out, with 5 to 7 MB on top for the placement check's copy of the beats and 3 MB while its second
  reading is made. In Chrome the page's process held 10 to 25 MB more with the stage than without,
  at about 300 MB, and its peak was 319 MB with the check against 314 MB without. Not measured in
  Safari.
- **Every beat must be timed alone.** When a beat type's timestamps each average several cycles
  there is no reading, as decided on 25 November. That leaves out all three Voice Memos
  recordings, the ETA's because its ticks average two cycles.
- **Audio at 44.1 kHz was tested only on conversions.** The filter bank now keeps its top band
  there, cut to 18 to 20.7 kHz, where it used to drop it, since most of the Omega's unlock lies
  in it. On the Omega's capture converted to 44.1 kHz the stage read nothing before and reads
  0.34 ± 0.04 ms and 289 ± 1° now, against 0.34 ± 0.04 ms and 288 ± 1° at 48 kHz. The timing uses
  the band too, so readings at 44.1 kHz move a little: the ETA's rate from 1.71 to 1.69 s/day and
  its beat error from 0.302 to 0.310 ms, and its beat error from the unlocks from 0.14 to
  0.25 ms, against 0.275 ms at 48 kHz; converted with a low-pass at 20 kHz, 0.14 to 0.15 ms. The
  Omega's rate stays at 0.41 s/day. No capture was made at 44.1 kHz. At 48 kHz nothing changes.
  A band is cut to fit only when at least half of it is left, so 16 kHz audio keeps its four
  bands.

- **Not checked against a timing machine.** That the first sound is the unlock in both
  co-axial beats is a reading of the patents, and the Omega 3861's 36° lift angle comes from a
  forum post; each degree of it moves the amplitude by about 8°.

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

A watch's rate can change quickly. An old 18,000 vph Swiss-lever watch, recorded through Safari for
five minutes on 22 November 2026, ran at about +40 s/day for its first 45 s and about -25 s/day
after three and a half minutes, and swung by 17 s/day (standard deviation) within seconds, once by
27 s/day in about 7 s, with no cycle of one minute. The tracker lets the rate wander only slowly,
so it fell behind: before each of the three times the lock was lost, it was already 0.6 to 4 ms
behind the beats, 4 ms being the edge of its search. Its gate is set by how much its misses vary,
not by how large they are, so a steady lag narrowed it until every beat was refused, though each
stood 30 to 40 dB above the background, and after 5 s the lock was dropped. A repeat analysis,
which starts the tracker again from a straight line through the last 40 s of beats, did not catch
it up: on a one-minute capture of the same watch it set the tracker to +77 s/day, sure of it to
±0.24 s/day, while the watch was running about +50 s/day and slowing. Each new lock numbered its
beats afresh, so the tick and the tock could swap, and the trace stepped by 1 to 6 ms.
Since 22 November:

- The tracker is started again from the beats when it refuses three confident timestamps of each
  timed beat type in a row, or when its last six misses of each all fall the same way with a
  median beyond 0.5 ms. It starts from a line through the latest eight confident timestamps of
  each type, and only when they lie within three times its usual scatter of that line.
- A repeat analysis folds its audio at one beat period and looks for each beat no more than 4 ms
  from where that period puts it. It starts its search for the period from the period of the
  beats already timed in its audio when the tracker's period is beyond the search's reach, and
  folds only as much of the latest audio as keeps those beats within 1 ms of a straight line,
  down to 8 s. Irregular watches and watches timed over several cycles keep the whole history.
- A lock found within 20 s of a lost one, at the same beat rate, carries on its beat numbers and
  its reference points, so a tick stays a tick and the trace carries on.

On that recording the lock now holds for all five minutes, the tracker is started again 23 times,
and no step in the trace exceeds 1 ms. Against each beat's loudest moment above 1 kHz, a timing
that shares no code with the pipeline, 3 of 746 tick timestamps lie more than 0.5 ms from their
median distance, against 40 before. The recording is not published, so the tests use simulated
watches instead. Of six simulated 18,000 vph watches whose rate swings by 40 s/day either way
every 70 s, at most 3.6 s/day each second, all six keep their lock, with timestamps 0.08 to
0.12 ms rms from the true beat times. The tracker as it was lost the lock on one of them and
swapped its tick and tock, and lagged another's beats so far that about a hundred timestamps of
each type were more than 0.5 ms out. On a simulated watch whose ticking pauses for 6.8 s, the lock
found again carries on within 0.1 ms rms, where one that numbered its beats afresh swapped the
tick and the tock. The regular recordings read as before, apart from the Omega's Safari capture:
its repeat analysis at 40 s used to stop at the edge of its search for the period and now
settles inside it, and its 20 s readings moved by up to 0.035 s/day, its Swiss-lever beat error
by up to 0.011 ms. On the five-minute recording the lock analyses took 11.9 s of computing
instead of 16.0 s, because no lock has to be found again and the repeat analyses fold less audio.

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
- A beat type that stops being timed and is found again later can start from a fresh reference
  point, so its trace line can resume a few milliseconds from where it stopped. A lock found
  again within 20 s of a lost one keeps the old reference points only if it times some of the
  same beats; after a silence it starts afresh, though its beat numbers carry on.
- After a lost lock the readings start again from the new lock's beats, even when the trace
  carries on.
- The changes of 22 November for fast changes of rate were measured on one real watch and on
  simulated ones. A faint watch timed over several cycles whose rate changes as fast is untested.

## The screen: amplitude, beat error and the names of the beats

Milestone 8's fourth step, on 26 November 2026, puts what is read from the sounds inside the beats
on the screen. Everything in this section was checked in Chrome on a computer and in the automated
tests, and on the iPhone on 27 November as set out [below](#on-the-iphone-27-november); the ETA has
not yet been measured live with it.

**The readout** gives rate, amplitude and beat error. The amplitude is in whole degrees and the beat
error in hundredths of a millisecond, each with its stated scatter and the stretch of beats it rests
on underneath, as in "±1.1° over 50 s". Both come from the sounds inside the beats for either
escapement. The gap between the timed beats, which was the Swiss-lever beat error until now, is no
longer shown, and the log no longer says "not shown: co-axial". A reading that is not shown is a
dash with the reason under it:

| Under the dash | When |
| --- | --- |
| needs 15 s of beats | the lock is younger than that, or its first reading is still being worked out; "needed" once the source has stopped |
| needs 20 s of beats | amplitude only: the reading's beats span one 10 s block, so a sound that moves within it could not be lined up (since 27 November); "needed" once the source has stopped |
| changed: reading again | the gaps between the timed beats stepped, as when the watch is adjusted, and both readings start again from the beats after the step, for 15 s or more (since 27 November) |
| beats too faint | a beat type's timestamps each average several cycles, so no single beat can be placed |
| too few clear beats | a lock old enough to have them has fewer than 10 confident beats of a type |
| sounds not found | no unlock, or no lock to pair with it, in the averaged beats |
| check the lift angle | the time from the first sound to the lock gives no amplitude between 150° and 330° at the lift angle set |
| sounds not clear enough | more than 5% of the draws did not find the same sounds |
| readings too scattered | the draws scatter by more than 0.1 ms, or 5° |
| beat timing unsure | the placement check: with the beats on the trend of their timestamps the reading moves too far, or cannot be made |
| irregular beat | under the beat error only: the watch runs irregularly, and keeps its amplitude |
| check the beat rate | a beat lies halfway between the tick and the tock, so the beat rate in use is half the watch's own |
| lift angle changed | under the amplitude only: the run has ended and the lift angle was changed in Settings afterwards (decided on 26 November). During a run a new lift angle is read again at once |

Two things follow for a Swiss lever. Its beat error now comes 15 s or more after the lock, with the
amplitude, where the gap between the timed beats came with the lock; and its value moves to the
unlock: the ETA's Safari capture reads 0.275 ± 0.028 ms from its unlocks, whole, against 0.31 ms
between its timed beats. A watch whose beats must be averaged over several cycles has neither
reading: all three Voice Memos recordings.

**Which beat is the tick.** A lock numbers its beats from wherever it begins, so until now the same
beat of a watch was called the tick in about half of all runs. The names now come from the watch
(`js/dsp/names.js`, decided on 24, 25 and 26 November). On a Swiss lever the tick is the beat
followed by the longer gap between the timed beats, named as soon as that gap is more than 3 times
its uncertainty from even and a gap can be read at all, which for most watches is the first reading
of the lock. On a co-axial it is the beat with the longer time from unlock to lock, named with the
first amplitude that is shown, once the two times differ by more than 3 times their combined
scatter; the gap between a co-axial's timed beats is not used, since its two beats are timed at
different sounds. Until a watch's beats are named, both are drawn in one grey, on the trace and in
the averaged beat, and the words say "beats"; the lock is not delayed. A name once given stays for
as long as the beat numbers carry on, through repeat analyses and through a lock found again moments
after it was lost, and nothing on the screen is renamed. A change of the escapement setting takes
the names back until the other rule gives them. The readings carry `tick`, the beat type that is the
tick, and the signed gap between the timed beats is now given in the order of the beat types: it
used to follow the latest analysis's own order, and could change sign within a run.

- **The ETA, as a Swiss lever.** Six runs of its Safari capture and six of its Voice Memos
  recording, begun 1.9 s apart so that the lock begins on either beat: each named its tick with the
  first reading of the lock, and all six named the same beat of the watch, though the pipeline's own
  number for it was 0 in some runs and 1 in others. The gap is 0.31 ± 0.007 ms on the capture and
  0.41 ± 0.013 ms on the recording, 30 to 40 times its uncertainty.
- **The Omega, as a co-axial at 36°.** Five runs of its Safari capture, begun 1.9 s apart, each
  reading the sounds every 5 s: named 30.7, 30.7, 41.0, 35.8 and 35.8 s after the lock, with the
  first amplitude shown, and all five named the same beat, the one that takes 6.9 ms from unlock to
  lock against 6.3 ms, each to about 0.04 ms. In two of the five the lock began on the other beat.
- **Simulated watches.** Every lever of the tests that is 0.2 ms or more out of beat is named with
  the first reading of its lock, by the beat the longer gap really follows: 28,800 vph 0.3 ms out,
  21,600 vph 0.8 ms out the other way, each of the six beat rates 0.5 ms out, and a lever built from
  the motion of a balance 0.5 ms out. Watches in beat are not named, nor is a 36,000 vph watch read
  as 18,000 vph. A lock found again after a pause keeps its names; told to number its beats afresh,
  it numbers them the other way round and names the same beat. Of the 46 simulated watches of the
  prototype's check, all 27 co-axials whose amplitude is shown are named by the longer time, none
  wrongly. On 24 November, on 84 simulated levers 0.01 to 0.2 ms out of beat, none was named wrongly
  at 3 times the uncertainty, and 2 of the faintest were at 2 times.

**The averaged beat** has a bar for each beat above its curves while an amplitude is shown, from
where that beat's unlock begins to where its lock begins, with its length beside it: 6.90 and 6.27
ms on the Omega demo. The amplitude comes from the two lengths. A bar's end that falls outside the
12 ms shown either side of the beat is cut off there.

**A co-axial with a Swiss lever's lift angle.** While the escapement is co-axial and the lift angle
is above 40°, a note under the readings says that co-axial movements use less, with the two figures
the co-axial investigation found: 38° in Omega's technical guide for its calibres 8520 and 8521, and
36° reported for the 3861 by a watchmaker on a forum. Left at the default 52°, the Omega's 288°
would come out as 416°, which is not believable, and the readout says "check the lift angle". The
note speaks of the run's escapement and lift angle, which a demo brings with it, until either is
changed in Settings after the run has ended; from then on, and before any run, it speaks of the ones
set (decided on 27 November). Until then a stopped run's escapement was used whatever was set, so
that setting co-axial after Stop brought no note until the next Start, as on the iPhone. Following
Settings as soon as a run ends was tried and not kept: in Chrome it brought the note up beside the
Omega demo's 290°, made at the demo's own 36°, when Settings were co-axial at 52°.

**The simulator** has an amplitude slider, 150° to 330°, starting at 270° (decided on 26 November).
Its watch is a Swiss lever whose lift angle is the one set in Settings (decided the same day), so
the amplitude read is the amplitude set, whatever the setting; the slider sets how long before its
lock each beat's unlock comes. Until now that was 7 ms at every beat rate, which at 52° the app
reads as 294° at 28,800 vph and as nothing believable at 21,600 vph and below. A lift angle changed
while the simulator runs starts it again, as a new beat rate does. Left running, its beats from
before the change were read with the new angle for up to a minute, at amplitudes the watch never
had: with 270° set, 186° for half a minute after a change from 52° to 36°, then a dash, and 268°
only a minute after the change. Its loudness now starts at 3.00× instead of 2.00× (agreed on 26
November), and the slider reaches 4.00×: at 2.00× the simulated unlock stands about 10 dB over the
noise of the averaged beat, 5 to 17% of the draws lost it, and the readings were often held back; at
2.50× and 3.00× none did at any of four beat rates. In Node, at 52°, the simulator at 270° reads
268.8° to 269.3° at 18,000 to 28,800 vph and 266.8° to 267.9° at 36,000 vph, and 0.38 to 0.43 ms for
0.40 ms set. With other lift angles set: 268° at 36° and 28,800 vph, 269° at 60° and 21,600 vph,
199.6° for 200° set at 70° and 18,000 vph, and 296° for 300° set at 30° and 36,000 vph.

**The audio diagnostic** takes a lift angle as well (decided on 26 November), 52° unless another is
typed, and gives the app's own amplitude and beat error in its reading line and in its report, as
"amplitude 288° ±1.1° over 50 s" or "amplitude — (needs 15 s of beats)". The report keeps the gap
between the timed beats beside them, under that name, with each beat's time from unlock to lock and
what reading the sounds cost. Until this step the page ran the pipeline without a lift angle and
called that gap the beat error. The page now starts with the 60-second recording (decided on 26
November). Since 27 November the two readings come about 23 s in for a clear watch and about 39 s in
for one as faint as the Omega, which a 30-second recording ends before. Its "longest single step" is
the longest the analysis held up the recording; the reading finished whole where the recording ends
counts in the load but not there (since 27 November). Before, on the iPhone, that finish set it, at
2126 ms.

**Where the audio ends,** at Stop and at the end of a recording, the reading of the beats' sounds
that is being worked out is finished and shown (decided on 26 November); until then it was dropped,
and a run could end on a dash with its last reading a second from done. A reading is spread over the
audio that follows its start, so that the beats are still timed promptly, and takes 1.0 to 2.3 s of
computing on the iPhone: the last numbers can come that long after Stop. They rest on beats heard
before the end, as every reading does, and no reading is started for it. A reading finished within
the last second, which had not yet gone out with the once-a-second readings, is shown as well. The
audio diagnostic does the same for its report, and so does `tools/run-stream.js` when it is given a
share of real time.

In Chrome at phone size, on this computer, with each source played at real speed:

- **The Omega demo** locked 9 s in with both beats grey and a dash for both readings. 46 s in it
  showed 290° ±1.5° and 0.34 ms ±0.07, each over 30 s, coloured its beats and drew its bars. 53 s in
  the second reading was held back, more than 5% of its draws having lost the unlock, and both went
  back to a dash. The recording ended while a third was being worked out: finished there, in 3.4 and
  3.5 s of computing in two runs, it showed 289° ±1.1° and 0.31 and 0.30 ms ±0.05, each over 45 s,
  where the demo used to end on a dash. Stopped 43 s in, while its first reading was being worked
  out, the demo showed "needed 30 s of beats" and within a second 290° ±1.5° and 0.34 ms ±0.07, with
  its beats coloured. On the iPhone, before this step, the same demo was read four times and the
  last could be shown. In Node, with a reading every 5 s finished at once, all five are shown: 0.34,
  0.32, 0.30, 0.30 and 0.32 ms, and 290°, 290°, 289°, 289° and 288°.
- **The ETA demo** coloured its beats at the lock and ended with a dash for both readings and
  "needed 30 s of beats": its capture has 22 s of them after the lock.
- **The simulator as it starts** (28,800 vph, 270°, 0.40 ms) locked 9 s in and showed 268° ±1.0° and
  0.40 ms ±0.03 from 43 s in; at 21,600 vph, 269° ±0.6° and 0.40 ms from 45 s in. After Stop the
  numbers stayed, and setting the lift angle to 50° left a dash for the amplitude with "lift angle
  changed", the beat error staying. Set as co-axial at 52°, the note on lift angles showed and the
  beats stayed grey. With the lift angle set to 36° it showed 268° ±1.4° and 0.43 ms ±0.03 from
  43 s in. A lift angle changed from 52° to 50° 14 s into a run started the simulator again at
  once; it locked 9 s later and showed 268° ±0.8° and 0.38 ms ±0.02 41 s after the change.
- **The audio diagnostic**, with a recording played in as the microphone, showed "needs 30 s of
  beats" for both from the lock on, and its report gave the lift angle, both readings and the gap
  between the timed beats. Chrome's simulated microphone drops out about 35 s in and runs at 44.1
  kHz, so no reading of the sounds was shown in 60 s there: the Omega's capture at 36° had its three
  readings held back ("sounds not clear enough"), and a simulated lever lost its lock at 36 s. With
  the page's script served so that the stage read after 12 s of beats, and nothing else changed, the
  simulated lever of 0.50 ms and 270° at 50° read "amplitude 270° ±0.5° over 12 s · beat error 0.50
  ms ±0.02 over 12 s". Served so that the first reading started about a second before the end of a
  30-second recording, the report gave "amplitude 270° ±0.3° over 21 s, beat error 0.51 ms ±0.01
  over 21 s". Before a reading made in the last second was reported where the audio ends, the same
  run's report ended on "needed 30 s of beats" with that reading already made.
- **Six positions**, on the simulator: a position saved 22 s after the lock kept a dash for both,
  and one saved 42 s after its lock kept 0.39 ms and 268° (see [Six positions](#six-positions)).

### On the iPhone, 27 November

Lawrence ran these on his iPhone with the site as merged from pull request 57, in Safari:

- **The Omega demo** locked about 10 s in with the beats grey, showed both readings and coloured its
  beats about 40 s in, and kept both to the end with no dash in between. It ended on 288° ±1.1° and
  0.32 ms ±0.04, each over 51 s, with bars of 6.93 and 6.32 ms; its fifth reading was still being
  worked out where the replay ended, and was finished there ("last in 1.7 s of computing over 1.3
  s"). A computer's fifth reading of the capture is also 288° and 0.32 ms. Before this step the
  iPhone made four readings of the demo.
- **The Omega demo stopped 40 s in,** while its first reading was being worked out, showed 290°
  ±1.5° and 0.34 ms ±0.07 a fraction of a second after Stop, as in Chrome. The line under the signal
  read "last in 1.0 s of computing over 1.7 s": more than the half of real time a reading gets
  during a run (1.4 s over 2.8 s), so the Stop finished it. Stopped at about 36.5 s, before the
  first reading starts, it kept its dashes with "needed 30 s of beats". The window in which a Stop
  finishes the first reading is about 2 s wide, from 38.6 s to about 40.6 s.
- **The simulator** (28,800 vph, 270°, 0.40 ms) locked about 8 s in with its beats coloured from the
  start, and showed 269° ±1.1° and 0.40 ms ±0.02 about 40 s in. With the amplitude moved to 215°
  about a minute in, the old 269° stayed on the screen for about 20 s, a dash with "sounds not clear
  enough" followed for about 20 s, and then 214°; it ended on 214° ±0.5° and 0.38 ms ±0.02, each
  over 60 s. After Stop, a lift angle set to 50° left a dash for the amplitude with "lift angle
  changed". Started again at 50°, it read 268° ±1.3° over 35 s.
- **The co-axial note** did not come when the escapement was set to co-axial with the simulator
  stopped, until it was started again; fixed since (above).
- **The audio diagnostic,** recording the Omega live for 60 s at co-axial and 36°, locked at 8.1 s
  and reported 282° ±1.0° and 0.20 ms ±0.02, each over 52 s, with 7.08 and 6.48 ms from unlock to
  lock, tick first.
- **The Omega live,** fully wound and dial up, through the phone's default microphone: −0.7 s/day
  ±0.06, 283° ±1.7° and 0.16 ms ±0.02, each over 51 s, with bars of 7.05 and 6.44 ms and the signal
  at 42 times the noise spread. The plan's check expects near 0.20 ms and 285° to 289° for the watch
  in that state, as the prototype read it on 23 November; the audio diagnostic minutes earlier read
  0.20 ms and 282°. Its last reading was finished at Stop ("2.3 s of computing over 2.4 s").

What this step leaves as it is, and its limits:

- **A reading can appear, give way to a dash and come back,** as the Omega demo's did above. With 30
  to 40 s of the Omega's beats 4 to 6% of the draws lose its faint unlock, against the 5% allowed,
  and one beat more or less in the reading decides. No rule holds a number on the screen through
  that: a dash, never a stale value. It was left so on 26 November until it is seen on the phone;
  the Omega demo showed no such dash there in one run. The two rules considered were to show the
  first number only after two readings in a row pass, which adds about 5 s and would have left the
  Omega demo in Chrome without a number for its whole minute, and to keep a number once shown up to
  a higher share of failing draws, which shows readings the gate refuses today and has not been
  measured.
- **The last numbers can come after Stop,** by up to a reading's computing: about 1.4 s on the
  iPhone, and 2.2 to 3.5 s for the Omega on this computer. Start pressed in that time waits for it.
  No reading is started where the audio ends, so the last one shown can rest on beats up to about 10
  s before the end.
- **After a change, the beat error was slow and the amplitude first stale, then blank.** Both rest
  on up to a minute of beats. With the simulator's beat error moved from 0.40 to 1.00 ms, the
  reading passed through 0.42 ms after 9 s, 0.51 after 18 s, 0.79 after 34 s and 0.97 after 54 s,
  each stated at ±0.02 to ±0.07 ms: the scatter says how the beats of that minute agree, not how
  far the watch has moved within it. With its amplitude moved from 270° to 220°, the old reading
  stayed for 9 s, a dash followed for 20 s, and 219° was shown from 28 s after the change; on the
  iPhone, with 215° set, the old 269° stayed about 20 s, the dash about 20 s more, and 214° came
  about 40 s after the change. Since 27 November the stretch starts again when the beat error
  steps, and the beat error comes about 16 s after such a change ([Following an
  adjustment](#following-an-adjustment-27-november)). An amplitude change on a Swiss lever moves no
  gap, so it still waits for the old beats to leave. The fifth step follows the amplitude over time,
  in 10 s blocks, and is the planned mend for that.
- **A Swiss lever within about 0.05 ms of in beat may never be named,** and its two lines then
  nearly coincide. On 24 November, of simulated levers 20 s after the lock, all 24 at 0.1 to 0.2 ms
  were named, 10 of 12 at 0.05 ms, and none of 12 in perfect beat. The names follow the sign of the
  gap, so a watch adjusted through zero would swap them at its next new lock.
- **A co-axial's beats stay grey for 20 s or more after every lock,** 31 s on the Omega's capture,
  and for good when no amplitude can be shown. The rule was checked on one watch, the Omega 3861,
  and on simulated ones.
- **The names say nothing of which way the balance swings,** which sound alone cannot tell. They
  only name the same beat from run to run. A watch set to the wrong escapement is named by the wrong
  rule.
- **The trace is still drawn from the timed beats,** so the gap between its two lines is the gap
  between each beat's loudest sounds, not the beat error on the readout: 0.42 ms against 0.27 ms on
  the ETA's capture, and 3.4 ms against 0.3 ms on the Omega's. The caption says so.
- **On the audio diagnostic a 30 s recording is too short for a faint watch's two readings,** which
  come about 39 s in for the Omega; a clear watch's come about 23 s in. The page starts with 60 s.

### Following an adjustment (27 November)

A watchmaker adjusting the beat error moves the gap between the tick and the tock at once, and the
timed beats show it beat by beat, but the beat error from the unlocks rests on up to a minute of
beats. Until now it showed the old value, then a mixture, for 44 to 54 s after a change of 0.6 ms on
a simulated lever, stated as if right (issue 36 of the co-axial investigation). Now, once a second,
the pipeline compares the gap of each tick-tock cycle between its timed beats over the last 5 s with
the gaps of the beats the latest reading rests on, using only beats timed alone and confidently.
When the two disagree for 3 s running, by more than K standard errors of their difference and by
more than 0.03 ms, the stretch of beats starts again from where the gaps stepped: the split of the
last 20 s that best separates two levels, moved past any gaps just after it that lie nearer the old
level. Both readings show "changed: reading again" until a reading from 15 s of the new beats comes,
and the amplitude waits for one from 20 s. A co-axial's gap moves with its amplitude, so a change of
its amplitude restarts it too; a Swiss lever's does not.

How readily it restarts, and how long the stretch is, is the new setting "Amplitude and beat error
sensitivity", proposed by Lawrence Fan; its presets were chosen by him on 27 November from an
experiment on 26 recordings. The rate keeps its own averaging window: it is timed beat by beat from
each beat's loudest sound, while the amplitude and the beat error come from the faint unlock,
averaged over many beats. A change of the setting during a run keeps the readings shown and applies
from the next reading. The audio diagnostic uses Medium.

| Sensitivity | High | Medium (default) | Low |
| --- | --- | --- | --- |
| Stretch of beats | 45 s | 60 s | 60 s |
| First reading, after a lock or a restart | 15 s | 15 s | 15 s |
| Threshold K | 4 | 6 | 8 |
| After a 0.6 or 0.2 ms change | right at 16 s (26 s at 18,000 vph), after 4 to 8 s of the old value and 8 to 12 s of dash; the amplitude back 5 s later | the same | the same |
| After a 0.1 ms change | right at 16 s, 8 s wrong first | right at 18 s, 18 s wrong first | not found: 44 s wrong |
| Restarts in 15 minutes of real watches left alone | 9: 34 s of beat error and 90 s of amplitude dash | 2: 22 s of each | 1: 5 s of each |
| Scatter on the Omega, beat error and amplitude | ±0.017 to 0.024 ms, ±0.9° | ±0.014 to 0.020 ms, ±0.8 to 0.9° | ±0.014 to 0.019 ms, ±0.7 to 0.8° |
| A Swiss lever's amplitude after a 55° drop | right at 19 s | right at 24 s | right at 24 s |
| Computing per reading | about 0.6 of Medium's | | |

The experiment ran the real-time pipeline in Node over each recording, with every reading
finished in the audio block it started in, so the times are seconds of audio. The recordings were
the two Safari captures; Lawrence's two 5-minute and two 60 s captures of the Omega and a 5-minute
capture of an 18,000 vph Mitoma, kept on his computer and not published; simulated levers at
18,000, 21,600 and 28,800 vph with 0.3 ms of beat jitter; the co-axial of the balance model; and
nine simulated changes of beat error and amplitude. It tried stretches of 30, 45 and 60 s, first
readings at 15, 20 and 30 s and K of 4, 6 and 8. A 30 s stretch was too short: the simulated
co-axial never showed a beat error with it, and the Omega's Safari capture showed a dash 45 to 100%
of the time. A first reading at 15 s cost nothing seen. "Real watches left alone" are the two
5-minute Omega captures and the Mitoma's. The full tables are in the investigation's "Option 1
experiment".

In Node, built: a simulated lever at 28,800 vph and 270°, moved from 0.40 to 1.00 ms 60 s in, showed
the dash 4.4 s after the change, 0.97 ms ±0.03 15.7 s after it, then 0.98 to 1.00 ms, and its
amplitude, 268° ±1.4, 20.8 s after it. Without the rule it showed 0.42 ms ±0.02 at that moment, and
0.96 ms only 55 s after the change. Of the six recordings, at the default:

- **The ETA's Safari capture** gains two readings, 0.23 ms ±0.03 at 23.4 s, with the amplitude
  held back, and 0.27 ms ±0.04 and 265.8° ±0.7 at 28.6 s, where it ended before its first.
- **The Omega's Safari capture** shows the same values at the same times. From 23.4 s to 38.8 s
  its dash says "sounds not clear enough" instead of "needs 30 s of beats".
- **The ETA's Voice Memos recording** gives its reason for a dash, `lift-range`, from 23.4 s
  instead of 38.8 s.
- **The two Omega Voice Memos recordings and the no-watch capture** are unchanged.
- **Rule B never fires** on any of the six, at any sensitivity.

Its limits:

- **A restart costs both readings a dash,** for 8 to 12 s on a clear watch (20 s at 18,000 vph), and
  much longer on a faint one or a co-axial, which need 30 to 50 s of new beats to read: on the faint
  simulated lever, whose beat error is never shown, a restart blanked its amplitude for 55 to 80 s;
  on the simulated co-axial whose rest position moved, the right value came 56 s after the change, a
  dash until then, against 39 s with 15 s wrong and 24 s of dash without the rule. One idea, not
  measured: a restart that blanks only the beat error.
- **Restarts come on their own,** most at High. On the Omega they follow its amplitude, which
  wandered 14 to 17° over five minutes in both captures, so they mark real changes of the watch.
- **A change under about 0.05 ms is never found,** and the old value stays until its beats have
  left: 20 s at High, 44 s at Medium and Low.
- **On a co-axial left alone, a restart marks a change of its sounds, not always of its beat
  error.** Its timed beats are its loudest sounds, a different one in the tick and the tock, so
  the gap between them moves with the amplitude as well (below).

### On the iPhone, 27 and 28 November

Lawrence ran these on his iPhone with the site as merged from pull request 60, in Safari:

- **Settings** showed "Amplitude and beat error sensitivity" at Medium (default), and opening the
  dialog no longer opened the beat rate's picker (pull request 59).
- **The Simulator** at its defaults locked at about 8 s, showed 0.38 ms at about 25 s and 269° at
  about 30 s. Moved from 0.40 to 1.00 ms, both readings went to "changed: reading again" within a
  few seconds and came back about 25 s after the change, at 1.00 ms, the rate and the amplitude as
  before. At High, moved from 1.00 to 0.90 ms, both went to a dash within a few seconds; the beat
  error came back "over 15 s", resting on beats from after the change only, and the amplitude 5 s
  later. In Node, over 8 runs of the app's simulator, that restart came 5 to 12 s after the change,
  the beat error 15.2 to 16.3 s after it at 0.86 to 0.93 ms, and the amplitude 5 s later.
- **The Omega demo,** at High, said "sounds not clear enough" from about 24 s, showed both readings
  from about 43 s, and ended on 289° ±1.1° and 0.30 ms ±0.05 over 45 s, the longest stretch High
  allows, after reading 7 times; Node gives 288.5° and 0.299 ms over 45 s, also after 7 readings.
- **The ETA demo,** at High, showed its beat error from about 25 s and its amplitude just before
  the end, ending on 266° ±0.7° and 0.27 ms ±0.03 over 20 s, as in Node; before pull request 60 it
  ended on dashes. Its 30 s read the same at any sensitivity.
- **The Omega live,** left alone at Medium for 5 minutes, showed "changed: reading again" twice
  and ended on 286° ±0.9° and 0.19 ms ±0.02 over 60 s. Replayed in Node from his capture, kept on
  his computer and not published, it restarted once, 170 s in, where the gap between the timed beats
  rose from 1.29 to 1.39 ms and the amplitude fell from about 293° to 280°; the beat error from the
  unlocks stayed between 0.135 and 0.158 ms across it. Around 208 s the gap fell 0.12 ms, past the
  threshold for 2 s of the 3 needed: most likely the second restart on the phone, whose readings
  fall at slightly other times. High restarted 4 times in the same capture, Low not at all.
- **The audio diagnostic,** 60 s of the Omega live at co-axial and 36°, gave 293° ±1.2° and 0.18 ms
  ±0.02 over 50 s, with the pipeline at 17.1% of real time and a longest single step of 545 ms
  (2126 ms before pull request 58 left out the reading finished at the end).
- **The co-axial lift angle note** (issue 37, pull request 58) came at once when the escapement was
  set to co-axial with playback stopped, and did not come beside a finished Omega demo with the
  settings left at a Swiss lever.

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

The most recent audio since the last interruption is kept in memory for saving: the last
minute, 2 minutes or 5 minutes, as chosen under "Keep for saving" in the Microphone panel and
remembered on the device. At 48 kHz that is about 12 MB a minute, so 58 MB for 5 minutes. The
choice takes effect at once; a shorter one drops the oldest audio kept, and a longer one fills
up from then on. The save button names the length ("Save the last 2 minutes"), and the note
under it gives the length and size of the file it would make. The file is a 32-bit float WAV,
handed over through the share sheet where there is one (on the iPhone, Save to Files) or as a
download. Replayed under Your file, it is the very audio that was analysed: in Chrome, an 80 s
live run of the ETA recording, kept with "Last 2 minutes", saved 79.8 s and replayed to the same
+5.3 s/day and 0.44 ms as the live reading.

When Stop is pressed, the microphone closes at once, but the audio already handed to the analysis
is still analysed and shown before the run ends; the dock says "Finishing the last audio" while it
is. That audio is in the saved file, so a run that fits in the length kept now reads exactly as a
replay of its saved file. Until 22 November the answers still on their way at Stop were ignored. In
Chrome, with the ETA's Safari capture played in as the microphone and Stop pressed while 2 chunks
of audio (0.19 s at the 44.1 kHz Chrome delivers) were still waiting, the live screen read +1.7 ±
0.07 s/day over 17 s, against +1.6 ± 0.06 over 18 s for the replay of its saved file, and the
traces differed. Now, stopped with 2 and with 3 chunks waiting, the live screen and the replay show
the same numbers and the same trace, pixel for pixel. On the iPhone on 23 November, a 40 s live run
of the Omega, measured as co-axial and kept whole in the saved file, read −1.4 ± 0.07 s/day over 20
s, and the replay of its saved file read the same, with no dot of the trace added, missing or
moved. A stop for a problem (an error, or the analysis falling 8 s behind) still ends the run at
once. Stopping a replay or the simulator works the same way.

In Chrome on a computer, with the ETA recording played in as a simulated microphone (Chrome
delivers it at 44.1 kHz), the live reading after 50 s was +6.9 s/day and 0.40 ms. The recording
itself, streamed through the pipeline, reads +6.88 s/day and 0.38 ms at the same point, and the
saved minute replayed under Your file read +6.9 s/day and 0.40 ms. With 3 s of digital silence
inserted into the recording at 40 s, the app showed the interruption, resumed when the sound
came back and locked again 9 s later. The automated tests drive the same code with a stand-in for
the microphone: a simulated watch cut off for 2 s gives no readings during the gap, no confident
dots in it and a fresh lock after it, and its saved minute matches the analysed audio sample for
sample and replays to the same reading within 0.1 s/day. In six-position mode a reading can be
saved a full window after that fresh lock: 20.5 s after it in the tests, and in Chrome, with the
same simulated watch played in as the microphone, "Ready to save as Dial up" came 20 s after the
lock at 36 s, at +12.0 ± 0.1 s/day against a true +12.

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
- Saving copies the kept audio, writes the file and hands it to the browser, so for a moment it
  can take up to four times the memory of the audio: about 230 MB for 5 minutes at 48 kHz.
  Writing a 5-minute file took 0.14 s on a computer and has not been timed on the iPhone.
- The microphone cannot wait for the analysis. If the analysis falls more than 8 s behind, the
  measurement stops with a message. The iPhone ran the pipeline 22.6 times faster than real time.

## Six positions

A watch keeps slightly different time in each position, because gravity acts on its balance
differently dial up, dial down and on each edge. A switch at the top of the screen chooses between
two modes, and the choice is remembered on the device:

- **Continuous**, the default, is the app as it was: it measures for as long as the source runs
  and records no position.
- **Six positions** adds a log below the readings, with a row for dial up, dial down, crown up,
  crown down, crown left and crown right.

Each position has a small line drawing, beside its row and, larger, beside the line saying which
position to measure next. The four upright positions show the watch face-on, standing on a ground
line with its crown pointing the named way. The two flat ones show it from a little above, lying
on the ground line: dial up with its hands, dial down with a shaded case back and the crown on
the left, as it is once the watch is turned over. They are drawn in the text colour, so they
follow light and dark mode, and screen readers skip them, since the position's name is always
written beside them.

Each position is its own run. Place the watch, press Start, and keep it still until the reading
has settled: the lock must have lasted the whole averaging window, counted from the moment
"Locked" appears. The window slides with the audio, so the reading saved then draws only on audio
heard since the lock, none from before the watch was placed or while it settled. (The readout in
continuous mode also uses the beats timed in the stretch the lock was found in, about the 8 s
before "Locked".) The window is the one set in the settings (10, 20, 40 or 60 s), or longer when a
faint watch's ticks are averaged over several cycles, so a reading always runs for the longer of
the two. A lost lock starts the count again, and so does a microphone interruption, from the lock
found when the sound is back. The button "Save as Dial up" becomes available then:
with the default 20 s window and a lock after 8 s, about 28.5 s after Start. Saving stops the run,
leaves the saved reading on the screen and suggests the next position without a reading. Tapping
a row chooses the position the next reading is saved as, to skip one or to measure one again; a
new reading replaces the old. Any source can be saved from, the simulator and recordings
included, and a reading still on the screen after Stop can be saved, once per run.

Each row keeps the rate with its statistical uncertainty, the beat error and the amplitude or why
there is none, the window the reading was made over ("Over a 20 s window") and what the rate was
measured from: the number of beats ("120 beats"), or, for a faint watch whose timestamps each
average several tick-tock cycles, the number of timestamps and cycles ("33 timestamps of up to 8
cycles"). Below the rows, the summary gives the average rate, the spread (fastest minus slowest
position), the largest beat error with its position and the median amplitude. A reading whose rate
is uncertain by more than ±1 s/day is marked and left out of the average and the spread, and a line
says so; its beat error and its amplitude still count. No uncertainty is given for the average: each
position's ± is statistical only, and a watch's 20 s readings can move by more than that (from −0.2
to +1.6 s/day over the minute of the Omega's Safari capture, each ±0.09), so a combined figure would
look more precise than it is. One log is kept at a time, on the device; "Start new log" clears it
after asking. Exporting it is planned for a later version.

Since milestone 8's fourth step (26 November) the beat error is the one measured from the unlocks,
for either escapement, and each row also keeps the amplitude, both with their scatter and the lift
angle the amplitude was worked out with: "+1.7 s/d ±0.07 · 0.31 ms · 288°", and under it "beat error
±0.04 ms · amplitude ±1.1° at 36° lift". Both need 15 s of beats since the lock (30 s until 27
November), and the amplitude 20 s, and Save does not wait for them, as decided on 26 November.
When the rate is ready and they are not, as on a faint watch, the line above the button says "The
beat error and the amplitude need 15 s of beats: wait for them, or save without.", or "The
amplitude needs 20 s of beats: wait for it, or save without." when only the amplitude is to come. A
position saved without them keeps a dash and says "saved before 15 s of beats", "saved before 20 s
of beats", or "saved while reading again after a change" after a restart; a reading the pipeline
held back keeps its reason, as on the readout.
The reason comes from the readings, not from the escapement setting, so a co-axial is no longer
marked "beat error not shown: co-axial". The summary's largest beat error and median amplitude count
the positions that have one, and each is a dash, with "not read in any position", when none has. The
median is the middle amplitude, or midway between the two in the middle. A log saved before this
step still loads: its beat errors are the gap between the timed beats, as shown then, and its rows
say "no amplitude: not measured".

Checked in Chrome on a computer at phone size, with the ETA recording played in as a simulated
microphone, while the window was still counted from the start of the lock's audio: six positions
were saved one after another. Each became ready to save 20.4 to 20.8 s after Start, one 32.5 s
after, and the summary read +5.5 s/day over 6 positions, a spread of 1.1 s/day and a largest beat
error of 0.44 ms. Chrome appears to play the file from its start at each Start: five positions
read +5.3 or +5.4 s/day, as the recording's first 20 s do on their own (+5.31 ± 0.09), and the
one ready after 32.5 s read +6.4, as the recording's 12 to 32 s do (+6.38 ± 0.11), because the
ETA ran faster later in the recording. The log and the mode came back after the page was
reloaded, a position measured again replaced its reading, a reading could not be saved twice, and
"Start new log" emptied the log. With the second Omega recording played in and the escapement set
to co-axial, two positions read −2.2 ± 0.4 and −1.8 ± 0.7 s/day, marked "beat error not shown:
co-axial". With the window counted from the lock, one position of the ETA in Chrome locked about
9 s after Start and was ready 30.3 s after it (checked every 2 s), reading +6.3 ± 0.10 s/day over
a 20 s window, as the recording does from 9 to 29 s.

In the automated tests, on the ETA's Safari capture, a simulated watch and the Omega's Safari
capture alike, the lock appears at 8.07 s and a reading can be saved from 28.55 s with the 20 s
window (20.36 s when the window was counted from the start of the lock's audio). With a 40 s window
the Omega's capture can be saved from 49.03 s and not before, and the reading records the 40 s; a
window changed to 60 s waits until the lock has lasted 60 s. Saved at its end, the Omega's capture
keeps 0.32 ms and 288° at 36° of lift. A simulated lever 0.5 ms out of beat at 270°, saved 20 s
after its lock, keeps a dash for both, and saved 12 s later keeps both within 0.03 ms and 1° of the
truth. In Chrome, on the simulator, a position saved 22 s after the lock read "+8.1 s/d ±0.07" with
"no beat error or amplitude: saved before 30 s of beats", one saved 42 s after its lock read "+8.1
s/d ±0.07 · 0.39 ms · 268°", and the summary gave a largest beat error of 0.39 ms and a median
amplitude of 268° of 1 position. A log stored before this step, with rows of both kinds, drew
without overflow at a width of 375 points.

On the iPhone 17 Pro Max with iOS 27.2, on 25 November 2026, the Omega was measured in all six
positions in co-axial mode with the 20 s window: +2.1 ± 0.1 s/day dial up, +1.7 ± 0.07 dial down,
−0.8 ± 0.1 crown up, −1.6 ± 0.1 crown down, +0.5 ± 0.09 crown left and −1.5 ± 0.06 crown right.
The summary read an average of +0.1 s/day and a spread of 3.7 s/day, dial up fastest and crown
down slowest. Dial down and crown up waited for windows lengthened to 24 and 32 s, as their ticks
were fainter and averaged over several cycles. Crown up's 33 timestamps were shown as "33 beats";
since 26 November a reading's count names the cycles averaged, and readings saved before then,
which did not record them, show "33 timestamps". The log was still there after Safari was quit and
opened again.

Known limits of the six-position log:

- The app does not know how the watch lies. A reading is saved as whichever position is chosen.
- A faint watch waits for its longer window. A simulated 18,000 vph watch averaged over 32 cycles
  needs 154 s, and when the averaging deepens during a run the save waits for the longer window.
- The log keeps whatever is saved: readings from different watches, sources, escapement settings or
  lift angles are not told apart in the summary, nor are beat errors saved before 26 November, which
  are the gap between the timed beats, from those saved since.
- A position saved as soon as its rate is ready has no beat error and no amplitude. With the default
  20 s window that is every position, unless the watch is left for another 10 s or more before Save
  is pressed. The six-position run on the phone was made before this step, and none has been made
  since.
- A watch's rate also changes with its state of wind and over time, so readings taken minutes
  apart differ for that reason too.

## Hosting

The app is a folder of static files with no build step, served by GitHub Pages over HTTPS.
Browsers allow the microphone only on secure pages, so the app cannot be opened from a local
file. [docs/hosting.md](docs/hosting.md) explains how to set up the site, how to host your own
copy, and how to test on a computer. Since 28 November GitHub's own Jekyll build writes the commit
it was built from into `version.json`, and the page's fine print shows it ("Version 50d4ce3."),
linked to the commit, as does the audio diagnostic's report ("Version: 50d4ce3"), so that a
screenshot or a report says which version made it; served any other way, they show none.
`_config.yml` keeps the Markdown and the folders the app does not load out of the published site.

`index.html` is the timegrapher. Its header shows rate, amplitude and beat error, each with its
uncertainty or the reason for a dash under it, with the beat rate, escapement, lift angle and
averaging window under them, and dashes instead of stale numbers when there is no lock or the
microphone is interrupted (see [The
screen](#the-screen-amplitude-beat-error-and-the-names-of-the-beats)). When the watch runs
irregularly, a warning below them says by how much its beats wander from one to the next. Below are
the trace, one dot per beat in milliseconds ahead of an ideal clock with low-confidence beats dimmed
and beats not yet named in grey; a signal meter with advice; and the averaged tick and tock, with a
bar from each beat's unlock to its lock while an amplitude is shown. Under the meter a line of fine
print gives the input level and the share of real time the analysis uses, how often the sounds
inside the beats have been read and what the latest reading cost in computing and in time, with the
pipeline's own word for the reason when a reading is held back. The source can be the microphone, a
simulated watch whose rate, beat error, amplitude, beat variability and loudness can be changed
while it runs, one of two demo recordings, or a recording chosen from the phone, replayed at real
speed or faster. A switch above the readings chooses continuous measuring or the six-position log
(see [Six positions](#six-positions)). Settings (beat rate, escapement, lift angle, mains frequency,
averaging window, amplitude and beat error sensitivity, theme), the chosen microphone, the mode, the
six-position log and whether the magnetism notice has been read are kept on the device. Reset to
defaults, beside Done, sets the Settings dialog's own settings back as a first visit has them and
applies them at once, as any change there is applied: a new beat rate or mains frequency restarts
the measurement. It asks no question first. The microphone, the mode and the log stay. The line
under the readings gives the beat rate, the escapement and lift angle the readings are made with,
and the rate's window: for example "21,600 vph · co-axial · lift 36° · 20 s window".

The two demo recordings are the ETA's and the Omega's Safari captures among the [test
recordings](#test-recordings): what the phone's microphone gave Safari, so the sounds inside their
beats can be read as a live watch's are. They replaced the three Voice Memos recordings, which allow
no such reading. A demo plays with its own watch's escapement and lift angle, 50° for the ETA and
36° for the Omega, whatever the settings, and the line under the readings shows the escapement and
lift angle in use. A lift angle set in Settings while a demo plays replaces the demo's for the rest
of that run; a demo never changes the stored setting. A demo also plays only the first channel of
its capture, as the microphone gives it to the app. The second channel is silent: it changes no
reading, and playing it nearly doubled the pipeline's computing (in Node, without the stage, about
10% of real time against 5% for the Omega's capture, and 13% against 7% for the ETA's). Both were
decided on 26 November. Two limits follow from the captures' lengths:

- **The ETA's 30 s leave time for two readings.** A reading of the sounds inside the beats needs
  15 s of beats after the lock, which comes at 8 s: in Node the first comes 23.4 s in, 0.23 ms with
  the amplitude held back, and the second 28.6 s in, 0.27 ms and 266°. Until 27 November it needed
  30 s of beats, and the demo showed a dash for both.
- **The Omega's 60 s leave time for three readings on a computer,** the first about 45 s in and the
  last just before the end, and for four on an iPhone 17 Pro Max.

In Chrome on a computer, before the fourth step of milestone 8 put the readings of the sounds on the
screen, with nothing changed in Settings, the ETA demo ran at 50° and ended at +1.7 ± 0.05 s/day and
0.31 ms between its timed beats, with the analysis at 8% of real time. The Omega demo ran at 36° and
ended at +0.9 ± 0.09 s/day over its last 20 s, with the analysis at 19% of real time. It was read
three times: the first reading was on the screen about 45 s after Start, after 2.2 s of computing
over 4.4 s, and could be shown; the second was held back, more than 5% of its draws having lost the
unlock; the third, 3.1 s of computing over 6.2 s, could be shown. Setting the lift angle to 40°
during the ETA demo changed the line under the readings to 40° at once, and the next start of the
demo was at 50° again, with the setting still as stored.

On an iPhone 17 Pro Max on 26 November 2026, also before that step, the ETA demo ran at 50° and
ended at +1.7 ± 0.05 s/day and 0.31 ms, 112 times the noise spread, with the analysis at 9% of real
time. The Omega demo ran
at 36° and ended at +0.9 ± 0.09 s/day, 66 times the noise spread, with the analysis at 16% of real
time and the fine print "amplitude read 4 times, last in 1.4 s of computing over 2.9 s, both to
show". Settings still held the default 52° afterwards. What the two demos show since that step is
under [The screen](#the-screen-amplitude-beat-error-and-the-names-of-the-beats), from Chrome on a
computer.

The theme is Auto by default, which follows the phone's light or dark setting, or Light or Dark
whatever the phone is set to. It changes at once, the charts and the browser's bars included, and
a stored choice is applied before the page is first drawn, so the screen never shows the phone's
theme first. In Chrome at phone size, each choice gave the expected colours under both phone
settings and came back after a reload. On the iPhone on 25 November, Auto looked as before, Dark
and Light switched the whole screen at once, the choice was kept with no flash of the other theme
after Safari was quit and opened again, and Auto followed the phone's setting when it changed. The
audio diagnostic and the browser check still follow the phone.

`check.html` checks the browser: secure connection, microphone access, audio worklets, screen
wake lock, and whether the signal pipeline loads.

`diagnostic.html` is the audio diagnostic. It records up to 60 s from the first channel of a
chosen microphone with the browser's echo cancellation, noise suppression and automatic gain
off (or on, to compare), shows the waveform above 2 kHz, and runs the real-time pipeline on the
audio as it arrives in a background worker, with the escapement and the lift angle chosen on the
page, so that it gives rate, amplitude and beat error as the app does. Afterwards it reports what
the browser actually applied, the levels, any dropouts or interruptions, the readings and the
pipeline's load. The
recording can be saved as a 32-bit float WAV file holding nothing but the audio. A speed test
times the pipeline on 60 s of a simulated watch.

## Running the tests

Requires Node 22 or later. There is nothing to install.

```
npm test             # about fifteen minutes on a fast computer
npm run typecheck    # needs TypeScript (tsc) on the path
node tools/run-analysis.js tests/fixtures/eta-2836-2.wav 2 54    # whole recording
node tools/run-analysis.js tests/fixtures/omega-3861-safari.wav 0 0 0 36   # with a lift angle
node tools/run-analysis.js tests/fixtures/omega-3861-safari.wav 0 0 0 36 never   # plain average
node tools/run-stream.js tests/fixtures/eta-2836-2.wav 2 54      # real time, in chunks
node tools/run-stream.js tests/fixtures/omega-3861.wav 2 60 0 0 21600   # beat rate given
node tools/run-stream.js tests/fixtures/omega-3861-safari.wav 0 0 4096 0 0 36   # with a lift angle
```

## Layout

```
CLAUDE.md              guidance for AI agents working in this repository
index.html             the timegrapher (script in js/main.js, styles in css/app.css)
check.html             browser check
diagnostic.html        audio diagnostic (script in js/diagnostic.js)
version.json           the commit the site was built from, written by GitHub's build (js/version.js)
_config.yml            what GitHub's build leaves out of the published site
docs/hosting.md        setting up GitHub Pages
js/dsp/filterbank.js   band-pass filter bank, 1.5 to 22.5 kHz, and energy envelopes
js/dsp/cleanup.js      noise levelling, click clipping, mains-hum comb filter
js/dsp/acquire.js      beat-rate search by folding, exact and fast
js/dsp/template.js     averaged tick-tock cycle
js/dsp/timing.js       matched-filter beat timing, with averaging for faint watches
js/dsp/irregular.js    irregular watches: every beat timed on its own
js/dsp/estimate.js     rate and beat error from the timestamps; the escapement setting
js/dsp/sounds.js       each beat type's averaged beat and the sounds in it (milestone 8)
js/dsp/amplitude.js    the unlock and the lock; beat error from the unlocks and amplitude, with
                       their scatter, the gates and the lining up (milestone 8)
js/dsp/soundstage.js   the same in real time: the envelopes kept, the beats read since the
                       lock, each reading spread over the audio blocks (milestone 8)
js/dsp/steps.js        rule B: the stretch of beats starts again when the beat error steps;
                       the sensitivity presets
js/dsp/names.js        which beat is the tick: the longer gap after it on a Swiss lever, the
                       longer time from unlock to lock on a co-axial (milestone 8)
js/dsp/offline.js      runs all stages over a whole recording or a window of it
js/dsp/tracker.js      Kalman beat tracker
js/dsp/pipeline.js     real-time pipeline: listening, tracking, lock lost
js/dsp/session.js      the pipeline plus a record of its computing time; the speed test
js/dsp/worker.js       runs a session in a background worker
js/audio/capture.js    microphone choice, raw-audio request, interruptions
js/audio/capture-worklet.js  audio-thread chunker
js/audio/live.js       the microphone as a source: interruptions, resuming, the audio kept for saving
js/audio/ring.js       the most recent stretch of audio, in fixed memory
js/audio/wav.js        WAV reader for recordings, writer for saved captures
js/audio/simulator.js  synthetic watch, as whole recordings or endless and adjustable
js/audio/file-source.js  decodes a recording and hands it out in chunks
js/audio/player.js     paces a source in real time, or faster
js/ui/model.js         what the screen shows, worked out from the pipeline's events
js/ui/trace.js         the trace
js/ui/waveform.js      the averaged tick and tock, with a bar from each unlock to its lock
js/ui/canvas.js        drawing helpers and chart colours
js/ui/wake.js          keeps the screen on while measuring
js/ui/save.js          hands a saved file to the share sheet or a download
js/ui/theme.js         applies the theme chosen in the settings
js/ui/positions.js     the six-position log: when a reading can be saved, what it keeps, and
                       the summary
js/ui/position-icons.js  a drawing of each of the six positions
js/store.js            settings and the six-position log, kept on the device
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
  delivered the phone's mono microphone. These two are also the app's demo recordings, which
  play the first channel only.
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
- suggestions taken into the design, including the Kalman beat tracker, the beat-rate override,
  the continuous mode beside the six-position log, and the sensitivity setting for the amplitude
  and the beat error
- the six recordings in `tests/fixtures/` (five of watches, one with no watch), which are the
  only test data not produced by AI-written code
- every check on the iPhone

What this means for the readings: every result above comes from AI-written code, tested
against AI-written synthetic signals and against the real recordings. The expected values
for the first two recordings also come from AI-written code. No reading has yet been compared
with a bench timegrapher, so treat rates, beat errors and amplitudes from this project as
unverified.

## Licence

MIT. See `LICENSE`.
