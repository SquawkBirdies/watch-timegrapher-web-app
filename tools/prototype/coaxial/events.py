"""Prototype: beat error and amplitude from the sounds inside each beat.

The app gives each beat one timestamp, at the loudest part of its averaged sound. In a
co-axial escapement the loudest part is a different event in the two beats, so the gap
between the timestamps is not the beat error. This prototype finds the sounds inside each
beat, takes the first as the unlock and the last loud one as the lock, and pairs them between
the two beats:

    beat error  = how far the tock's unlock falls from midway between the ticks' unlocks
    amplitude   = lift angle / (2 sin(pi f t)),  t = mean time from unlock to lock

It reads audio and the JSON written by beats.mjs. Run the scripts that use it with
python3 -I. It needs numpy and scipy.
"""
import json
import numpy as np
from scipy import signal, stats
from scipy.io import wavfile

# The app's filter-bank bands from 5 kHz up, in hertz.
HF_BANDS = [(5000, 7000), (7000, 9000), (9000, 11500), (11500, 14500), (14500, 18000), (18000, 22500)]

# A reading is shown only when resampling the beats supports it.
MAX_SD_MS = 0.1      # largest scatter of the beat error over the resamples, as the app's gate
MAX_AMP_SD = 5.0     # largest scatter of the amplitude over the resamples, in degrees
MAX_FAIL = 0.05      # largest share of resamples in which the sounds are not found

# Matching a sound in a short stretch of beats against a template of it.
MATCH_SMOOTH_MS = 0.15  # as find_sounds smooths a portrait
MAX_SHIFT_MS = 1.5      # furthest a sound is looked for from its place in the template
STRONG = 0.5            # a match counts if it is at least this share of the template against itself

# Lining the beats up again (`measure`'s reline).
RELINE_BLOCK_S = 10.0   # blocks whose sounds are matched against the whole stretch's
RELINE_MIN_BEATS = 10   # fewest beats of each type in a block
RELINE_NEAR_MS = 1.0    # how far a lined-up sound may be from where the plain average put it

# Lining up only the sounds that move (`measure`'s reline="test", the default). A sound whose
# block shifts scatter no more than their own resampled scatter allows is left on the plain
# average.
TEST_RESAMPLES = 40     # resamples of each block's beats for the scatter of its shifts, as the filter's
TEST_P = 0.01           # the chance that a sound which does not move is lined up all the same
TEST_MIN_BLOCKS = 2     # fewest blocks in which a sound was placed for it to be tested at all
TEST_MIN_SD_MS = 0.01   # floor on a block shift's scatter, so that a loud sound's tiny one cannot
                        # turn a hundredth of a millisecond into a change


def load_wav(path, channel=0):
    fs, x = wavfile.read(path)
    if x.ndim > 1:
        x = x[:, channel]
    if x.dtype.kind == "i":
        x = x.astype(np.float64) / np.iinfo(x.dtype).max
    return fs, x.astype(np.float64)


def load_beats(path):
    with open(path) as f:
        return json.load(f)


def smooth(e, k):
    if k <= 1:
        return e
    w = np.hanning(k + 2)[1:-1]
    return np.convolve(e, w / w.sum(), mode="same")


def band_rows(x, fs, bands=HF_BANDS, smooth_ms=0.10):
    """Energy envelope of each band at the audio's own rate, divided by the band's median.
    Zero-phase filters."""
    rows = []
    for lo, hi in bands:
        if hi >= 0.49 * fs:
            continue
        sos = signal.butter(4, [lo, hi], btype="band", fs=fs, output="sos")
        y = signal.sosfiltfilt(sos, x)
        e = smooth(y * y, max(1, int(round(smooth_ms * 1e-3 * fs))))
        rows.append(e / np.median(e))
    return rows


def app_rows(x, fs, bands=HF_BANDS, envelope_rate=12000):
    """Envelopes made the way the app's filter bank makes them: a causal fourth-order
    high-pass and low-pass per band, then the mean square of every few samples, which gives
    12 kHz from 48 kHz audio. No clipping and no mains comb. Returns the rows and their rate."""
    dec = max(1, round(fs / envelope_rate))
    rows = []
    for lo, hi in bands:
        if hi >= 0.47 * fs:
            continue
        y = signal.sosfilt(signal.butter(4, lo, btype="highpass", fs=fs, output="sos"), x)
        y = signal.sosfilt(signal.butter(4, hi, btype="lowpass", fs=fs, output="sos"), y)
        n = len(y) // dec
        e = (y[: n * dec] ** 2).reshape(n, dec).mean(axis=1)
        rows.append(e / np.median(e))
    return rows, fs / dec


def beat_times(beats, j):
    """Times and beat numbers of the beats of type j. When the app timed every beat on its
    own, those timestamps are used. When it averaged several cycles per timestamp, every beat
    is placed on the trend of the confident timestamps instead."""
    b = beats["beats"][j]
    t = np.array(b["t"])
    n = np.array(b["n"])
    ok = np.array(b["ok"]).astype(bool)
    if b["K"] == 1:
        return t[ok], n[ok]
    slope, icpt = np.polyfit(n[ok], t[ok], 1)
    r = signal.medfilt(t[ok] - (icpt + slope * n[ok]), 15)
    nn = np.arange(np.ceil(n[ok].min()), np.floor(n[ok].max()) + 1)
    nn = nn[(nn - j) % 2 == 0]
    return icpt + slope * nn + np.interp(nn, n[ok], r), nn


def stack(e, fs, times, before, after):
    """Rows of e around each time, linearly interpolated to the exact timestamp. Also returns
    which of the times had the whole stretch inside the recording."""
    win = np.arange(-int(before * fs), int(after * fs) + 1)
    rows = []
    kept = []
    for i, tt in enumerate(times):
        pos = tt * fs + win
        if pos[0] < 0 or pos[-1] >= len(e) - 1:
            continue
        i0 = np.floor(pos).astype(np.int64)
        fr = pos - i0
        rows.append(e[i0] * (1 - fr) + e[i0 + 1] * fr)
        kept.append(i)
    return np.array(rows), win / fs * 1e3, np.array(kept, dtype=int)


def stacks(rows, fs, times, before=0.040, after=0.012):
    """One matrix per band: every beat's envelope around its timestamp. Also returns the
    times of the beats that are in the matrices."""
    out = []
    tms = None
    kept = np.arange(len(times))
    for e in rows:
        M, tms, kept = stack(e, fs, times, before, after)
        out.append(M)
    return out, tms, np.asarray(times)[kept]


def robust_sd(v):
    """Scatter from the median absolute deviation, so that a few dips or spikes do not count."""
    return 1.4826 * np.median(np.abs(v - np.median(v)))


def band_means(S, tms, idx=None, base_until=-14.0):
    """Mean over beats of each band with the highest and lowest 5% of beats left out at each
    instant, as an excess over the band's level before the beat. One loud click in a single
    beat therefore does not show."""
    out = []
    for M in S:
        m = stats.trim_mean(M if idx is None else M[idx], 0.05, axis=0)
        base = np.median(m[tms < base_until])
        out.append(m / base - 1.0)
    return np.array(out)


def shared_weights(means0, means1, tms, base_until=-14.0):
    """One set of band weights for both beats, so that the tick and the tock are drawn from the
    same mixture of bands. A band counts for more the further the beats stand above its noise."""
    w = np.zeros(len(means0))
    for means in (means0, means1):
        sd = np.array([robust_sd(m[tms < base_until]) for m in means])
        w += np.maximum(means.max(axis=1), 0) / (sd * sd + 1e-30)
    return w / w.sum()


def portrait(means, weights):
    """The averaged beat: the bands added with their weights, as an excess over the noise in
    units of the noise level."""
    return (weights[:, None] * means).sum(axis=0)


def find_sounds(c, tms, base_until=-14.0, min_z=5.0, min_prom_db=2.5, smooth_ms=0.15, guard=1.5, rise=0.5):
    """The sounds in a portrait. Each is a local maximum of the smoothed curve that stands above
    the valley before it and above anything the stretch before the beat shows: `min_z` times its
    scatter and `guard` times its highest point. A sound's onset is where its rising edge is
    the fraction `rise` of the way, in energy, from that valley to the maximum."""
    dt = tms[1] - tms[0]
    k = max(1, int(round(smooth_ms / dt)))
    s = smooth(c, k)
    quiet = s[tms < base_until]
    noise = robust_sd(quiet)
    threshold = max(min_z * noise, guard * quiet.max())
    floor = 3.0 * noise
    db = 10 * np.log10(np.maximum(s, floor) / floor)
    peaks, _ = signal.find_peaks(db, prominence=min_prom_db, distance=max(1, int(0.3 / dt)))
    sounds = []
    for p in peaks:
        if s[p] < threshold or tms[p] < base_until:
            continue
        start = sounds[-1]["ipeak"] if sounds else np.searchsorted(tms, base_until)
        v = start + int(np.argmin(s[start:p + 1]))
        vlev = max(s[v], 0.0) if sounds else 0.0
        level = vlev + rise * (s[p] - vlev)
        i = p
        while i > v and s[i] > level:
            i -= 1
        frac = (level - s[i]) / (s[i + 1] - s[i] + 1e-30)
        sounds.append({
            "ipeak": int(p),
            "peak_ms": float(tms[p]),
            "onset_ms": float(tms[i] + frac * dt),
            "level": float(s[p]),
            "level_db": float(10 * np.log10(s[p] / noise)),
        })
    return sounds, noise


def matched(c, tms):
    """A portrait smoothed as find_sounds smooths it, for matching."""
    return smooth(c, max(1, int(round(MATCH_SMOOTH_MS / (tms[1] - tms[0])))))


def shift_of(ref, blk, tms, lo, hi, nearest=True):
    """How much later, in milliseconds, a sound comes in `blk` than in `ref`, looked for within
    MAX_SHIFT_MS. The match at each shift is the product of the reference's stretch from lo to
    hi and the block's portrait, each with its mean taken off: a matched filter, which suits a
    faint sound in noise. With `nearest`, of the peaks in the match at least STRONG times the
    reference's product with itself, the one nearest no shift is taken, so that a louder sound
    reaching into the search cannot win; without, the largest. None when no peak qualifies, or
    when the largest is at the edge of the search."""
    dt = tms[1] - tms[0]
    i0, i1 = np.searchsorted(tms, lo), np.searchsorted(tms, hi)
    g = ref[i0:i1] - ref[i0:i1].mean()
    n = int(round(MAX_SHIFT_MS / dt))
    if i0 - n < 0 or i1 + n > len(blk):
        return None
    score = np.array([np.dot(g, blk[i0 + k:i1 + k] - blk[i0 + k:i1 + k].mean()) for k in range(-n, n + 1)])
    if nearest:
        floor = STRONG * np.dot(g, g)
        peaks = [k for k in range(1, len(score) - 1) if score[k] >= max(score[k - 1], score[k + 1], floor)]
        if not peaks:
            return None
        k = min(peaks, key=lambda k: abs(k - n))
    else:
        k = int(np.argmax(score))
        if k == 0 or k == len(score) - 1:
            return None
    a, b, c = score[k - 1], score[k], score[k + 1]
    frac = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    return (k - n + frac) * dt


def windows_of(pair, j):
    """The stretches of a template matched for beat type j's unlock and lock: from before each
    sound starts to after it is loudest."""
    return [(pair[k + str(j)]["onset_ms"] - 0.5, pair[k + str(j)]["peak_ms"] + 0.5) for k in ("f", "l")]


def block_shifts(S, times, tms, base_until, weights, templates, windows, block_seconds=RELINE_BLOCK_S, until=None, resamples=0, seed=1):
    """How far each beat type's unlock and lock have moved, block by block, against templates of
    them. templates[j] and windows[j] hold the unlock's and the lock's. Returns for each type the
    middle times of the blocks and the two shifts in milliseconds, NaN where a sound could not
    be placed. With `resamples`, each block's beats are also resampled that many times and the
    scatter of each shift is returned after the shifts, NaN where fewer than four in five
    resamples placed the sound, as the filter requires of a block."""
    t0 = min(t.min() for t in times)
    t_end = max(t.max() for t in times) if until is None else until
    rng = np.random.default_rng(seed)
    out = []
    for j in (0, 1):
        mids, su, sl, du, dl = [], [], [], [], []
        a = t0
        while a + block_seconds <= t_end + 0.5:
            idx = [np.flatnonzero((t >= a) & (t < a + block_seconds)) for t in times]
            if min(len(i) for i in idx) >= RELINE_MIN_BEATS:
                c = matched(portrait(band_means(S[j], tms, idx[j], base_until), weights), tms)
                shifts = [shift_of(templates[j][k], c, tms, *windows[j][k]) for k in (0, 1)]
                mids.append(a + 0.5 * block_seconds)
                su.append(np.nan if shifts[0] is None else shifts[0])
                sl.append(np.nan if shifts[1] is None else shifts[1])
                if resamples:
                    drawn = [[shift_of(templates[j][k], cb, tms, *windows[j][k]) for k in (0, 1)]
                             for cb in (matched(portrait(band_means(S[j], tms, rng.choice(idx[j], len(idx[j])), base_until), weights), tms) for _ in range(resamples))]
                    for k, d in ((0, du), (1, dl)):
                        got = [v[k] for v in drawn if v[k] is not None]
                        d.append(float(np.std(got)) if len(got) >= 0.8 * resamples else np.nan)
            a += block_seconds
        out.append((np.array(mids), np.array(su), np.array(sl)) + ((np.array(du), np.array(dl)) if resamples else ()))
    return out


def moved(blocks, p=TEST_P):
    """Which sounds move against the beats' timestamps, from block_shifts with resamples. If a
    sound does not move, its n shifts s_i scatter about their weighted mean as their own scatter
    sd_i says, and sum(((s_i - mean) / sd_i)^2) follows a chi-squared distribution with n - 1
    degrees of freedom; the sound counts as moving when the sum is beyond the point that
    chance passes with probability p. Returns for each beat type and sound (unlock, lock) a dict
    with `moved`, `chi2`, `dof` and the `limit` it was held to; a sound placed in fewer than
    TEST_MIN_BLOCKS blocks is not tested and does not count as moving."""
    out = []
    for j in (0, 1):
        _, su, sl, du, dl = blocks[j]
        row = []
        for s, d in ((su, du), (sl, dl)):
            ok = ~np.isnan(s) & ~np.isnan(d)
            n = int(ok.sum())
            if n < TEST_MIN_BLOCKS:
                row.append({"moved": False, "chi2": float("nan"), "dof": max(n - 1, 0), "limit": float("nan")})
                continue
            w = 1.0 / np.maximum(d[ok], TEST_MIN_SD_MS) ** 2
            mean = float((w * s[ok]).sum() / w.sum())
            chi2 = float((w * (s[ok] - mean) ** 2).sum())
            limit = float(stats.chi2.ppf(1 - p, n - 1))
            row.append({"moved": chi2 > limit, "chi2": chi2, "dof": n - 1, "limit": limit})
        out.append(row)
    return out


def beat_shifts(blocks, times, use=None):
    """Each beat's unlock and lock shift, read off a line through the blocks and held level
    beyond the first and last. None when a sound was placed in fewer than two blocks of a type:
    then there is nothing to line up on. With `use` (from `moved`), a sound that does not move
    keeps a shift of zero, so it stays where the plain average puts it, and only the sounds that
    move need placing in two blocks."""
    out = []
    for j in (0, 1):
        mids, su, sl = blocks[j][:3]
        per = []
        for k, s in enumerate((su, sl)):
            if use is not None and not use[j][k]["moved"]:
                per.append(np.zeros(len(times[j])))
                continue
            ok = ~np.isnan(s)
            if ok.sum() < 2:
                return None
            per.append(np.interp(times[j], mids[ok], s[ok]))
        out.append(per)
    return out


def describe_moved(use):
    """Which sounds `moved` found moving, and each sound's sum against its limit, as text."""
    parts = []
    for j, beat in ((0, "tick"), (1, "tock")):
        for k, sound in ((0, "unlock"), (1, "lock")):
            u = use[j][k]
            if np.isnan(u["chi2"]):
                parts.append("%s %s not tested" % (beat, sound))
            else:
                parts.append("%s %s %s (%.1f against %.1f on %d)" % (beat, sound, "moves" if u["moved"] else "steady", u["chi2"], u["limit"], u["dof"]))
    return ", ".join(parts)


def shift_rows(S, tms, s_ms):
    """The stacked beats with each beat read s_ms later, so that a sound that comes s_ms late in
    that beat lines up with the others."""
    return [np.array([np.interp(tms + s, tms, row) for row, s in zip(M, s_ms)]) for M in S]


def lift_limits(bph, lift_deg=None, amp_lo=150.0, amp_hi=330.0):
    """Shortest and longest believable time from unlock to lock, in milliseconds: an amplitude
    of 150 to 330 degrees. Above 330, Witschi's fault table expects the balance to knock against
    its banking (overbanking). Without a lift angle, any from 30 to 55 degrees is allowed for."""
    f = bph / 7200.0
    lo_l, hi_l = (lift_deg, lift_deg) if lift_deg else (30.0, 55.0)
    return 1e3 * np.arcsin(lo_l / (2 * amp_hi)) / (np.pi * f), 1e3 * np.arcsin(hi_l / (2 * amp_lo)) / (np.pi * f)


def pair_beats(s0, s1, bph, lift_deg=None, max_ratio=1.18):
    """Choose the unlock and the lock of each beat. The unlock is a beat's first sound. The lock
    is chosen for both beats together: among the later sounds, the pair whose times from the
    unlock agree between the two beats within `max_ratio` and whose quieter member, measured
    against its own beat's loudest sound, is loudest. Returns None and the reason when that
    pair's times are not believable for a watch, or when there is no such pair."""
    if len(s0) < 2 or len(s1) < 2:
        return None, "fewer than two sounds in a beat"
    lo, hi = lift_limits(bph, lift_deg)
    f0, f1 = s0[0], s1[0]
    top0 = max(e["level"] for e in s0)
    top1 = max(e["level"] for e in s1)
    best = None
    for a in s0[1:]:
        for b in s1[1:]:
            t0 = a["onset_ms"] - f0["onset_ms"]
            t1 = b["onset_ms"] - f1["onset_ms"]
            if max(t0, t1) / min(t0, t1) > max_ratio:
                continue
            score = min(a["level"] / top0, b["level"] / top1)
            if best is None or score > best[0]:
                best = (score, a, b, t0, t1)
    if best is None:
        return None, "no two sounds the same time after the first in both beats"
    _, a, b, t0, t1 = best
    if not (lo <= t0 <= hi and lo <= t1 <= hi):
        return None, "time from first sound to lock (%.1f and %.1f ms) outside %.1f to %.1f ms" % (t0, t1, lo, hi)
    return {"f0": f0, "l0": a, "f1": f1, "l1": b, "lift0": t0, "lift1": t1}, ""


def amplitude(lift_deg, bph, t_ms):
    f = bph / 7200.0
    return lift_deg / (2 * np.sin(np.pi * f * t_ms * 1e-3))


def measure(x, fs, B, lift, nboot=200, t_from=None, t_to=None, seed=1, weights=None, rows=None, find=None, use_peak=False, reline="test"):
    """Portraits, sounds and paired readings for one recording.

    x, fs    audio and its sample rate; or pass `rows` (band envelopes) with fs as their rate
    B        the JSON written by beats.mjs
    lift     lift angle in degrees
    nboot    resamples of the beats for the uncertainty; 0 for none
    t_from, t_to   use only the beats between these times, in seconds
    weights  band weights to use instead of working them out
    find     keyword arguments for find_sounds; use_peak times sounds at their maxima
    reline   True lines the beats up again before averaging (False gives the plain
             average, as before 18 November), so that a sound whose place moves with
             the amplitude is not smeared: the beats' timestamps follow their loudest sound, and
             when the amplitude swings the other sound's place moves with the lift time. Blocks
             of RELINE_BLOCK_S are matched against the plain average to see how far the unlock
             and the lock have moved; each beat is shifted by that, once for each sound, and
             averaged again. A smeared sound's half-rise lands early, which biased the reading.
             Each resample measures the blocks again from the beats it drew and lines those
             beats up on what it found, so the shifts' own noise is in the uncertainty.
             Falls back to the plain average, with `relined` saying why, when a sound is placed
             in fewer than two blocks.
             reline="test", the default since 18 November, lines up only the sounds whose
             block shifts show a change (`moved`):
             a sound that does not move is left where the plain average puts it, and when none
             moves the reading is the plain average's, resamples and all. The choice is made
             once, on all the beats; each resample then lines up the same sounds. `moved` in
             the result says what the test found.

    Returns a dict. `reading` is None, with `why`, when the sounds could not be paired.
    Otherwise it holds, in milliseconds, `first_gap` (the tock's unlock later than midway between
    the ticks' unlocks; its size is the beat error), `last_gap` (the same for the locks) and
    `lift0`, `lift1` (unlock to lock in the ticks and in the tocks).
    """
    find = find or {}
    bph = B["bph"]
    lo, hi = lift_limits(bph, lift)
    base_until = -(hi + 1.5)
    rows = band_rows(x, fs) if rows is None else rows
    T = []
    for j in (0, 1):
        t, n = beat_times(B, j)
        if t_from is not None:
            keep = (t >= t_from) & (t < t_to)
            t, n = t[keep], n[keep]
        T.append((t, n))
    # The gap between the app's tick and tock timestamps beyond half a period.
    slope = np.polyfit(np.concatenate([T[0][1], T[1][1]]), np.concatenate([T[0][0], T[1][0]]), 1)[0]
    gap = (np.median(T[1][0] - slope * T[1][1]) - np.median(T[0][0] - slope * T[0][1])) * 1e3
    S = []
    times = []
    # Each stacked beat's distance from the common line, in milliseconds, so that resampling
    # the beats resamples the gap between the timestamp lines too. On a regular watch that gap
    # is known to a hundredth of a millisecond; on an irregular one it is the largest part of
    # the uncertainty, and leaving it out made the readings look far more precise than they are.
    resid = []
    tms = None
    for j in (0, 1):
        Sj, tms, tj = stacks(rows, fs, T[j][0])
        S.append(Sj)
        times.append(tj)
        kept = np.isin(T[j][0], tj)
        resid.append((T[j][0][kept] - slope * T[j][1][kept]) * 1e3)
    n0, n1 = len(S[0][0]), len(S[1][0])

    def readings(idx0=None, idx1=None, w=None):
        g = gap if idx0 is None else float(np.median(resid[1][idx1]) - np.median(resid[0][idx0]))
        m0 = band_means(S[0], tms, idx0, base_until)
        m1 = band_means(S[1], tms, idx1, base_until)
        if w is None:
            w = shared_weights(m0, m1, tms, base_until)
        ports = []
        for m in (m0, m1):
            c = portrait(m, w)
            sounds, noise = find_sounds(c, tms, base_until, **find)
            if use_peak:
                for e in sounds:
                    e["onset_ms"] = e["peak_ms"]
            ports.append((c, sounds, noise))
        pair, why = pair_beats(ports[0][1], ports[1][1], bph, lift)
        if pair is None:
            return None, why, ports, w
        res = {
            "first_gap": g + pair["f1"]["onset_ms"] - pair["f0"]["onset_ms"],
            "last_gap": g + pair["l1"]["onset_ms"] - pair["l0"]["onset_ms"],
            "lift0": pair["lift0"],
            "lift1": pair["lift1"],
            "f0": pair["f0"]["onset_ms"],
            "l0": pair["l0"]["onset_ms"],
            "f1": pair["f1"]["onset_ms"],
            "l1": pair["l1"]["onset_ms"],
            "first_db": min(pair["f0"]["level_db"], pair["f1"]["level_db"]),
            "pair": pair,
        }
        return res, "", ports, w

    r, why, ports, W = readings(w=weights)
    out = {"bph": bph, "lift": lift, "gap": gap, "n0": n0, "n1": n1, "reading": r, "why": why, "ports": ports, "tms": tms, "weights": W, "limits": (lo, hi),
           "stacks": S, "times": times, "base_until": base_until}
    if r is None:
        return out
    if reline:
        pair = r["pair"]
        templates = [[matched(ports[j][0], tms)] * 2 for j in (0, 1)]
        windows = [windows_of(pair, j) for j in (0, 1)]
        test = reline == "test"
        blocks = block_shifts(S, times, tms, base_until, W, templates, windows, resamples=TEST_RESAMPLES if test else 0)
        use = moved(blocks) if test else None
        shifts = beat_shifts(blocks, times, use)
        if use is not None:
            out["moved"] = use
        if use is not None and not any(u["moved"] for row in use for u in row):
            out["relined"] = "not lined up again: no sound moved: " + describe_moved(use)
        elif shifts is None:
            out["relined"] = "not lined up again: a sound was placed in fewer than two blocks of %.0f s" % RELINE_BLOCK_S
        else:
            lined = [[shift_rows(S[j], tms, shifts[j][k]) for k in (0, 1)] for j in (0, 1)]
            # Where the plain average put each sound; the lined-up sound is looked for near it.
            near = [[pair["f%d" % j]["onset_ms"], pair["l%d" % j]["onset_ms"]] for j in (0, 1)]

            def relined(idx0=None, idx1=None, w=None):
                g = gap if idx0 is None else float(np.median(resid[1][idx1]) - np.median(resid[0][idx0]))
                idx = (idx0, idx1)
                use, stacks = shifts, lined
                if idx0 is not None:
                    # The whole procedure again on the drawn beats: their blocks, their shifts,
                    # and the drawn beats lined up on them. A wrong shift moves a lined-up sound
                    # one way and the mean shift added back the other, so drawing the shifts
                    # alone, with the beats left as the whole set lined them up, would overstate
                    # the scatter.
                    drawn = [[M[idx[j]] for M in S[j]] for j in (0, 1)]
                    drawn_times = [times[j][idx[j]] for j in (0, 1)]
                    use = beat_shifts(block_shifts(drawn, drawn_times, tms, base_until, w, templates, windows), drawn_times, out.get("moved"))
                    if use is None:
                        return None, "a sound was placed in fewer than two blocks", ports, w
                    stacks = [[shift_rows(drawn[j], tms, use[j][k]) for k in (0, 1)] for j in (0, 1)]
                at, dbs = [], []
                for j in (0, 1):
                    found = []
                    for k in (0, 1):
                        c = portrait(band_means(stacks[j][k], tms, None, base_until), w)
                        sounds, _ = find_sounds(c, tms, base_until, **find)
                        if not sounds:
                            return None, "a sound was lost in the lined-up average", ports, w
                        e = min(sounds, key=lambda e: abs(e["onset_ms"] - near[j][k]))
                        if abs(e["onset_ms"] - near[j][k]) > RELINE_NEAR_MS:
                            return None, "a lined-up sound is more than %.1f ms from the plain average's" % RELINE_NEAR_MS, ports, w
                        found.append((e["peak_ms"] if use_peak else e["onset_ms"]) + float(np.mean(use[j][k])))
                        if k == 0:
                            dbs.append(e["level_db"])
                    at.append(found)
                lifts = [at[j][1] - at[j][0] for j in (0, 1)]
                if not all(lo <= v <= hi for v in lifts):
                    return None, "lined-up time from unlock to lock (%.1f and %.1f ms) outside %.1f to %.1f ms" % (lifts[0], lifts[1], lo, hi), ports, w
                res = {
                    "first_gap": g + at[1][0] - at[0][0],
                    "last_gap": g + at[1][1] - at[0][1],
                    "lift0": lifts[0],
                    "lift1": lifts[1],
                    "f0": at[0][0], "l0": at[0][1], "f1": at[1][0], "l1": at[1][1],
                    "first_db": min(dbs),
                    "pair": pair,
                }
                return res, "", ports, w

            readings = relined
            r, why, _, _ = readings(w=W)
            out["reading"], out["why"] = r, why
            out["relined"] = "lined up again on %d blocks of %.0f s" % (len(blocks[0][0]), RELINE_BLOCK_S) + (": " + describe_moved(use) if use is not None else "")
            if r is None:
                return out
    out["amp"] = amplitude(lift, bph, 0.5 * (r["lift0"] + r["lift1"]))
    out["amp_tick"] = amplitude(lift, bph, r["lift0"])
    out["amp_tock"] = amplitude(lift, bph, r["lift1"])
    if nboot <= 0:
        return out
    names = ("first_gap", "last_gap", "lift0", "lift1")
    rng = np.random.default_rng(seed)
    boot = []
    for _ in range(nboot):
        rb, _, _, _ = readings(rng.integers(0, n0, n0), rng.integers(0, n1, n1), W)
        if rb is not None:
            boot.append([rb[k] for k in names])
    boot = np.array(boot) if boot else np.zeros((0, 4))
    out["fail"] = 1 - len(boot) / nboot
    if len(boot) > 5:
        out["sd"] = dict(zip(names, boot.std(axis=0)))
        out["amp_sd"] = float(amplitude(lift, bph, 0.5 * (boot[:, 2] + boot[:, 3])).std())
        out["show_beat_error"] = bool(out["fail"] <= MAX_FAIL and out["sd"]["first_gap"] <= MAX_SD_MS)
        out["show_amplitude"] = bool(out["fail"] <= MAX_FAIL and out["amp_sd"] <= MAX_AMP_SD)
    else:
        out["show_beat_error"] = out["show_amplitude"] = False
    return out


def describe(o):
    """The result of `measure` as lines of text."""
    lines = ["beats: %d ticks, %d tocks; gap between the app's timestamps %+.3f ms; believable unlock-to-lock time %.1f to %.1f ms" % (o["n0"], o["n1"], o["gap"], o["limits"][0], o["limits"][1])]
    lines.append("band weights: " + " ".join("%.2f" % v for v in o["weights"]))
    if "relined" in o:
        lines.append(o["relined"])
    for j, name in ((0, "tick"), (1, "tock")):
        for e in o["ports"][j][1]:
            lines.append("  %s sound: starts %+.2f ms, loudest %+.2f ms, %.1f dB over the noise of the average" % (name, e["onset_ms"], e["peak_ms"], e["level_db"]))
    r = o["reading"]
    if r is None:
        lines.append("no reading: " + o["why"])
        return lines
    sd = o.get("sd")
    pm = (lambda k: " +- %.2f" % sd[k]) if sd else (lambda k: "")
    held = lambda shown: "" if shown else "  [held back: the resamples do not agree well enough]"
    lines.append("beat error from the first sounds: %.2f%s ms (the tock's unlock %+.3f ms from midway)%s" % (abs(r["first_gap"]), pm("first_gap"), r["first_gap"], held(o.get("show_beat_error", True))))
    lines.append("gap between the last sounds: %+.2f%s ms" % (r["last_gap"], pm("last_gap")))
    lines.append("unlock to lock: tick %.2f%s ms, tock %.2f%s ms, ratio %.3f" % (r["lift0"], pm("lift0"), r["lift1"], pm("lift1"), r["lift0"] / r["lift1"]))
    lines.append("amplitude at %.0f degrees of lift: %.0f%s degrees (tick alone %.0f, tock alone %.0f)%s" % (
        o["lift"], o["amp"], (" +- %.0f" % o["amp_sd"]) if "amp_sd" in o else "", o["amp_tick"], o["amp_tock"], held(o.get("show_amplitude", True))))
    if "fail" in o:
        lines.append("resamples in which the sounds were not found: %.0f%%; the weaker unlock stands %.1f dB over the noise of the average" % (100 * o["fail"], r["first_db"]))
    return lines
