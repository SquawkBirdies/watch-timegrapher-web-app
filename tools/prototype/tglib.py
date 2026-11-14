"""Shared helpers for the timegrapher prototype (offline analysis of recordings)."""
import numpy as np
from scipy.io import wavfile
from scipy import signal


def load(path, t0=0.0, t1=None):
    fs, x = wavfile.read(path)
    x = x.astype(np.float64)
    if x.ndim == 1:
        x = x[:, None]
    a = int(t0 * fs)
    b = len(x) if t1 is None else int(t1 * fs)
    return fs, x[a:b]


def band_energy(x, fs, lo, hi, order=4):
    """Sum over channels of squared band-passed signal (zero-phase), full rate."""
    sos = signal.butter(order, [lo, hi], btype="band", fs=fs, output="sos")
    e = 0.0
    for c in range(x.shape[1]):
        y = signal.sosfiltfilt(sos, x[:, c])
        e = e + y * y
    return e


def smooth(e, n):
    if n <= 1:
        return e
    k = np.ones(n) / n
    return np.convolve(e, k, mode="same")


def robust_clip(e, fs, win_s=1.0, k=40.0):
    """Clip energy at k x running median (per window) to tame handling noise / glitches."""
    out = e.copy()
    w = int(win_s * fs)
    for a in range(0, len(e), w):
        seg = out[a:a + w]
        m = np.median(seg)
        np.minimum(seg, k * m, out=seg)
    return out


def fold(e, period, nb, t=None):
    """Fold series e (sample index time) at `period` samples into nb phase bins (mean)."""
    if t is None:
        t = np.arange(len(e), dtype=np.float64)
    ph = (t / period) % 1.0
    idx = np.minimum((ph * nb).astype(np.int64), nb - 1)
    s = np.bincount(idx, weights=e, minlength=nb)
    c = np.bincount(idx, minlength=nb)
    return s / np.maximum(c, 1)


def period_search(e, fs_e, P0_s, ppm_range, bin_s=0.25e-3, oversample=4.0):
    """Epoch-folding search around period P0_s (seconds). e sampled at fs_e.
    Returns trials(ppm), stat (profile variance)."""
    P0 = P0_s * fs_e
    nb = max(8, int(round(P0_s / bin_s)))
    dur = len(e) / fs_e
    step_ppm = 1e6 * (P0_s / nb) / dur / oversample
    trials = np.arange(-ppm_range, ppm_range + step_ppm, step_ppm)
    t = np.arange(len(e), dtype=np.float64)
    stat = np.empty(len(trials))
    for i, ppm in enumerate(trials):
        stat[i] = fold(e, P0 * (1 + ppm * 1e-6), nb, t).var()
    return trials, stat


def zscore_peak(stat):
    med = np.median(stat)
    mad = np.median(np.abs(stat - med)) * 1.4826 + 1e-300
    k = int(np.argmax(stat))
    return k, (stat[k] - med) / mad
