"""Swing-bias check: where the averaged beat puts the unlock and the lock, against the truth.

For one simulated watch, the reference stretch is averaged on the app's timestamps with the plain
average, and the times of the sounds it finds are set against the true unlock and lock of every
beat that went into the average, each measured from that beat's own timestamp. The search is run
at the half-rise the prototype uses and at later points on the rising edge, and at the peak.

usage: python3 -I tools/prototype/coaxial/bias/where.py <coaxial|lever> <file.wav> <stream.json> <events.json> [seconds] [--compact]

The audio and <stream.json> come from `beats.mjs sim`, <events.json> from `truth.mjs` with the
same overrides. [seconds] is the length of the reference stretch, 60 by default. --compact
prints one line per search point: the amplitude found, the true one, and how far each sound
found lies from its true mean.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np  # noqa: E402
import events as ev  # noqa: E402

LIFT = {"coaxial": 36, "lever": 50}
# The prototype's half-rise, later points on the rising edge, and the peak.
VARIANTS = [("rise 0.5 (the method)", {}, False), ("rise 0.65", {"rise": 0.65}, False),
            ("rise 0.8", {"rise": 0.8}, False), ("rise 0.9", {"rise": 0.9}, False), ("peak", {}, True)]


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if len(args) < 4 or args[0] not in LIFT:
        sys.exit(__doc__)
    kind, wav, stream, events = args[:4]
    t_to = float(args[4]) if len(args) > 4 else 60.0
    compact = "--compact" in argv
    lift = LIFT[kind]
    fs, x = ev.load_wav(wav)
    with open(events) as f:
        truth = json.load(f)
    U, L = np.array(truth["unlock"]), np.array(truth["lock"])
    mid = 0.5 * (U + L)
    B = ev.load_beats(stream)
    rows = ev.band_rows(x, fs)

    def offsets(tj):
        """True unlock and lock of each stacked beat, in ms after its timestamp."""
        k = np.clip(np.searchsorted(mid, tj), 1, len(mid) - 1)
        k = np.where(np.abs(mid[k - 1] - tj) < np.abs(mid[k] - tj), k - 1, k)
        return (U[k] - tj) * 1e3, (L[k] - tj) * 1e3

    def amp(t_ms):
        return ev.amplitude(lift, B["bph"], t_ms)

    for label, find, peak in VARIANTS:
        # The plain average: lining the beats up again would hide the smear this measures.
        o = ev.measure(None, fs, B, lift, 0, t_from=0.0, t_to=t_to, rows=rows, find=find, use_peak=peak, reline=False)
        r = o["reading"]
        if r is None:
            print("%s: no reading: %s" % (label, o["why"]))
            continue
        true = [offsets(o["times"][j]) for j in (0, 1)]
        true_lift = np.mean([np.mean(dl - du) for du, dl in true])
        found = amp(0.5 * (r["lift0"] + r["lift1"]))
        if compact:
            offs = ["u%d %+.3f (sd %.2f) l%d %+.3f (sd %.2f)" % (j, r["f%d" % j] - du.mean(), du.std(), j, r["l%d" % j] - dl.mean(), dl.std())
                    for j, (du, dl) in enumerate(true)]
            print("  %-22s amplitude %.1f, true %.1f, error %+.1f; found minus true, ms: %s" % (label, found, amp(true_lift), found - amp(true_lift), "; ".join(offs)))
            continue
        print("%s: amplitude %.1f from the found times, %.1f from the true mean times" % (label, found, amp(true_lift)))
        for j, (du, dl) in enumerate(true):
            print("  beat %d: unlock found %+.3f, true mean %+.3f (sd %.3f, %+.3f to %+.3f); lock found %+.3f, true mean %+.3f (sd %.3f); lift found %.3f, true mean %.3f ms" % (
                j, r["f%d" % j], du.mean(), du.std(), du.min(), du.max(), r["l%d" % j], dl.mean(), dl.std(), r["lift%d" % j], (dl - du).mean()))


if __name__ == "__main__":
    main(sys.argv[1:])
