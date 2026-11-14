"""Final numbers: consistent tick/tock reference (shape cross-correlation), beat error,
windowed rates. usage: finalize.py wav t0 res_prefix
Writes <prefix>_final.json and <prefix>_final.npz (trace points with consistent reference).
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import signal
import tglib as tg
from track import robust_line

path, t0, resp = sys.argv[1], float(sys.argv[2]), sys.argv[3]
res = json.load(open(resp + "_res.json"))
Z = np.load(resp + "_res.npz")
fs, x = tg.load(path, t0, None)
Tnom = 3600.0 / res["bph"]
e = tg.band_energy(x, fs, 2500, 14500)
e = tg.smooth(e, 5)
w = fs // 2
for a in range(0, len(e), w):
    seg = e[a:a + w]; seg /= np.median(seg); np.minimum(seg, 30, out=seg)
win = np.arange(-int(0.012 * fs), int(0.012 * fs))
shapes = {}
trackable = [f["j"] for f in res["fits"]]
for j in (0, 1):
    t, n = Z["t%d" % j], Z["n%d" % j]
    b, a = np.polyfit(n, t, 1)
    r = signal.medfilt(t - (a + b * n), 15) if len(t) > 15 else np.zeros(len(t))
    # one aligned window per physical beat: interpolate smoothed track to every beat index of this type
    nn = np.arange(np.ceil(n.min()), np.floor(n.max()) + 1)
    nn = nn[(nn - j) % 2 == 0]
    ts = a + b * nn + np.interp(nn, n, r)
    M = []
    for tt in ts:
        pos = tt * fs + win
        if pos[0] < 0 or pos[-1] >= len(e) - 1:
            continue
        i0 = np.floor(pos).astype(np.int64); fr = pos - i0
        M.append(e[i0] * (1 - fr) + e[i0 + 1] * fr)
    M = np.array(M)
    med = np.median(M, axis=0)
    shapes[j] = med / np.median(med[: int(0.003 * fs)]) - 1.0
out = dict(label=res["label"], bph=res["bph"], rate=res.get("rate"), rate_sd=res.get("rate_sd"), fits=res["fits"], beats=res["beats"], acq=res["acq"])
# tick vs tock reference check: cross-correlate the two halves of the matched template
# (built from the hum-filtered multi-band envelopes, so mains-locked interference is excluded)
s_best, cc_best = 0.0, 0.0
if len(trackable) == 2:
    Tm = Z["T"]; fe = res["fe"]; c1, c2 = res["cents"]; nbT = Tm.shape[1]
    tau = np.arange(-int(0.010 * fe), int(0.010 * fe) + 1)
    L = int(0.002 * fe)
    A = np.maximum(Tm[:, (c1 + tau) % nbT], 0.0)
    cc = []
    for sft in range(-L, L + 1):
        B = np.maximum(Tm[:, (c2 + tau + sft) % nbT], 0.0)
        num = (A * B).sum(); den = np.sqrt((A * A).sum() * (B * B).sum()) + 1e-30
        cc.append(num / den)
    cc = np.array(cc)
    k = int(np.argmax(cc))
    off = 0.0
    if 0 < k < len(cc) - 1:
        p_, q_, r_ = cc[k - 1], cc[k], cc[k + 1]
        off = 0.5 * (p_ - r_) / (p_ - 2 * q_ + r_)
    # tock features sit s_best later than its reference point, relative to the tick's
    s_best = (k - L + off) / fe
    cc_best = float(cc[k])
    d_raw = res["offset_ms"] * 1e-3
    d_true = d_raw + s_best
    out.update(tick_tock_shape_corr=cc_best, ref_shift_ms=s_best * 1e3, offset_raw_ms=d_raw * 1e3, beat_offset_ms=d_true * 1e3,
               beat_error_half_ms=abs(d_true) * 1e3, beat_error_full_ms=2 * abs(d_true) * 1e3, offset_sd_ms=res.get("offset_sd_ms"))
    print("%s: tick/tock template similarity %.3f at reference shift %+.3f ms; raw offset %+.3f -> beat offset %+.3f ms (beat error %.2f ms half-diff / %.2f ms full-diff)" % (
        res["label"], cc_best, s_best * 1e3, d_raw * 1e3, d_true * 1e3, abs(d_true) * 1e3, 2 * abs(d_true) * 1e3))
# trace points with consistent reference: event time = t - (0 for tick) / + (-s) for tock
pts = {}
for j in trackable:
    t = Z["t%d" % j] - (s_best if j == 1 else 0.0) * 0  # keep raw; apply below
    pts[j] = dict(t=Z["t%d" % j] + (-(-s_best) if False else 0.0), n=Z["n%d" % j], ok=Z["ok%d" % j])
# event times
ev = {}
for j in trackable:
    tj = Z["t%d" % j].copy()
    if j == 1:
        tj = tj + s_best
    ev[j] = tj
# windowed rates on combined events (tock shifted by measured beat offset to merge lines)
allt, alln = [], []
for j in trackable:
    K = [b["K"] for b in res["beats"] if b["j"] == j][0]
    sel = np.zeros(len(ev[j]), bool); sel[::K] = True
    m = sel & Z["ok%d" % j]
    tj = ev[j][m] - (out.get("beat_offset_ms", 0.0) * 1e-3 if j == 1 else 0.0)
    allt.append(tj); alln.append(Z["n%d" % j][m])
allt, alln = np.concatenate(allt), np.concatenate(alln)
o = np.argsort(alln); allt, alln = allt[o], alln[o]
a, b, wts = robust_line(alln, allt)
r = allt - (a + b * alln)
s = 1.4826 * np.median(np.abs(r - np.median(r)))
sb = s / np.sqrt(((alln - alln.mean()) ** 2).sum())
out.update(rate_joint=86400.0 * (Tnom / b - 1.0), rate_joint_sd=86400.0 * Tnom * sb / b ** 2, jitter_ms=s * 1e3, n_dots=int(len(allt)), span_s=float(allt[-1] - allt[0]))
print("  joint rate %+.2f +- %.2f s/d over %.0f s, %d dots, scatter %.3f ms" % (out["rate_joint"], out["rate_joint_sd"], out["span_s"], len(allt), s * 1e3))
wr = []
for wlen in (10.0, 20.0):
    vals = []
    for st in np.arange(allt[0], allt[-1] - wlen + 0.01, wlen):  # non-overlapping
        m = (allt >= st) & (allt < st + wlen)
        if m.sum() >= 6:
            a_, b_, _ = robust_line(alln[m], allt[m])
            rr = allt[m] - (a_ + b_ * alln[m]); s_ = 1.4826 * np.median(np.abs(rr - np.median(rr)))
            sd_ = 86400.0 * Tnom * (s_ / np.sqrt(((alln[m] - alln[m].mean()) ** 2).sum())) / b_ ** 2
            vals.append((st + wlen / 2, 86400.0 * (Tnom / b_ - 1.0), sd_))
    if vals:
        print("  %2.0f-s windows: " % wlen + "  ".join("%+.1f(+-%.1f)" % (v[1], v[2]) for v in vals))
    wr.append(vals)
out["win10"] = wr[0]; out["win20"] = wr[1]
json.dump(out, open(resp + "_final.json", "w"), indent=1, default=float)
sv = {}
for j in trackable:
    sv["t%d" % j] = ev[j]; sv["n%d" % j] = Z["n%d" % j]; sv["ok%d" % j] = Z["ok%d" % j]
sv["shape0"] = shapes[0]; sv["shape1"] = shapes[1]; sv["win_ms"] = win / fs * 1e3
np.savez(resp + "_final.npz", **sv)
