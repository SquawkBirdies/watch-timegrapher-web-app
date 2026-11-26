# Watch Timegrapher Web App

A mechanical watch timegrapher that runs in a phone's web browser and listens through the
microphone. It measures rate (seconds per day) and beat error (milliseconds) and draws a
real-time trace.

**Status: milestone 7 of 9.** The timegrapher listens to the phone's microphone. It can also be
driven by a simulated watch, by two demo recordings or by a recording of your own. It measures
continuously, or saves a reading for each of the six positions a watch is checked in. Milestone
8, amplitude and a beat error measured from the unlock, is under way: the first three of its six
steps are in the code. The app now reads both while it measures, but its screen does not show
them yet; a line of fine print on the Signal card says what reading them costs.

Tested in Safari on an iPhone 17 Pro Max with iOS 27.2 (the audio diagnostic in milestone 4, the
timegrapher replaying its three demo recordings of the time, all made with Voice Memos, in
milestone 5, a live measurement of the Omega in milestone 6, a six-position run of the Omega and
the theme setting in milestone 7, and the two demos of today with the cost of reading the Omega's
amplitude in milestone 8), and in Chrome on a computer at phone size, where the microphone was also
tested with a recording played in as a simulated microphone.

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
and no beat error is shown. Told 18,000 vph, a 36,000 vph watch has its every other beat taken,
so the tick and the tock found are both its ticks, and its tocks fall halfway between them. Until
18 November that went unnoticed: run for 60 s, such a watch showed a beat error of about
0.005 ms in every reading, against a true 0.50 ms. The pipeline now looks for a beat halfway
between the tick and the tock, and shows no beat error when it finds one.

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

The escapement can be set to Swiss lever (the default) or co-axial: pass
`{ escapement: 'coaxial' }` to `Pipeline` or `analyze`. A co-axial escapement's tick and tock
are different sounds, so the gap between them is not the beat error. In co-axial mode the rate
is still measured from both beats, and no beat error is reported. The Omega 3861 captured
through Safari showed why: in Swiss-lever mode it read a steady 3.4 ms beat error that does not
describe the watch, and the beat-error checks passed it.

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

Milestone 8 brings that method into the app, for both escapements, in six steps. The first three
are in. `js/dsp/sounds.js` averages each beat type's envelopes around its timestamps and finds
the sounds in the averaged beat. `js/dsp/amplitude.js` takes the first as the unlock, chooses the
lock for both beats together, and gives the beat error from the unlocks and the amplitude, each
with a scatter and a verdict on whether it may be shown. `js/dsp/soundstage.js` does the same in
the real-time pipeline, on the beats heard since the lock. Each runs when a lift angle is given:
`analyze` with `{ liftAngle: 36 }` (a fifth argument to `tools/run-analysis.js`), the pipeline
with the same option (a seventh argument to `tools/run-stream.js`). The app gives its pipeline
the lift angle from the settings, so the readings are made while it measures; the screen that
shows them is the fourth step.

| Recording, first channel, whole | Beat error from the unlocks | Amplitude | Unlock to lock, tick and tock | May be shown |
| --- | --- | --- | --- | --- |
| Omega 3861, Safari capture, at 36° | 0.343 ± 0.043 ms | 287.7 ± 1.2° | 6.96 ± 0.03 and 6.33 ± 0.04 ms | both; lined up again on its two locks |
| ETA 2836-2, Safari capture, at 50° | 0.275 ± 0.027 ms | 265.9 ± 0.5° | 7.49 ± 0.01 and 7.50 ± 0.03 ms | both; nothing moved |
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
  confident beat's stretch is cut out of them at its timestamp's own place.
- **Which beats.** Those heard since the lock appeared, at most the last 60 s of them, and only
  beats that were timed alone. The beats of the 8 s of audio a lock is found in are left out, so
  that a reading rests on nothing from before the watch was placed, as the six-position log
  asks. A lost lock clears everything.
- **When.** The first reading starts when each beat type has 30 s of beats. The next start 5 s
  apart while the beats still reach back less than a minute, and 10 s apart after that.
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
| Omega 3861, Safari capture, co-axial, 36° | 8.1 s | 38.8 s, from 30 s of beats | reliably shown from 49 s, with 41 s of beats; at the end 0.31 ± 0.04 ms and 288.4 ± 1.0° from 51 s of beats |
| Simulated lever, 0.50 ms and 270°, at 50° | 8.1 s | 38.8 s | 0.49 ± 0.01 ms and 269.6 ± 0.2°, shown from the first reading |
| ETA 2836-2, Safari capture | 8.1 s | none: the capture is 30 s long | |
| ETA 2836-2, Voice Memos recording | 8.1 s | 38.8 s | no reading for its first minute: the first sound found comes at no believable time before the lock (`lift-range`), 0.05 s of computing a try; then its timestamps average cycles |
| The two Omega 3861 Voice Memos recordings | 52 s and 12 s | none: timestamps that each average several cycles | a dash, with that reason |

The times are those of the readings event that first carried the reading. In the app a reading
appears later by twice its computing, as below.

With 30 to 40 s of its beats, 4 to 10% of the Omega's draws lose its faint unlock, against the
5% a reading is allowed: read every second, it was shown twice in ten and held back eight times,
then shown every time from 41 s of beats on. So the first number of a watch like it can appear,
give way to a dash and come back. What was read was 0.30 to 0.34 ms and 288° to 290° throughout.
Read from the beats before the lock as well, the same capture would have had its first reading
at 30.6 s instead of 38.8 s, and been reliably shown from 37.8 s instead of 49 s
(`sounds: { sinceLock: false }`).

What has been checked, on a computer:

- **The real-time stage against the whole-recording one.** Fed a made-up watch block by block,
  it gives the reading the whole-recording stage gives of the same beats, to rounding, also once
  the envelopes it keeps have been moved up in their buffer. Spread over the audio by a clock the
  test keeps, a reading with every sound lined up is the same to the last digit as one finished
  at once. In the pipeline, a simulated lever's events are the same whether the audio comes in
  chunks of 1,024 or 4,096 samples, and its timestamps, rate and beat error are the same with
  the stage as without. So are those of the six recordings.
- **Against the prototype.** Given each beat where the prototype puts it, and the prototype's
  own draws, the port gives every one of the 200 resampled readings within 2 hundred-millionths
  of a millisecond of the prototype's on envelopes made as the app makes them
  (`analyze.py --app`), which is rounding: on the two captures, lined up where a sound moves and
  with every sound lined up, and on 59 simulated watches, with the same share of draws failing
  and the same verdicts. The prototype reads the captures at 0.340 ± 0.044 ms and 287.6 ± 1.2°,
  and 0.273 ± 0.026 ms and 265.7 ± 0.5°. The port puts each beat at its timestamp's own place in
  the envelope instead, three eighths of an envelope sample (0.03 ms) earlier, the same for every
  beat, and makes its own draws.
- **Against the truth, on the 46 simulated watches the prototype was judged on,** 42 co-axials
  on the Omega's pattern and 4 levers. 31 beat errors are shown, as the prototype shows on the
  same envelopes. Every one lies within 3 times its own stated scatter of the truth, the worst
  2.4 times, and within 0.15 ms, the worst a co-axial in beat shown 0.14 ms off at a stated
  ±0.07 ms. Over the 31 the errors are 1.06 times the stated scatter, rms. The 31 amplitudes
  shown lie within 1.6°. Nothing is shown for the 6 whose unlock is set 2 dB over the background
  or level with it, or for the 3 of 20 s; one of the 6 took another sound for an unlock and read
  3.05 ms off, and 95% of its draws disagree with it.
- **Levers.** The 4 among the 46 and 8 whose impulse is as loud as the drop or up to 9 dB
  louder are all shown, within 0.011 ms at a stated ±0.008 to ±0.011 ms, and within 0.3°. The 5
  whose unlock is lost or whose impulse cannot be heard give no reading.
- **Watches that do not hold still.** A simulated lever with each beat 0.5 ms off the grid,
  which the pipeline finds irregular, keeps its amplitude, 269.7 ± 0.2° against 270°, and shows
  no beat error. One swinging by 30° either way every 40 s, too fast for 10 s blocks to follow,
  reads its amplitude 10° high; a quarter of its draws take another sound, and nothing is shown.

The limits so far:

- **The gates limit a reading's scatter, not its error,** as the co-axial shown 0.14 ms off
  says. A stated scatter counts how the beats differ within the reading, and nothing else.
- **Noisy timestamps can shift the beat error from the unlocks, and its scatter does not say
  so.** Each beat is averaged where its timestamp puts it, so timestamps that scatter smear the
  averaged sounds. In the prototype, simulated faint co-axials whose unlock is as loud as its
  lock, with timestamps scattering by 0.10 to 0.15 ms, read 0.067 ms off on average and 0.099 ms
  at worst, 2.8 times their stated scatter. It was not seen on the simulated levers, on the
  simulations shaped like the Omega or on the Safari captures. The prototype reads the beat
  error a second time with every beat on the trend of its timestamps and adds the difference to
  the stated scatter. The app does not yet: that check costs 13 to 30% more computing, and
  waits until a phone has timed the stage.
- **A stretch under 20 s has one block and nothing to line up on.** A made-up watch of 15 s
  whose amplitude falls by 36° reads it 6° low and shows it. In real time a reading has 30 s of
  beats or more.
- **Nothing for the first 30 s after a lock,** and for a watch whose unlock is as faint as the
  Omega's, nothing steady before about 40 s. Each lost lock starts that wait again.
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
- **Its memory:** 18.5 MB for the envelopes kept, and 8 to 14 MB more while a reading is worked
  out. In Chrome the page's process held 10 to 25 MB more with the stage than without, at about
  300 MB. Not measured in Safari.
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
- **The screen does not show any of it yet.** That is the fourth step.
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

Each row keeps the rate with its statistical uncertainty, the beat error or why there is none,
the window the reading was made over ("Over a 20 s window") and what the rate was measured from:
the number of beats ("120 beats"), or, for a faint watch whose timestamps each average several
tick-tock cycles, the number of timestamps and cycles ("33 timestamps of up to 8 cycles"). Below
the rows, the summary gives the average rate, the spread (fastest minus slowest position) and the
largest beat error with its position. A reading whose rate is uncertain by more than ±1 s/day is
marked and left out of the average and the spread, and a line says so; its beat error still
counts. No uncertainty is given for the average: each position's ± is statistical only, and a
watch's 20 s readings can move by more than that (from −0.2 to +1.6 s/day over the minute of the
Omega's Safari capture, each ±0.09), so a combined figure would look more precise than it is. One log is kept at a time, on the device;
"Start new log" clears it after asking. Exporting it is planned for a later version.

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
window (20.36 s when the window was counted from the start of the lock's audio). With a 40 s
window the Omega's capture can be saved from 49.03 s and not before, and the reading records the
40 s; a window changed to 60 s waits until the lock has lasted 60 s.

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
- The log keeps whatever is saved: readings from different watches, sources or escapement settings
  are not told apart in the summary.
- A watch's rate also changes with its state of wind and over time, so readings taken minutes
  apart differ for that reason too.

## Hosting

The app is a folder of static files with no build step, served by GitHub Pages over HTTPS.
Browsers allow the microphone only on secure pages, so the app cannot be opened from a local
file. [docs/hosting.md](docs/hosting.md) explains how to set up the site, how to host your own
copy, and how to test on a computer.

`index.html` is the timegrapher. Its header shows rate, beat error and a place for the amplitude,
which stays a dash until the fourth step of milestone 8, with the beat rate, lift angle and
averaging window under them, and dashes instead of
stale numbers when there is no lock or the microphone is interrupted. When the watch runs irregularly, a warning below them says
by how much its beats wander from one to the next. Below are the trace, one dot per beat in milliseconds ahead
of an ideal clock with low-confidence beats dimmed; a signal meter with advice; and the averaged
tick and tock. Under the meter a line of fine print gives the input level and the share of real
time the analysis uses. For now it also says how often the sounds inside the beats have been
read, what the latest reading cost in computing and in time, and whether its amplitude and beat
error could be shown; the numbers themselves are not on the screen yet. The source can be the microphone, a simulated watch whose rate, beat error, beat
variability and loudness can be changed while it runs, one of two demo recordings, or a
recording chosen from the phone, replayed at real speed or faster. A switch above the readings
chooses continuous measuring or the six-position log (see [Six positions](#six-positions)).
Settings (beat rate, escapement, lift angle, mains frequency, averaging window, theme), the
chosen microphone, the mode, the six-position log and whether the magnetism notice has been read
are kept on the device.

The two demo recordings are the ETA's and the Omega's Safari captures among the [test
recordings](#test-recordings): what the phone's microphone gave Safari, so the sounds inside their
beats can be read as a live watch's are. They replaced the three Voice Memos recordings, which
allow no such reading. A demo plays with its own watch's escapement and lift angle, 50° for the ETA
and 36° for the Omega, whatever the settings, and the line under the readings shows the lift angle
in use. A lift angle set in Settings while a demo plays replaces the demo's for the rest of that
run; a demo never changes the stored setting. A demo also plays only the first channel of its
capture, as the microphone gives it to the app. The second channel is silent: it changes no
reading, and playing it nearly doubled the pipeline's computing (in Node, without the stage, about
10% of real time against 5% for the Omega's capture, and 13% against 7% for the ETA's). Both were
decided on 26 November. Two limits follow from the captures' lengths:

- **The ETA's 30 s are too short for an amplitude.** A reading needs 30 s of beats after the lock,
  which comes at 8 s. The demo shows rate and beat error only, until a longer capture is recorded.
- **The Omega's 60 s leave time for three readings on a computer,** the first about 45 s in and the
  last just before the end, and for four on an iPhone 17 Pro Max.

In Chrome on a computer, with nothing changed in Settings, the ETA demo ran at 50° and ended at
+1.7 ± 0.05 s/day and 0.31 ms, with the analysis at 8% of real time. The Omega demo ran at 36° and
ended at +0.9 ± 0.09 s/day over its last 20 s, with the analysis at 19% of real time. It was read
three times: the first reading was on the screen about 45 s after Start, after 2.2 s of computing
over 4.4 s, and could be shown; the second was held back, more than 5% of its draws having lost the
unlock; the third, 3.1 s of computing over 6.2 s, could be shown. Setting the lift angle to 40°
during the ETA demo changed the line under the readings to 40° at once, and the next start of the
demo was at 50° again, with the setting still as stored.

On an iPhone 17 Pro Max on 26 November 2026, the ETA demo ran at 50° and ended at +1.7 ± 0.05 s/day
and 0.31 ms, 112 times the noise spread, with the analysis at 9% of real time. The Omega demo ran
at 36° and ended at +0.9 ± 0.09 s/day, 66 times the noise spread, with the analysis at 16% of real
time and the fine print "amplitude read 4 times, last in 1.4 s of computing over 2.9 s, both to
show". Settings still held the default 52° afterwards.

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
audio as it arrives in a background worker. Afterwards it reports what the browser actually
applied, the levels, any dropouts or interruptions, the readings and the pipeline's load. The
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
js/ui/waveform.js      the averaged tick and tock
js/ui/canvas.js        drawing helpers and chart colours
js/ui/wake.js          keeps the screen on while measuring
js/ui/save.js          hands a saved file to the share sheet or a download
js/ui/theme.js         applies the theme chosen in the settings
js/ui/positions.js     the six-position log: when a reading can be saved, and the summary
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
- suggestions taken into the design, including the Kalman beat tracker, the beat-rate override
  and the continuous mode beside the six-position log
- the six recordings in `tests/fixtures/` (five of watches, one with no watch), which are the
  only test data not produced by AI-written code

What this means for the readings: every result above comes from AI-written code, tested
against AI-written synthetic signals and against the real recordings. The expected values
for the first two recordings also come from AI-written code. No reading has yet been compared
with a bench timegrapher, so treat rates and beat errors from this project as unverified.

## Licence

MIT. See `LICENSE`.
