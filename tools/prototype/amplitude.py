"""Amplitude study: beat-aligned averaged tick/tock envelopes at 48 kHz with bootstrap
uncertainty, split-half reproducibility, and onset detection.
usage: amplitude.py wav t0 res_prefix out.png lift_deg
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import signal
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import tglib as tg

path, t0, resp, out, lift = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4], float(sys.argv[5])
res = json.load(open(resp + "_res.json"))
Z = np.load(resp + "_res.npz")
fs, x = tg.load(path, t0, None)
bph = res["bph"]; f_osc = bph / 7200.0
rng = np.random.default_rng(0)
win = np.arange(-int(0.016 * fs), int(0.008 * fs))
tms = win / fs * 1e3


def beat_times(j):
    t, n = Z["t%d" % j], Z["n%d" % j]
    b, a = np.polyfit(n, t, 1)
    r = signal.medfilt(t - (a + b * n), 15)
    nn = np.arange(np.ceil(n.min()), np.floor(n.max()) + 1)
    nn = nn[(nn - j) % 2 == 0]
    return a + b * nn + np.interp(nn, n, r)


def stack(e, ts):
    M = []
    for tt in ts:
        pos = tt * fs + win
        if pos[0] < 0 or pos[-1] >= len(e) - 1:
            continue
        i0 = np.floor(pos).astype(np.int64); fr = pos - i0
        M.append(e[i0] * (1 - fr) + e[i0 + 1] * fr)
    return np.array(M)


def prep(lo, hi, chans=(0, 1), sm=7):
    e = tg.band_energy(x[:, list(chans)], fs, lo, hi)
    e = tg.smooth(e, sm)
    w = fs // 2
    for a in range(0, len(e), w):
        seg = e[a:a + w]; seg /= np.median(seg); np.minimum(seg, 40, out=seg)
    return e


def amp(t_ms):
    return lift / (2 * np.sin(np.pi * f_osc * t_ms * 1e-3))


bands = [(3000, 6000), (6000, 10000), (10000, 14500), (5000, 14500)]
fig, axes = plt.subplots(len(bands), 2, figsize=(13, 3.3 * len(bands)), squeeze=False)
base_sl = (tms > -15.5) & (tms < -9.5)
summary = []
for bi, (lo, hi) in enumerate(bands):
    e = prep(lo, hi)
    for j, name in ((0, "tick"), (1, "tock")):
        M = stack(e, beat_times(j))
        nbe = len(M)
        mean = M.mean(axis=0)
        base = mean[base_sl].mean()
        # bootstrap sd of the mean curve
        bs = np.array([M[rng.integers(0, nbe, nbe)].mean(axis=0) for _ in range(300)])
        sd = bs.std(axis=0)
        zc = (mean - base) / sd
        # smooth z over 0.25 ms
        k = int(0.00025 * fs)
        zs = tg.smooth(zc, k) * np.sqrt(k) / np.sqrt(k)  # keep scale of single-sample z (conservative)
        # main pulse: maximum; its onset = last time before peak where curve < 25% of peak excess
        pk = int(np.argmax(mean)); ex = mean - base
        kk = pk
        while kk > 0 and ex[kk] > 0.25 * ex[pk]:
            kk -= 1
        main_on = tms[kk]
        # earliest sustained excess: mean-base > 3.5 sd for >= 0.2 ms, searching from -13 ms
        run = int(0.0002 * fs)
        ab = (zc > 3.5).astype(float)
        sus = np.convolve(ab, np.ones(run), mode="valid") >= run
        start_idx = np.searchsorted(tms, -13.0)
        cand = np.where(sus[start_idx:])[0]
        first_on = tms[start_idx + cand[0]] if len(cand) else np.nan
        # split halves
        h1, h2 = M[: nbe // 2].mean(axis=0), M[nbe // 2:].mean(axis=0)
        ax = axes[bi, j]
        ax.fill_between(tms, 10 * np.log10(np.maximum(mean - 2 * sd, 1e-3) / base), 10 * np.log10((mean + 2 * sd) / base), color="C0", alpha=.25, lw=0)
        ax.plot(tms, 10 * np.log10(mean / base), color="C0", lw=.9, label="mean of %d beats (band +-2 sd)" % nbe)
        ax.plot(tms, 10 * np.log10(h1 / h1[base_sl].mean()), color="C2", lw=.5, alpha=.8, label="first half")
        ax.plot(tms, 10 * np.log10(h2 / h2[base_sl].mean()), color="C3", lw=.5, alpha=.8, label="second half")
        ax.axvline(main_on, color="k", lw=.6); ax.axvline(first_on, color="k", lw=.6, ls=":")
        ax.set_ylim(-1.0, 4.0); ax.set_xlim(-12, 4); ax.set_xticks(np.arange(-12, 5, 1)); ax.grid(True, alpha=.3)
        ax.set_title("%s %d-%d Hz: first onset %.2f ms, main onset %.2f ms" % (name, lo, hi, first_on, main_on), fontsize=10)
        if bi == 0 and j == 0:
            ax.legend(fontsize=7)
        # list significant local bumps before main onset
        sm_ex = tg.smooth(ex / sd, k)
        pks, pr = signal.find_peaks(tg.smooth(ex, k), distance=int(0.0005 * fs))
        bumps = [(tms[p], 10 * np.log10(mean[p] / base), sm_ex[p]) for p in pks if -12 < tms[p] < main_on - 0.3 and sm_ex[p] > 3.0]
        gap = main_on - first_on
        summary.append((name, lo, hi, first_on, main_on, gap, amp(gap) if gap > 0 else np.nan))
        print("%s %5d-%5d: first sustained onset %.2f ms, main onset %.2f ms -> gap %.2f ms -> %.0f deg | bumps(ms,dB,z): %s" % (
            name, lo, hi, first_on, main_on, gap, amp(gap) if gap > 0 else float("nan"), ", ".join("%.2f/%.1f/%.1f" % b for b in bumps)))
plt.tight_layout(); plt.savefig(out, dpi=75)
print("gap -> amplitude table (lift %.0f deg, %.0f bph):" % (lift, bph), ", ".join("%.1f ms=%.0f" % (g, amp(g)) for g in (4.5, 4.9, 6.5, 7.0, 7.2, 7.5, 8.0, 9.0, 10.0)))
