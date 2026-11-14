"""Per-beat matched-filter tracking, rate / beat-error fit, and trace plots.
usage: track.py wav label t0 t1 K out_prefix [bph]
K = number of consecutive two-beat cycles coherently averaged before timing (1 = every beat).
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import signal
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import tglib as tg
import pipeline as pl


def clusters(T, P, fe):
    """Locate tick and tock cluster centres in template T (rows x phase)."""
    comb = (np.maximum(T, 0) ** 2).sum(axis=0)
    k = int(round(0.5e-3 * fe))
    cs = np.convolve(np.r_[comb, comb[:k]], np.ones(k), mode="valid")[:len(comb)]
    nb = len(comb)
    c1 = int(np.argmax(cs))
    half = nb // 2
    w = int(0.012 * fe)
    cand = [(c1 + half + j) % nb for j in range(-w, w + 1)]
    c2 = cand[int(np.argmax(cs[cand]))]
    return (c1, c2) if c1 < c2 else (c2, c1)


def matched_tracks(E, fe, P, T, cents, pre_ms=8.0, post_ms=12.0, lag_ms=4.0, K=1, centre_track=None):
    """Return per-cycle lag estimates for each cluster. C[j][k, L]."""
    n = E.shape[1]
    nb = T.shape[1]
    pre, post, Lm = int(pre_ms * 1e-3 * fe), int(post_ms * 1e-3 * fe), int(lag_ms * 1e-3 * fe)
    ncyc = int((n - 2 * (post + Lm) - nb) // P)
    lags = np.arange(-Lm, Lm + 1)
    out = []
    grid = np.arange(n)
    for j, c in enumerate(cents):
        tau = np.arange(-pre, post + 1)
        G = np.maximum(T[:, (c + tau) % nb], 0.0)          # rows x tau (matched-filter weights)
        G = G - G.mean(axis=1, keepdims=True)
        gnorm = np.sqrt((G ** 2).sum())
        C = np.zeros((ncyc, len(lags)))
        m = np.arange(-pre - Lm, post + Lm + 1)
        for k in range(ncyc):
            p = k * P + c + (centre_track[j][k] if centre_track is not None else 0.0)
            if p + m[0] < 0 or p + m[-1] >= n - 1:
                continue
            pos = p + m
            i0 = np.floor(pos).astype(np.int64)
            fr = pos - i0
            seg = E[:, i0] * (1 - fr) + E[:, i0 + 1] * fr     # rows x m
            acc = np.zeros(len(lags))
            for r in range(E.shape[0]):
                acc += np.correlate(seg[r], G[r], mode="valid")
            C[k] = acc / gnorm
        out.append(C)
    return out, lags


def pick(C, lags, fe, K=1):
    """Coherently average K consecutive cycles, then parabolic peak pick. Returns lag (samples), z."""
    if K > 1:
        ker = np.ones(K) / K
        Cs = np.apply_along_axis(lambda v: np.convolve(v, ker, mode="same"), 0, C)
    else:
        Cs = C
    # noise sd of C per unit: E rows have sd ~ row sd; estimate from robust spread of Cs overall
    sd = 1.4826 * np.median(np.abs(Cs - np.median(Cs)))
    k = np.argmax(Cs, axis=1)
    lag = np.empty(len(k)); z = np.empty(len(k))
    for i, kk in enumerate(k):
        z[i] = (Cs[i, kk] - np.median(Cs)) / sd
        if 0 < kk < Cs.shape[1] - 1:
            a, b, c = Cs[i, kk - 1], Cs[i, kk], Cs[i, kk + 1]
            d = a - 2 * b + c
            off = 0.5 * (a - c) / d if d != 0 else 0.0
        else:
            off = 0.0
        lag[i] = lags[kk] + off
    return lag, z


def robust_line(n, t, w=None, iters=6):
    """Iteratively reweighted (Tukey) straight-line fit t = a + b n. Returns a, b, weights."""
    w = np.ones_like(t) if w is None else w.copy()
    for _ in range(iters):
        A = np.vstack([np.ones_like(n), n]).T * w[:, None]
        coef, *_ = np.linalg.lstsq(A, t * w, rcond=None)
        r = t - (coef[0] + coef[1] * n)
        s = 1.4826 * np.median(np.abs(r - np.median(r))) + 1e-12
        u = r / (4.685 * s)
        w = np.where(np.abs(u) < 1, (1 - u ** 2) ** 2, 0.0)
    return coef[0], coef[1], w


if __name__ == "__main__":
    path, label, t0, t1, K, outp = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
    bph = int(sys.argv[7]) if len(sys.argv) > 7 else None
    R = pl.analyse(path, t0, t1, bph=bph, hum=60.0, label=label)
    E, fe, P, T = R["E"], R["fe"], R["P"], R["T"]
    cents = clusters(T, P, fe)
    print("  cluster centres (ms): %.2f, %.2f  separation %.3f ms (half period %.3f)" % (cents[0] / fe * 1e3, cents[1] / fe * 1e3, (cents[1] - cents[0]) / fe * 1e3, P / fe * 500))
    # pass 1: wide lags
    Cs, lags = matched_tracks(E, fe, P, T, cents, lag_ms=5.0)
    tr = []
    for j in range(2):
        lag, z = pick(Cs[j], lags, fe, K=max(K, 8))
        # smooth track (median over 9 cycles)
        tr.append(signal.medfilt(lag, 9))
    # rebuild template with aligned cycles (mean track of both clusters)
    shift = 0.5 * (tr[0] + tr[1])
    T2, _ = pl.build_template(E[:, : int((len(shift)) * P + T.shape[1])], fe, P, shifts=shift)
    cents2 = clusters(T2, P, fe)
    Cs, lags = matched_tracks(E, fe, P, T2, cents2, lag_ms=3.0, centre_track=[shift, shift])
    res = {}
    fig, axes = plt.subplots(4, 1, figsize=(11, 16))
    allt, alln, allz, allj = [], [], [], []
    for j in range(2):
        lag, z = pick(Cs[j], lags, fe, K=K)
        k = np.arange(len(lag))
        tt = (k * P + cents2[j] + shift[: len(lag)] + lag) / fe  # seconds
        allt.append(tt); alln.append(2 * k + j); allz.append(z); allj.append(np.full(len(k), j))
    t_all = np.concatenate(allt); n_all = np.concatenate(alln).astype(float); z_all = np.concatenate(allz); j_all = np.concatenate(allj)
    order = np.argsort(n_all)
    t_all, n_all, z_all, j_all = t_all[order], n_all[order], z_all[order], j_all[order]
    Tnom = 3600.0 / R["bph"]
    good = z_all > 4.0
    print("  beats: %d, confident (z>4): %d (%.0f%%); median z tick %.1f tock %.1f" % (len(t_all), good.sum(), 100 * good.mean(), np.median(z_all[j_all == 0]), np.median(z_all[j_all == 1])))
    # joint robust fit: t = a + T n + d*[odd]
    a, b, w = robust_line(n_all[good], t_all[good] - 0.0)
    resid = t_all - (a + b * n_all)
    # beat error from median residual difference tick vs tock (robust)
    d = np.median(resid[good & (j_all == 1)]) - np.median(resid[good & (j_all == 0)])
    # refit removing offset
    tcorr = t_all - d * (j_all == 1)
    a, b, w = robust_line(n_all[good], tcorr[good])
    resid = tcorr - (a + b * n_all)
    rate = 86400.0 * (Tnom / b - 1.0)
    jit = 1.4826 * np.median(np.abs(resid[good] - np.median(resid[good])))
    print("  beat period %.6f ms -> rate %+.2f s/d ; tick/tock offset d = %+.3f ms ; residual jitter (robust sd) %.3f ms" % (b * 1e3, rate, d * 1e3, jit * 1e3))
    # rate over sliding windows (10 s)
    win = 10.0
    tsec = t_all
    rates = []
    for s in np.arange(tsec[0], tsec[-1] - win + 0.01, 2.0):
        m = good & (tsec >= s) & (tsec < s + win)
        if m.sum() > 10:
            a_, b_, _ = robust_line(n_all[m], tcorr[m])
            rates.append((s + win / 2, 86400.0 * (Tnom / b_ - 1.0)))
    rates = np.array(rates)
    if len(rates):
        print("  10-s window rates (s/d): min %+.1f max %+.1f ; values: %s" % (rates[:, 1].min(), rates[:, 1].max(), " ".join("%+.1f" % v for v in rates[:, 1])))
    # ---- plots
    ph = np.arange(T2.shape[1]) / fe * 1e3
    comb = (np.maximum(T2, 0)).sum(axis=0)
    axes[0].plot(ph, comb, lw=.7); axes[0].set_title("%s: folded template (sum of bands), period %.4f ms" % (label, P / fe * 1e3)); axes[0].set_xlabel("phase ms"); axes[0].grid(True, alpha=.3)
    for j, col in ((0, "C0"), (1, "C1")):
        sl = np.arange(-int(0.012 * fe), int(0.02 * fe))
        axes[1].plot(sl / fe * 1e3, comb[(cents2[j] + sl) % len(comb)], color=col, label=("tick", "tock")[j])
    axes[1].legend(); axes[1].set_title("tick vs tock template, aligned on main peak"); axes[1].set_xlabel("ms from main peak"); axes[1].grid(True, alpha=.3)
    # trace: residual vs nominal, wrapped +-span
    y = (t_all - n_all * Tnom)
    y = y - np.median(y[:20])
    for j, col in ((0, "C0"), (1, "C1")):
        m = (j_all == j)
        axes[2].scatter(t_all[m & good], y[m & good] * 1e3, s=5, color=col)
        axes[2].scatter(t_all[m & ~good], y[m & ~good] * 1e3, s=3, color="0.75")
    axes[2].set_title("trace: beat arrival vs ideal %d bph clock (grey = low confidence)   rate %+.1f s/d, offset %.2f ms" % (R["bph"], rate, abs(d) * 1e3)); axes[2].set_xlabel("time s"); axes[2].set_ylabel("ms"); axes[2].grid(True, alpha=.3)
    axes[3].plot(t_all, z_all, lw=.5); axes[3].axhline(4, color="r", lw=.5); axes[3].set_title("per-beat detection z"); axes[3].set_xlabel("time s"); axes[3].grid(True, alpha=.3)
    plt.tight_layout(); plt.savefig(outp + "_track.png", dpi=80)
    np.savez(outp + "_beats.npz", t=t_all, n=n_all, z=z_all, j=j_all, T2=T2, cents=np.array(cents2), P=P, fe=fe, bph=R["bph"])
    print("  saved", outp + "_track.png")
