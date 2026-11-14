"""Adaptive matched-filter beat tracking.
usage: track2.py wav label t0 t1 out_prefix [bph]
Chooses, per beat type (tick/tock), how many consecutive cycles K must be coherently averaged
for reliable timing, then fits rate and tick/tock offset. Saves results to <out>_res.npz/json.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import signal
import tglib as tg
import pipeline as pl
from track import clusters, robust_line


def mf(E, fe, P, T, c, data_off=0.0, pre_ms=8.0, post_ms=12.0, lag_ms=4.0, shift=None):
    n = E.shape[1]; nb = T.shape[1]
    pre, post, Lm = int(pre_ms * 1e-3 * fe), int(post_ms * 1e-3 * fe), int(lag_ms * 1e-3 * fe)
    lags = np.arange(-Lm, Lm + 1)
    tau = np.arange(-pre, post + 1)
    G = np.maximum(T[:, (c + tau) % nb], 0.0)
    G = G - G.mean(axis=1, keepdims=True)
    G /= np.sqrt((G ** 2).sum())
    m = np.arange(-pre - Lm, post + Lm + 1)
    ncyc = int((n - nb - 2 * len(m)) // P)
    C = np.zeros((ncyc, len(lags)))
    for k in range(ncyc):
        p = k * P + c + data_off + (shift[k] if shift is not None else 0.0)
        pos = p + m
        if pos[0] < 0 or pos[-1] >= n - 1:
            continue
        i0 = np.floor(pos).astype(np.int64); fr = pos - i0
        seg = E[:, i0] * (1 - fr) + E[:, i0 + 1] * fr
        acc = np.zeros(len(lags))
        for r in range(E.shape[0]):
            acc += np.correlate(seg[r], G[r], mode="valid")
        C[k] = acc
    return C, lags


def avgK(C, K):
    if K <= 1:
        return C
    ker = np.ones(K) / K
    return np.apply_along_axis(lambda v: np.convolve(v, ker, mode="valid"), 0, C)


def peaks(Cs, lags):
    k = np.argmax(Cs, axis=1)
    val = Cs[np.arange(len(k)), k]
    lag = lags[k].astype(float)
    for i, kk in enumerate(k):
        if 0 < kk < Cs.shape[1] - 1:
            a, b, c = Cs[i, kk - 1], Cs[i, kk], Cs[i, kk + 1]
            d = a - 2 * b + c
            if d < 0:
                lag[i] += 0.5 * (a - c) / d
    return lag, val


def run(path, label, t0, t1, bph=None, hum=60.0, verbose=True):
    R = pl.analyse(path, t0, t1, bph=bph, hum=hum, label=label, verbose=verbose)
    E, fe, P, T = R["E"], R["fe"], R["P"], R["T"]
    cents = clusters(T, P, fe)
    Tnom = 3600.0 / R["bph"]
    res = dict(label=label, bph=R["bph"], acq=R["acq"], fold_ppm=R["ppm"], fe=fe, P=P, cents=list(map(int, cents)), beats=[])
    q = P / 4.0
    Ks = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]
    for it in range(2):
        tracks = []
        for j, c in enumerate(cents):
            C, lags = mf(E, fe, P, T, c)
            Cn, _ = mf(E, fe, P, T, c, data_off=q)          # noise reference: same filter, off-pulse data
            chosen = None
            for K in Ks:
                Cs, Cns = avgK(C, K), avgK(Cn, K)
                lag, val = peaks(Cs, lags)
                _, nval = peaks(Cns, lags)
                thr = np.percentile(nval, 99)
                frac = float((val > thr).mean())
                zcal = (val - nval.mean()) / (nval.std() + 1e-12)
                if verbose and it == 1:
                    print("   %s K=%2d (%.1f s): %.0f%% of dots above 99%% noise level, median z %.1f" % (("tick", "tock")[j], K, K * P / fe, 100 * frac, np.median(zcal)))
                if frac >= 0.85:
                    chosen = (K, lag, val, thr, zcal)
                    break
            if chosen is None:
                chosen = (K, lag, val, thr, zcal)
            tracks.append(chosen)
        if it == 0:
            # realign template only when both beat types are detectable beat-by-beat
            if all(tr[0] <= 2 for tr in tracks):
                n0 = min(len(tr[1]) for tr in tracks)
                sh = signal.medfilt(0.5 * (tracks[0][1][:n0] + tracks[1][1][:n0]), 9)
                T, _ = pl.build_template(E[:, : int(n0 * P + T.shape[1])], fe, P, shifts=sh)
                cents = clusters(T, P, fe)
                res["cents"] = list(map(int, cents))
            else:
                pass
    # assemble beat list
    out = []
    for j, (K, lag, val, thr, zcal) in enumerate(tracks):
        k = np.arange(len(lag)) + (K - 1) / 2.0          # centre cycle index of each averaged estimate
        t = (k * P + cents[j] + lag) / fe
        n = 2 * k + j
        out.append(dict(j=j, K=K, t=t, n=n, ok=val > thr, z=zcal))
        res["beats"].append(dict(j=j, K=int(K), frac_ok=float((val > thr).mean()), zmed=float(np.median(zcal))))
    # rate fit on independent estimates (every K-th), ok only
    fits = []
    for o in out:
        sel = np.zeros(len(o["t"]), bool); sel[::o["K"]] = True
        m = sel & o["ok"]
        if m.sum() >= 5:
            a, b, w = robust_line(o["n"][m], o["t"][m])
            r = o["t"][m] - (a + b * o["n"][m])
            s = 1.4826 * np.median(np.abs(r - np.median(r)))
            nn = o["n"][m]
            sb = s / np.sqrt(((nn - nn.mean()) ** 2).sum())
            rate = 86400.0 * (Tnom / b - 1.0)
            srate = 86400.0 * Tnom * sb / b ** 2
            fits.append(dict(j=o["j"], a=a, b=b, jitter_ms=s * 1e3, rate=rate, rate_sd=srate, n=int(m.sum())))
            print("  %s: K=%d, %d independent dots, timing scatter %.3f ms, rate %+.2f +- %.2f s/d" % (("tick", "tock")[o["j"]], o["K"], m.sum(), s * 1e3, rate, srate))
        else:
            print("  %s: not trackable (only %d confident dots)" % (("tick", "tock")[o["j"]], m.sum()))
    res["fits"] = fits
    if len(fits) == 2:
        # common-slope fit: weighted mean period, then offset
        wts = np.array([1 / f["rate_sd"] ** 2 for f in fits])
        rate = float((np.array([f["rate"] for f in fits]) * wts).sum() / wts.sum())
        rate_sd = float(1 / np.sqrt(wts.sum()))
        b = Tnom / (1 + rate / 86400.0)
        offs = []
        for o in out:
            m = o["ok"]
            offs.append(np.median(o["t"][m] - b * o["n"][m]))
        d = offs[1] - offs[0]
        # scatter of d: from jitters
        sd_d = np.hypot(fits[0]["jitter_ms"] / np.sqrt(fits[0]["n"]), fits[1]["jitter_ms"] / np.sqrt(fits[1]["n"])) * 1.25
        res.update(rate=rate, rate_sd=rate_sd, offset_ms=float(d * 1e3), offset_sd_ms=float(sd_d))
        print("  combined rate %+.2f +- %.2f s/d ; tock offset from midpoint %+.3f +- %.3f ms" % (rate, rate_sd, d * 1e3, sd_d))
    elif len(fits) == 1:
        res.update(rate=fits[0]["rate"], rate_sd=fits[0]["rate_sd"], offset_ms=None)
    return res, out, T, R


if __name__ == "__main__":
    path, label, t0, t1, outp = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    bph = int(sys.argv[6]) if len(sys.argv) > 6 else None
    res, out, T, R = run(path, label, t0, t1, bph=bph)
    np.savez(outp + "_res.npz", T=T, **{"t%d" % o["j"]: o["t"] for o in out}, **{"n%d" % o["j"]: o["n"] for o in out},
             **{"ok%d" % o["j"]: o["ok"] for o in out}, **{"z%d" % o["j"]: o["z"] for o in out})
    json.dump(res, open(outp + "_res.json", "w"), indent=1, default=float)
    print("  saved", outp + "_res.json")
