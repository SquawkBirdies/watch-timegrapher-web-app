"""Checks of the prototype: how much its readings move with the analysis choices, and how it
does on simulated watches whose beat error and amplitude are known.

usage: python3 -I tools/prototype/coaxial/checks.py vary <file.wav> <prefix>.beats.json <lift angle>
       python3 -I tools/prototype/coaxial/checks.py sims <directory for the simulated watches>
       python3 -I tools/prototype/coaxial/checks.py kalman <file.wav> <prefix> <lift angle>
       python3 -I tools/prototype/coaxial/checks.py kalman-sims <directory>

`kalman` compares where the beats are lined up before averaging: on the whole-recording
timestamps (<prefix>.beats.json), or on what the real-time pipeline and a Kalman beat tracker
give (<prefix>.stream.json, from `beats.mjs stream`). `kalman-sims` does the same on simulated
watches.

`sims` runs node on beats.mjs for each watch, so it needs Node 22 or later, and takes about
twenty minutes.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import events as ev


def line(label, o):
    r = o["reading"]
    if r is None:
        print("%-36s no reading: %s" % (label, o["why"]))
        return
    sd = o.get("sd")
    print("%-36s first sounds %+.3f%s ms, last sounds %+.3f ms, unlock to lock %.2f and %.2f ms, amplitude %.0f%s, unlock %.1f dB, beats %d+%d%s" % (
        label, r["first_gap"], (" +- %.3f" % sd["first_gap"]) if sd else "", r["last_gap"], r["lift0"], r["lift1"], o["amp"],
        (" +- %.0f" % o["amp_sd"]) if "amp_sd" in o else "", r["first_db"], o["n0"], o["n1"],
        (", resamples failing %.0f%%, %s" % (100 * o["fail"], "shown" if o["show_beat_error"] else "held back")) if "fail" in o else ""))


def vary(wav, beats, lift):
    fs, x = ev.load_wav(wav)
    B = ev.load_beats(beats)
    rows = ev.band_rows(x, fs)
    seconds = len(x) / fs
    line("whole recording", ev.measure(x, fs, B, lift, 200, rows=rows))
    for win in (30, 20, 15, 10):
        a = 1.0
        while a + win <= seconds + 0.01:
            line("%d s from %.0f s" % (win, a), ev.measure(x, fs, B, lift, 100, a, a + win, rows=rows))
            a += win
    print("analysis choices, whole recording:")
    for rise in (0.25, 0.5, 0.75):
        line("sound starts %.0f%% up its rise" % (100 * rise), ev.measure(x, fs, B, lift, 0, rows=rows, find={"rise": rise}))
    line("sounds timed at their loudest", ev.measure(x, fs, B, lift, 0, rows=rows, use_peak=True))
    for sm in (0.08, 0.25, 0.4):
        line("portrait smoothed over %.2f ms" % sm, ev.measure(x, fs, B, lift, 0, rows=rows, find={"smooth_ms": sm}))
    for k in range(len(rows)):
        w = np.zeros(len(rows))
        w[k] = 1
        line("band %d to %d Hz alone" % ev.HF_BANDS[k], ev.measure(x, fs, B, lift, 0, rows=rows, weights=w))
    line("all bands counted alike", ev.measure(x, fs, B, lift, 0, rows=rows, weights=np.ones(len(rows)) / len(rows)))
    app, fe = ev.app_rows(x, fs)
    line("envelopes as the app makes them", ev.measure(None, fe, B, lift, 200, rows=app, find={"smooth_ms": 0.25}))


def simulate(outdir, name, kind, over, lift):
    prefix = os.path.join(outdir, name.replace(" ", "_").replace(",", ""))
    subprocess.run(["node", os.path.join(HERE, "beats.mjs"), "sim", kind, prefix, json.dumps(over)], capture_output=True, text=True, check=True)
    truth = json.load(open(prefix + ".truth.json"))
    fs, x = ev.load_wav(prefix + ".wav")
    B = ev.load_beats(prefix + ".beats.json")
    os.remove(prefix + ".wav")
    head = "%-36s true %.2f ms and %.0f degrees | " % (name, abs(truth["unlockGapMs"]), truth["meanAmplitude"])
    if any(sum(b["ok"]) < 10 for b in B["beats"]):
        print(head + "the app timed too few beats")
        return None
    o = ev.measure(x, fs, B, lift, 100)
    r = o["reading"]
    if r is None:
        print(head + "no reading: " + o["why"])
        return None
    if "sd" not in o:
        print(head + "no reading: the resamples found no sounds")
        return None
    be = abs(r["first_gap"]) - abs(truth["unlockGapMs"])
    amp = o["amp"] - truth["meanAmplitude"]
    print(head + "read %.2f +- %.2f ms (%+.2f) %s | %.0f +- %.0f degrees (%+.0f) %s | resamples failing %.0f%%, unlock %.1f dB" % (
        abs(r["first_gap"]), o["sd"]["first_gap"], be, "shown" if o["show_beat_error"] else "HELD",
        o["amp"], o["amp_sd"], amp, "shown" if o["show_amplitude"] else "HELD", 100 * o["fail"], r["first_db"]))
    return {"be": be, "amp": amp, "show_be": o["show_beat_error"], "show_amp": o["show_amplitude"]}


def sims(outdir):
    os.makedirs(outdir, exist_ok=True)
    cases = []
    for seed in range(1, 9):
        cases.append(("co-axial in beat", seed, "coaxial", {}, 36))
    for rest, label in ((1.35, "0.5"), (2.7, "1.0"), (-2.7, "1.0 the other way"), (5.4, "2.0")):
        for seed in (11, 12):
            cases.append(("co-axial beat error %s ms" % label, seed, "coaxial", {"restOffsetDeg": rest}, 36))
    for amp in (200, 240, 310):
        for seed in (21, 22):
            cases.append(("co-axial amplitude %d" % amp, seed, "coaxial", {"amplitude": amp}, 36))
    for seed in (31, 32):
        cases.append(("co-axial amplitude wandering", seed, "coaxial", {"amplitudeSwing": {"base": 285, "swing": 10, "period": 23}}, 36))
    for db in (4, 3, 2, 0):
        for seed in (41, 42, 43):
            cases.append(("co-axial unlock %d dB" % db, seed, "coaxial", {"unlockDb": db}, 36))
    for seconds in (30, 20):
        for seed in (51, 52, 53):
            cases.append(("co-axial %d s" % seconds, seed, "coaxial", {"seconds": seconds}, 36))
    for rest, label in ((0, "0"), (1.7, "0.5")):
        for seed in (61, 62):
            cases.append(("lever beat error %s ms" % label, seed, "lever", {"restOffsetDeg": rest}, 50))
    groups = {}
    for group, seed, kind, over, lift in cases:
        groups.setdefault(group, []).append(simulate(outdir, "%s, seed %d" % (group, seed), kind, dict(over, seed=seed), lift))
    print()
    for group, results in groups.items():
        got = [s for s in results if s]
        be = [abs(s["be"]) for s in got if s["show_be"]]
        amp = [abs(s["amp"]) for s in got if s["show_amp"]]
        print("%-36s %d runs; beat error shown in %d, worst error %s ms; amplitude shown in %d, worst error %s degrees" % (
            group, len(results), len(be), ("%.2f" % max(be)) if be else "-", len(amp), ("%.0f" % max(amp)) if amp else "-"))


SKIP = 12  # beats of each type left out at the start, while the Kalman tracker settles


def alignments(stream):
    """The real-time pipeline's beats lined up four ways: on each beat's own timestamp, on where
    the Kalman tracker expected the beat before it came, on where the tracker placed it
    afterwards, and on one straight line through all the timestamps of its type."""
    out = {}
    for key, label in ((None, "real-time timestamps"), ("pred", "Kalman tracker, expected"), ("post", "Kalman tracker, settled"), ("line", "one straight line")):
        beats = []
        for b in stream["beats"]:
            ok = np.array(b["ok"], dtype=bool)
            ok[np.flatnonzero(ok)[:SKIP]] = False
            t = np.array(b["t"], dtype=float)
            n = np.array(b["n"], dtype=float)
            if key in ("pred", "post"):
                t = np.array([v if v is not None else np.nan for v in b[key]], dtype=float)
            elif key == "line":
                slope, icpt = np.polyfit(n[ok], t[ok], 1)
                t = icpt + slope * n
            beats.append({"type": b["type"], "K": 1, "t": t[ok].tolist(), "n": n[ok].tolist(), "ok": [1] * int(ok.sum())})
        out[label] = {"bph": stream["bph"], "beats": beats}
    return out


def kalman(wav, prefix, lift):
    fs, x = ev.load_wav(wav)
    rows = ev.band_rows(x, fs)
    seconds = len(x) / fs
    offline = ev.load_beats(prefix + ".beats.json")
    stream = ev.load_beats(prefix + ".stream.json")
    ways = alignments(stream)
    for b in stream["beats"]:
        ok = np.array(b["ok"], dtype=bool)
        ok[np.flatnonzero(ok)[:SKIP]] = False
        t = np.array(b["t"], dtype=float)[ok]
        for key in ("pred", "post"):
            k = np.array([v if v is not None else np.nan for v in b[key]], dtype=float)[ok]
            print("%s: own timestamp minus the tracker's %s time scatters by %.3f ms" % ("tick" if b["type"] == 0 else "tock", "expected" if key == "pred" else "settled", 1e3 * np.std(t - k)))
    print("whole recording:")
    line("whole-recording timestamps", ev.measure(x, fs, offline, lift, 200, rows=rows))
    for label, B in ways.items():
        line(label, ev.measure(x, fs, B, lift, 200, rows=rows))
    print("audio heard so far, as it would build up in real time:")
    for upto in (20, 30, 40, 50, 60):
        if upto > seconds + 0.5:
            break
        for label in ("real-time timestamps", "Kalman tracker, expected", "Kalman tracker, settled"):
            line("%2d s, %s" % (upto, label), ev.measure(x, fs, ways[label], lift, 100, 0.0, upto, rows=rows))


def kalman_sims(outdir):
    os.makedirs(outdir, exist_ok=True)
    cases = []
    for seconds in (60, 40, 30):
        for seed in (71, 72, 73, 74):
            cases.append(("co-axial %d s" % seconds, seed, {"seconds": seconds}))
    for seed in (81, 82, 83, 84):
        cases.append(("co-axial unlock 3 dB", seed, {"unlockDb": 3}))
    tally = {}
    for group, seed, over in cases:
        prefix = os.path.join(outdir, ("%s seed %d" % (group, seed)).replace(" ", "_"))
        subprocess.run(["node", os.path.join(HERE, "beats.mjs"), "sim", "coaxial", prefix, json.dumps(dict(over, seed=seed))], capture_output=True, text=True, check=True)
        truth = json.load(open(prefix + ".truth.json"))
        fs, x = ev.load_wav(prefix + ".wav")
        os.remove(prefix + ".wav")
        rows = ev.band_rows(x, fs)
        ways = alignments(ev.load_beats(prefix + ".stream.json"))
        for label in ("real-time timestamps", "Kalman tracker, expected", "Kalman tracker, settled"):
            o = ev.measure(x, fs, ways[label], 36, 100, rows=rows)
            r = o["reading"]
            t = tally.setdefault((group, label), {"runs": 0, "shown": 0, "worst": 0.0, "db": []})
            t["runs"] += 1
            if r is None or "sd" not in o:
                print("%-28s seed %d  %-26s no reading" % (group, seed, label))
                continue
            err = abs(r["first_gap"]) - abs(truth["unlockGapMs"])
            t["db"].append(r["first_db"])
            if o["show_beat_error"]:
                t["shown"] += 1
                t["worst"] = max(t["worst"], abs(err))
            print("%-28s seed %d  %-26s beat error %.2f +- %.2f ms (%+.2f), amplitude %.0f (true %.0f), unlock %.1f dB, resamples failing %.0f%%, %s" % (
                group, seed, label, abs(r["first_gap"]), o["sd"]["first_gap"], err, o["amp"], truth["meanAmplitude"], r["first_db"], 100 * o["fail"], "shown" if o["show_beat_error"] else "HELD"))
    print()
    for (group, label), t in tally.items():
        print("%-28s %-26s shown in %d of %d, worst error %.2f ms, unlock %.1f dB on average" % (group, label, t["shown"], t["runs"], t["worst"], np.mean(t["db"]) if t["db"] else float("nan")))


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "vary":
        vary(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    elif len(sys.argv) == 3 and sys.argv[1] == "sims":
        sims(sys.argv[2])
    elif len(sys.argv) == 5 and sys.argv[1] == "kalman":
        kalman(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    elif len(sys.argv) == 3 and sys.argv[1] == "kalman-sims":
        kalman_sims(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
