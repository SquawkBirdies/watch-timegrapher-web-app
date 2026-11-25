"""Swing-bias check: how much lining the beats up again takes out, against the truth.

The prototype lines the beats up again before averaging by default (track.Reference and
events.measure, `reline`): blocks of the reference stretch say how far each sound has moved, each
beat is shifted by that, once for the unlock and once for the lock, and averaged again, so that
the moving sound stands sharp. This script reads one watch both ways, with the plain average and
lined up again, and scores both against the simulator's true unlock and lock of every beat.

usage: python3 -I tools/prototype/coaxial/bias/realign.py <coaxial|lever> <file.wav> <stream.json> [events.json] [seconds]

The audio and <stream.json> come from `beats.mjs sim`, <events.json> from `truth.mjs` with the
same overrides. [seconds] is the length of the reference stretch, 60 by default. For each way it
prints the reference stretch's amplitude, then the 10 s blocks after the reference against the
true amplitude of each block's beats: how many were measured, their rms error, worst and mean.
The truth is given both from the beats' mean lift time and as the mean of each beat's own
amplitude, which is higher when the amplitude swings. For a recording, leave <events.json> out:
each block's amplitude is printed both ways.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402
import events as ev  # noqa: E402
import track as tk  # noqa: E402

LIFT = {"coaxial": 36, "lever": 50}
BLOCK_S = 10.0


def rms(v):
    return float(np.sqrt(np.mean(np.square(v))))


def main(argv):
    if len(argv) < 3 or argv[0] not in LIFT:
        sys.exit(__doc__)
    kind, wav, stream = argv[:3]
    rest = argv[3:]
    events = rest.pop(0) if rest and rest[0].endswith(".json") else None
    lift = LIFT[kind]
    fs, x = ev.load_wav(wav)
    ref_s = min(float(rest[0]) if rest else 60.0, len(x) / fs)
    B = ev.load_beats(stream)
    o = ev.measure(None, fs, B, lift, 0, rows=ev.band_rows(x, fs), reline=False)
    if "stacks" not in o:
        sys.exit("no beats to average: " + o["why"])
    bph, tms, base_until, times = o["bph"], o["tms"], o["base_until"], o["times"]

    def amp(t_ms):
        return ev.amplitude(lift, bph, t_ms)

    if events:
        with open(events) as f:
            truth = json.load(f)
        U, L = np.array(truth["unlock"]), np.array(truth["lock"])
        mid = 0.5 * (U + L)

    def true_lifts(tj):
        """True time from unlock to lock of the beats nearest these timestamps, in ms."""
        k = np.clip(np.searchsorted(mid, tj), 1, len(mid) - 1)
        k = np.where(np.abs(mid[k - 1] - tj) < np.abs(mid[k] - tj), k - 1, k)
        return (L[k] - U[k]) * 1e3

    # The 10 s blocks after the reference stretch, with enough beats of both types.
    t_end = max(t.max() for t in times)
    blocks = []
    for a in np.arange(ref_s, t_end - BLOCK_S + 1e-9, BLOCK_S):
        idx = [np.flatnonzero((t >= a) & (t < a + BLOCK_S)) for t in times]
        if min(len(i) for i in idx) >= tk.MIN_BEATS:
            blocks.append((a + 0.5 * BLOCK_S, idx))

    if events:
        before = [true_lifts(times[j][times[j] < ref_s]) for j in (0, 1)]
        print("truth over the reference stretch: amplitude %.1f from the mean lift, %.1f as the mean of each beat's" % (
            amp(0.5 * sum(v.mean() for v in before)), np.mean(np.concatenate([amp(v) for v in before]))))
    readings = {}
    for label, reline in (("plain", False), ("lined up again", True)):
        ref = tk.Reference(o["stacks"], times, tms, base_until, bph, lift, ref_s, nearest=True, reline=reline, levels=o["levels"])
        if ref.pair is None:
            print("%s: no reference: %s" % (label, ref.why))
            continue
        note = " (%s)" % ref.relined if reline else ""
        print("%s%s: reference stretch amplitude %.1f" % (label, note, amp(0.5 * sum(ref.stretch_lift))))
        readings[label] = [ref.block(idx) for _, idx in blocks]
        if not events:
            continue
        errs = []
        for (_, idx), got in zip(blocks, readings[label]):
            if got is not None:
                true_a = np.mean(np.concatenate([amp(true_lifts(times[j][idx[j]])) for j in (0, 1)]))
                errs.append(amp(got) - true_a)
        if errs:
            print("  blocks after the reference: %d of %d measured, rms %.1f, worst %.1f, mean %+.1f degrees" % (
                len(errs), len(blocks), rms(errs), np.max(np.abs(errs)), np.mean(errs)))
        else:
            print("  blocks after the reference: none of %d measured" % len(blocks))
    if not events:
        for b, (t, _) in enumerate(blocks):
            print("  block at %3.0f s: %s" % (t, ", ".join(
                "%s %s" % (label, "-" if v[b] is None else "%.1f" % amp(v[b])) for label, v in readings.items())))


if __name__ == "__main__":
    main(sys.argv[1:])
