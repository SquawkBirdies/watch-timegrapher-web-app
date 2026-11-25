"""The figure in the investigation write-up: the two beats of each Safari capture on a common
clock, with the unlock and the lock the prototype found.

usage: python3 -I tools/prototype/coaxial/figure.py <omega>.beats.json <eta>.beats.json out.png
       (run from the repository root; the beats files come from beats.mjs)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import events as ev

omega, eta, out = sys.argv[1:4]
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
TICK, TOCK = "#2a78d6", "#eb6834"
plt.rcParams.update({"font.size": 12, "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "text.color": INK})
cases = [
    ("tests/fixtures/omega-3861-safari.wav", omega, 36, "Omega 3861, co-axial: only the first and last sounds line up", (-8, 8)),
    ("tests/fixtures/eta-2836-2-safari.wav", eta, 50, "ETA 2836-2, Swiss lever: the two beats sound alike", (-10, 6)),
]
fig, axes = plt.subplots(2, 1, figsize=(8.2, 8.4), facecolor=SURFACE)
for ax, (wav, beats, lift, title, xlim) in zip(axes, cases):
    fs, x = ev.load_wav(wav)
    o = ev.measure(x, fs, ev.load_beats(beats), lift, 0)
    if o["reading"] is None:
        sys.exit("%s: no reading: %s" % (wav, o["why"]))
    tms, gap, r = o["tms"], o["gap"], o["reading"]
    ax.set_facecolor(SURFACE)
    top = 0
    for j, (label, colour, shift) in enumerate((("tick", TICK, 0.0), ("tock", TOCK, gap))):
        y = 10 * np.log10(np.maximum(1 + ev.smooth(o["ports"][j][0], 7), 0.5))
        ax.plot(tms + shift, y, color=colour, lw=2, label=label, solid_capstyle="round")
        top = max(top, y.max())
    for text, a, b in (("unlock", r["f0"], r["f1"] + gap), ("lock", r["l0"], r["l1"] + gap)):
        ax.plot([a], [-1.6], marker="^", ms=8, color=TICK, clip_on=False, zorder=5)
        ax.plot([b], [-1.6], marker="^", ms=8, color=TOCK, clip_on=False, zorder=5)
        ax.annotate(text, (0.5 * (a + b), top * 1.02), ha="center", va="bottom", color=INK, fontsize=12)
        ax.axvspan(min(a, b) - 0.5, max(a, b) + 1.1, color=GRID, alpha=0.45, lw=0, zorder=0)
    ax.set_xlim(*xlim)
    ax.set_ylim(-2.5, top * 1.16)
    ax.set_xticks(np.arange(xlim[0], xlim[1] + 0.1, 2))
    ax.grid(True, axis="y", color=GRID, lw=0.8)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.set_title(title, loc="left", fontsize=12.5, color=INK, pad=10)
    ax.set_ylabel("dB over the background")
    ax.legend(loc="upper right", frameon=False, fontsize=11, handlelength=1.4)
axes[1].set_xlabel("milliseconds; the tock is drawn half a period after the tick")
fig.tight_layout(h_pad=2.0)
fig.savefig(out, dpi=150, facecolor=SURFACE)
