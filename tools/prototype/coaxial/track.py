"""Prototype: follow the amplitude over time with a slow Kalman filter.

The unlock is too faint to time in a single beat, so the beat tracker cannot carry the
amplitude. This works one level up. A reference stretch of beats, long enough to find the
unlock and the lock (events.py), gives their places in the averaged beat. Every short block of
beats after that is averaged too, and each sound is matched against the reference's to see how
far it has moved. That gives the block's time from unlock to lock, with an uncertainty from
resampling the block's beats. A one-state Kalman filter then follows that time from block to
block:

    state        t_k, the mean time from unlock to lock over the two beats, in milliseconds
    model        t_k+1 = t_k + w,   w ~ N(0, q * seconds between blocks)
    measurement  z_k = t_k + v,     v ~ N(0, R_k), R_k from resampling block k

and the amplitude is the usual formula applied to t_k.

usage: python3 -I tools/prototype/coaxial/track.py recording <file.wav> <prefix> <lift angle>
       python3 -I tools/prototype/coaxial/track.py sims <directory>
       python3 -I tools/prototype/coaxial/track.py figure <sims output> <recording output> out.png

`recording` reads <prefix>.stream.json from `beats.mjs stream`. `sims` makes simulated watches
whose amplitude changes in a known way, and takes about half an hour. `figure` draws the
tracks from what the other two printed, saved to files.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import events as ev

SMOOTH_MS = 0.15      # as find_sounds smooths a portrait
MAX_SHIFT_MS = 1.5    # furthest a sound is looked for from its place in the reference
MIN_BEATS = 10        # fewest beats of each type in a block
GATE = 3.0            # a block further than this many standard deviations from the filter is left out


def smoothed(c, tms):
    return ev.smooth(c, max(1, int(round(SMOOTH_MS / (tms[1] - tms[0])))))


def portraits(S, tms, idx, base_until, weights=None):
    """The averaged tick and tock of the chosen beats, and the band weights used."""
    means = [ev.band_means(S[j], tms, idx[j], base_until) for j in (0, 1)]
    if weights is None:
        weights = ev.shared_weights(means[0], means[1], tms, base_until)
    return [ev.portrait(m, weights) for m in means], weights


def shift_of(ref, blk, tms, lo, hi):
    """How much later, in milliseconds, a sound comes in `blk` than in `ref`: the shift at which
    the reference's stretch from lo to hi, with its mean taken off, best matches the block's
    portrait. None when the best match is at the edge of the search."""
    dt = tms[1] - tms[0]
    i0, i1 = np.searchsorted(tms, lo), np.searchsorted(tms, hi)
    g = ref[i0:i1] - ref[i0:i1].mean()
    n = int(round(MAX_SHIFT_MS / dt))
    if i0 - n < 0 or i1 + n > len(blk):
        return None
    score = np.array([np.dot(g, blk[i0 + k:i1 + k] - blk[i0 + k:i1 + k].mean()) for k in range(-n, n + 1)])
    k = int(np.argmax(score))
    if k == 0 or k == len(score) - 1:
        return None
    a, b, c = score[k - 1], score[k], score[k + 1]
    frac = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    return (k - n + frac) * dt


class Reference:
    """Where the unlock and the lock are in the averaged beat of a reference stretch."""

    def __init__(self, S, times, tms, base_until, bph, lift, until):
        self.S, self.times, self.tms, self.base_until = S, times, tms, base_until
        idx = [np.flatnonzero(t < until) for t in times]
        raw, self.weights = portraits(S, tms, idx, base_until)
        sounds = [ev.find_sounds(c, tms, base_until)[0] for c in raw]
        self.pair, self.why = ev.pair_beats(sounds[0], sounds[1], bph, lift)
        self.curves = [smoothed(c, tms) for c in raw]
        self.beats = [len(i) for i in idx]
        if self.pair is not None:
            self.lift = [self.pair["lift0"], self.pair["lift1"]]
            # The stretch of the reference that is matched: from before a sound starts to after
            # it is loudest.
            self.windows = [[(self.pair[k + str(j)]["onset_ms"] - 0.5, self.pair[k + str(j)]["peak_ms"] + 0.5) for k in ("f", "l")] for j in (0, 1)]

    def block(self, idx):
        """Mean time from unlock to lock of the beats in idx (one index array per beat type), or
        None when a sound could not be placed."""
        raw, _ = portraits(self.S, self.tms, idx, self.base_until, self.weights)
        lifts = []
        for j in (0, 1):
            c = smoothed(raw[j], self.tms)
            su = shift_of(self.curves[j], c, self.tms, *self.windows[j][0])
            sl = shift_of(self.curves[j], c, self.tms, *self.windows[j][1])
            if su is None or sl is None:
                return None
            lifts.append(self.lift[j] + sl - su)
        return 0.5 * (lifts[0] + lifts[1])


def follow(ref, block_seconds, drift_deg, bph, lift, resamples=40, seed=1):
    """Measure every block and run the filter over the measurements.

    drift_deg  how far the amplitude may wander in one second, in degrees: the filter's q

    Returns one dict per block: its middle time, how many beats, the block's own measurement
    and its scatter under resampling, and the filter's value and uncertainty after the block."""
    rng = np.random.default_rng(seed)
    t_end = max(t.max() for t in ref.times)
    t0 = min(t.min() for t in ref.times)
    t_ref = 0.5 * (ref.lift[0] + ref.lift[1])
    # One degree of amplitude in milliseconds of unlock-to-lock time, near the reference.
    ms_per_deg = t_ref / ev.amplitude(lift, bph, t_ref)
    q = (drift_deg * ms_per_deg) ** 2
    state, var = None, None
    out = []
    a = t0
    while a + block_seconds <= t_end + 0.5:
        idx = [np.flatnonzero((t >= a) & (t < a + block_seconds)) for t in ref.times]
        row = {"t": a + 0.5 * block_seconds, "beats": [len(i) for i in idx], "z": None, "sd": None, "used": False}
        if min(len(i) for i in idx) >= MIN_BEATS:
            z = ref.block(idx)
            if z is not None:
                zs = [ref.block([rng.choice(i, len(i)) for i in idx]) for _ in range(resamples)]
                zs = np.array([v for v in zs if v is not None])
                if len(zs) >= 0.8 * resamples:
                    row["z"], row["sd"] = z, max(float(zs.std()), 0.02)
        if state is not None:
            var += q * block_seconds
        if row["z"] is not None:
            if state is None:
                state, var, row["used"] = row["z"], row["sd"] ** 2, True
            elif abs(row["z"] - state) <= GATE * np.sqrt(var + row["sd"] ** 2):
                gain = var / (var + row["sd"] ** 2)
                state += gain * (row["z"] - state)
                var *= 1 - gain
                row["used"] = True
        row["state"], row["state_sd"] = state, (None if var is None else float(np.sqrt(var)))
        out.append(row)
        a += block_seconds
    return out


def true_amplitude(spec, constant, t):
    t = np.asarray(t, dtype=float)
    if spec and "swing" in spec:
        s = spec["swing"]
        return s["base"] + s["swing"] * np.sin(2 * np.pi * t / s["period"])
    if spec and "ramp" in spec:
        r = spec["ramp"]
        return np.where(t <= r["t0"], r["from"], np.where(t >= r["t1"], r["to"], r["from"] + (r["to"] - r["from"]) * (t - r["t0"]) / (r["t1"] - r["t0"])))
    return np.full(t.shape, constant)


def prepare(wav, stream_json, lift, reference_seconds):
    fs, x = ev.load_wav(wav)
    B = ev.load_beats(stream_json)
    o = ev.measure(x, fs, B, lift, 0)
    return Reference(o["stacks"], o["times"], o["tms"], o["base_until"], o["bph"], lift, reference_seconds), o


def show(rows, bph, lift, truth=None):
    amp = lambda t: ev.amplitude(lift, bph, t)
    for r in rows:
        line = "  %5.0f s  beats %2d+%2d  " % (r["t"], r["beats"][0], r["beats"][1])
        if truth is not None:
            line += "true %5.1f  " % truth(r["t"])
        if r["z"] is None:
            line += "block: no measurement       "
        else:
            # The scatter of the amplitude that goes with the scatter of the time.
            line += "block %5.1f +- %4.1f%s  " % (amp(r["z"]), amp(r["z"]) * r["sd"] / r["z"], " " if r["used"] else "*")
        if r["state"] is not None:
            line += "filter %5.1f +- %4.1f" % (amp(r["state"]), amp(r["state"]) * r["state_sd"] / r["state"])
        print(line)


def recording(wav, prefix, lift):
    fs, x = ev.load_wav(wav)
    seconds = len(x) / fs
    ref, o = prepare(wav, prefix + ".stream.json", lift, seconds + 1)
    if ref.pair is None:
        print("no reference: " + ref.why)
        return
    print("reference: all %d+%d beats, unlock to lock %.2f and %.2f ms, amplitude %.0f degrees" % (ref.beats[0], ref.beats[1], ref.lift[0], ref.lift[1], ev.amplitude(lift, o["bph"], 0.5 * sum(ref.lift))))
    for block_seconds in (10, 15):
        print("blocks of %d s, amplitude allowed to wander by 1 degree in a second; * = left out by the filter's gate:" % block_seconds)
        show(follow(ref, block_seconds, 1.0, o["bph"], lift), o["bph"], lift)


def sims(outdir):
    os.makedirs(outdir, exist_ok=True)
    lift, reference_seconds, block_seconds = 36, 60, 10
    cases = [
        ("steady 285", {}),
        ("ramp 290 to 250 from 60 s to 180 s", {"amplitudeRamp": {"from": 290, "to": 250, "t0": 60, "t1": 180}}),
        ("step 285 to 255 at 120 s", {"amplitudeRamp": {"from": 285, "to": 255, "t0": 120, "t1": 120.5}}),
        ("wandering 285 +- 10, every 60 s", {"amplitudeSwing": {"base": 285, "swing": 10, "period": 60}}),
    ]
    drifts = (0.5, 1.0, 2.0)
    summary = {}
    for name, over in cases:
        for seed in (91, 92):
            prefix = os.path.join(outdir, ("%s seed %d" % (name, seed)).replace(" ", "_").replace(",", ""))
            subprocess.run(["node", os.path.join(HERE, "beats.mjs"), "sim", "coaxial", prefix, json.dumps(dict(over, seed=seed, seconds=180))], capture_output=True, text=True, check=True)
            truth_file = json.load(open(prefix + ".truth.json"))
            truth = lambda t, spec=truth_file["amplitudeSpec"]: float(np.mean(true_amplitude(spec, 285.0, np.atleast_1d(t))))
            ref, o = prepare(prefix + ".wav", prefix + ".stream.json", lift, reference_seconds)
            os.remove(prefix + ".wav")
            bph = o["bph"]
            if ref.pair is None:
                print("%s, seed %d: no reference: %s" % (name, seed, ref.why))
                continue
            amp = lambda t: ev.amplitude(lift, bph, t)
            print("%s, seed %d: reference from the first %d s (%d+%d beats): %.0f degrees" % (name, seed, reference_seconds, ref.beats[0], ref.beats[1], amp(0.5 * sum(ref.lift))))
            for drift in drifts:
                rows = follow(ref, block_seconds, drift, bph, lift)
                if drift == 1.0:
                    show(rows, bph, lift, truth)
                # Blocks after the reference stretch are the test: the filter has not seen them.
                later = [r for r in rows if r["t"] > reference_seconds and r["state"] is not None]
                block_err = [amp(r["z"]) - truth(r["t"]) for r in later if r["z"] is not None]
                filter_err = [amp(r["state"]) - truth(r["t"]) for r in later]
                key = (name, drift)
                s = summary.setdefault(key, {"block": [], "filter": [], "missing": 0, "gated": 0, "blocks": 0})
                s["block"] += block_err
                s["filter"] += filter_err
                s["missing"] += sum(1 for r in later if r["z"] is None)
                s["gated"] += sum(1 for r in later if r["z"] is not None and not r["used"])
                s["blocks"] += len(later)
    print()
    rms = lambda v: float(np.sqrt(np.mean(np.square(v)))) if len(v) else float("nan")
    for (name, drift), s in summary.items():
        print("%-36s drift %.1f deg/s: blocks alone rms error %.1f, worst %.1f; filter rms error %.1f, worst %.1f; %d blocks, %d without a measurement, %d gated out" % (
            name, drift, rms(s["block"]), max(np.abs(s["block"])) if s["block"] else float("nan"), rms(s["filter"]), max(np.abs(s["filter"])) if s["filter"] else float("nan"), s["blocks"], s["missing"], s["gated"]))


def read_tracks(path):
    """The tracks printed by `sims` or `recording`: a list of (heading, rows)."""
    import re
    row = re.compile(r"^\s+(\d+) s\s+beats\s+\d+\+\s*\d+\s+(?:true\s+([\d.]+)\s+)?(?:block\s+([\d.]+) \+-\s+([\d.]+)(\*| )|block: no measurement)\s+(?:filter\s+([\d.]+) \+-\s+([\d.]+))?")
    tracks = []
    for text in open(path):
        m = row.match(text)
        if m and tracks:
            f = lambda v: float(v) if v is not None else np.nan
            tracks[-1][1].append({"t": f(m.group(1)), "true": f(m.group(2)), "block": f(m.group(3)), "sd": f(m.group(4)), "gated": m.group(5) == "*", "filter": f(m.group(6)), "filter_sd": f(m.group(7))})
        elif not text.startswith(" ") and text.strip():
            tracks.append((text.strip(), []))
    return [t for t in tracks if t[1]]


def figure(sims_path, recording_path, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    surface, ink, ink2, grid = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
    blue, orange = "#2a78d6", "#eb6834"
    plt.rcParams.update({"font.size": 11, "axes.edgecolor": grid, "axes.labelcolor": ink2, "xtick.color": ink2, "ytick.color": ink2, "text.color": ink})
    sims = [t for t in read_tracks(sims_path) if "seed 91" in t[0]]
    capture = read_tracks(recording_path)[0]
    titles = ["Simulated: steady at 285\u00b0", "Simulated: falling from 290\u00b0 to 250\u00b0", "Simulated: dropping from 285\u00b0 to 255\u00b0 at once", "Simulated: wandering by \u00b110\u00b0 every 60 s"]
    fig = plt.figure(figsize=(8.2, 10.2), facecolor=surface)
    grid_spec = fig.add_gridspec(3, 2, height_ratios=[1, 1, 0.9])
    axes = [fig.add_subplot(grid_spec[i // 2, i % 2]) for i in range(4)] + [fig.add_subplot(grid_spec[2, :])]

    def draw(ax, rows, title, ylim, legend):
        t = np.array([r["t"] for r in rows])
        ax.set_facecolor(surface)
        if not np.isnan(rows[0]["true"]):
            ax.plot(t, [r["true"] for r in rows], color=ink, lw=1.4, ls=(0, (4, 2)), label="true amplitude", zorder=2)
        ok = np.array([not np.isnan(r["block"]) for r in rows])
        b = np.array([r["block"] for r in rows])
        e = np.array([r["sd"] for r in rows])
        gated = np.array([r["gated"] for r in rows])
        ax.errorbar(t[ok], b[ok], yerr=e[ok], fmt="none", ecolor=blue, elinewidth=1, alpha=0.55, zorder=3)
        ax.plot(t[ok & ~gated], b[ok & ~gated], "o", ms=5, color=blue, mec=surface, mew=1, label="each 10 s block", zorder=4)
        if (ok & gated).any():
            ax.plot(t[ok & gated], b[ok & gated], "o", ms=5, mfc=surface, mec=blue, mew=1.4, label="block left out by the filter", zorder=4)
        ax.plot(t, [r["filter"] for r in rows], color=orange, lw=2, label="filter", zorder=5)
        ax.set_ylim(*ylim)
        ax.set_title(title, loc="left", fontsize=11.5, color=ink, pad=8)
        ax.grid(True, axis="y", color=grid, lw=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        if legend:
            ax.legend(loc=legend, frameon=False, fontsize=9.5, handlelength=1.6)

    for i, (ax, (_, rows)) in enumerate(zip(axes, sims)):
        draw(ax, rows, titles[i], (240, 304), "lower left" if i == 2 else None)
        ax.set_xticks(np.arange(0, 181, 60))
        ax.axvspan(0, 60, color=grid, alpha=0.45, lw=0, zorder=0)
        if i == 0:
            ax.text(30, 243, "reference", ha="center", va="bottom", color=ink2, fontsize=9.5)
        if i % 2 == 0:
            ax.set_ylabel("amplitude, degrees")
        if i >= 2:
            ax.set_xlabel("seconds")
    draw(axes[4], capture[1], "Omega 3861, Safari capture, 36\u00b0 lift angle", (272, 296), "lower right")
    axes[4].set_xlabel("seconds")
    axes[4].set_ylabel("amplitude, degrees")
    axes[4].set_xticks(np.arange(0, 61, 10))
    fig.tight_layout(h_pad=1.6)
    fig.savefig(out, dpi=150, facecolor=surface)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "figure":
        figure(sys.argv[2], sys.argv[3], sys.argv[4])
    elif len(sys.argv) == 5 and sys.argv[1] == "recording":
        recording(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    elif len(sys.argv) == 3 and sys.argv[1] == "sims":
        sims(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
