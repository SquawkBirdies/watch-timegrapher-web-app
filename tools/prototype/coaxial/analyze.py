"""Beat error and amplitude of one recording from the sounds inside each beat.

usage: python3 -I tools/prototype/coaxial/analyze.py <file.wav> <prefix>.beats.json <lift angle>
           [--app] [--from seconds --to seconds] [--resamples n] [--plain | --lined] [--plot out.png]

<prefix>.beats.json comes from beats.mjs. --app works on envelopes made the way the app's
filter bank makes them (12 kHz, causal filters) instead of the audio at its own rate. The sounds
whose 10 s blocks show them moving are lined up again before averaging (see events.measure and
events.moved); --lined lines every sound up, and --plain gives the plain average, as before
18 November.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import events as ev

p = argparse.ArgumentParser()
p.add_argument("wav")
p.add_argument("beats")
p.add_argument("lift", type=float)
p.add_argument("--app", action="store_true")
p.add_argument("--from", dest="t_from", type=float)
p.add_argument("--to", dest="t_to", type=float)
p.add_argument("--resamples", type=int, default=200)
way = p.add_mutually_exclusive_group()
way.add_argument("--plain", action="store_true")
way.add_argument("--lined", action="store_true")
p.add_argument("--plot")
a = p.parse_args()

reline = False if a.plain else True if a.lined else "test"
fs, x = ev.load_wav(a.wav)
B = ev.load_beats(a.beats)
if a.app:
    rows, fe = ev.app_rows(x, fs)
    o = ev.measure(None, fe, B, a.lift, a.resamples, a.t_from, a.t_to, rows=rows, find={"smooth_ms": 0.25}, reline=reline)
else:
    o = ev.measure(x, fs, B, a.lift, a.resamples, a.t_from, a.t_to, reline=reline)
print("\n".join(ev.describe(o)))

if a.plot and "ports" in o:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    tms = o["tms"]
    fig, axes = plt.subplots(2, 1, figsize=(11, 6.5), sharex=True)
    for j, name in ((0, "tick"), (1, "tock")):
        c, sounds, noise = o["ports"][j]
        ax = axes[j]
        ax.plot(tms, 10 * np.log10(np.maximum(1 + ev.smooth(c, 7), 0.5)), lw=1.6, color="#2a78d6" if j == 0 else "#eb6834")
        for e in sounds:
            ax.axvline(e["onset_ms"], color="#52514e", lw=0.6, ls=":")
        if o["reading"]:
            r = o["reading"]
            ax.axvline(r["f%d" % j], color="#0b0b0b", lw=1.2)
            ax.axvline(r["l%d" % j], color="#0b0b0b", lw=1.2)
        ax.set_title("%s: dB over the background; dotted = each sound's start, solid = unlock and lock" % name, fontsize=10, loc="left")
        ax.set_xlim(-16, 10)
        ax.set_xticks(np.arange(-16, 11, 2))
        ax.grid(True, alpha=0.3)
    axes[1].set_xlabel("milliseconds from the app's timestamp of the beat")
    fig.tight_layout()
    fig.savefig(a.plot, dpi=110)
