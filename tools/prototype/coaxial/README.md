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
  how Witschi defines it for a Swiss lever;
- amplitude: from the mean time between unlock and lock and a lift angle, with Witschi's
  formula.

The sounds are found in six bands from 5 to 22.5 kHz, added into one averaged beat by their own
energy, as a fixed filter would hear them (since 22 November; see "Adding the bands by energy").
A real watch's sounds do not start at the same moment in every band, so the mixture decides
where a sound starts, and it must not move with the room's noise.

Witschi's two documents used here are its training document, "Testing methods for mechanical
watches" (2025), and the ChronoCube operating instructions (version 2.0, 2020). Both say the
first sound of a lever beat, the unlock, is timed for the rate and the beat error, and the time
from its start to the start of the last, loudest sound for the amplitude. No other maker's
description was found.

A reading is held back unless resampling the beats supports it (`events.py` has the limits). A
resample that takes another sound counts as failing, not as scatter (see "Resamples that find
another sound").
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
python3 -I tools/prototype/coaxial/track.py sims /tmp/track-lever lever  # about half an hour
python3 -I tools/prototype/coaxial/checks.py suite /tmp/suite          # about 40 minutes
python3 -I tools/prototype/coaxial/checks.py pairing /tmp/pairing      # about twenty minutes
python3 -I tools/prototype/coaxial/track.py swings /tmp/swings both     # about an hour
python3 -I tools/prototype/coaxial/track.py steady /tmp/steady both     # about half an hour
python3 -I tools/prototype/coaxial/checks.py rates /tmp/rates           # about ten minutes
python3 -I tools/prototype/coaxial/checks.py noise /tmp/noise           # about twenty minutes
```

`beats.mjs wav` runs the app's whole-recording analysis for the timestamps, and `beats.mjs
stream` its real-time pipeline. The last argument of `analyze.py` is the lift angle. `--app`
works on envelopes made the way the app's filter bank makes them. Every reading lines up again,
before averaging, the sounds whose 10 s blocks show them moving (see "Lining up only the sounds
that move"), leaving out any block's shift that scatters by more than 0.3 ms over its resamples
(see "Block shifts that took another sound"). `analyze.py --lined`, and `lined` on the other
commands, line every sound up;
`--plain` and `plain` give the plain average. Given `both`, `checks.py sims` and `suite` and
`track.py sims`, `swings` and `steady` run every watch plain and lined, given `three` all three
ways, and the words `plain`, `lined` and `test` (the default) can be given together. Those
commands keep each simulated watch's timestamps in their directory; run again on the same
directory, they make only the audio again (`beats.mjs synth`, under a second) and check that its
truth matches, since the app's analysis is the slow part.

| File | What it does |
| --- | --- |
| `beats.mjs` | timestamps of a recording, or a simulated watch with known truth |
| `events.py` | the method: averaged beats, their sounds, the pairing, the gates |
| `analyze.py` | one recording, printed, with an optional plot |
| `checks.py` | readings across analysis choices; simulated watches; the unit tests' watches |
| `track.py` | the amplitude followed over time with a slow Kalman filter |
| `suite.mjs` | the unit tests' simulated watches as recordings, with their truth |
| `figure.py` | the first figure in the write-up |
| `bias/` | where the swing bias comes from, against the true time of every beat's sounds |

The scripts in `bias/` check one simulated watch against the true time of each beat's unlock and
lock, which `beats.mjs` keeps only as averages. `truth.mjs` writes those times for the watch that
`beats.mjs sim` makes with the same overrides. `where.py` sets the sounds found in the plain
average against the true times of the beats that went into it, at the half-rise the method uses,
at later points on the rising edge and at the peak. `realign.py` reads the watch with the plain
average and lined up again, and scores the reference and the 10 s blocks after it against the
truth; given a recording and no truth, it prints each block's amplitude both ways. For the lever
swinging ±30° once a minute, the first watch of `track.py swings`:

```
O='{"amplitude":285,"amplitudeSwing":{"base":285,"swing":30,"period":60},"seed":91,"seconds":180}'
node tools/prototype/coaxial/beats.mjs sim lever /tmp/swing30 "$O"     # about two minutes
node tools/prototype/coaxial/bias/truth.mjs lever /tmp/swing30 "$O"
python3 -I tools/prototype/coaxial/bias/where.py lever /tmp/swing30.wav /tmp/swing30.stream.json /tmp/swing30.events.json
python3 -I tools/prototype/coaxial/bias/realign.py lever /tmp/swing30.wav /tmp/swing30.stream.json /tmp/swing30.events.json
```

`where.py` then finds the unlock 0.45 to 0.47 ms before its true mean and the amplitude 18.7°
low. `realign.py` reads the reference at 264.7° plain and 282.7° lined up again, against a true
283.4°, and the 11 blocks after it 29.3° and 1.2° rms off.

The simulated watch is `tests/helpers/balance.js`: a balance swinging as a sine, with the unlock
and the lock at set angles, so the beat error and the amplitude are known. It can also be made
irregular: `beatJitterMs` moves each whole beat off the regular grid and `amplitudeJitterDeg`
each beat's amplitude, drawn afresh for every beat on a random stream of their own, so that a
watch without them is the same to the last sample. A sound's `arrival` makes it start at its own
time and level in each band, as a real watch's sounds do; its parts come early or late and loud
or quiet together, and a watch without it is the same to the last sample. `tests/balance.test.js`
checks its truth.

## What it measured

All on a computer. Nothing has been compared with a timing machine.

| Recording | Beat error from the first sounds | Amplitude |
| --- | --- | --- |
| Omega 3861, Safari capture, 60 s | 0.35 ± 0.02 ms | 287° at a 36° lift angle |
| ETA 2836-2, Safari capture, 30 s | 0.30 ± 0.02 ms | 267° at a 50° lift angle |
| The three Voice Memos recordings | nothing shown | nothing shown |

These add the bands by energy, the default since 22 November, and line up only the sounds that
move, the default since 18 November: on the Omega the two locks, on the ETA nothing. Added by
noise, as before 22 November, the Omega read 0.31 ± 0.03 ms and 284° and the ETA 0.15 ± 0.01 ms
and 263°; the figures below that are dated before 22 November were measured that way, and most
of those not about lining up came from the plain average. The ± is the scatter under resampling
only. Across the analysis choices the Omega's beat error ran from 0.26 to 0.38 ms (by noise,
plain average). The ETA's last sounds are 0.31 ms apart, which is the app's own Swiss-lever
reading: the app's timestamps sit at the loudest part of each beat, which in a lever watch is the
drop, while Witschi's instruments time the unlock. By energy the ETA's unlocks now read 0.30 ms
apart too; by noise they read 0.15.

On simulated co-axial watches (60 s, 21,600 vph, unlock 5 dB over the background) with a true
beat error of 0, 0.5, 1 and 2 ms, sixteen runs read within 0.11 ms, the worst one in beat at
±0.04 ms and the rest within 0.07 ms, and amplitudes of 200° to 310° within 1°. With the unlock
2 dB over the background or less, or with only 20 s of audio, nothing was shown. Of all 46
simulated runs, 33 were shown, one 0.11 ms off and the rest within 0.09 ms, and the amplitude
within 2°. By noise, as before 22 November, 32 were shown, within 0.09 ms and 2°; with every
sound lined up the same 46 showed beat error in 31 and amplitude in 33, none more than 0.10 ms or
2° out (22 and 30 before block shifts that took another sound were left out): the co-axial's
faint unlock gives noisy shifts to line the beats up on, which widens the stated uncertainty
(see "Lining the beats up again").

Until 19 November the simulated watches read low, the co-axial by about 2.8° and the lever by
about 0.9°, for two reasons in `balance.js`, not in the method. Each lock was delayed by the size
of a random draw, 0.05 ms on average on the co-axial, which its true amplitude did not count; and
the co-axial's two beats had a mean lift angle of 36.1° while the prototype is told 36°. The
lock's variation from beat to beat now averages zero, and the co-axial's lift angles average 36°,
so a simulated watch's unlock-to-lock times give its true amplitude. Figures in this README
marked as measured before 19 November carry the old offset. A real watch has the same kind of
delay, which Witschi's training document calls lost motion; its formula takes the time as
measured, so how a real watch reads depends on how its published lift angle was arrived at.

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

| Omega 3861, Safari capture, plain average, beats lined up on | Beat error | Amplitude | Unlock over the noise of the average |
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
level by between -0.5 and +1.0 dB, and the readings were shown as often: 8 of 16 on the
real-time timestamps and on each of the tracker's times. No reading shown was more than 0.06 ms
from the truth; held back, up to 0.13 ms.

## Following the amplitude over time

The beat tracker cannot carry the amplitude: the unlock is too faint to time in one beat, so
there is nothing to correct with at each beat. `track.py` works one level up. A reference
stretch, 60 s here, gives the places of the unlock and the lock in the averaged beat. The
recording is cut into 10 s blocks from its start, the reference stretch included, and each
block's beats are averaged. Its unlock and lock are matched against the reference's to see how
far each has moved. That gives the block's time from unlock to lock, with a scatter from
resampling the block's beats 40 times. A one-state Kalman filter follows it:

```
state        t, the mean time from unlock to lock over the two beats
model        t(k+1) = t(k) + w,   w ~ N(0, q x seconds between blocks)
measurement  z(k)   = t(k) + v,   v ~ N(0, R(k)),  R(k) from resampling block k
amplitude    lift angle / (2 sin(pi f t))
```

q is set as how far the amplitude may wander in a second, in degrees: 2° by default, which was
1° until the larger swings below showed it smoothing them away. The filter's value is shown only
while its own uncertainty is 5° or less, the limit the whole-recording reading uses; otherwise
the commands print "dash", as an app would show one, so that a value held over blocks with no
measurement is not shown. A block more than 3 standard deviations from the filter's value is
left out. When two measured blocks in a row are
both left out but agree with each other within 3 standard deviations, the filter starts again
from them: a sudden change is believed once it has been seen twice. Both commands also print
the filter without that restart, gate only, as it was before.

Each sound is looked for within 1.5 ms of its place in the reference. The match at each shift
is the product of the reference's stretch around the sound with the block's, a matched filter,
which suits a faint sound in noise. Of the peaks in that match at least half as strong as the
reference matched with itself, the one nearest the sound's place is taken. An earlier version
took the strongest peak (`strongest` on the command line gives it back). On a simulated Swiss
lever, whose unlock is followed 2.4 ms later by a louder sound, that lost every block once the
amplitude fell about 20° below the reference: the louder sound reached into the search and won
at its edge. Two other ways were tried and dropped, both on the co-axial's faint unlock. A
normalised correlation matched noise up to 1.4 ms away. Searching where the last accepted block
found each sound let one wrong block lead the following ones astray for two minutes.

Simulated watches, 180 s each, two runs for each way the amplitude changes, the co-axial at
21,600 vph and a 36° lift angle, the lever at 28,800 vph and 50°, with the reference lining up
only the sounds that move, the default. Errors against the true amplitude, in degrees, over the
12 blocks after the reference in each of the two runs, counting only blocks that gave a
measurement: root mean square, then the worst.

| Co-axial | Blocks measured | Blocks alone | Filter, 0.5° a second | Filter, 1° | Filter, 2° |
| --- | --- | --- | --- | --- | --- |
| steady at 285° | 21 of 24 | 2.3, 5.8 | 1.1, 2.5 | 1.3, 2.8 | 1.8, 4.2 |
| 290° to 250° over 120 s | 23 of 24 | 2.4, 8.5 | 5.0, 11.0 | 2.0, 4.8 | 1.9, 7.2 |
| 285° to 255° at once | 20 of 24 | 2.3, 8.2 | 8.4, 28.9 | 8.1, 28.7 | 6.1, 28.1 |
| ±10° every 60 s | 20 of 24 | 2.2, 5.2 | 7.9, 15.5 | 5.2, 15.0 | 3.3, 7.9 |

| Swiss lever | Blocks measured | Blocks alone | Filter, 0.5° a second | Filter, 1° | Filter, 2° |
| --- | --- | --- | --- | --- | --- |
| steady at 285° | 24 of 24 | 0.9, 1.5 | 0.8, 1.3 | 0.8, 1.4 | 0.8, 1.5 |
| 290° to 250° over 120 s | 24 of 24 | 0.7, 1.4 | 2.4, 8.7 | 0.8, 1.6 | 0.7, 1.5 |
| 285° to 255° at once | 24 of 24 | 0.7, 1.1 | 8.7, 30.0 | 8.6, 29.9 | 8.6, 29.9 |
| ±10° every 60 s | 24 of 24 | 0.9, 2.0 | 9.2, 16.6 | 5.5, 15.7 | 0.9, 2.1 |

The comparisons in the next two paragraphs were measured before 19 November, with the plain
average and the simulated watch's earlier offset (see "What it measured"). Against the earlier
search, the co-axial's worst block errors fell from 10.8° to 8.7° when
steady and from 17.7° to 11.5° around the drop, and the lever's falling amplitude was followed
to within 1.4° all the way down, where before half its blocks were lost. The cost is co-axial
blocks with no reading: a block whose unlock is too faint for a strong match is dropped
rather than guessed, up to 5 of 24 against 1 before. The threshold of a half is not tuned; on
single runs 0.3 kept every co-axial block and its old errors, and 0.7 halved the worst error and
lost half the blocks.

The filter helps the co-axial when the amplitude holds or moves slowly, and adds nothing to the
lever's blocks, which scatter by under 1°. Without the restart it failed after a sudden drop:
the gate rejected every right block as too far from the filter's value, which stayed where it
was, 284° against 255° on the lever. At 1° a second its error over the blocks after the
reference was then 20.5° rms on the lever and 17.1° on the co-axial (on the fixed simulator,
21.1° and 18.9°). With the restart the
filter came within 0.6° of the lever's new level and within 1.3° of the co-axial's, 20 s after
the drop, in every run. The worst error stays, because the first block after a drop is still
left out. The restart never fired on the steady runs or on the Omega capture, nor on 32 more
steady runs (see "Larger swings, and false restarts"). It does not help the ±10° swing: blocks
left out there differ from each other as much as from the filter, so they never agree, and only
the looser 2° a second keeps up. At 0.5° a second it fired on the co-axial's fall, taking that
filter's error from 9.4° rms to 5.0° on the fixed simulator (7.0° to 3.0° before).

On the Omega's Safari capture, with the whole capture as the reference, so not an independent
test, the six 10 s blocks read 280°, 282°, 289°, 287°, 286° and 282°, each with a scatter of
1.3° to 2.0°. The filter at 2° a second, its default, followed them with no dash: 280°, 282°,
289°, 287°, 286°, 282°. At 1° a second it read 288° for the third.

Limits of this part: it needs the reference first, a minute here. The reference is fixed, and a
sound is looked for within 1.5 ms of its place in it, which on both simulated watches covers
amplitudes down to about 50° below the reference's. A block that gives no measurement leaves the
filter at its last value, which an app would have to show as a dash.

## Larger swings, and false restarts

Witschi's training document says the meshing of the gears can move a watch's amplitude by up to
30°, and calls that normal. `track.py swings` tries larger and faster swings than the ±10° above:
±15° and ±30° once a minute (in most movements the wheel that carries the seconds hand turns once
a minute), and ±15° every 5 s, faster than a block. Three runs of each, 180 s, with the plain
average, which is where the bias below was found; lining up only the sounds that move, the
default, takes most of it away (see "Lining up only the sounds that move"). Errors are in
degrees against the true amplitude averaged over each block, which is all a 10 s block can see:
that averaging alone keeps 95% of a once-a-minute swing. "Kept" is the share of the swing that
survives, from fitting a sine of the known period. The true average is 285°; steady watches'
references read 283.3° to 285.8° on the co-axial and 284.9° to 285.7° on the lever (see below).

| Co-axial | Reference | Blocks alone | Kept | Filter, 1° a second | 2° | 4° |
| --- | --- | --- | --- | --- | --- | --- |
| ±15° every 60 s | 286° to 288° | 4.5, 9.4 | 95% | 11.0, 23.1; 38% | 6.5, 18.4; 68% | 6.0, 18.6; 79% |
| ±30° every 60 s | 291° to 302° | 13.5, 26.1 | 82% | 24.1, 52.3; 33% | 24.2, 52.1; 52% | 17.2, 43.5; 67% |
| ±15° every 5 s | 285° to 288° | 3.2, 7.1 | | 2.7, 5.2 | 2.8, 5.7 | 2.9, 6.5 |

| Swiss lever | Reference | Blocks alone | Kept | Filter, 1° a second | 2° | 4° |
| --- | --- | --- | --- | --- | --- | --- |
| ±15° every 60 s | 280° to 281° | 5.4, 8.0 | 90% | 15.4, 26.6; 57% | 5.4, 8.1; 90% | 5.4, 8.0; 90% |
| ±30° every 60 s | 264° to 268° | 30.0, 41.4 | 69% | 33.4, 72.0; 6% | 38.1, 69.8; 42% | 29.9, 41.4; 69% |
| ±15° every 5 s | 281° | 5.5, 8.0 | | 5.5, 7.8 | 5.5, 7.9 | 5.5, 7.9 |

- A swing moves the reading itself, not only the filter. The lever's 60 s reference reads 280°
  to 281° at ±15° and 264° to 268° at ±30°, where a steady one reads 285° to 286°, and every
  block measured from it inherits the error. The co-axial reads 1° to 3° high at ±15° and 6° to
  17° high at ±30°. The 5 s swing does the same as the 60 s one, so what matters is the spread
  of amplitudes among the beats averaged, not how fast it changes; the ±10° swing above cost the
  lever's plain blocks about 1°. The cause, checked against the simulator's true unlock and lock
  times (`bias/`): the app's timestamp follows a beat's loudest sound, so a sound whose place
  moves with the lift time is smeared in the average, and the point where a smeared sound is
  half risen lands early. In the lever that is the unlock: at ±15° it lands 0.07 ms before its
  true mean where a steady watch's lands 0.05 ms after, so the lift reads 0.11 ms long. At ±30°
  the swing piles beats at its two ends, the smeared unlock splits in two and the earlier half
  is taken. (The times at ±15° were measured before 19 November.) Witschi times each vibration
  on its own, so its readings should not be biased this way. Averaging is what lets the
  prototype find the co-axial's faint unlock at all.
- At 1° a second, its earlier default, the filter smoothed away most of a real swing:
  it kept 38% of the co-axial's ±15° and 57% of the lever's, 20 s late, where the blocks alone
  keep 95% and 90%. At 2° a second it keeps 68% and 90%, so 2° is now the default.
- The worst errors at 2° and 4° a second, about 18° on the co-axial, are blocks with no
  measurement, where the filter holds its last value while the swing goes on. Shown only while
  its own uncertainty is 5° or less, as an app would show it, the co-axial's ±15° swing at
  2° a second gave 26 of 36 readings, 4.6° rms and 10.4° at worst; at 4° a second, 22 of 36,
  4.2° and 9.0°. Lining up only what moves, 22 of 36 at 2.3° and 6.0°, and 19 at 1.8° and 3.6°.
- A swing faster than a block reads as its average.

`track.py steady` made 16 more steady watches of each kind, 180 s each, 192 scored blocks per
kind, read here by default. No block was left out by the gate and the restart never fired, at
any setting from 0.5° to 4° a second, any of the three ways: false restarts are below 1 in 55
measured co-axial blocks and 1 in 64 lever blocks, with 95% confidence, so fewer than about one
in 10 minutes. The co-axial's blocks scatter about as their resampling says: 9 of 167 lie beyond
twice their own scatter and 3 beyond three times, against about 8 and 0.5 expected. 25 of its
192 blocks gave no measurement. Its blocks were 2.0° rms, 7.2° at worst. A looser setting costs
little when nothing changes: the co-axial filter's error went from 1.6° rms, 5.3° at worst, at
1° a second to 1.8° and 6.5° at 2°, and 1.9° and 7.0° at 4°. The lever's blocks and filter stayed
at 0.8° rms. With the dash, the steady co-axial showed 153 of its 192 readings at 2° a second,
against 188 at 1°: about one in five is a dash, each at least a block long. Those shown were
1.8° rms and 6.5° at worst. Every lever reading was shown. Many short watches rather than a
few long ones, because making a simulated 600 s watch took over 15 minutes against 2 for 180 s.

## Lining the beats up again

From 18 November every reading lined each beat up again before averaging, until, the same day,
lining up only the sounds that move took its place as the default (next section). `analyze.py
--lined`, and `lined` on the other commands, still line every sound up. The 10 s blocks are
matched against the plain average to see how far the unlock and
the lock have moved. Each beat is shifted by that, read off a line through the blocks, once for
each sound, and averaged again, so that the sound that moves with the amplitude stands sharp.
Each sound's time is its place in its lined-up average plus the beats' mean shift. Each
resample repeats the whole procedure, blocks included, on the beats it draws. In the amplitude
filter the lined-up averages become the templates the blocks are matched against. A sound must
be placed in at least two blocks, so a 20 s recording falls back to the plain average.

Whole recordings of swinging watches, three of each, 180 s, as analyze.py reads them; amplitude
error against the true mean lift time of all the beats, and in brackets how many were shown:

| Watch | Plain average | Every sound lined up |
| --- | --- | --- |
| Lever, ±15° every 60 s | −4.2° to −3.9° (3) | −0.2° to +0.1° (3) |
| Lever, ±30° every 60 s | −20.0° to −19.1° (3) | −0.9° to −0.3° (3) |
| Lever, ±15° every 5 s | −3.9° to −2.7° (3) | −3.8° to −2.6° (3) |
| Co-axial, ±15° every 60 s | +0.3° to +1.6° (3) | −0.7° to +0.1° (3) |
| Co-axial, ±30° every 60 s | +9.6° to +11.6° (3) | −0.2° to +0.5° (3) |
| Co-axial, ±15° every 5 s | +0.9° to +1.9° (3) | +1.1° to +1.8° (3) |

With the plain average every biased reading in that table was shown: the gates do not see this
bias. Its beat error stayed within 0.08 ms of the truth. Lined up, every sound or only those that
move, the ±30° beat errors are within 0.06 ms; until 21 November one ±30° watch of each kind
showed one 0.13 and 0.14 ms off, from a block shift that had taken another sound (see "Block
shifts that took another sound"). Every sound lined up, one co-axial ±15° swing every 5 s read
0.11 ms off. The amplitude filter's blocks, against the truth averaged over each block, rms and
worst over 36 blocks:

| Watch | Plain average | Every sound lined up |
| --- | --- | --- |
| Lever, ±15° every 60 s | 5.4°, 8.0° | 0.7°, 1.7° |
| Lever, ±30° every 60 s | 30.0°, 41.4° | 1.8°, 4.0° |
| Co-axial, ±15° every 60 s | 4.5°, 9.4° | 6.1°, 29.3° |
| Co-axial, ±30° every 60 s | 13.5°, 26.1° | 7.5°, 33.0° |

The 5 s swings were about the same: 5.5° and 5.4° rms on the lever, 3.2° and 3.0° on the
co-axial. The co-axial's ±30° figure lined up rose from 5.5° when block shifts that took another
sound were left out (see "Block shifts that took another sound"): one block that gave no
measurement before now gives one, 33.0° off, as it does by default.

Any change of amplitude within a recording does the same. On `track.py sims`'s cases, two
watches each, the co-axial's whole recording read on the plain average +5.6° to +7.2° off on the
fall from 290° to 250° and +8.0° to +9.1° on the 30° step, all shown; lined up, −0.5° to +0.3°
and −1.3° to +0.2°. The lever's fall went from +1.9° to +2.7° off to +0.2° to +0.4°, and its
step, held back on the plain average, was shown lined up, within 0.3°. The filter's blocks were
about the same both ways in those cases, except the lever's ±10° swing: 1.3° rms plain, 0.9°
lined up.

Where nothing changes:

- `checks.py sims`, the 46 simulated watches: no wrong reading either way, and the readings
  moved little. But lined up, the co-axial's stated beat-error uncertainty rose from mostly
  0.03 to 0.07 ms to 0.06 to 0.10 ms, so beat error was shown in 31 of 46 instead of 32, and
  amplitude in 33 instead of 32; before block shifts that took another sound were left out, the
  uncertainty reached 0.13 ms and the counts were 22 and 30. The faint unlock gives each block a
  noisy shift, and lining the beats up on noise spreads them again. The lever's were unchanged.
- `checks.py suite`: the same verdicts on the unit tests' 36 watches, none shown wrongly. The
  Omega capture read 0.30 ms and 285° against 0.31 ms and 284°; the ETA's 0.15 ms and 263° both
  ways; the Voice Memos recordings and the no-watch capture gave nothing either way.
- `track.py steady`: no restart either way on 16 watches of each kind. The co-axial measured
  163 blocks lined up against 167; the lever's were the same.
- A whole-recording reading takes about four to five times as long lined up. With 50 resamples,
  on the computer these were run on, the Omega capture took 6 s plain and 29 s lined up, and a
  180 s lever 27 s and 142 s; resampling each block, which leaving out block shifts that took
  another sound needs, added 4 s and 28 s of that. By default they took 30 s and 52 s, as
  before.

So on the lever, lining up takes the bias away and costs nothing measured. On the co-axial it
takes away the bias of a large change in the whole reading, but adds scatter where nothing
changes, and at ±15° it misplaced the steady tick unlock in some of the filter's blocks.
Lawrence chose on 18 November to make it the default for both escapements, and later that day
to line up only the sounds that move.

## Lining up only the sounds that move

The default since 18 November (`events.moved`). Lining up helps only when a sound moves against
the timestamps; where nothing moves, the shifts it lines the beats up on are noise. So each sound
of each beat type is tested first. Each 10 s block's beats are resampled 40 times, which gives
each block shift its own scatter σᵢ, floored at 0.01 ms. If a sound does not move, its n shifts
sᵢ scatter about their weighted mean as their σᵢ say, and Σ((sᵢ − s̄)/σᵢ)² follows a χ²
distribution with n − 1 degrees of freedom. The sound is lined up only when the sum passes its 1%
point, 15.1 for the 6 blocks of 60 s and 32.0 for the 17 of 180 s; otherwise it keeps a shift of
zero and stays where the plain average puts it. When no sound moves, the reading is the plain
average's, resamples and all. The choice is made once, on all the beats, and each resample lines
up the same sounds. In the amplitude filter the test is made on the reference's blocks.

On the 46 simulated watches beat error was shown in 32 and amplitude in 32, as plain, none more
than 0.09 ms or 2° out. The test lined up sounds in 2, the two wandering by ±10° every 23 s.
Before 19 November it also lined up one steady watch's lock by mistake, without changing the
reading. On the 16 steady watches of each kind in `track.py steady` the filter's blocks read as
plain.

Whole recordings, 180 s, amplitude error against the truth, with the test:

| Watch | Plain | Lined up | Only what moves |
| --- | --- | --- | --- |
| Lever, ±15° every 60 s | −4.2° to −3.9° | −0.2° to +0.1° | −0.2° to +0.1° |
| Lever, ±30° every 60 s | −20.0° to −19.1° | −0.9° to −0.3° | −0.9° to −0.3° |
| Co-axial, ±15° every 60 s | +0.3° to +1.6° | −0.7° to +0.1° | −0.3° to +0.1° |
| Co-axial, ±30° every 60 s | +9.6° to +11.6° | −0.2° to +0.5° | −0.3° to +0.3° |
| Co-axial, falling from 290° to 250° | +5.6° to +7.2° | −0.5° to +0.3° | −0.8° to +0.4° |
| Co-axial, 30° step | +8.0° to +9.1° | −1.3° to +0.2° | −0.9° to +0.2° |

Each was shown as often as lined up, beat error too. The smallest change tried, ±10° every 60 s,
was found in all four watches read whole, the moving sounds summing 41 to 1,366 against a limit
of 30.6 to 32, and ±15° every 60 s in all six 60 s references, 15 to 948 against 13.3 to 15.1.
A swing faster than a block stays plain: at ±15° every 5 s, all 6 whole readings and 5 of 6
references lined nothing up, and such a swing reads as its average either way.

- The filter's co-axial blocks read best this way at ±15° every 60 s: 2.2° rms and 5.0° at worst,
  against 4.5° and 9.4° plain and 6.1° and 29.3° with every sound lined up, where the steady
  tick unlock was misplaced in some blocks. At ±30°, 7.4° rms with one block 32.9° off, against
  13.5° plain and 7.5° lined up, with the same block 33.0° off. The lever's filter reads as
  lined up. Before 19 November the
  simulated watch's offset hid most of the plain average's bias here and made it look the best.
- On the ETA capture's beats from 1 to 21 s nothing moves (largest sum 2.6 against 6.6), so the
  plain 0.165 ± 0.011 ms is shown, where lined up it was held back with 17% of resamples
  failing; so is a 30 s simulated co-axial (seed 51). A change found on just two blocks would
  still be lined up on them and could still be held back.
- `checks.py suite` gave the same verdicts all three ways on the unit tests' 36 watches. On the
  Omega capture the test lines up both locks (26.1 and 20.4 against 13.3 on 4): either the
  amplitude changed during the capture or the scatter is too small on real audio, and one capture
  cannot tell.
- The test took about 15 s on a 180 s recording that read in 19 s plain and 77 s lined up. Where
  a sound moves, lining it up costs as before.
- A small change the test misses keeps its bias while showing the plain average's tighter
  uncertainty, and the uncertainty leaves out the chance that the choice was wrong.
- Whether live readings jump when a sound flips between plain and lined up as the window moves
  has not been measured.

## Block shifts that took another sound

Since 21 November, lining up leaves out a block's shift for a sound when the shift scatters by
more than 0.3 ms over the block's 40 resamples, or when fewer than 32 of them placed the sound
(`RELINE_MAX_SD_MS`, `events.reliable`). That block's beats are still averaged, shifted along
the line through the other blocks; at either end the nearest kept block's shift holds. It applies
to whole readings and to the amplitude filter's reference, both ways of lining up. Which blocks
are left out is decided once, on all the beats, and every resample leaves out the same ones, as
it lines up the same sounds. Lining every sound up now resamples each block too, for the scatter.

Why. The shifts are joined block to block, not fitted, so one wrong shift sets the shift of every
beat in its block and half of each neighbour's, and the lined-up sound's place adds back the
beats' mean shift. Two whole readings on ±30° swings, one of each kind, showed beat errors 0.13
and 0.14 ms off by default, at a stated ±0.07 and ±0.09 ms, where the plain average read them
within 0.02 ms. Against the simulator's true unlocks (`bias/truth.mjs`), each had one block whose
shift had taken another sound: the co-axial's tock unlock gave −1.06 ms in its last block where
the unlock had moved −0.20 ms, and the lever's tick unlock +1.21 ms at 105 s where it had moved
−0.74 ms. Each moved its lined-up unlock by 0.13 to 0.16 ms. Their resamples scattered by 0.42
and 0.97 ms, against at most 0.37 ms for every other block lined up on in the two watches. A fit
would not have served: on the lever at ±30° neighbouring blocks are truly 0.7 ms apart.

Whole recordings, 180 s and 50 resamples, against the truth: ±30° every 60 s with seeds 91 to 97
(`track.py swings <dir> <kind> test 91 92 93 94 95 96 97`), ±15° every 60 s and every 5 s with
seeds 91 to 93, and `track.py sims`'s fall, step, wander and steady watch with seeds 91 and 92, so
21 of each kind; by default:

| | Beat errors shown, of 42 | More than 0.1 ms off | Worst shown | Amplitude at ±30° |
| --- | --- | --- | --- | --- |
| Before | 40 | 2, 0.133 and 0.140 ms | 0.140 ms | −2.1° to +2.0° |
| Leaving out shifts that scatter by more than 0.3 ms | 42 | 0 | 0.083 ms | −0.9° to +1.0° |

It left out 36 of about 1,600 shifts of sounds that were lined up, at most 6 in a watch, and none
on the steady watches or the lever's ±15° swings. The lever's ±30° readings scatter by 0.025 ms
(median) against 0.090 before, so the two held back before are shown, 0.035 and 0.051 ms off.
Errors come to 0.86 and 0.90 times their stated scatter (rms) on the co-axial and the lever. Both
Safari captures read as before to the last digit, whole and in every 30, 20, 15 and 10 s window,
as do the two wandering watches of the 46 simulated ones, which are the only ones the default
lines up, the six readings of `checks.py kalman-sims` that it lines up, and every watch in which
nothing moves. It costs nothing by default, since the test already resamples every block.

Tried as well, on the same watches:

- At 0.2 ms both bad readings are mended too; at 0.5 ms the co-axial is not.
- A count after "Resamples that find another sound": leave a shift out when more than a share of
  its resamples miss the sound or put it over 0.5 ms from the block's shift. At 20%, as blocks
  must already be placed in four of five resamples, 41 of 42 were shown: a lever block 0.65 ms off
  with only 10% of its resamples off stayed in. At 5%, 41 of 42, and it left out 76 shifts, which
  put amplitudes at ±30° up to 2.9° off. A few far-off resamples raise the scatter sharply, which
  is why the scatter catches what a count does not.
- Beat error from the plain average, with amplitude as now: no reading over 0.1 ms off, but the
  lever lost the precision lining up gives it, 0.028 ms of scatter at ±15° against 0.010.
- A gate of 0.05 ms on the scatter, so that twice it stays within 0.1 ms: 29 of the 42 shown, and
  3 of the 14 at ±30°.

Its limits:

- The margin is narrow: the co-axial's bad block scattered by 0.42 ms and good blocks reached
  0.37 ms.
- The choice of blocks is made once, so the stated uncertainty leaves out the chance that it was
  wrong.
- The co-axial's faint tock unlock follows its true movement only loosely: two of its blocks were
  0.3 and 0.5 ms off while their resamples scattered by 0.07 and 0.08 ms, and no rule on the
  scatter sees that. On these watches it cost no shown reading.
- On the lever at ±30° the errors come to 1.23 times the stated scatter (rms), so it is a little
  small there, and lined up either way the seven readings lean 0.025 ms low on average.
- With every sound lined up, one co-axial ±15° swing every 5 s still read 0.11 ms off (0.10 ms
  before): a swing faster than a block moves nothing from block to block, so lining up there is
  on noise. The default leaves it plain.

## Resamples that find another sound

Since 18 November a resample that places the unlock or the lock of either beat more than 0.5 ms
from where all the beats put it counts as failing (`OTHER_SOUND_MS`), as one that finds nothing
believable does, and the scatter comes from the rest. Before, its reading counted as scatter,
and one such resample in a hundred could hold back a reading every other sign supported.

Measured on 18 November, before the simulated watch was corrected: every resample was kept for
108 readings, with 100 resamples each: the 46 simulated watches,
the 33 of the unit tests' watches that give a reading, the 16 simulated co-axials of
`checks.py kalman-sims` read on the real-time timestamps, and the two Safari captures whole and
in 30, 20, 15 and 10 s windows as `checks.py vary` cuts them. 36 were held back: 16 by failing
resamples alone, 10 by failing resamples and scatter, and 10 by scatter alone, six of those the
irregular watches. 39 of the 10,800 resamples, in 12 readings, had taken another sound: mostly
one beat's unlock, and often its lock, at an earlier sound 2 to 7 ms away, with a time from
unlock to lock still believable; on the Omega's short windows, some the tick's unlock 0.5 to
0.8 ms late. One or two of them raised the beat error's scatter from 0.02 to 0.07 ms without
them to between 0.27 and 0.74 ms.

With the rule, three readings held back before are shown: simulated co-axials of 30 s and 60 s,
0.025 and 0.010 ms off the truth, and the ETA capture from 11 to 21 s at 0.15 ms, which has no
truth but agrees with the whole capture and with its earlier 10 to 20 s reading of 0.16 ms.
`checks.py sims` and `suite` gave the same verdicts as before on every watch and recording; only
the 20 s co-axial that one stray had given a scatter of 0.96 ms now reads ±0.04, still held by
its 40% failing. The irregular watches stay held: none of their resamples found another sound.

- It trusts the sounds all the beats found while at least 95% of the resamples agree. If all the
  beats took the wrong sound and up to 5% of the resamples found the right one, the reading would
  now be shown. None of the 108 did that.
- The resamples that found another sound are left out of the scatter, which therefore says
  nothing of the chance of taking another sound, as for the resamples that fail.
- The 0.5 ms was chosen, not measured; 0.3 ms gave the same verdicts. Some of the Omega's
  short-window resamples placed the tick's unlock 0.5 to 0.8 ms late, which may be the same faint
  sound starting late rather than another sound.
- The failing share holds back far more. A limit of 20% instead of 5% would show five more of the
  108, the four with a truth within 0.05 ms, but readings 36% and 39% failing were 0.17 and
  0.11 ms off, so it stays at 5%.
- Until 18 November the failing share was worked out as 1 minus the share kept, and 5 failing
  resamples of 100 came to 0.05000000000000004, just over the limit, so a reading exactly at it
  was held back. It is now counted. Of the 108, that shows only the Omega capture's first 30 s,
  at 0.29 ± 0.04 ms and 284 ± 1°, against 0.31 ms and 284° for the whole capture.

## A lever whose impulse is its loudest sound

Since 21 November, when the loudest pair of later sounds comes too soon after the first sound to
be the lock, the pairing takes the loudest pair whose time is believable instead, but only when
both its sounds are louder than their beat's first sound (`events.pair_beats`).

Why. The lock is chosen as the loudest pair of later sounds at matching times in the two beats,
and a time from the first sound outside the believable range (an amplitude of 150° to 330° at
the lift angle) refused the reading. A lever whose impulse is louder than its drop in both beats
paired its impulses, 2.4 ms after the unlock, and gave nothing, though its drops were believable
and the app's Swiss-lever beat error read it right. That is not far from a real lever: the ETA's
impulse stands only 6.2 dB below its drop in one beat.

The guard. When the unlock is lost, the first sound found is the impulse, and the drop comes too
soon after it. A quieter sound after the drop can then be believable: taken as the lock, on
simulated levers with the unlock at −10 dB and a sound 4 ms after the drop, it read amplitudes
48° low, and showed them. A lock is louder than an unlock, by 12 to 18 dB in both Safari
captures, so a quieter pair is taken only when both its sounds are louder than their beat's first
sound. Such a lever still gives nothing.

Simulated levers, 60 s, true beat error 0.50 ms, impulse as loud as the drop (25 dB) or up to
9 dB louder, at 28,800, 21,600 and 18,000 vph, 220° to 310°, the impulse 2.4 or 3.4 ms after
the unlock, three seeds each, read by default with 100 resamples:

| | Shown, of 30 | Worst beat error | Worst amplitude |
| --- | --- | --- | --- |
| Before | 1 | 0.009 ms | 0.0° |
| Now | 30 | 0.027 ms | 0.7° |

The app's Swiss-lever beat error read all 30 within 0.010 ms. `checks.py pairing` runs eight of
these watches, four whose unlock is lost and one whose impulse cannot be heard: every lever with
a loud impulse is shown within 0.02 ms and 0.5°, and the other five give nothing (see "A lever
whose unlock is lost").

Nothing else moved. The six recordings read as before to the last digit, as do the 36 watches
of `checks.py suite`; its blurred three sounds still gives nothing, since its first sound is
louder than its last. Of the 46 watches of `checks.py sims`, 45 read as before to the last
digit; a 20 s co-axial, held back either way, took one more resample (35% failing instead of
36%), and its stated scatter rose from 0.07 to 0.09 ms. It costs one comparison.

Its limits:

- Only simulated levers. No recording of a lever whose impulse is louder than its drop exists
  here.
- The guard rests on the unlock being quieter than the drop. A watch whose first sound is not,
  as the blurred three sounds, gives nothing; nothing in such a beat says which sound is the
  unlock.
- A lost unlock whose first sound found is quieter than a later sound inside the believable
  times would still be taken; not tried.

## A lever whose unlock is lost

Since 22 November a pairing is refused when nothing lies between the first sound and the lock in
a beat (`events.pair_beats`).

Why. When the unlock is too faint to find, the first sound found is the impulse, and the lift
is timed from it: short by the impulse's delay, so the amplitude reads high. Where that still
reads under 330°, it was shown. Of 11 simulated levers (60 s, true beat error about 0.5 ms)
with the unlock at −10 dB, 6 were shown 44° to 109° high: 200° and 220° at 28,800 vph read
263° and 299°, 220° at 21,600 read 274°, 220° and 260° at 18,000 read 264° and 323°, and 220°
at 36,000 read 329°. The other 5 read over 330° and were refused. Their beat errors were right
within 0.01 ms. A co-axial with its unlock lost read 0.93 ms off at 220° and was held back. Noise
added to the ETA's Safari capture loses its unlock the same way, at 18 and 21 dB over its
background above 5 kHz; at the ETA's 263° the impulse is 5.0 ms before the drop, which reads
over 330°.

What gives it away. Both escapements make a sound between the unlock and the lock in each beat:
the lever its impulse, the co-axial its impulse in one beat and a sound 4.2 ms after the unlock
in the other. That sound is louder than the unlock, by 7 to 8 dB in the ETA, so when the unlock
is heard it is heard too. In every right reading of 376 watches surveyed (the simulated ones of
these checks, of the amplitude filter's runs and of the investigation, and the recordings) such
a sound lay there in both beats, except in one of the suite's: the made-up watch whose tock
changes its loudest sound has only two sounds in its tock. With the unlock lost, none did.

Read by default with 100 resamples, the rule refused all ten lost-unlock readings that were
shown or held (the six levers above, three more at 220° and the co-axial). Of the other 156
watches so read, it acted on only three, and in no resample of any. The six recordings, the 46
watches of `checks.py sims` and the suite's other 35 read as before to the last digit. The
three are its cost: two levers whose impulse cannot be heard (−10 dB) give nothing where they
read right, and so does the suite's two-sound tock, which read 0.05 ms against 0. A lever whose
impulse stood 6 dB under its unlock was still found and read right. It costs one search of a
beat's few sounds.

Its limits:

- The lost unlock was made by setting it to −10 dB in the simulated lever, and on real audio by
  adding white noise to a capture.
- A lever with a further sound between its impulse and its drop in both beats would still be
  timed from its impulse with its unlock lost. The ETA has one, 5.1 ms after its unlock, in its
  tock only. Not tried.
- A lever whose impulse cannot be heard gives nothing. None has been seen; in both captures the
  impulse is louder than the unlock.

## Through the app's unit tests

`npm test` runs only the JavaScript pipeline, so it cannot test the prototype. `suite.mjs`
builds the 36 simulated watches that the test files make as whole recordings, with the same
settings and seeds, and writes each one out with its truth and the app's timestamps in co-axial
mode. `checks.py suite` runs it, then the prototype on them and on the six recordings in
`tests/fixtures`. Left out are the five watches that `tests/interface.test.js` makes as live
streams, and the Voice Memos ETA recording that `tests/irregular.test.js` re-times.

Since 18 November `suite.mjs` makes them louder and 60 s long, as decided that day, because as
the tests make them they are too quiet for the prototype in their 20 to 75 s (see "Why the unit
tests' watches give no reading" below). Each gain is raised, never lowered, until the first
sound of the quieter beat is as loud as in the default watch at gain 3.6. The quieter beat's
unlock then stands 3.4 to 4.9 dB over the background, 3.9 in the middle, against 3.8 dB in the
Omega's Safari capture. The app's own tests keep their quiet watches, which test the timing of
faint watches. `--as-tested` builds them as the tests do.

These watches come from the app's own simulator, `js/audio/simulator.js`, which places each
beat's sounds at fixed times. Every tock sound moves by the set offset, so that offset is the
true beat error. No balance is behind them, so the time from the first sound to the last loud
one, 7 ms for the default sounds, is checked instead of an amplitude. The lift angle is chosen
per beat rate to make that time read 280°, so that the gate on believable amplitudes passes.

Louder and 60 s long, by default; the plain average gave the same verdicts, as did adding the
bands by noise before 22 November:

| Outcome on the 36 watches | Watches |
| --- | --- |
| shown and wrong | 2: the 36,000 vph watches told 18,000 vph read 0.01 and 0.03 ms against 0.50 |
| shown and right | 22, none more than 0.05 ms off, stated to ±0.01 to ±0.07 ms |
| refused, rightly | 1: the two-sound co-axial, whose beats share no first sound |
| held back, would have been wrong | 6: 3 basket cases and 1, 2 and 5 ms jitter, by their scatter |
| nothing | 5: the two 18,000 vph watches told 36,000, which the app could not time; the blurred three sounds, whose loudest later sound comes 2.0 ms after its first and whose last is quieter than its first; the two-sound watch whose tock changes its loudest sound, with nothing between its tock's first sound and its lock, which read 0.05 ms against 0 until 22 November; and no watch |

The two wrong readings come from the beat rate the test gives. Told 18,000 vph, the app takes
every other beat of a 36,000 vph watch, so its ticks and its tocks are both the watch's ticks:
the gap between them is not the beat error, and the true tocks are never timed. The app's own
Swiss-lever reading had the same fault until 18 November (see Limits). A beat halfway between
the app's beats gives it away, and the app now looks for one.

As the tests make them (`--as-tested`), by default:

| Outcome on the 36 watches | Watches |
| --- | --- |
| shown and wrong by more than 0.1 ms | 0 |
| shown and right | 0; the two-sound watch whose tock changes its loudest sound read 0.01 ms against 0 until 22 November, and now gives nothing, with nothing between its tock's first sound and its lock |
| refused, rightly | 1: the two-sound co-axial, whose beats share no first sound |
| held back, would have been right | 4, off by 0.02 to 0.08 ms |
| held back, would have been wrong | 1: 5 ms jitter |
| nothing to measure | 30 |

Added by noise, before 22 November, 7 were held back that would have been right and 6 that would
have been wrong, and 22 gave nothing: adding by energy finds a faint unlock less often.

The two Safari captures read as above. The three Voice Memos recordings and the capture with no
watch give nothing.

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

### Why the unit tests' watches give no reading

They are too quiet for their length, not beyond the method. The simulator's unlock is a quarter
as loud as the drop. Measured at the unlock's own place in the average, in the band where it
stands highest, so that noise cannot lift the figure as a maximum would, the weaker beat's
unlock of the 28 watches with the simulator's usual sounds stands 0.3 to 1.9 dB over the
background, 1.2 dB in the middle:

| Unlock of the weaker beat | Over the background | Over the noise of the average |
| --- | --- | --- |
| The unit tests' watches, 20 to 75 s | 0.3 to 1.9 dB | at most 10.2 dB, 6.3 in the middle |
| `balance.js` co-axial set to 2 dB, 60 s: nothing shown | 1.7 dB | 9.3 dB |
| `balance.js` co-axial at its default 5 dB, 60 s | 3.1 dB | 11.5 dB |
| Omega 3861 Safari capture, 60 s | 3.8 dB | 12.5 dB |
| ETA 2836-2 Safari capture, 30 s | 11.8 dB | 23.2 dB |

`balance.js` sets a sound's level within its own band; the app's bands and smoothing read it
lower. Readings came when the weaker unlock stood about 10 to 12 dB over the noise of the
average, which grows by 5 dB for every tenfold more beats. So showing nothing for these watches
is right: in 20 to 75 s their beats cannot place the unlock to 0.1 ms. With more beats they
read. Watches with the simulator's usual sounds at the loudness most tests use (gain 1.6, true
beat error 0.40 ms), two of each length:

| Length | Lined up | Plain average |
| --- | --- | --- |
| 60 s | held (0.53 ± 0.17 ms); nothing | held (0.39 ± 0.04 ms); nothing |
| 120 s | 0.28 ± 0.08 ms shown; held | 0.34 ± 0.04 ms shown; held |
| 240 s | 0.33 ± 0.08 and 0.34 ± 0.07 ms shown | 0.39 ± 0.03 and 0.33 ± 0.03 ms shown |

At gain 1.0, 240 s gave one reading of two, 0.40 ± 0.09 ms lined up. Eight more watches of
120 s at gain 1.6, read without resampling, show no bias: the beat error came out 0.01 ms low
on average lined up, scattering by 0.07 ms, and 0.00 plain, scattering by 0.05, close to the
±0.08 and ±0.04 the resampling states. But with the gate at 0.1 ms of scatter, a reading shown
at that edge can be more than 0.1 ms off, as the 0.28 ms one is. Lining up widened the scatter
by half again where nothing changes. The time from unlock to drop read 0.05 to 0.08 ms long on
the app's timestamps and 0.02 to 0.04 ms long on the true beat times, so the amplitudes read 2°
to 5° low: the quieter beat's timestamps jitter more, and the jitter smears its unlock early. A
240 s reading took 4 to 6 minutes lined up, in Python on a computer, and about 1 minute plain.

Tried and not kept, on 18 November, before the simulated watch was corrected: a resample carries
the recording's noise twice over, about 1.5 dB more than the whole set, so a sound the whole set
finds 7 to 8 dB over the noise of the average is lost in about half the resamples. Holding each
resample to the whole set's threshold, and timing the sounds where the whole set found them, cut
the failing resamples (`lever 28800` from 79% to 5%) and showed more of the 46 simulated
watches: beat error in 23 instead of 19 lined up and 39 instead of 33 plain, amplitude in 37
instead of 30 and 40 instead of 33. But it showed a 20 s co-axial 0.11 ms off at ±0.04 and,
plain, the run with a 2 s gap 0.11 ms off at ±0.06. Once the sound is pinned, a noise bump on
its edge in the whole average moves every resample alike, so the stated scatter can be too
small; the fresh search in each resample is what held these back.

## Audio at 44.1 kHz

Since 22 November, a band that reaches above 0.47 times the sample rate, the limit of the app's
filter bank, is cut to fit rather than dropped (`events.fitted_bands`). At 48 kHz every band fits
and nothing changes. At 44.1 kHz the band from 18 kHz is kept as 18 to 20.7 kHz. Milestone 8's
filter bank is to do the same, as decided on 22 November; today the app drops that band at
44.1 kHz.

Why. An iPhone may deliver 44.1 kHz with another microphone, and the Omega's unlock stands mostly
above 18 kHz. With that band dropped, the Omega gave nothing.

No capture made at 44.1 kHz exists, so `checks.py rates` converts the Safari captures through
the Fourier transform, which keeps everything below 22.05 kHz, has the app time them again, and
reads them by default with 100 resamples:

| | 48 kHz | 44.1 kHz, band cut to fit | 44.1 kHz, band dropped |
| --- | --- | --- | --- |
| Omega 3861, 36° | 0.307 ± 0.028 ms, 284.1° | 0.302 ± 0.033 ms, 285.3° | nothing |
| ETA 2836-2, 50° | 0.152 ± 0.013 ms, 263.4° | 0.141 ± 0.012 ms, 263.2° | 0.137 ± 0.011 ms, 262.7° |
| No watch | nothing | nothing | nothing |

Every reading in the table is shown; the bands were added by noise, as before 22 November (by
energy, see "Adding the bands by energy"). With a low-pass at 20 kHz as well, where many converters at
44.1 kHz stop, the Omega read 0.283 ± 0.026 ms and 286.3°. The ETA's move comes with the band: at
48 kHz with the whole band left out it reads 0.137 ms.

The 46 watches of `checks.py sims`, made at 48 kHz, converted and read with their 48 kHz
timestamps: the same 32 beat errors are shown as at 48 kHz, none more than 0.098 ms off, the
amplitude within 2.9°; with the band dropped, 23 were shown. Made at 44.1 kHz, which draws other
random sounds from the same seeds, 24 are shown (14 with the band dropped). Two of those are
0.102 and 0.116 ms off; read at 48 kHz, the same two watches are 0.107 and 0.121 ms off, so it
is the watches drawn, not the rate.

Nothing else moved. At 48 kHz the band envelopes are the same to the last sample, so the six
recordings read as before to the last digit, as do the simulated watches of every check.

Its limits:

- Only converted captures. A microphone that runs at 44.1 kHz may filter its top differently.
- The app's timestamps here come from its filter bank as it is today, without the band. Timed
  with the band as well, the Omega read 0.322 ± 0.027 ms, and 0.304 ± 0.026 ms with the 20 kHz
  low-pass.
- Fresh simulated watches can be shown a little more than 0.1 ms off, at 48 kHz as at 44.1 kHz
  (see Limits). Those the simulator makes at 44.1 kHz err more, 1.3 to 1.4 times their stated
  scatter (rms), whichever rate they are read at; why is not known.

## Adding the bands by energy

Since 22 November the bands are added by their own energy (`events.WEIGHTING`, "energy"): each
band's envelope, which is scaled to its own noise, is weighted by that noise, so that the averaged
beat is the sounds' excess energy summed from 5 to 22.5 kHz, as a fixed filter would hear it.
Before, each band counted by how far the beats stood over its noise ("noise", still there as
`measure(..., weighting="noise")`), the most precise mixture but one that the noise chooses.

Why. A real watch's sounds do not start at the same moment in every band. Read band by band, the
ETA's top band, 18 to 22.5 kHz, starts its tick's unlock 0.14 ms after the middle bands and its
tock's 0.33 ms after; every sound of the ETA, the loud drop as well, starts earlier in the low
bands. A phone, a browser or a room delays both beats alike, so the difference between the tick
and the tock is in the watch. When noise with another spectrum than the capture's background was
added, the weights by noise shifted and the ETA's beat error moved by up to 0.18 ms, shown.

`checks.py noise` reads the two Safari captures, and a simulated lever built to sound like the
ETA (below), in quiet and altered, one draw of each, with the app's timestamps on the quiet audio
(timing the altered audio again moved no reading by more than 0.01 ms). Levels are against the
audio's own background above 5 kHz; pink noise falls 3 dB per octave, as most room noise does
above 5 kHz; the room is the no-watch Safari capture; the echo is a 0.4 s room response.

| ETA 2836-2, 50° | By energy | By noise, as before |
| --- | --- | --- |
| Quiet | 0.302 ± 0.022 ms, 266.8° | 0.152 ± 0.013 ms, 263.4° |
| Pink noise, 0 dB | 0.322 ± 0.027 ms, 266.8° | 0.270 ± 0.024 ms, 266.2° |
| Pink noise, +5 dB | 0.296 ± 0.036 ms, 266.7° | 0.297 ± 0.033 ms, 267.0° |
| White noise, +5 dB | 0.330 ± 0.034 ms, 267.3° | 0.246 ± 0.040 ms, 265.3° |
| Room, +5 dB | 0.328 ± 0.045 ms, 266.4° | 0.166 ± 0.014 ms, 263.7° |
| Echo, −5 dB | 0.308 ± 0.022 ms, 266.9° | 0.148 ± 0.012 ms, 263.7° |

| Omega 3861, 36° | By energy | By noise, as before |
| --- | --- | --- |
| Quiet | 0.347 ± 0.024 ms, 286.8° | 0.307 ± 0.028 ms, 284.1° |
| Pink noise, 0 dB | held back (0.385 ± 0.090 ms) | 0.262 ± 0.049 ms, 284.7° |
| Pink noise, +5 dB | nothing | held back |
| White noise, +5 dB | nothing | held back |
| Room, +5 dB | nothing | held back |
| Echo, −5 dB | 0.317 ± 0.034 ms, 286.9° | 0.270 ± 0.036 ms, 284.1° |

Every reading not marked was shown. By energy the ETA stays within 0.03 ms of its quiet reading,
about one stated scatter, under every change; by noise it moved by up to 0.15 ms here. The Omega
is read almost from its top band either way; by energy that band counts for about a fifth, so
noise elsewhere buries its faint unlock sooner and it gives nothing where by noise it was held
back. Neither way shows a wrong number for it.

The simulated lever is `ETA_LIKE` in `checks.py`: each sound made of one part per band through the
simulator's `arrival`, at the level and the delay the ETA's averaged beats show in that band, with
the tock's further sound 5.1 ms after its unlock and the no-watch capture as its background. Its
14.5 to 18 kHz parts start 0.35 ms after their events in both beats, so its truth is what that
band would read: 0.182 ms and 263°. Band by band it arrives like the ETA.

| ETA-like simulated lever | By energy | By noise, as before |
| --- | --- | --- |
| Quiet | 0.430 ± 0.027 ms, 270.0° | 0.211 ± 0.022 ms, 265.1° |
| Pink noise, 0 dB | 0.432 ± 0.033 ms, 269.9° | 0.405 ± 0.017 ms, 269.6° |
| Pink noise, +5 dB | 0.436 ± 0.038 ms, 270.4° | 0.427 ± 0.019 ms, 270.8° |
| White noise, +5 dB | 0.439 ± 0.038 ms, 270.2° | 0.397 ± 0.070 ms, 268.7° |
| Room, +5 dB | 0.431 ± 0.058 ms, 269.1° | 0.222 ± 0.024 ms, 265.6° |
| Echo, −5 dB | 0.425 ± 0.028 ms, 270.0° | 0.240 ± 0.027 ms, 265.6° |

The simulator reproduces the shift, and by energy the reading holds still in it. Holding still is
not being right: against this model's truth it reads 0.25 ms and 7° high, an offset set by the
watch's own delays and loudness in each band, which a real watch does not tell.

Elsewhere:

- The 46 simulated watches of `checks.py sims`, whose sounds start at once in every band: 33
  beat errors shown, one 0.11 ms off (in beat, at ±0.04 ms), the rest within 0.09 ms, and the
  amplitude within 2°, against 32 within 0.09 ms by noise.
- The unit tests' watches, made louder: the same verdicts, 22 shown and right within 0.05 ms. As
  the tests make them: 4 held back that would have been right and 1 that would have been wrong,
  against 7 and 6 by noise; 30 give nothing against 22.
- `checks.py pairing`: the same verdicts on every lever, the shown ones within 0.02 ms.
- At 44.1 kHz (`checks.py rates`): the Omega 0.327 ± 0.027 ms and 287.6° with the band cut to
  fit, the ETA 0.268 ± 0.024 ms and 266.4°; with the band dropped the Omega gives nothing and
  the ETA reads 0.165 ms.
- The amplitude filter on the Omega's capture (`track.py recording`) reads blocks of 284° to 291°
  against 280° to 289° by noise, at ±2° to ±5° against ±1° to ±2°.
- The stated scatter is wider: the ETA ±0.022 ms against ±0.013, the Omega ±0.024 ms against
  ±0.028.

## Limits

- That the first sound is the unlock in both beats is a reading of the patents' sequence of
  events, not something the audio proves. Only an instrument with a co-axial mode can check
  it, such as a Witschi set to its test mode Spe1. The ChronoCube's manual shows no such
  setting.
- The 3861's 36° lift angle comes from a forum post. Each degree moves the amplitude by 7.9°.
- The two beats take 8% different times from unlock to lock. The prototype uses their mean.
  Witschi's scope view shows an amplitude for each beat; averaged that way the Omega reads
  284.6°, against the prototype's 284.2°. Read from one beat alone it would be 273° or 296°. No
  description was found of what Spe1 does.
- The 3861's unlock stands only 3.5 to 5.5 dB over the background, mostly above 18 kHz. It took
  30 to 60 s of beats to find reliably, and the Voice Memos recordings do not show it. At
  44.1 kHz it is found only because the band from 18 kHz is cut to fit (see "Audio at 44.1 kHz").
  Added by energy, the top band counts for about a fifth, so noise in the other bands buries it
  sooner: with pink noise at the capture's own background above 5 kHz it was held back, and with
  more it gave nothing (see "Adding the bands by energy").
- A real watch's beat error from the unlocks depends on which frequencies are heard, since its
  sounds start at different moments in different bands. Added by energy, the reading does not
  move with the room's noise, but whether it agrees with a timing machine is not known: no maker
  publishes the band its pickup hears.
- The ETA's beat error from the unlocks was not steady across its 30 s capture when the bands
  were added by noise, and why is not yet known. Its 10 s stretches read 0.21, 0.16 and 0.10 ms
  (the first 12 s for the first), each ± 0.02, while the gap between the app's timestamps held at
  0.41 to 0.42 ms. By energy they read 0.36 ± 0.03, 0.31 ± 0.04 and 0.30 ± 0.08 ms, within their
  scatter of each other but wider. A longer capture would tell. Its unlock itself is found from
  4 s of beats on. With every sound lined up, the first 20 s were held back, with 18% of
  resamples failing to find the sounds, where the plain average read 0.16 ± 0.01 ms; lining up
  only what moves keeps them plain.
- The averaging assumes the amplitude holds still over the beats averaged. On simulated watches
  a ±15° swing moved the lever's plain reading about 4° low and a ±30° swing about 20° low; the
  co-axial's read high, by up to 12° at ±30°. See "Larger swings, and false restarts". Lining up
  the sounds that move, the default now, takes it away on the lever, and on the co-axial for
  changes slower than a block, without the precision lining every sound up costs a steady
  co-axial; see "Lining up only the sounds that move".
- The gate shows a beat error whose scatter under resampling is 0.1 ms or less, which does not
  keep its error under 0.1 ms: a reading shown at ±0.09 ms can be about 0.18 ms off at twice its
  scatter. On the 46 simulated watches the default's errors came to 1.0 times its stated scatter
  (rms). The two readings shown 0.13 and 0.14 ms off on ±30° swings came from block shifts that
  had taken another sound, now left out (see "Block shifts that took another sound"). Over five
  draws of the 46 watches at 48 kHz, every seed raised by 0, 100, 200, 300 and 400, 3 of the 135
  co-axial beat errors shown were more than 0.1 ms off, by 0.101 to 0.118 ms, at a stated
  ±0.034 to ±0.098 ms. Their errors came to 1.06 times their stated scatter (rms), none beyond
  three times; the 20 levers shown were within 0.017 ms. The co-axial's errors lean 0.016 ms one
  way, which the stated scatter does not include: the simulated co-axial's two unlocks differ in
  shape, and the half-rise the method times lags them 0.046 and 0.062 ms behind their true start.
  The lever's two unlocks are alike and lag alike. Whether a real co-axial leans so, only a
  reference instrument could tell.
- Most readings that are held back are held by failing resamples: 26 of 36 of the 108 readings
  in "Resamples that find another sound", at 8% to 93% failing against the 5% limit. A resample
  carries the noise twice over, so it loses a faint sound that all the beats together find.
  Resamples that took another sound, which made the scatter gate touchy, now count as failing.
- A watch with a faint unlock needs minutes, not seconds. The unit tests' watches, whose weaker
  unlock stands 0.3 to 1.9 dB over the background, gave a reading for 1 of the 35 that tick in
  20 to 75 s; watches like them read after 2 to 4 minutes (see "Why the unit tests' watches give
  no reading"). At that edge a shown beat error can be more than 0.1 ms off. Milestone 8 keeps
  60 s of beats, as decided on 18 November, so such a watch shows a dash. Nothing is shown for an
  irregular watch, whose uncertainty came to 0.25 to 0.89 ms.
- A beat rate given at half the watch's own pairs the watch's ticks with its ticks. On the
  36,000 vph watches told 18,000 vph the prototype showed 0.01 and 0.03 ms against a true
  0.50 ms. The app's live pipeline did the same in Swiss-lever mode until 18 November: on those
  watches run for 60 s it showed a beat error of about 0.01 ms or less in 20 to 32 of its
  readings, at the tests' gain of 1.4 and louder. Its test ran 40 s, too short for the watch to
  give a reading. The app now shows no beat error when it finds a beat halfway between its
  beats, and a port needs the same check.
- A lever whose unlock is too faint to find is refused, since nothing lies between its first
  sound, the impulse, and its lock (see "A lever whose unlock is lost"). So is a lever whose
  impulse cannot be heard. One with a further sound between its impulse and its drop in both
  beats would still be timed from its impulse, its amplitude high.
- One watch and one capture. The averaging itself runs on a whole recording, in Python, even
  when the beat times come from the real-time pipeline.
