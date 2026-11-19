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

Witschi's two documents used here are its training document, "Testing methods for mechanical
watches" (2025), and the ChronoCube operating instructions (version 2.0, 2020). Both say the
first sound of a lever beat, the unlock, is timed for the rate and the beat error, and the time
from its start to the start of the last, loudest sound for the amplitude. No other maker's
description was found.

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
python3 -I tools/prototype/coaxial/track.py sims /tmp/track-lever lever  # about half an hour
python3 -I tools/prototype/coaxial/checks.py suite /tmp/suite          # about 40 minutes
python3 -I tools/prototype/coaxial/track.py swings /tmp/swings both     # about an hour
python3 -I tools/prototype/coaxial/track.py steady /tmp/steady both     # about half an hour
```

`beats.mjs wav` runs the app's whole-recording analysis for the timestamps, and `beats.mjs
stream` its real-time pipeline. The last argument of `analyze.py` is the lift angle. `--app`
works on envelopes made the way the app's filter bank makes them. Every reading lines up again,
before averaging, the sounds whose 10 s blocks show them moving (see "Lining up only the sounds
that move"). `analyze.py --lined`, and `lined` on the other commands, line every sound up;
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

`where.py` then finds the unlock 0.53 ms before its true mean and the amplitude 20.5° low.
`realign.py` reads the reference at 261.9° plain and 283.4° lined up again, against a true
282.4°, and the 11 blocks after it 30.5° and 2.1° rms off.

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

These line up only the sounds that move, the default since 18 November: on the Omega the two
locks, on the ETA nothing. The plain average read both the same; with every sound lined up the
Omega read 0.30 ± 0.03 ms and 285°. Most of the figures below that are not about lining up came
from the plain average. The ± is the scatter under resampling only. Across the analysis choices
the Omega's beat error runs from 0.26 to 0.38 ms (plain average). The ETA's last sounds are
0.31 ms apart, which is the app's own Swiss-lever reading: the app's timestamps sit at the
loudest part of each beat, which in a lever watch is the drop, while Witschi's instruments time
the unlock.

On simulated co-axial watches (60 s, 21,600 vph, unlock 5 dB over the background) with a true
beat error of 0, 0.5, 1 and 2 ms, sixteen runs all read within 0.10 ms, and amplitudes of 200° to
310° read 1° to 5° low. With the unlock 2 dB over the background or less, or with only 20 s of
audio, nothing was shown. Of all 46 simulated runs, 33 were shown and none of those was more than
0.10 ms or 5° out, and lining up only the sounds that move, the default, gave the same. With
every sound lined up the same 46 showed beat error in 19 and amplitude in 30, none more than
0.09 ms or 6° out: the co-axial's faint unlock gives noisy shifts to line the beats up on, which
widens the stated uncertainty (see "Lining the beats up again").

The low amplitudes come from the simulated watch, not from the method. About 2° is a delay
`balance.js` adds to every lock, 0.05 ms on average, which its true amplitude does not count.
About 1° is that its two beats have a mean lift angle of 36.1° while the prototype is told 36°.
How a real watch reads depends on how its published lift angle was arrived at. Witschi's
training document names the same kind of delay in real watches, lost motion, and its formula
takes the time as measured.

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
level by between -0.1 and +0.4 dB, and the readings were shown about as often: 6 of 16 on the
real-time timestamps, 6 and 7 on the tracker's expected and settled times. No reading, shown or
held, was more than 0.08 ms from the truth.

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
21,600 vph and a 36° lift angle, the lever at 28,800 vph and 50°. Errors against the true
amplitude, in degrees, over the 12 blocks after the reference in each of the two runs, counting
only blocks that gave a measurement: root mean square, then the worst. The co-axial's include
the 3° or so by which that simulated watch reads low, which comes from the simulation, not from
the method (see "What it measured").

| Co-axial | Blocks measured | Blocks alone | Filter, 0.5° a second | Filter, 1° | Filter, 2° |
| --- | --- | --- | --- | --- | --- |
| steady at 285° | 21 of 24 | 3.8, 8.7 | 3.3, 4.9 | 3.4, 5.3 | 3.7, 7.0 |
| 290° to 250° over 120 s | 24 of 24 | 4.2, 9.3 | 3.0, 8.0 | 2.5, 6.1 | 3.5, 8.1 |
| 285° to 255° at once | 19 of 24 | 3.9, 11.5 | 8.0, 26.5 | 7.9, 26.3 | 6.5, 26.1 |
| ±10° every 60 s | 22 of 24 | 3.9, 7.1 | 7.2, 15.1 | 6.2, 17.9 | 4.0, 8.3 |

| Swiss lever | Blocks measured | Blocks alone | Filter, 0.5° a second | Filter, 1° | Filter, 2° |
| --- | --- | --- | --- | --- | --- |
| steady at 285° | 24 of 24 | 0.5, 1.2 | 0.5, 1.1 | 0.5, 1.1 | 0.5, 1.1 |
| 290° to 250° over 120 s | 24 of 24 | 0.7, 1.4 | 0.6, 1.1 | 0.5, 1.1 | 0.6, 1.3 |
| 285° to 255° at once | 24 of 24 | 0.5, 1.2 | 8.4, 29.2 | 8.4, 29.1 | 8.4, 29.0 |
| ±10° every 60 s | 24 of 24 | 2.2, 3.6 | 7.5, 13.8 | 5.3, 17.9 | 2.2, 3.7 |

Against the earlier search, the co-axial's worst block errors fell from 10.8° to 8.7° when
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
reference was then 20.5° rms on the lever and 17.1° on the co-axial. With the restart the
filter came within 0.6° of the lever's new level and within 1.3° of the co-axial's, 20 s after
the drop, in every run. The worst error stays, because the first block after a drop is still
left out. The restart never fired on the steady runs or on the Omega capture, nor on 32 more
steady runs (see "Larger swings, and false restarts"). It does not help the ±10° swing: blocks
left out there differ from each other as much as from the filter, so they never agree, and only
the looser 2° a second keeps up. At 0.5° a second it fired once on the co-axial's fall, taking
that filter's error from 7.0° rms to 3.0°.

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
a minute), and ±15° every 5 s, faster than a block. Two runs of each, 180 s. Errors are in
degrees against the true amplitude averaged over each block, which is all a 10 s block can see:
that averaging alone keeps 95% of a once-a-minute swing. "Kept" is the share of the swing that
survives, from fitting a sine of the known period. The true average is 285°; steady watches'
references read 280.7° to 282.9° on the co-axial and 284.0° to 284.7° on the lever (see below).

| Co-axial | Reference | Blocks alone | Kept | Filter, 1° a second | 2° | 4° |
| --- | --- | --- | --- | --- | --- | --- |
| ±15° every 60 s | 283°, 284° | 2.8, 4.8 | 91% | 10.8, 20.8; 32% | 6.3, 20.9; 69% | 6.2, 20.9; 76% |
| ±30° every 60 s | 293°, 296° | 12.6, 24.0 | 87% | 30.6, 57.3; 50% | 20.5, 44.8; 47% | 15.0, 29.4; 72% |
| ±15° every 5 s | 284°, 283° | 2.8, 4.8 | | 1.7, 3.3 | 2.2, 3.9 | 2.5, 4.3 |

| Swiss lever | Reference | Blocks alone | Kept | Filter, 1° a second | 2° | 4° |
| --- | --- | --- | --- | --- | --- | --- |
| ±15° every 60 s | 279°, 279° | 6.0, 7.5 | 90% | 15.7, 27.5; 57% | 6.0, 7.6; 90% | 6.0, 7.5; 90% |
| ±30° every 60 s | 262°, 263° | 31.3, 42.2 | 52% | 38.5, 73.1; 17% | 33.4, 70.2; 36% | 31.0, 42.2; 51% |
| ±15° every 5 s | 280°, 280° | 6.4, 8.5 | | 6.4, 8.3 | 6.4, 8.4 | 6.4, 8.5 |

- A swing moves the reading itself, not only the filter. The lever's 60 s reference reads 279°
  at ±15° and 262° to 263° at ±30°, where a steady one reads 284°, and every block measured from
  it inherits the error. The co-axial reads 1° to 2° high at ±15° and 11° to 14° high at ±30°.
  The 5 s swing does the same as the 60 s one, so what matters is the spread of amplitudes among
  the beats averaged, not how fast it changes; the ±10° swing above cost the lever about 2°. The
  cause, checked against the simulator's true unlock and lock times (`bias/`): the app's timestamp
  follows a beat's loudest sound, so a sound whose place moves with the lift time is smeared in
  the average, and the point where a smeared sound is half risen lands early. In the lever that
  is the unlock: at ±15° it lands 0.07 ms before its true mean where a steady watch's lands
  0.05 ms after, so the lift reads 0.11 ms long. At ±30° the swing piles beats at its two ends,
  the smeared unlock splits in two and the earlier half is taken. Witschi times each vibration
  on its own, so its readings should not be biased this way. Averaging is what lets the
  prototype find the co-axial's faint unlock at all.
- At 1° a second, its default until now, the filter smoothed away most of a real swing: it kept
  32% of the co-axial's ±15° and 57% of the lever's, 20 s late, where the blocks alone keep 90%.
  At 2° a second it keeps 69% and 90%, so 2° is now the default.
- The worst errors at 2° and 4° a second, about 21° on the co-axial, are blocks with no
  measurement, where the filter holds its last value while the swing goes on. Shown only while
  its own uncertainty is 5° or less, as an app would show it, the co-axial's ±15° swing at
  2° a second gave 19 of 24 readings, 3.2° rms and 7.0° at worst; at 4° a second, 16 of 24,
  2.5° and 4.5°.
- A swing faster than a block reads as its average.

`track.py steady` made 16 more steady watches of each kind, 180 s each, 192 scored blocks per
kind. No block was left out by the gate and the restart never fired, at any setting from 0.5° to
4° a second: false restarts are below 1 in 57 measured co-axial blocks and 1 in 64 lever blocks,
with 95% confidence, so fewer than about one in 10 minutes. The co-axial's blocks scatter as
their resampling says: 7 of 172 lie beyond twice their own scatter and 1 beyond three times. 20
of its 192 blocks gave no measurement. A looser setting costs little when nothing changes: the
co-axial filter's error went from 3.5° rms, 7.8° at worst, at 1° a second to 3.6° and 8.9° at
2°, and 3.8° and 13.0° at 4°. The lever's stayed at 0.6° rms. With the dash, the steady co-axial
showed 159 of its 192 readings at 2° a second, against 189 at 1°: about one in six is a dash,
each at least a block long. Those shown were 3.5° rms and 8.8° at worst. Every lever reading
was shown. Many short watches rather than a
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

| Watch | As now | Lined up again |
| --- | --- | --- |
| Lever, ±15° every 60 s | −4.1° to −3.8° (3) | −0.2° to +0.1° (3) |
| Lever, ±30° every 60 s | −19.8° to −19.0° (3) | −1.1° to +2.1° (2) |
| Lever, ±15° every 5 s | −3.9° to −2.9° (3) | −3.9° to −2.8° (3) |
| Co-axial, ±15° every 60 s | +0.3° to +1.5° (3) | −1.3° to 0.0° (3) |
| Co-axial, ±30° every 60 s | +9.1° to +13.1° (3) | −1.0° to +0.2° (3) |
| Co-axial, ±15° every 5 s | +0.2° to +1.7° (3) | +0.5° to +2.0° (3) |

As now, every biased reading in that table was shown: the gates do not see this bias. Beat error
stayed within 0.08 ms of the truth either way; lined up, the lever's ±30° showed it in only 1
of 3. The amplitude filter's blocks, against the truth averaged over each block, rms and worst
over 36 blocks:

| Watch | As now | Lined up again |
| --- | --- | --- |
| Lever, ±15° every 60 s | 6.3°, 8.9° | 0.9°, 2.5° |
| Lever, ±30° every 60 s | 31.3°, 42.2° | 2.7°, 4.7° |
| Co-axial, ±15° every 60 s | 2.7°, 4.9° | 7.2°, 32.6° |
| Co-axial, ±30° every 60 s | 11.6°, 24.0° | 5.8°, 18.3° |

The 5 s swings were unchanged: 6.4° rms on the lever both ways, 2.9° and 3.2° on the co-axial.

Any change of amplitude within a recording does the same. On `track.py sims`'s cases, two
watches each, the co-axial's whole recording read as now +5.6° to +6.5° off on the fall from
290° to 250° and +7.6° to +9.0° on the 30° step, all shown; lined up, −0.3° to +0.3° and −1.3°
to +0.2°. The lever's fall went from +2.1° to +3.1° off to +0.2° to +0.4°, and its step, held
back as now, was shown lined up, within 0.3°. The filter's blocks were about the same both ways
in those cases, except the lever's ±10° swing: 2.2° rms as now, 0.8° lined up.

Where nothing changes:

- `checks.py sims`, the 46 simulated watches: no wrong reading either way, and the readings
  moved little. But lined up, the co-axial's stated beat-error uncertainty rose from mostly
  0.03 to 0.05 ms to 0.06 to 0.13 ms, so beat error was shown in 19 of 46 instead of 33, and
  amplitude in 30 instead of 33. The faint unlock gives each block a noisy shift, and lining
  the beats up on noise spreads them again. The lever's were unchanged.
- `checks.py suite`: the same verdicts on the unit tests' 36 watches, none shown wrongly; one
  held reading, the 1 ms jitter, became no reading. The Omega capture read 0.30 ms and 285°
  against 0.31 ms and 284°; the ETA's 0.15 ms and 263° both ways; the Voice Memos recordings
  and the no-watch capture gave nothing either way.
- `track.py steady`: no restart either way on 16 watches of each kind. The co-axial measured
  166 blocks lined up against 172; the lever's were the same.
- A whole-recording reading takes about four times as long lined up: with 50 resamples, the
  Omega capture went from 4.5 s to 18.6 s, a 180 s lever from 22 s to 92 s.

So on the lever, lining up takes the bias away and costs nothing measured. On the co-axial it
takes away the bias of a large change in the whole reading, but adds scatter where nothing
changes and made the filter's blocks worse at ±15°. Lawrence chose on 18 November to make it
the default for both escapements, and later that day to line up only the sounds that move.

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

On the 46 simulated watches beat error was shown in 33 and amplitude in 33, as plain, none more
than 0.10 ms or 5° out. The test lined up a sound in 3: the two wandering by ±10° every 23 s, and
one steady watch by mistake (amplitude 200, seed 21: the tock's lock at 15.1 against 13.3), whose
reading did not change. On the 16 steady watches of each kind in `track.py steady` the filter's
blocks read as plain, within 0.1°.

Whole recordings, 180 s, amplitude error against the truth, with the test:

| Watch | Plain | Lined up | Only what moves |
| --- | --- | --- | --- |
| Lever, ±15° every 60 s | −4.1° to −3.8° | −0.2° to +0.1° | −0.2° to +0.1° |
| Lever, ±30° every 60 s | −19.8° to −19.0° | −1.1° to +2.1° | −1.2° to +2.1° |
| Co-axial, ±15° every 60 s | +0.3° to +1.5° | −1.3° to 0.0° | −0.8° to +0.1° |
| Co-axial, ±30° every 60 s | +9.1° to +13.1° | −1.0° to +0.2° | −1.6° to +0.2° |
| Co-axial, falling from 290° to 250° | +5.6° to +6.5° | −0.3° to +0.3° | −0.7° to +0.4° |
| Co-axial, 30° step | +7.6° to +9.0° | −1.3° to +0.2° | −0.8° to +0.3° |

Each was shown as often as lined up, beat error too. The smallest change tried, ±10° every 60 s,
was found in all four watches read whole, the moving sounds summing 52 to 1,208 against a limit
of 32, and ±15° every 60 s in all six 60 s references, 20 to 900 against 13.3 to 15.1. A swing
faster than a block mostly stays plain: at ±15° every 5 s, 5 of 6 whole readings and 5 of 6
references lined nothing up, and such a swing reads as its average either way.

- The filter's co-axial blocks still lose at ±15° every 60 s: the test finds the swing and lines
  the reference up, and the blocks read 4.1° rms against 2.7° plain and 7.2° lined up. At ±30°,
  6.1° against 11.6° plain and 5.8° lined up. The lever's filter reads as lined up.
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

Louder and 60 s long, lined up as by default; the plain average gave the same verdicts:

| Outcome on the 36 watches | Watches |
| --- | --- |
| shown and wrong | 2: the 36,000 vph watches told 18,000 vph read 0.01 and 0.03 ms against 0.50 |
| shown and right | 23, none more than 0.05 ms off, stated to ±0.01 to ±0.07 ms |
| refused, rightly | 1: the two-sound co-axial, whose beats share no first sound |
| held back, would have been wrong | 6: 3 basket cases and 1, 2 and 5 ms jitter, by their scatter |
| nothing | 4: the two 18,000 vph watches told 36,000, which the app could not time; the blurred three sounds, whose first sound is 2.0 ms before its lock; and no watch |

The two wrong readings come from the beat rate the test gives. Told 18,000 vph, the app takes
every other beat of a 36,000 vph watch, so its ticks and its tocks are both the watch's ticks:
the gap between them is not the beat error, and the true tocks are never timed. The app's own
Swiss-lever reading had the same fault until 18 November (see Limits). A beat halfway between
the app's beats gives it away, and the app now looks for one.

As the tests make them (`--as-tested`), with the plain average:

| Outcome on the 36 watches | Watches |
| --- | --- |
| shown and wrong by more than 0.1 ms | 0 |
| shown and right | 1: the two-sound watch whose tock changes its loudest sound, 0.01 ms against 0 |
| refused, rightly | 1: the two-sound co-axial, whose beats share no first sound |
| held back, would have been right | 7, off by 0.01 to 0.07 ms |
| held back, would have been wrong | 6: 3 basket cases, 1 and 5 ms jitter, a run with a 2 s gap |
| nothing to measure | 21 |

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

Tried and not kept: a resample carries the recording's noise twice over, about 1.5 dB more than
the whole set, so a sound the whole set finds 7 to 8 dB over the noise of the average is lost in
about half the resamples. Holding each resample to the whole set's threshold, and timing the
sounds where the whole set found them, cut the failing resamples (`lever 28800` from 79% to
5%) and showed more of the 46 simulated watches: beat error in 23 instead of 19 lined up and 39
instead of 33 plain, amplitude in 37 instead of 30 and 40 instead of 33. But it showed a 20 s
co-axial 0.11 ms off at ±0.04 and, plain, the run with a 2 s gap 0.11 ms off at ±0.06. Once the
sound is pinned, a noise bump on its edge in the whole average moves every resample alike, so
the stated scatter can be too small; the fresh search in each resample is what held these back.

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
  30 to 60 s of beats to find reliably, and the Voice Memos recordings do not show it.
- The ETA's beat error from the unlocks is not steady across its 30 s capture, and why is not
  yet known. Its 10 s stretches read 0.21, 0.16 and 0.10 ms (the first 12 s for the first), each
  ± 0.02, while the gap between the app's timestamps held at 0.41 to 0.42 ms. Either the unlock
  moves against the rest of the beat or the stated uncertainty is too small; the whole capture's
  0.15 ± 0.01 ms hides it, and a longer capture would tell. Its unlock itself is found from
  4 s of beats on. With every sound lined up, the first 20 s were held back, with 18% of
  resamples failing to find the sounds, where the plain average read 0.16 ± 0.01 ms; lining up
  only what moves keeps them plain.
- The averaging assumes the amplitude holds still over the beats averaged. On simulated watches
  a ±15° swing moved the lever's reading 5° low and a ±30° swing 22° low; the co-axial's read
  high, by up to 14° at ±30°. See "Larger swings, and false restarts". Lining up the sounds
  that move, the default now, takes it away on the lever, and in the co-axial's whole reading,
  for changes slower than a block, without the precision lining every sound up costs a steady
  co-axial; see "Lining up only the sounds that move".
- The gate on the scatter of the resamples is touchy: one stray resample in a hundred can hold
  a good reading back.
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
- One watch and one capture. The averaging itself runs on a whole recording, in Python, even
  when the beat times come from the real-time pipeline.
