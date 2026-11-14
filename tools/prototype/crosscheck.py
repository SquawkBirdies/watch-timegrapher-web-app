"""Independent cross-check of rate: fold separate time blocks at the nominal period and
measure the drift of the tick position between blocks by cross-correlating block profiles
against the whole-file profile. usage: crosscheck.py wav t0 t1 bph nblocks lo hi [hum]
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import signal
import tglib as tg

path, t0, t1, bph, nblk, lo, hi = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), float(sys.argv[7])
fs, x = tg.load(path, t0, t1)
e = tg.band_energy(x, fs, lo, hi)
e = tg.smooth(e, 8)
# normalise + clip
w = fs // 2
for a in range(0, len(e), w):
    seg = e[a:a + w]; seg /= np.median(seg); np.minimum(seg, 30, out=seg)
# 60 Hz comb
M = 800
g = sum(np.roll(e, k * M) for k in (-2, -1, 1, 2)) / 4.0
e = e - g
P = 2 * 3600.0 / bph * fs
nb = int(round(P))
t = np.arange(len(e), dtype=np.float64)
full = tg.smooth(tg.fold(e, P, nb, t), 12)
c = int(np.argmax(full))
print("whole-file tick at phase %.3f ms" % (c / fs * 1e3))
L = int(0.004 * fs)
win = (c + np.arange(-int(0.004 * fs), int(0.008 * fs))) % nb
ref = full[win] - full[win].mean()
blk = len(e) // nblk
ph, tc = [], []
for b in range(nblk):
    sl = slice(b * blk, (b + 1) * blk)
    pr = tg.smooth(tg.fold(e[sl], P, nb, t[sl]), 12)
    best, bl = -1e9, 0
    cc = []
    for lag in range(-L, L + 1):
        v = np.dot(pr[(win + lag) % nb] - pr[(win + lag) % nb].mean(), ref)
        cc.append(v)
    cc = np.array(cc)
    k = int(np.argmax(cc))
    off = 0.0
    if 0 < k < len(cc) - 1:
        a_, b_, c_ = cc[k - 1], cc[k], cc[k + 1]
        off = 0.5 * (a_ - c_) / (a_ - 2 * b_ + c_)
    ph.append((k - L + off) / fs)
    tc.append((b + 0.5) * blk / fs)
ph, tc = np.array(ph), np.array(tc)
A = np.vstack([np.ones_like(tc), tc]).T
coef, res, *_ = np.linalg.lstsq(A, ph, rcond=None)
r = ph - A @ coef
print("block phases (ms):", " ".join("%+.3f" % (v * 1e3) for v in ph))
sd = r.std(ddof=2) / np.sqrt(((tc - tc.mean()) ** 2).sum())
print("drift %.3f +- %.3f ppm -> rate %+.2f +- %.2f s/d (positive = gaining)" % (coef[1] * 1e6, sd * 1e6, -coef[1] * 86400, sd * 86400))
