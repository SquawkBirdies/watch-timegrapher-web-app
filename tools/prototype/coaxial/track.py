"""Prototype: follow the amplitude over time with a slow Kalman filter.

The unlock is too faint to time in a single beat, so the beat tracker cannot carry the
amplitude. This works one level up. A reference stretch of beats, long enough to find the
unlock and the lock (events.py), gives their places in the averaged beat. The recording is cut
into short blocks from its first beat, the reference stretch included, and each block's beats
are averaged too. Each sound is matched against the reference's to see how far it has moved:
of the matches within 1.5 ms of its place in the reference that are strong enough, the one
nearest that place is taken, not the strongest, so that a louder neighbour reaching into the
search cannot be taken for the sound. That gives the block's time from unlock to lock, with an uncertainty from resampling the
block's beats. A one-state Kalman filter then follows that time from block to block:

    state        t_k, the mean time from unlock to lock over the two beats, in milliseconds
    model        t_k+1 = t_k + w,   w ~ N(0, q * seconds between blocks)
    measurement  z_k = t_k + v,     v ~ N(0, R_k), R_k from resampling block k

and the amplitude is the usual formula applied to t_k, shown only while its own uncertainty is
5 degrees or less. A block further than 3 standard deviations from the filter is left out, but
when two measured blocks in a row are both left out and agree with each other, the filter
starts again from them: a sudden change is believed once it has been seen twice. `recording`
and `sims` also print the filter without that restart, as it was before, for comparison.

The sounds of the reference's beats that move against the timestamps are lined up again before
averaging (Reference.reline, events.moved), so that a change of amplitude during the reference
does not smear the sound whose place moves with it. With `lined` every sound is lined up, as
from 18 November until the test was added the same day; with `plain` the reference is the plain
average, as before. `both` runs `sims`, `swings` and `steady` plain and lined on every watch,
`three` all three ways, and the words `plain`, `lined` and `test` (the default) can also be
given together. With more than one way, `sims` and `swings` also read each watch whole each
way, as analyze.py would.

usage: python3 -I tools/prototype/coaxial/track.py recording <file.wav> <prefix> <lift angle> [strongest] [plain|lined]
       python3 -I tools/prototype/coaxial/track.py sims <directory> [coaxial|lever] [strongest] [plain|lined|test|both|three]
       python3 -I tools/prototype/coaxial/track.py swings <directory> [coaxial|lever] [plain|lined|test|both|three] [seeds...]
       python3 -I tools/prototype/coaxial/track.py steady <directory> [coaxial|lever] [plain|lined|test|both|three] [runs] [seconds]
       python3 -I tools/prototype/coaxial/track.py figure <sims output> <recording output> out.png

`recording` reads <prefix>.stream.json from `beats.mjs stream`. `sims` makes simulated watches
whose amplitude changes in a known way, co-axial (36° lift angle, 21,600 vph) unless `lever`
(50°, 28,800 vph) is given, and takes about half an hour. `strongest` gives the earlier search,
which took the strongest match. `figure` draws the tracks from what the other two printed, saved
to files. A watch an earlier run left in the directory is not timed again: only its audio is
made again (`beats.mjs synth`), and the truth it gives is checked against the earlier run's.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import events as ev

MIN_BEATS = 10        # fewest beats of each type in a block
GATE = 3.0            # a block further than this many standard deviations from the filter is left out
DRIFT_DEG = 2.0       # how far the amplitude may wander in a second, the filter's default: at 1, it
                      # kept only a third of a 15 degree swing once a minute (see `swings`)
DASH_DEG = 5.0        # a dash rather than the filter's value while its own uncertainty is over this,
                      # as for the whole-recording reading, so that a value held over blocks with no
                      # measurement is not shown


# Matching a sound against a template, shared with events.py's lining up again.
smoothed = ev.matched
shift_of = ev.shift_of
MAX_SHIFT_MS, STRONG = ev.MAX_SHIFT_MS, ev.STRONG


def portraits(S, tms, idx, base_until, weights=None, levels=None):
    """The averaged tick and tock of the chosen beats, and the band weights used: by energy
    when the bands' levels are given (events.WEIGHTING), otherwise by noise."""
    got = [ev.band_means(S[j], tms, idx[j], base_until, with_base=True) for j in (0, 1)]
    means = [m for m, _ in got]
    if weights is None:
        weights = ev.mix_weights(means[0], means[1], got[0][1], got[1][1], tms, base_until, levels)
    return [ev.portrait(m, weights) for m in means], weights


class Reference:
    """Where the unlock and the lock are in the averaged beat of a reference stretch."""

    def __init__(self, S, times, tms, base_until, bph, lift, until, nearest=True, reline="test", levels=None):
        self.S, self.times, self.tms, self.base_until = S, times, tms, base_until
        # Take the strong match nearest each sound's place (True) or the strongest (False, the
        # earlier search).
        self.nearest = nearest
        idx = [np.flatnonzero(t < until) for t in times]
        raw, self.weights = portraits(S, tms, idx, base_until, levels=levels)
        sounds = [ev.find_sounds(c, tms, base_until)[0] for c in raw]
        self.pair, self.why = ev.pair_beats(sounds[0], sounds[1], bph, lift)
        self.beats = [len(i) for i in idx]
        self.relined = None
        self.moved = None
        if self.pair is not None:
            self.lift = [self.pair["lift0"], self.pair["lift1"]]
            # The reference stretch's own reading of each beat type's lift
            self.stretch_lift = list(self.lift)
            # Each sound is matched against a template of it: the stretch of the reference from
            # before the sound starts to after it is loudest.
            self.templates = [[smoothed(c, tms)] * 2 for c in raw]
            self.windows = [ev.windows_of(self.pair, j) for j in (0, 1)]
            if reline:
                self.reline(idx, until, test=reline == "test")

    def reline(self, idx, until, test=False):
        """Line the reference's beats up again before averaging, as events.measure does with
        reline: blocks within the reference say how far each sound has moved, each beat is
        shifted by that once for the unlock and once for the lock, and the two lined-up averages
        become the templates. Blocks are then measured against those, and the lift where the
        shifts are zero comes from them too, so a block's lift is that plus its own shifts.
        With `test`, only the sounds whose block shifts show a change are lined up (events.moved);
        the others keep a shift of zero, and when none moves the reference stays plain. A block's
        shift that scatters by more than events.RELINE_MAX_SD_MS over its resamples is left out
        (events.reliable)."""
        S = [[M[idx[j]] for M in self.S[j]] for j in (0, 1)]
        times = [self.times[j][idx[j]] for j in (0, 1)]
        blocks = ev.block_shifts(S, times, self.tms, self.base_until, self.weights, self.templates, self.windows, until=until, resamples=ev.TEST_RESAMPLES)
        use = ev.moved(blocks) if test else None
        self.moved = use
        # As events.measure does: a block's shift that took another sound in some of its
        # resamples is not lined up on.
        blocks, left_out = ev.reliable(blocks)
        if use is not None and not any(u["moved"] for row in use for u in row):
            self.relined = "not lined up again: no sound moved: " + ev.describe_moved(use)
            return
        shifts = ev.beat_shifts(blocks, times, use)
        if shifts is None:
            self.relined = "not lined up again: a sound was placed in fewer than two blocks"
            return
        templates, windows, lift = [], [], []
        for j in (0, 1):
            found = []
            for k, name in ((0, "f"), (1, "l")):
                c = ev.portrait(ev.band_means(ev.shift_rows(S[j], self.tms, shifts[j][k]), self.tms, None, self.base_until), self.weights)
                sounds, _ = ev.find_sounds(c, self.tms, self.base_until)
                near = self.pair[name + str(j)]["onset_ms"]
                e = min(sounds, key=lambda e: abs(e["onset_ms"] - near)) if sounds else None
                if e is None or abs(e["onset_ms"] - near) > ev.RELINE_NEAR_MS:
                    self.relined = "not lined up again: a sound was lost in the lined-up average"
                    return
                found.append((c, e))
            templates.append([smoothed(c, self.tms) for c, _ in found])
            windows.append([(e["onset_ms"] - 0.5, e["peak_ms"] + 0.5) for _, e in found])
            lift.append(found[1][1]["onset_ms"] - found[0][1]["onset_ms"])
        self.templates, self.windows, self.lift = templates, windows, lift
        self.stretch_lift = [lift[j] + float(np.mean(shifts[j][1] - shifts[j][0])) for j in (0, 1)]
        n_out = ev.count_left_out(left_out, use)
        self.relined = "lined up again on %d blocks" % len(blocks[0][0]) + (
            ", leaving out %d shift%s that scattered by more than %.1f ms" % (n_out, "" if n_out == 1 else "s", ev.RELINE_MAX_SD_MS) if n_out else "") + (
            ": " + ev.describe_moved(use) if use is not None else "")

    def block(self, idx):
        """Mean time from unlock to lock of the beats in idx (one index array per beat type), or
        None when a sound could not be placed."""
        raw, _ = portraits(self.S, self.tms, idx, self.base_until, self.weights)
        lifts = []
        for j in (0, 1):
            c = smoothed(raw[j], self.tms)
            su = shift_of(self.templates[j][0], c, self.tms, *self.windows[j][0], self.nearest)
            sl = shift_of(self.templates[j][1], c, self.tms, *self.windows[j][1], self.nearest)
            if su is None or sl is None:
                return None
            lifts.append(self.lift[j] + sl - su)
        return 0.5 * (lifts[0] + lifts[1])


def measure_blocks(ref, block_seconds, resamples=40, seed=1):
    """Measure every block: one dict per block with its middle time, how many beats, and its
    time from unlock to lock with the scatter of that under resampling (None when a block gave
    no measurement)."""
    rng = np.random.default_rng(seed)
    t_end = max(t.max() for t in ref.times)
    t0 = min(t.min() for t in ref.times)
    out = []
    a = t0
    while a + block_seconds <= t_end + 0.5:
        idx = [np.flatnonzero((t >= a) & (t < a + block_seconds)) for t in ref.times]
        row = {"t": a + 0.5 * block_seconds, "beats": [len(i) for i in idx], "z": None, "sd": None}
        if min(len(i) for i in idx) >= MIN_BEATS:
            z = ref.block(idx)
            if z is not None:
                zs = [ref.block([rng.choice(i, len(i)) for i in idx]) for _ in range(resamples)]
                zs = np.array([v for v in zs if v is not None])
                if len(zs) >= 0.8 * resamples:
                    row["z"], row["sd"] = z, max(float(zs.std()), 0.02)
        out.append(row)
        a += block_seconds
    return out


def run_filter(ref, blocks, block_seconds, drift_deg, bph, lift, restart=True):
    """Run the filter over measured blocks. Returns a copy of each block with whether the filter
    used it, and the filter's value and uncertainty after it.

    drift_deg  how far the amplitude may wander in one second, in degrees: the filter's q
    restart    start again from two measured blocks in a row that the gate left out but that
               agree with each other; False gives the earlier filter, gate only"""
    t_ref = 0.5 * (ref.lift[0] + ref.lift[1])
    # One degree of amplitude in milliseconds of unlock-to-lock time, near the reference.
    ms_per_deg = t_ref / ev.amplitude(lift, bph, t_ref)
    q = (drift_deg * ms_per_deg) ** 2
    state, var = None, None
    left_out = []
    out = []
    for block in blocks:
        row = dict(block, used=False, restarted=False)
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
                left_out = []
            else:
                left_out.append(row)
                a, b = left_out[-2:] if len(left_out) >= 2 else (None, None)
                if restart and a is not None and abs(a["z"] - b["z"]) <= GATE * np.hypot(a["sd"], b["sd"]):
                    w = [1 / a["sd"] ** 2, 1 / b["sd"] ** 2]
                    state = (w[0] * a["z"] + w[1] * b["z"]) / sum(w)
                    var = 1 / sum(w)
                    row["used"], row["restarted"] = True, True
                    left_out = []
        row["state"], row["state_sd"] = state, (None if var is None else float(np.sqrt(var)))
        out.append(row)
    return out


def follow(ref, block_seconds, drift_deg, bph, lift, resamples=40, seed=1, restart=True):
    """Measure every block and run the filter over the measurements."""
    return run_filter(ref, measure_blocks(ref, block_seconds, resamples, seed), block_seconds, drift_deg, bph, lift, restart)


def true_amplitude(spec, constant, t):
    t = np.asarray(t, dtype=float)
    if spec and "swing" in spec:
        s = spec["swing"]
        return s["base"] + s["swing"] * np.sin(2 * np.pi * t / s["period"])
    if spec and "ramp" in spec:
        r = spec["ramp"]
        return np.where(t <= r["t0"], r["from"], np.where(t >= r["t1"], r["to"], r["from"] + (r["to"] - r["from"]) * (t - r["t0"]) / (r["t1"] - r["t0"])))
    return np.full(t.shape, constant)


class NoReference:
    """What stands for the reference when the app timed too few beats to stack: no pair, and
    why. Until 25 November building a Reference from such a result failed with a KeyError."""

    pair = None
    relined = None

    def __init__(self, why):
        self.why = why


def reference_of(o, lift, reference_seconds, nearest=True, reline="test"):
    """The reference from the stacked beats of a plain `events.measure` result, or a
    NoReference saying why there are none."""
    if "stacks" not in o:
        return NoReference(o["why"])
    return Reference(o["stacks"], o["times"], o["tms"], o["base_until"], o["bph"], lift, reference_seconds, nearest, reline, o["levels"])


def prepare(wav, stream_json, lift, reference_seconds, nearest=True, reline="test"):
    fs, x = ev.load_wav(wav)
    B = ev.load_beats(stream_json)
    # Only the stacked beats are wanted here; the reference does its own lining up.
    o = ev.measure(x, fs, B, lift, 0, reline=False)
    return reference_of(o, lift, reference_seconds, nearest, reline), o


def filter_sd_deg(row, amp):
    """The filter's uncertainty after a block, in degrees of amplitude."""
    return amp(row["state"]) * row["state_sd"] / row["state"]


def shown(row, amp):
    """Whether an app would show the filter's value after this block, rather than a dash."""
    return row["state"] is not None and filter_sd_deg(row, amp) <= DASH_DEG


def show(rows, bph, lift, truth=None):
    """Print each block and the filter after it; "dash" marks a value an app would not show."""
    amp = lambda t: ev.amplitude(lift, bph, t)
    for r in rows:
        line = "  %5.0f s  beats %2d+%2d  " % (r["t"], r["beats"][0], r["beats"][1])
        if truth is not None:
            line += "true %5.1f  " % truth(r["t"])
        if r["z"] is None:
            line += "block: no measurement       "
        else:
            # The scatter of the amplitude that goes with the scatter of the time.
            line += "block %5.1f +- %4.1f%s  " % (amp(r["z"]), amp(r["z"]) * r["sd"] / r["z"], "r" if r.get("restarted") else " " if r["used"] else "*")
        if r["state"] is not None:
            line += "filter %5.1f +- %4.1f%s" % (amp(r["state"]), filter_sd_deg(r, amp), "" if shown(r, amp) else "  dash")
        print(line)


def recording(wav, prefix, lift, nearest=True, reline="test"):
    fs, x = ev.load_wav(wav)
    seconds = len(x) / fs
    ref, o = prepare(wav, prefix + ".stream.json", lift, seconds + 1, nearest, reline)
    if ref.pair is None:
        print("no reference: " + ref.why)
        return
    print("reference: all %d+%d beats, unlock to lock %.2f and %.2f ms, amplitude %.0f degrees%s" % (
        ref.beats[0], ref.beats[1], ref.stretch_lift[0], ref.stretch_lift[1], ev.amplitude(lift, o["bph"], 0.5 * sum(ref.stretch_lift)), "; " + ref.relined if ref.relined else ""))
    for block_seconds in (10, 15):
        print("blocks of %d s, amplitude allowed to wander by %g degrees in a second; * = left out by the filter's gate, r = the filter started again:" % (block_seconds, DRIFT_DEG))
        show(follow(ref, block_seconds, DRIFT_DEG, o["bph"], lift), o["bph"], lift)
    print("blocks of 10 s, %g degrees in a second, gate only (the filter without the restart):" % DRIFT_DEG)
    show(follow(ref, 10, DRIFT_DEG, o["bph"], lift, restart=False), o["bph"], lift)


def simulate(outdir, kind, name, over, seed, seconds):
    """Make one simulated watch with beats.mjs. When an earlier run of the same watch left its
    timestamps in outdir, only the audio is made again (`beats.mjs synth`, under a second): the
    same overrides and seed make the same watch, and the app's analysis is the slow part. Both
    kinds start from the same 285 degrees, so that their results compare directly. Returns what
    the analyses below need: the plain whole-recording measure, the band envelopes, the beats,
    the beat rate, the lift angle and the truth."""
    lift = 36 if kind == "coaxial" else 50
    prefix = os.path.join(outdir, ("%s seed %d" % (name, seed)).replace(" ", "_").replace(",", ""))
    args = json.dumps(dict({"amplitude": 285}, **over, seed=seed, seconds=seconds))
    script = os.path.join(HERE, "beats.mjs")
    if os.path.exists(prefix + ".stream.json") and os.path.exists(prefix + ".truth.json"):
        before = json.load(open(prefix + ".truth.json"))
        subprocess.run(["node", script, "synth", kind, prefix, args], capture_output=True, text=True, check=True)
        if json.load(open(prefix + ".truth.json")) != before:
            raise RuntimeError(prefix + ": the watch made again is not the one the earlier run timed")
    else:
        subprocess.run(["node", script, "sim", kind, prefix, args], capture_output=True, text=True, check=True)
    fs, x = ev.load_wav(prefix + ".wav")
    os.remove(prefix + ".wav")
    rows = ev.band_rows(x, fs)
    B = ev.load_beats(prefix + ".stream.json")
    # Only the stacked beats are wanted here; the reference does its own lining up.
    o = ev.measure(None, fs, B, lift, 0, rows=rows, reline=False)
    truth = json.load(open(prefix + ".truth.json"))
    return {"o": o, "rows": rows, "fs": fs, "B": B, "whole": ev.load_beats(prefix + ".beats.json"), "bph": o["bph"], "lift": lift, "truth": truth, "spec": truth["amplitudeSpec"]}


def reference(sim, reference_seconds, nearest=True, reline="test"):
    return reference_of(sim["o"], sim["lift"], reference_seconds, nearest, reline)


# The two ways of averaging that `sims`, `swings` and `steady` compare when given `both`.
WAYS = {False: "plain average", True: "lined up", "test": "lined up if moved"}
# The words that choose them on the command line, in any combination.
WAY_WORDS = {"plain": (False,), "lined": (True,), "test": ("test",), "both": (False, True), "three": (False, True, "test")}


def whole(sim, reline, resamples=100):
    """The whole-recording reading, as analyze.py gives it from the app's whole-recording
    timestamps, against the truth: amplitude error, beat error error, and whether each would be
    shown. None when there is no reading."""
    o = ev.measure(None, sim["fs"], sim["whole"], sim["lift"], resamples, rows=sim["rows"], reline=reline)
    r = o["reading"]
    if r is None or "sd" not in o:
        return None
    t = sim["truth"]
    true_amp = ev.amplitude(sim["lift"], sim["bph"], 0.5 * (t["liftMs"][0] + t["liftMs"][1]))
    return {"amp": o["amp"] - true_amp, "be": abs(r["first_gap"]) - abs(t["unlockGapMs"]), "show_amp": o["show_amplitude"], "show_be": o["show_beat_error"], "relined": o.get("relined")}


def whole_summary(label, got, runs):
    """One line on the whole-recording readings of several watches."""
    got = [g for g in got if g]
    amp = [g["amp"] for g in got if g["show_amp"]]
    be = [g["be"] for g in got if g["show_be"]]
    return "%s whole recording: amplitude shown in %d of %d, error %s; beat error shown in %d, error %s" % (
        label, len(amp), runs, ("%+.1f to %+.1f" % (min(amp), max(amp))) if amp else "-", len(be), ("%+.2f to %+.2f ms" % (min(be), max(be))) if be else "-")


def block_truth(spec, t, block_seconds):
    """The true amplitude averaged over the block centred on t, which is what a block can see."""
    return float(true_amplitude(spec, 285.0, np.linspace(t - 0.5 * block_seconds, t + 0.5 * block_seconds, 201)).mean())


def swing_fit(t, v, period):
    """Fit v = c + a sin(2 pi (t - lag) / period) by least squares. Returns a and lag in seconds."""
    w = 2 * np.pi / period
    X = np.column_stack([np.ones_like(t), np.sin(w * t), np.cos(w * t)])
    c = np.linalg.lstsq(X, v, rcond=None)[0]
    phase = np.arctan2(c[2], c[1])
    return float(np.hypot(c[1], c[2])), float(-phase / w)


def swings(outdir, kind="coaxial", ways=(True,), seeds=(91, 92, 93, 94)):
    """Larger and faster swings than `sims` tries. Witschi's training document says the meshing of
    the gears can move a watch's amplitude by up to 30 degrees, and that this is normal. In most
    movements the wheel that carries the seconds hand turns once a minute, hence the 60 s swings;
    the 5 s swing is faster than a block. Errors are against the true amplitude averaged over each
    block, and the share of the swing kept is from fitting a sine of the known period. With both
    ways, each watch is also read whole, as analyze.py reads a recording, against its truth."""
    os.makedirs(outdir, exist_ok=True)
    reference_seconds, block_seconds = 60, 10
    drifts = (1.0, 2.0, 4.0)
    cases = [
        ("swinging 285 +- 15, every 60 s", 15, 60),
        ("swinging 285 +- 30, every 60 s", 30, 60),
        ("swinging 285 +- 15, every 5 s", 15, 5),
    ]
    summary, wholes = {}, {}
    for name, swing, period in cases:
        for seed in seeds:
            sim = simulate(outdir, kind, name, {"amplitudeSwing": {"base": 285, "swing": swing, "period": period}}, seed, 180)
            bph, lift, spec = sim["bph"], sim["lift"], sim["spec"]
            amp = lambda t: ev.amplitude(lift, bph, t)
            truth = lambda t: block_truth(spec, t, block_seconds)
            for way in ways:
                label = "%s, seed %d, %s" % (name, seed, WAYS[way])
                # 50 resamples rather than analyze.py's 200: enough to say shown or held back.
                got = whole(sim, way, 50) if len(ways) > 1 else None
                wholes.setdefault((name, way), []).append(got)
                if got and got["relined"]:
                    print("%s: whole recording %s" % (label, got["relined"]))
                ref = reference(sim, reference_seconds, reline=way)
                if ref.pair is None:
                    print("%s: no reference: %s" % (label, ref.why))
                    continue
                print("%s: reference from the first %d s (%d+%d beats): %.1f degrees%s" % (label, reference_seconds, ref.beats[0], ref.beats[1], amp(0.5 * sum(ref.stretch_lift)), "; " + ref.relined if ref.relined else ""))
                blocks = measure_blocks(ref, block_seconds)
                for drift in drifts:
                    rows = run_filter(ref, blocks, block_seconds, drift, bph, lift)
                    if drift == DRIFT_DEG:
                        print("%s, %.0f degrees a second (true = averaged over the block):" % (label, drift))
                        show(rows, bph, lift, truth)
                    later = [r for r in rows if r["t"] > reference_seconds and r["state"] is not None]
                    measured = [r for r in later if r["z"] is not None]
                    s = summary.setdefault((name, way, drift), {"block": [], "filter": [], "shown": [], "missing": 0, "gated": 0, "blocks": 0, "restarts": 0, "kept": [], "lag": []})
                    s["block"] += [amp(r["z"]) - truth(r["t"]) for r in measured]
                    s["filter"] += [amp(r["state"]) - truth(r["t"]) for r in later]
                    # As an app would show it, with a dash while the filter is unsure.
                    s["shown"] += [amp(r["state"]) - truth(r["t"]) for r in later if shown(r, amp)]
                    s["missing"] += len(later) - len(measured)
                    s["gated"] += sum(1 for r in measured if not r["used"])
                    s["restarts"] += sum(1 for r in rows if r["restarted"])
                    s["blocks"] += len(later)
                    if period >= 2 * block_seconds and len(measured) >= 3:
                        t = np.array([r["t"] for r in later])
                        seen, _ = swing_fit(t, np.array([truth(x) for x in t]), period)
                        a_blocks, lag_blocks = swing_fit(np.array([r["t"] for r in measured]), np.array([amp(r["z"]) for r in measured]), period)
                        a_filter, lag_filter = swing_fit(t, np.array([amp(r["state"]) for r in later]), period)
                        s["kept"].append((seen / swing, a_blocks / swing, a_filter / swing))
                        s["lag"].append((lag_blocks, lag_filter))
    print()
    rms = lambda v: float(np.sqrt(np.mean(np.square(v)))) if len(v) else float("nan")
    worst = lambda v: float(np.max(np.abs(v))) if len(v) else float("nan")
    for (name, way, drift), s in summary.items():
        line = "%-32s %-14s %.1f deg/s: blocks rms %.1f, worst %.1f, mean %+.1f; filter rms %.1f, worst %.1f; shown within %g degrees of uncertainty %d of %d, rms %.1f, worst %.1f; %d without a measurement, %d gated out, %d restarts" % (
            name, WAYS[way], drift, rms(s["block"]), worst(s["block"]), np.mean(s["block"]) if s["block"] else float("nan"), rms(s["filter"]), worst(s["filter"]),
            DASH_DEG, len(s["shown"]), s["blocks"], rms(s["shown"]), worst(s["shown"]), s["missing"], s["gated"], s["restarts"])
        if s["kept"]:
            k = np.mean(s["kept"], axis=0)
            lag = np.mean(s["lag"], axis=0)
            line += "; share of the swing kept: by averaging over a block %.2f, blocks %.2f, filter %.2f; filter %.1f s behind the blocks" % (k[0], k[1], k[2], lag[1] - lag[0])
        print(line)
    if len(ways) > 1:
        print()
        for (name, way), got in wholes.items():
            print(whole_summary("%-32s %-14s" % (name, WAYS[way]), got, len(got)))


def steady(outdir, kind="coaxial", runs=16, seconds=180, ways=(True,)):
    """How often the restart fires when nothing changes: many runs at a steady 285 degrees, where
    every restart is a false one. Counts restarts and gated blocks at each setting, how far the
    filter strays, and how often an app would show a dash. Many short runs rather than a few long
    ones, because making a simulated watch takes far longer than its length grows: a 180 s one
    takes about 2 minutes, a 600 s one over 15."""
    os.makedirs(outdir, exist_ok=True)
    reference_seconds, block_seconds = 60, 10
    drifts = (0.5, 1.0, 2.0, 4.0)
    summary = {(w, d): {"blocks": 0, "measured": 0, "gated": 0, "restarts": 0, "filter": [], "shown": [], "after": []} for w in ways for d in drifts}
    block_err = {w: [] for w in ways}
    block_z = {w: [] for w in ways}
    for seed in range(101, 101 + runs):
        sim = simulate(outdir, kind, "steady 285 for %d s" % seconds, {}, seed, seconds)
        bph, lift = sim["bph"], sim["lift"]
        amp = lambda t: ev.amplitude(lift, bph, t)
        for way in ways:
            ref = reference(sim, reference_seconds, reline=way)
            if ref.pair is None:
                print("seed %d, %s: no reference: %s" % (seed, WAYS[way], ref.why))
                continue
            blocks = measure_blocks(ref, block_seconds)
            later = [b for b in blocks if b["t"] > reference_seconds and b["z"] is not None]
            # Each block's error, and that error in units of its own scatter under resampling.
            block_err[way] += [amp(b["z"]) - 285.0 for b in later]
            t_ref = 0.5 * sum(ref.stretch_lift)
            block_z[way] += [(b["z"] - t_ref) / b["sd"] for b in later]
            line = "seed %d, %s: reference %.1f degrees, %d blocks after it, %d measured" % (seed, WAYS[way], amp(0.5 * sum(ref.stretch_lift)), sum(1 for b in blocks if b["t"] > reference_seconds), len(later))
            for drift in drifts:
                rows = run_filter(ref, blocks, block_seconds, drift, bph, lift)
                scored = [r for r in rows if r["t"] > reference_seconds and r["state"] is not None]
                s = summary[(way, drift)]
                s["blocks"] += len(scored)
                s["measured"] += sum(1 for r in scored if r["z"] is not None)
                s["gated"] += sum(1 for r in scored if r["z"] is not None and not r["used"])
                s["filter"] += [amp(r["state"]) - 285.0 for r in scored]
                s["shown"] += [amp(r["state"]) - 285.0 for r in scored if shown(r, amp)]
                for i, r in enumerate(rows):
                    if r["restarted"]:
                        s["restarts"] += 1
                        s["after"] += [amp(x["state"]) - 285.0 for x in rows[i:i + 3]]
                line += "; %.1f deg/s: %d gated, %d restarts" % (drift, sum(1 for r in scored if r["z"] is not None and not r["used"]), sum(1 for r in rows if r["restarted"]))
            print(line)
    print()
    rms = lambda v: float(np.sqrt(np.mean(np.square(v)))) if len(v) else float("nan")
    for way in ways:
        z = np.abs(np.array(block_z[way]))
        print("%s blocks: %d measured, error rms %.1f, worst %.1f degrees; beyond 2, 3 and 4 times their own scatter: %d, %d, %d" % (
            WAYS[way], len(block_err[way]), rms(block_err[way]), max(np.abs(block_err[way])), (z > 2).sum(), (z > 3).sum(), (z > 4).sum()))
    for (way, drift), s in summary.items():
        # With none seen in n blocks, the rate is below 3/n with 95% confidence.
        bound = " (so fewer than 1 in %d blocks, with 95%% confidence)" % (s["measured"] // 3) if s["restarts"] == 0 else ""
        print("%s, %.1f deg/s: %d blocks scored, %d measured, %d gated out, %d restarts%s; filter rms %.1f, worst %.1f degrees; shown within %g degrees of uncertainty %d, rms %.1f, worst %.1f%s" % (
            WAYS[way], drift, s["blocks"], s["measured"], s["gated"], s["restarts"], bound, rms(s["filter"]), max(np.abs(s["filter"])),
            DASH_DEG, len(s["shown"]), rms(s["shown"]), max(np.abs(s["shown"])) if s["shown"] else float("nan"),
            "; worst within two blocks after a restart %.1f" % max(np.abs(s["after"])) if s["after"] else ""))


def sims(outdir, kind="coaxial", nearest=True, ways=(True,)):
    os.makedirs(outdir, exist_ok=True)
    reference_seconds, block_seconds = 60, 10
    cases = [
        ("steady 285", {}),
        ("ramp 290 to 250 from 60 s to 180 s", {"amplitudeRamp": {"from": 290, "to": 250, "t0": 60, "t1": 180}}),
        ("step 285 to 255 at 120 s", {"amplitudeRamp": {"from": 285, "to": 255, "t0": 120, "t1": 120.5}}),
        ("wandering 285 +- 10, every 60 s", {"amplitudeSwing": {"base": 285, "swing": 10, "period": 60}}),
    ]
    drifts = (0.5, 1.0, 2.0, 4.0)
    summary, wholes = {}, {}
    for name, over in cases:
        for seed in (91, 92):
            sim = simulate(outdir, kind, name, over, seed, 180)
            bph, lift = sim["bph"], sim["lift"]
            truth = lambda t, spec=sim["spec"]: float(np.mean(true_amplitude(spec, 285.0, np.atleast_1d(t))))
            amp = lambda t: ev.amplitude(lift, bph, t)
            for way in ways:
                tag = "" if len(ways) == 1 else ", " + WAYS[way]
                if len(ways) > 1:
                    got = whole(sim, way, 50)
                    wholes.setdefault((name, way), []).append(got)
                    if got and got["relined"]:
                        print("%s, seed %d%s: whole recording %s" % (name, seed, tag, got["relined"]))
                ref = reference(sim, reference_seconds, nearest, way)
                if ref.pair is None:
                    print("%s, seed %d%s: no reference: %s" % (name, seed, tag, ref.why))
                    continue
                print("%s, seed %d%s: reference from the first %d s (%d+%d beats): %.0f degrees" % (name, seed, tag, reference_seconds, ref.beats[0], ref.beats[1], amp(0.5 * sum(ref.stretch_lift))))
                blocks = measure_blocks(ref, block_seconds)
                for drift, restart in [(d, r) for r in (True, False) for d in drifts]:
                    rows = run_filter(ref, blocks, block_seconds, drift, bph, lift, restart)
                    if drift == DRIFT_DEG:
                        if not restart:
                            print("%s, seed %d%s, gate only (the filter without the restart):" % (name, seed, tag))
                        show(rows, bph, lift, truth)
                    # Blocks after the reference stretch are the test: the filter has not seen them.
                    later = [r for r in rows if r["t"] > reference_seconds and r["state"] is not None]
                    s = summary.setdefault((name, way, drift, restart), {"block": [], "filter": [], "shown": [], "missing": 0, "gated": 0, "blocks": 0, "restarts": 0})
                    s["block"] += [amp(r["z"]) - truth(r["t"]) for r in later if r["z"] is not None]
                    s["filter"] += [amp(r["state"]) - truth(r["t"]) for r in later]
                    s["shown"] += [amp(r["state"]) - truth(r["t"]) for r in later if shown(r, amp)]
                    s["missing"] += sum(1 for r in later if r["z"] is None)
                    s["gated"] += sum(1 for r in later if r["z"] is not None and not r["used"])
                    s["restarts"] += sum(1 for r in rows if r["restarted"])
                    s["blocks"] += len(later)
    print()
    rms = lambda v: float(np.sqrt(np.mean(np.square(v)))) if len(v) else float("nan")
    worst = lambda v: float(np.max(np.abs(v))) if len(v) else float("nan")
    for (name, way, drift, restart), s in summary.items():
        print("%-36s %sdrift %.1f deg/s%s: blocks alone rms error %.1f, worst %.1f; filter rms error %.1f, worst %.1f; shown within %g degrees of uncertainty %d, rms %.1f, worst %.1f; %d blocks, %d without a measurement, %d gated out, %d restarts" % (
            name, "" if len(ways) == 1 else WAYS[way] + ", ", drift, "" if restart else ", gate only", rms(s["block"]), worst(s["block"]), rms(s["filter"]), worst(s["filter"]),
            DASH_DEG, len(s["shown"]), rms(s["shown"]), worst(s["shown"]), s["blocks"], s["missing"], s["gated"], s["restarts"]))
    if len(ways) > 1:
        print()
        for (name, way), got in wholes.items():
            print(whole_summary("%-36s %-14s" % (name, WAYS[way]), got, len(got)))


def read_tracks(path):
    """The tracks printed by `sims` or `recording`: a list of (heading, rows)."""
    import re
    row = re.compile(r"^\s+(\d+) s\s+beats\s+\d+\+\s*\d+\s+(?:true\s+([\d.]+)\s+)?(?:block\s+([\d.]+) \+-\s+([\d.]+)(\*| |r)|block: no measurement)\s+(?:filter\s+([\d.]+) \+-\s+([\d.]+))?")
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
    sims = [t for t in read_tracks(sims_path) if "seed 91" in t[0] and "gate only" not in t[0]]
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
    words = sys.argv[3:]
    ways = tuple(dict.fromkeys(w for word in words for w in WAY_WORDS.get(word, ()))) or ("test",)
    kind = "lever" if "lever" in words else "coaxial"
    numbers = [int(w) for w in words if w.isdigit()]
    if len(sys.argv) == 5 and sys.argv[1] == "figure":
        figure(sys.argv[2], sys.argv[3], sys.argv[4])
    elif len(sys.argv) >= 5 and sys.argv[1] == "recording":
        recording(sys.argv[2], sys.argv[3], float(sys.argv[4]), "strongest" not in sys.argv[5:], False if "plain" in sys.argv[5:] else True if "lined" in sys.argv[5:] else "test")
    elif len(sys.argv) >= 3 and sys.argv[1] == "sims":
        sims(sys.argv[2], kind, "strongest" not in words, ways)
    elif len(sys.argv) >= 3 and sys.argv[1] == "swings":
        swings(sys.argv[2], kind, ways, tuple(numbers) or (91, 92, 93, 94))
    elif len(sys.argv) >= 3 and sys.argv[1] == "steady":
        steady(sys.argv[2], kind, *numbers[:2], ways=ways)
    else:
        print(__doc__)
        sys.exit(1)
