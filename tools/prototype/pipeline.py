"""Timegrapher pipeline prototype (offline).

Stages
  1. filter bank -> per (band, channel) energy envelopes at 12 kHz, noise-normalised, clipped
  2. acquisition: beat-rate candidates x period search by epoch folding (coarse -> fine)
  3. template: folded tick/tock profiles per band (median over cycles), band weights from SNR
  4. per-beat matched filter -> timestamps (optionally coherently averaged over K cycles)
  5. rate / beat error by robust line fit; trace
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import signal
import tglib as tg

BANDS = [(1500, 2500), (2500, 3500), (3500, 5000), (5000, 7000), (7000, 9000), (9000, 11500), (11500, 14500)]
CANDIDATES = [18000, 19800, 21600, 25200, 28800, 36000]
DEC = 4


def envelopes(x, fs, bands=BANDS, hum=None):
    """Return E[(band,chan)] list of arrays at fe=fs/DEC: energy / running median - mean."""
    fe = fs / DEC
    out, meta = [], []
    for bi, (lo, hi) in enumerate(bands):
        sos = signal.butter(4, [lo, hi], btype="band", fs=fs, output="sos")
        for c in range(x.shape[1]):
            y = signal.sosfiltfilt(sos, x[:, c])
            e = tg.smooth(y * y, DEC)[::DEC].copy()
            # running-median normalisation (0.5 s blocks, linear interp between block centres)
            w = int(0.5 * fe)
            nblk = max(1, len(e) // w)
            med = np.array([np.median(e[i * w:(i + 1) * w]) for i in range(nblk)])
            ctr = (np.arange(nblk) + 0.5) * w
            floor = np.interp(np.arange(len(e)), ctr, med)
            e = e / floor
            np.minimum(e, 30.0, out=e)  # clip outliers
            if hum:
                M = int(round(fe / hum))
                g = np.zeros_like(e)
                for k in (-2, -1, 1, 2):
                    g += np.roll(e, k * M)
                e = e - g / 4.0
            e -= e.mean()
            out.append(e)
            meta.append((bi, c))
    return np.array(out), meta, fe


def fold_stat(E, P, nb, t):
    """Sum over rows of normalised folded-profile variance. Returns stat and profiles."""
    ph = (t / P) % 1.0
    idx = np.minimum((ph * nb).astype(np.int64), nb - 1)
    cnt = np.bincount(idx, minlength=nb).astype(np.float64)
    cnt[cnt == 0] = 1
    profs = np.empty((E.shape[0], nb))
    for r in range(E.shape[0]):
        profs[r] = np.bincount(idx, weights=E[r], minlength=nb) / cnt
    return profs


def acquisition(E, fe, cands=CANDIDATES, ppm_range=3500.0, verbose=True):
    """Coarse search over candidate beat rates and period offsets. Statistic: for each row the
    folded profile (1 ms bins, two-beat period) is reduced to the energy in its two strongest
    compact clusters (tick + tock), which rejects mains hum (20+ evenly spread spikes)."""
    # decimate envelopes to 2 kHz for coarse search
    d = int(round(fe / 2000))
    Ec = np.array([tg.smooth(e, d)[::d] for e in E])
    fc = fe / d
    sig = Ec.std(axis=1)
    t = np.arange(Ec.shape[1], dtype=np.float64)
    dur = Ec.shape[1] / fc
    results = []
    for bph in cands:
        P2 = 2 * 3600.0 / bph
        nb = int(round(P2 / 1e-3))
        step = 1e6 * (P2 / nb) / dur / 2.0
        trials = np.arange(-ppm_range, ppm_range + step, step)
        stat = np.empty(len(trials))
        for i, ppm in enumerate(trials):
            profs = fold_stat(Ec, P2 * fc * (1 + ppm * 1e-6), nb, t)
            # per-row z profile
            z = profs / (sig[:, None] / np.sqrt(len(t) / nb))
            # combine rows: sum of positive parts squared -> phase profile
            comb = (np.maximum(z, 0) ** 2).sum(axis=0)
            # tick + tock cluster: best 3-ms window plus the same window half a period later (+-10 ms search)
            k3 = np.convolve(np.r_[comb, comb[:2]], np.ones(3), mode="valid")[:nb]
            a = int(np.argmax(k3))
            half = nb // 2
            w = int(round(0.010 / (P2 / nb)))
            other = max(k3[(a + half + j) % nb] for j in range(-w, w + 1))
            stat[i] = k3[a] + other
        k = int(np.argmax(stat))
        med = np.median(stat); mad = 1.4826 * np.median(np.abs(stat - med)) + 1e-12
        results.append(dict(bph=bph, ppm=float(trials[k]), z=float((stat[k] - med) / mad), stat=float(stat[k])))
        if verbose:
            print("  cand %5d bph: best %+8.1f ppm  stat %.1f  z=%.1f" % (bph, trials[k], stat[k], (stat[k] - med) / mad))
    return results


def refine_period(E, fe, P2_s, ppm0, span=30.0, bin_s=1 / 6000.0):
    t = np.arange(E.shape[1], dtype=np.float64)
    nb = int(round(P2_s / bin_s))
    dur = E.shape[1] / fe
    step = 1e6 * bin_s / dur / 3.0
    trials = np.arange(ppm0 - span, ppm0 + span + step, step)
    sig = E.std(axis=1)
    stat = np.empty(len(trials))
    for i, ppm in enumerate(trials):
        profs = fold_stat(E, P2_s * fe * (1 + ppm * 1e-6), nb, t)
        z = profs / (sig[:, None] / np.sqrt(len(t) / nb))
        stat[i] = (np.maximum(z, 0) ** 2).sum()
    k = int(np.argmax(stat))
    # parabolic refinement
    if 0 < k < len(trials) - 1:
        a, b, c = stat[k - 1], stat[k], stat[k + 1]
        off = 0.5 * (a - c) / (a - 2 * b + c)
    else:
        off = 0.0
    return float(trials[k] + off * step), trials, stat


def build_template(E, fe, P, shifts=None):
    """Median-over-cycles folded profile for each row at period P (samples at fe), 1-sample bins.
    shifts: optional per-cycle time shift (samples) to align cycles (from a previous tracking pass)."""
    n = E.shape[1]
    nb = int(round(P))
    ncyc = int(n // P) - 1
    T = np.empty((E.shape[0], nb))
    grid = np.arange(nb)
    M = np.empty((ncyc, nb))
    for r in range(E.shape[0]):
        for k in range(ncyc):
            s = (shifts[k] if shifts is not None else 0.0)
            pos = k * P + s + grid
            M[k] = np.interp(pos, np.arange(n), E[r])
        T[r] = np.median(M, axis=0)
    return T, ncyc


def analyse(path, t0, t1, bph=None, hum=None, K=1, label="", verbose=True):
    fs, x = tg.load(path, t0, t1)
    E, meta, fe = envelopes(x, fs, hum=hum)
    if verbose:
        print("%s: %.1f s, %d rows at %.0f Hz" % (label, x.shape[0] / fs, E.shape[0], fe))
    acq = acquisition(E, fe, verbose=verbose) if bph is None else acquisition(E, fe, [bph], verbose=verbose)
    best = max(acq, key=lambda r: r["stat"])
    bph_d = best["bph"]
    P2_s = 2 * 3600.0 / bph_d
    ppm, trials, stat = refine_period(E, fe, P2_s, best["ppm"])
    P = P2_s * fe * (1 + ppm * 1e-6)
    if verbose:
        print("  -> %d bph, refined %+.2f ppm (mean rate %+.2f s/d)" % (bph_d, ppm, -ppm * 0.0864 / (1 + ppm * 1e-6)))
    T, ncyc = build_template(E, fe, P)
    return dict(fs=fs, fe=fe, E=E, meta=meta, acq=acq, bph=bph_d, ppm=ppm, P=P, T=T, ncyc=ncyc, x=x)


if __name__ == "__main__":
    path, t0, t1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    hum = float(sys.argv[4]) if len(sys.argv) > 4 and float(sys.argv[4]) > 0 else None
    analyse(path, t0, t1, hum=hum, label=os.path.basename(path))
