# Co-axial prototype: beat error and amplitude from the sounds inside a beat

A prototype, written on 16 November 2026. It is not part of the app and changes nothing the app
shows. The investigation behind it is written up in a separate Claude Doc kept by the owner.

## The idea

The app gives each beat one timestamp, at the loudest part of its averaged sound. In a Swiss
lever watch that is the same event in both beats. In the Omega 3861's co-axial escapement it is
the impulse in one beat and the lock in the other, 3.6 ms apart, which is where Swiss-lever
mode's false 3.4 ms beat error comes from.

Both beats still open with the same faint sound, the unlock, and close with the same loud one,
the lock. The prototype finds the sounds inside each averaged beat and pairs those two:

- beat error: how far the tock's unlock falls from midway between the ticks' unlocks, which is
  how a timing machine defines it;
- amplitude: from the mean time between unlock and lock and a lift angle, with the usual
  formula.

A reading is held back unless resampling the beats supports it (`events.py` has the limits).
Each resample draws beats with their sounds and their timestamps, so a watch whose beats
scatter is given the uncertainty that scatter brings.

## Running it

Node 22 or later, and Python 3 with numpy, scipy and matplotlib. From the repository root:

```
node tools/prototype/coaxial/beats.mjs wav tests/fixtures/omega-3861-safari.wav /tmp/omega
python3 -I tools/prototype/coaxial/analyze.py tests/fixtures/omega-3861-safari.wav /tmp/omega.beats.json 36
python3 -I tools/prototype/coaxial/analyze.py tests/fixtures/omega-3861-safari.wav /tmp/omega.beats.json 36 --app
python3 -I tools/prototype/coaxial/checks.py vary tests/fixtures/omega-3861-safari.wav /tmp/omega.beats.json 36
python3 -I tools/prototype/coaxial/checks.py sims /tmp/sims        # about twenty minutes
node tools/prototype/coaxial/beats.mjs stream tests/fixtures/omega-3861-safari.wav /tmp/omega
python3 -I tools/prototype/coaxial/checks.py kalman tests/fixtures/omega-3861-safari.wav /tmp/omega 36
python3 -I tools/prototype/coaxial/checks.py kalman-sims /tmp/kalman   # about ten minutes
python3 -I tools/prototype/coaxial/track.py recording tests/fixtures/omega-3861-safari.wav /tmp/omega 36
python3 -I tools/prototype/coaxial/track.py sims /tmp/track            # about half an hour
python3 -I tools/prototype/coaxial/checks.py suite /tmp/suite          # about fifteen minutes
```

`beats.mjs wav` runs the app's whole-recording analysis for the timestamps, and `beats.mjs
stream` its real-time pipeline. The last argument of `analyze.py` is the lift angle. `--app`
works on envelopes made the way the app's filter bank makes them.

| File | What it does |
| --- | --- |
| `beats.mjs` | timestamps of a recording, or a simulated watch with known truth |
| `events.py` | the method: averaged beats, their sounds, the pairing, the gates |
| `analyze.py` | one recording, printed, with an optional plot |
| `checks.py` | readings across analysis choices; simulated watches; the unit tests' watches |
| `track.py` | the amplitude followed over time with a slow Kalman filter |
| `suite.mjs` | the unit tests' simulated watches as recordings, with their truth |
| `figure.py` | the first figure in the write-up |

The simulated watch is `tests/helpers/balance.js`: a balance swinging as a sine, with the unlock
and the lock at set angles, so the beat error and the amplitude are known. `tests/balance.test.js`
checks its truth.

## What it measured

All on a computer. Nothing has been compared with a timing machine.

| Recording | Beat error from the first sounds | Amplitude |
| --- | --- | --- |
| Omega 3861, Safari capture, 60 s | 0.31 ± 0.03 ms | 284° at a 36° lift angle |
| ETA 2836-2, Safari capture, 30 s | 0.15 ± 0.01 ms | 263° at a 50° lift angle |
| The three Voice Memos recordings | nothing shown | nothing shown |

The ± is the scatter under resampling only. Across the analysis choices the Omega's beat error
runs from 0.26 to 0.38 ms. The ETA's last sounds are 0.31 ms apart, which is the app's own
Swiss-lever reading: the app's timestamps sit at the loudest part of each beat, which in a lever
watch is the drop, while a timing machine times the unlock.

On simulated co-axial watches (60 s, 21,600 vph, unlock 5 dB over the background) with a true
beat error of 0, 0.5, 1 and 2 ms, sixteen runs all read within 0.10 ms, and amplitudes of 200° to
310° read 1° to 5° low. With the unlock 2 dB over the background or less, or with only 20 s of
audio, nothing was shown. Of all 46 simulated runs, 33 were shown and none of those was more than
0.10 ms or 5° out.

The low amplitudes come from the simulated watch, not from the method. About 2° is a delay
`balance.js` adds to every lock, 0.05 ms on average, which its true amplitude does not count.
About 1° is that its two beats have a mean lift angle of 36.1° while the prototype is told 36°.
How a real watch reads depends on how its published lift angle was arrived at.

Two decibel scales appear here. "Over the background" is how far a sound stands over the
steady noise, and does not grow with averaging. "Over the noise of the average" is how far it
stands over the scatter left in the averaged beat, which shrinks as beats are added, so it
grows with them: the Omega's unlock went from 8.7 dB with 20 s of audio to 12.5 dB with 60 s.
The second decides whether a sound is found. The Omega's unlock is 3.5 to 5.5 dB on the first.

## With the real-time pipeline and a Kalman beat tracker

The readings above line the beats up on the timestamps of the app's whole-recording analysis.
`checks.py kalman` lines them up instead on what the app would have in real time: the timestamps
its real-time pipeline reports, or the beat times of a Kalman tracker (`js/dsp/tracker.js`, run
again over those timestamps with the pipeline's drift settings), either as the tracker expected
each beat before it came or as it placed it afterwards. The first 12 beats of each type are left
out while the tracker settles.

| Omega 3861, Safari capture, beats lined up on | Beat error | Amplitude | Unlock over the noise of the average |
| --- | --- | --- | --- |
| whole-recording timestamps | 0.31 ± 0.03 ms | 284° | 12.6 dB |
| real-time timestamps | 0.30 ± 0.03 ms | 284° | 12.5 dB |
| the Kalman tracker's expected times | 0.33 ± 0.03 ms | 284° | 12.4 dB |
| the Kalman tracker's settled times | 0.32 ± 0.03 ms | 284° | 12.4 dB |

The tracker works as the source of beat times and changes nothing that matters. A beat's own
timestamp scatters about the tracker's time by only 0.05 ms (ticks) or 0.10 ms (tocks), and the
unlock takes about half a millisecond to rise, so lining up on one or the other moves little. With the
audio building up as it would in real time, the gates held the reading back at 20 s and showed it
from 30 s on, the same for all three. The ETA reads 0.14 to 0.15 ms and 263° all four ways.

On sixteen simulated co-axial watches, lining the beats up on the tracker moved the unlock's
level by between -0.1 and +0.4 dB, and the readings were shown about as often: 6 of 16 on the
real-time timestamps, 6 and 7 on the tracker's expected and settled times. No reading, shown or
held, was more than 0.08 ms from the truth.

## Following the amplitude over time

The beat tracker cannot carry the amplitude: the unlock is too faint to time in one beat, so
there is nothing to correct with at each beat. `track.py` works one level up. A reference
stretch, 60 s here, gives the places of the unlock and the lock in the averaged beat. The
recording is cut into 10 s blocks from its start, the reference stretch included, and each
block's beats are averaged. Its unlock and lock are matched against the
reference's to see how far each has moved. That gives the block's time from unlock to lock, with
a scatter from resampling the block's beats 40 times. A one-state Kalman filter follows it:

```
state        t, the mean time from unlock to lock over the two beats
model        t(k+1) = t(k) + w,   w ~ N(0, q x seconds between blocks)
measurement  z(k)   = t(k) + v,   v ~ N(0, R(k)),  R(k) from resampling block k
amplitude    lift angle / (2 sin(pi f t))
```

q is set as how far the amplitude may wander in a second, in degrees. A block more than 3
standard deviations from the filter's value is left out.

Eight simulated co-axial watches, 180 s each, two for each way the amplitude changes. Errors
against the true amplitude, in degrees, over the 12 blocks after the reference in each of the two
runs: root mean square, then the worst. All include the 3° or so by which this simulated watch
reads low, which comes from the simulation, not from the method (see "What it measured").

| Simulated amplitude | Blocks alone | Filter, 0.5° a second | Filter, 1° | Filter, 2° |
| --- | --- | --- | --- | --- |
| steady at 285° | 4.8, 10.8 | 2.9, 4.4 | 3.2, 5.7 | 3.7, 7.6 |
| 290° to 250° over 120 s | 4.1, 9.3 | 8.8, 15.7 | 3.4, 7.2 | 3.1, 6.4 |
| 285° to 255° at once | 5.3, 17.7 | 17.7, 27.0 | 10.3, 26.7 | 4.1, 11.2 |
| ±10° every 60 s | 3.9, 7.1 | 8.4, 19.2 | 5.3, 10.6 | 4.3, 8.5 |

The filter helps when the amplitude holds or moves slowly, and lags when it moves faster than
q allows. At 2° a second it cut the worst error by about a third when the amplitude held, fell
slowly or dropped at once, and was a little worse than the blocks alone for the 60 s wander. At
1° a second its gate left out the first one or two blocks after the sudden drop, and it took
25 to 35 s to come within 5° of the new level. Neither setting is tuned.

On the Omega's Safari capture, with the whole capture as the reference, so not an independent
test, the six 10 s blocks read 280°, 282°, 289°, 287°, 286° and 282°, each with a scatter of
1.4° to 3.7°. The filter at 1° a second followed them: 280°, 281°, 288°, 288°, 286°, 282°.

Limits of this part: it needs the reference first, a minute here. The reference is fixed, and a
sound is looked for within 1.5 ms of its place in it, which at 21,600 vph covers amplitudes down
to about 50° below the reference's. In each of the four cases, one of the 24 scored blocks gave
no measurement.

## Through the app's unit tests

`npm test` runs only the JavaScript pipeline, so it cannot test the prototype. `suite.mjs`
builds the 36 simulated watches that the test files make as whole recordings, with the same
settings and seeds, and writes each one out with its truth and the app's timestamps in co-axial
mode. `checks.py suite` runs it, then the prototype on them and on the six recordings in
`tests/fixtures`. Left out are the five watches that `tests/interface.test.js` makes as live
streams, and the Voice Memos ETA recording that `tests/irregular.test.js` re-times.

These watches come from the app's own simulator, `js/audio/simulator.js`, which places each
beat's sounds at fixed times. Every tock sound moves by the set offset, so that offset is the
true beat error. No balance is behind them, so the time from the first sound to the last loud
one, 7 ms for the default sounds, is checked instead of an amplitude. The lift angle is chosen
per beat rate to make that time read 280°, so that the gate on believable amplitudes passes.

| Outcome on the 36 watches | Watches |
| --- | --- |
| shown and wrong by more than 0.1 ms | 0 |
| shown and right | 1: the two-sound watch whose tock changes its loudest sound, 0.01 ms against 0 |
| refused, rightly | 1: the two-sound co-axial, whose beats share no first sound |
| held back, would have been right | 7, off by 0.01 to 0.07 ms |
| held back, would have been wrong | 6: 3 basket cases, 1 and 5 ms jitter, a run with a 2 s gap |
| nothing to measure | 21 |

The simulator's unlock is a quarter as loud as the drop. After 30 to 75 s of beats it stands
7 to 11 dB over the noise of the average, mostly 8 to 9, which is at the edge of what the
prototype can find: it often found the unlock in one beat only, and refused rather than pair
unlike sounds. Where it found both, 6 to 87% of the resamples did not, against a limit of 5%.
The Omega capture's unlock stands 12.6 dB over the noise of the average. The two Safari captures
read as above. The three Voice Memos recordings and the capture with no watch give nothing.

The run also found a flaw, fixed here. Resampling redrew the averaged beats but kept the gap
between the tick and tock timestamp lines fixed. On a regular watch that gap is known to about
0.01 ms, so nothing was lost; on an irregular one it is the largest part of the uncertainty, and
the stated figure was 3 to 18 times too small. Each resample now draws every beat's timestamp
with its sound:

| Watch | True beat error | Read | Uncertainty before | After |
| --- | --- | --- | --- | --- |
| 1 ms jitter | 0.20 ms | 0.07 ms | ±0.09 ms | ±0.25 ms |
| 2 ms jitter | 0.20 ms | 0.25 ms | ±0.05 ms | ±0.32 ms |
| 5 ms jitter | 0.20 ms | 0.58 ms | ±0.05 ms | ±0.89 ms |
| basket cases 1, 2, 3 | 2.00 ms | 1.66, 1.60, 1.13 ms | ±0.06 to 0.07 ms | ±0.35 to 0.43 ms |

The 0.1 ms gate now holds each of these back by its own uncertainty. Before, they were held back
only because the sounds were not found consistently. The regular watches and the two Safari
captures read as before, with uncertainties within 0.01 ms of what they were.

## Limits

- That the first sound is the unlock in both beats is a reading of the patents' sequence of
  events, not something the audio proves. Only a timing machine with a co-axial mode can check
  it.
- The 3861's 36° lift angle comes from a forum post. Each degree moves the amplitude by 7.9°.
- The two beats take 8% different times from unlock to lock. The prototype uses their mean. No
  description was found of what a timing machine's co-axial mode does.
- The 3861's unlock stands only 3.5 to 5.5 dB over the background, mostly above 18 kHz. It took
  30 to 60 s of beats to find reliably, and the Voice Memos recordings do not show it.
- The gate on the scatter of the resamples is touchy: one stray resample in a hundred can hold
  a good reading back.
- It is not yet a general measure. On the simulated watches of the unit tests it showed a
  reading for 1 of the 35 that tick, and nothing for any irregular watch, whose uncertainty
  came to 0.25 to 0.89 ms.
- One watch and one capture. The averaging itself runs on a whole recording, in Python, even
  when the beat times come from the real-time pipeline.
