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

## Running it

Node 22 or later, and Python 3 with numpy, scipy and matplotlib. From the repository root:

```
node tools/prototype/coaxial/beats.mjs wav tests/fixtures/omega-3861-safari.wav /tmp/omega
python3 -I tools/prototype/coaxial/analyze.py tests/fixtures/omega-3861-safari.wav /tmp/omega.beats.json 36
python3 -I tools/prototype/coaxial/analyze.py tests/fixtures/omega-3861-safari.wav /tmp/omega.beats.json 36 --app
python3 -I tools/prototype/coaxial/checks.py vary tests/fixtures/omega-3861-safari.wav /tmp/omega.beats.json 36
python3 -I tools/prototype/coaxial/checks.py sims /tmp/sims        # about twenty minutes
```

`beats.mjs` runs the app's own analysis for the timestamps. The last argument of `analyze.py`
is the lift angle. `--app` works on envelopes made the way the app's filter bank makes them.

| File | What it does |
| --- | --- |
| `beats.mjs` | timestamps of a recording, or a simulated watch with known truth |
| `events.py` | the method: averaged beats, their sounds, the pairing, the gates |
| `analyze.py` | one recording, printed, with an optional plot |
| `checks.py` | how the readings move with the analysis choices; simulated watches |
| `figure.py` | the figure in the write-up |

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
Swiss-lever reading: the app times the drop, a timing machine the unlock.

On simulated co-axial watches (60 s, 21,600 vph, unlock 5 dB over the noise) with a true beat
error of 0, 0.5, 1 and 2 ms, sixteen runs all read within 0.10 ms, and amplitudes of 200° to
310° read 1° to 5° low. With the unlock 2 dB over the noise or less, or with only 20 s of
audio, nothing was shown.

## Limits

- That the first sound is the unlock in both beats is a reading of the patents' sequence of
  events, not something the audio proves. Only a timing machine with a co-axial mode can check
  it.
- The 3861's 36° lift angle comes from a forum post. Each degree moves the amplitude by 7.9°.
- The two beats take 8% different times from unlock to lock. The prototype uses their mean;
  what a timing machine's co-axial mode does is not published.
- The 3861's unlock stands only 3.5 to 5.5 dB over the noise, mostly above 18 kHz. It took
  about a minute of beats to find reliably, and compressed recordings do not show it.
- One watch and one capture. Whole recordings only: nothing here runs in real time.
