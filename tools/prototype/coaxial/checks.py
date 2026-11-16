"""Checks of the prototype: how much its readings move with the analysis choices, and how it
does on simulated watches whose beat error and amplitude are known.

usage: python3 -I tools/prototype/coaxial/checks.py vary <file.wav> <prefix>.beats.json <lift angle>
       python3 -I tools/prototype/coaxial/checks.py sims <directory for the simulated watches>

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


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "vary":
        vary(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    elif len(sys.argv) == 3 and sys.argv[1] == "sims":
        sims(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
