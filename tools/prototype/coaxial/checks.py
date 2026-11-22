"""Checks of the prototype: how much its readings move with the analysis choices, and how it
does on simulated watches whose beat error and amplitude are known.

usage: python3 -I tools/prototype/coaxial/checks.py vary <file.wav> <prefix>.beats.json <lift angle>
       python3 -I tools/prototype/coaxial/checks.py sims <directory for the simulated watches> [plain|lined|test|both|three]
       python3 -I tools/prototype/coaxial/checks.py kalman <file.wav> <prefix> <lift angle>
       python3 -I tools/prototype/coaxial/checks.py kalman-sims <directory>
       python3 -I tools/prototype/coaxial/checks.py suite <directory> [part of a watch name] [plain|lined|test|both|three]
       python3 -I tools/prototype/coaxial/checks.py pairing <directory> [plain|lined|test|both|three]

`kalman` compares where the beats are lined up before averaging: on the whole-recording
timestamps (<prefix>.beats.json), or on what the real-time pipeline and a Kalman beat tracker
give (<prefix>.stream.json, from `beats.mjs stream`). `kalman-sims` does the same on simulated
watches.

`sims` runs node on beats.mjs for each watch, so it needs Node 22 or later, and takes about
twenty minutes. A watch already timed in the directory by an earlier run is not timed again:
only its audio is made again (`beats.mjs synth`), and the truth it gives is checked against the
earlier run's.

Every reading lines up again, before averaging, the sounds whose blocks show them moving
(events.measure's reline="test"). With `lined`, `sims` and `suite` line every sound up, and with
`plain` they use the plain average, as before 18 November; with `both` they read every watch plain
and lined and score each, and with `three` all three ways. `plain`, `lined` and `test` can also
be given together.

`suite` runs suite.mjs to make the 36 watches the app's unit tests build as whole recordings,
then runs the prototype on them and on the six recordings in tests/fixtures, and scores each
reading against the truth. It takes about fifteen minutes. When the directory already holds
the watches from an earlier run, they are used again.

`pairing` reads simulated levers whose impulse is as loud as their drop or louder, levers whose
unlock is too faint to find and one whose impulse cannot be heard, against the truth, in about
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
    line("whole recording, plain average", ev.measure(x, fs, B, lift, 200, rows=rows, reline=False))
    line("whole recording, every sound lined up", ev.measure(x, fs, B, lift, 200, rows=rows, reline=True))
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


WAYS = {False: "plain average", True: "lined up", "test": "lined up if moved"}
# The words that choose them on the command line, in any combination.
WAY_WORDS = {"plain": (False,), "lined": (True,), "test": ("test",), "both": (False, True), "three": (False, True, "test")}


def simulate(outdir, name, kind, over, lift, ways=(True,)):
    """Make one simulated watch, or only its audio when an earlier run in outdir timed it, and
    read it each way. Returns one result per way, None where there was no reading."""
    prefix = os.path.join(outdir, name.replace(" ", "_").replace(",", ""))
    script = os.path.join(HERE, "beats.mjs")
    if os.path.exists(prefix + ".beats.json") and os.path.exists(prefix + ".truth.json"):
        before = json.load(open(prefix + ".truth.json"))
        subprocess.run(["node", script, "synth", kind, prefix, json.dumps(over)], capture_output=True, text=True, check=True)
        if json.load(open(prefix + ".truth.json")) != before:
            raise RuntimeError(prefix + ": the watch made again is not the one the earlier run timed")
    else:
        subprocess.run(["node", script, "sim", kind, prefix, json.dumps(over)], capture_output=True, text=True, check=True)
    truth = json.load(open(prefix + ".truth.json"))
    fs, x = ev.load_wav(prefix + ".wav")
    B = ev.load_beats(prefix + ".beats.json")
    os.remove(prefix + ".wav")
    out = []
    rows = ev.band_rows(x, fs)
    for way in ways:
        head = "%-36s %strue %.2f ms and %.0f degrees | " % (name, "" if len(ways) == 1 else WAYS[way] + ", ", abs(truth["unlockGapMs"]), truth["meanAmplitude"])
        if any(sum(b["ok"]) < 10 for b in B["beats"]):
            print(head + "the app timed too few beats")
            out.append(None)
            continue
        o = ev.measure(None, fs, B, lift, 100, rows=rows, reline=way)
        r = o["reading"]
        if r is None:
            print(head + "no reading: " + o["why"])
            out.append(None)
            continue
        if "sd" not in o:
            print(head + "no reading: the resamples found no sounds")
            out.append(None)
            continue
        be = abs(r["first_gap"]) - abs(truth["unlockGapMs"])
        amp = o["amp"] - truth["meanAmplitude"]
        print(head + "read %.2f +- %.2f ms (%+.2f) %s | %.0f +- %.0f degrees (%+.0f) %s | resamples failing %.0f%%, unlock %.1f dB%s" % (
            abs(r["first_gap"]), o["sd"]["first_gap"], be, "shown" if o["show_beat_error"] else "HELD",
            o["amp"], o["amp_sd"], amp, "shown" if o["show_amplitude"] else "HELD", 100 * o["fail"], r["first_db"],
            "" if not way else " | " + o.get("relined", "")))
        out.append({"be": be, "amp": amp, "show_be": o["show_beat_error"], "show_amp": o["show_amplitude"]})
    return out


def sims(outdir, ways=(True,)):
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
        for way, result in zip(ways, simulate(outdir, "%s, seed %d" % (group, seed), kind, dict(over, seed=seed), lift, ways)):
            groups.setdefault((group, way), []).append(result)
    print()
    for (group, way), results in groups.items():
        got = [s for s in results if s]
        be = [abs(s["be"]) for s in got if s["show_be"]]
        amp = [abs(s["amp"]) for s in got if s["show_amp"]]
        print("%-36s %s%d runs; beat error shown in %d, worst error %s ms; amplitude shown in %d, worst error %s degrees" % (
            group, "" if len(ways) == 1 else WAYS[way] + ", ", len(results), len(be), ("%.2f" % max(be)) if be else "-", len(amp), ("%.0f" % max(amp)) if amp else "-"))


def lever_sounds(impulse_db=18, unlock_db=12, after_drop=None):
    """The simulated lever's three sounds (tests/helpers/balance.js), with the impulse and the
    unlock at other levels, and optionally a fourth sound a while after the drop, as a rebound
    might make: (milliseconds after the drop, level)."""
    beat = [{"after": "unlock", "db": unlock_db, "riseMs": 0.12, "decayMs": 0.5, "band": [7000, 22000]},
            {"after": "unlock", "delayMs": 2.4, "delayJitterMs": 0.08, "db": impulse_db, "riseMs": 0.1, "decayMs": 0.5, "band": [5000, 22000]},
            {"after": "lock", "db": 25, "riseMs": 0.08, "decayMs": 0.7, "band": [5000, 22000]}]
    if after_drop:
        beat.append({"after": "lock", "delayMs": after_drop[0], "delayJitterMs": 0.1, "db": after_drop[1], "riseMs": 0.12, "decayMs": 0.5, "band": [5000, 22000]})
    return [beat, beat]


def pairing(outdir, ways=("test",)):
    """Levers whose impulse is as loud as the drop or louder, which the pairing once refused
    (issue 24 of the investigation), levers whose unlock is too faint to find, which were once
    read from the impulse (issue 25), and a lever whose impulse cannot be heard."""
    os.makedirs(outdir, exist_ok=True)
    print("Simulated levers, 60 s, true beat error 0.50 ms. The drop is 25 dB over the background.")
    print("The lost-unlock groups have the unlock at -10 dB, too faint to find, and should give")
    print("nothing; timed from the impulse, the amplitude read 63 to 79 degrees high (issues 24 and")
    print("25 of the investigation). The last group has the impulse at -10 dB and gives nothing too,")
    print("the cost of refusing a beat with nothing between its first sound and its lock.\n")
    cases = []
    for db, label in ((25, "as loud as the drop"), (28, "3 dB over the drop"), (34, "9 dB over the drop")):
        for seed in (1, 2):
            cases.append(("lever impulse %s" % label, seed, {"sounds": lever_sounds(db)}))
    cases.append(("lever impulse 3 dB over, 18,000 vph", 1, {"sounds": lever_sounds(28), "bph": 18000}))
    cases.append(("lever impulse 3 dB over, 220 degrees", 1, {"sounds": lever_sounds(28), "amplitude": 220}))
    for seed in (1, 2):
        cases.append(("lever unlock lost, sound after drop", seed, {"sounds": lever_sounds(unlock_db=-10, after_drop=(4.0, 15))}))
    cases.append(("lever unlock lost, 220 degrees", 1, {"sounds": lever_sounds(unlock_db=-10), "amplitude": 220}))
    cases.append(("lever unlock lost, 18,000 vph, 260 deg", 1, {"sounds": lever_sounds(unlock_db=-10), "bph": 18000, "amplitude": 260}))
    cases.append(("lever impulse missing", 1, {"sounds": lever_sounds(impulse_db=-10)}))
    groups = {}
    for group, seed, over in cases:
        over = dict(over, seconds=60, restOffsetDeg=1.7, seed=seed)
        for way, result in zip(ways, simulate(outdir, "%s, seed %d" % (group, seed), "lever", over, 50, ways)):
            groups.setdefault((group, way), []).append(result)
    print()
    for (group, way), results in groups.items():
        got = [s for s in results if s]
        be = [abs(s["be"]) for s in got if s["show_be"]]
        amp = [abs(s["amp"]) for s in got if s["show_amp"]]
        print("%-36s %s%d runs; beat error shown in %d, worst error %s ms; amplitude shown in %d, worst error %s degrees" % (
            group, "" if len(ways) == 1 else WAYS[way] + ", ", len(results), len(be), ("%.2f" % max(be)) if be else "-", len(amp), ("%.0f" % max(amp)) if amp else "-"))


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


TOL_MS = 0.10  # a shown beat error or unlock-to-lock time this far from the truth is wrong

RECORDINGS = [
    # file, beats.mjs arguments as the recording tests analyse it, lift angle, what is known
    ("omega-3861-safari.wav", [], 36, "co-axial; no reference reading"),
    ("eta-2836-2-safari.wav", [], 50, "Swiss lever; no reference reading"),
    ("omega-3861.wav", ["21600", "2", "60"], 36, "co-axial, Voice Memos"),
    ("omega-3861-b.wav", ["21600", "2", "73"], 36, "co-axial, Voice Memos"),
    ("eta-2836-2.wav", ["0", "2", "54"], 50, "Swiss lever, Voice Memos"),
    ("no-watch-safari.wav", [], 50, "no watch"),
]


def suite(outdir, match=None, ways=(True,)):
    os.makedirs(outdir, exist_ok=True)
    if any(f.endswith(".truth.json") for f in os.listdir(outdir)):
        print("Using the watches an earlier run left in %s.\n" % outdir)
    else:
        made = subprocess.run(["node", os.path.join(HERE, "suite.mjs"), outdir] + ([match] if match else []), capture_output=True, text=True)
        print(made.stdout + made.stderr)
    print("Simulated watches of the unit tests. The lift angle is chosen per beat rate so that the")
    print("watch's unlock-to-lock time reads 280 degrees: there is no balance behind these watches.\n")
    tally = {}
    for name in sorted(f[:-11] for f in os.listdir(outdir) if f.endswith(".truth.json")):
        prefix = os.path.join(outdir, name)
        truth = json.load(open(prefix + ".truth.json"))
        label = truth["name"]
        if not os.path.exists(prefix + ".beats.json"):
            verdict = "right" if truth["expect"] == "none" else "nothing"
            print("%-32s no beats from the app: %s" % (label, "right, there is no watch" if truth["expect"] == "none" else "nothing to measure"))
            for way in ways:
                tally.setdefault((way, verdict), []).append(label)
            continue
        B = ev.load_beats(prefix + ".beats.json")
        if any(sum(b["ok"]) < 10 for b in B["beats"]):
            print("%-32s the app timed too few beats" % label)
            for way in ways:
                tally.setdefault((way, "nothing"), []).append(label)
            continue
        fs, x = ev.load_wav(prefix + ".wav")
        rows = ev.band_rows(x, fs)
        # The lift angle at which this watch's time from first to last sound reads 280 degrees,
        # so that the gate on believable times passes it and the check falls on the times.
        lift_ms = truth["liftMs"] or 7.0
        lift = float(2 * 280 * np.sin(np.pi * B["bph"] / 7200 * lift_ms * 1e-3))
        for way in ways:
            o = ev.measure(None, fs, B, lift, 100, rows=rows, reline=way)
            r = o["reading"]
            head = "%-32s %s%s vph, lift %.1f deg | " % (label, "" if len(ways) == 1 else WAYS[way] + ", ", B["bph"], lift)
            if r is None or "sd" not in o:
                why = o["why"] if r is None else "the resamples found no sounds"
                verdict = "right" if truth["expect"] in ("refuse", "none") else "nothing"
                print(head + "no reading: %s%s" % (why, " (right: the beats share no first sound)" if truth["expect"] == "refuse" else ""))
                tally.setdefault((way, verdict), []).append(label)
                continue
            be, lt = abs(r["first_gap"]), 0.5 * (r["lift0"] + r["lift1"])
            shown = o["show_beat_error"]
            if truth["expect"] == "reading" and truth["beatErrorMs"] is not None:
                e_be, e_lt = be - truth["beatErrorMs"], lt - truth["liftMs"]
                ok = abs(e_be) <= TOL_MS and abs(e_lt) <= TOL_MS
                verdict = ("right" if ok else "WRONG") if shown else ("held, would be right" if ok else "held, would be wrong")
                print(head + "beat error %.2f +- %.2f (true %.2f, %+.2f), unlock to lock %.2f and %.2f (true %.2f) | %s, unlock %.1f dB, resamples failing %.0f%%" % (
                    be, o["sd"]["first_gap"], truth["beatErrorMs"], e_be, r["lift0"], r["lift1"], truth["liftMs"], verdict, r["first_db"], 100 * o["fail"]))
            else:
                verdict = "WRONG" if shown else "held"
                print(head + "beat error %.2f +- %.2f, unlock to lock %.2f and %.2f | %s: %s" % (
                    be, o["sd"]["first_gap"], r["lift0"], r["lift1"], verdict, "a reading where the beats share no first sound" if shown else "held back, as it should be"))
            tally.setdefault((way, verdict), []).append(label)
    print()
    for (way, verdict), names in sorted(tally.items(), key=lambda item: (ways.index(item[0][0]), item[0][1])):
        print("%s%-22s %2d: %s" % ("" if len(ways) == 1 else WAYS[way] + ", ", verdict, len(names), ", ".join(names)))

    if match:
        return
    print("\nRecordings in tests/fixtures, first channel:")
    repo = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
    for file, args, lift, known in RECORDINGS:
        path = os.path.join(repo, "tests", "fixtures", file)
        prefix = os.path.join(outdir, "rec_" + file[:-4])
        if not os.path.exists(prefix + ".beats.json"):
            done = subprocess.run(["node", os.path.join(HERE, "beats.mjs"), "wav", path, prefix] + args, capture_output=True, text=True)
            said = (done.stdout + done.stderr).strip().splitlines()
            if not os.path.exists(prefix + ".beats.json"):
                print("%-24s no beats from the app (%s): %s" % (file, known, said[-1][:90] if said else "no output"))
                continue
        B = ev.load_beats(prefix + ".beats.json")
        if not B["beats"] or any(sum(b["ok"]) < 10 for b in B["beats"]):
            print("%-24s the app timed too few beats (%s)" % (file, known))
            continue
        fs, x = ev.load_wav(path)
        rows = ev.band_rows(x, fs)
        for way in ways:
            o = ev.measure(None, fs, B, lift, 100, rows=rows, reline=way)
            r = o["reading"]
            tag = "" if len(ways) == 1 else WAYS[way] + ", "
            if r is None or "sd" not in o:
                print("%-24s %sno reading (%s): %s" % (file, tag, known, o["why"] if r is None else "the resamples found no sounds"))
                continue
            print("%-24s %sbeat error %.2f +- %.2f ms, amplitude %.0f +- %.0f at %d deg, %s (%s)%s" % (
                file, tag, abs(r["first_gap"]), o["sd"]["first_gap"], o["amp"], o["amp_sd"], lift, "shown" if o["show_beat_error"] else "held back", known,
                "" if not way else " | " + o.get("relined", "")))


if __name__ == "__main__":
    words = sys.argv[3:]
    ways = tuple(dict.fromkeys(w for word in words for w in WAY_WORDS.get(word, ()))) or ("test",)
    rest = [w for w in words if w not in WAY_WORDS]
    if len(sys.argv) == 5 and sys.argv[1] == "vary":
        vary(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    elif len(sys.argv) >= 3 and sys.argv[1] == "sims" and not rest:
        sims(sys.argv[2], ways)
    elif len(sys.argv) == 5 and sys.argv[1] == "kalman":
        kalman(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    elif len(sys.argv) == 3 and sys.argv[1] == "kalman-sims":
        kalman_sims(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == "suite" and len(rest) <= 1:
        suite(sys.argv[2], rest[0] if rest else None, ways)
    elif len(sys.argv) >= 3 and sys.argv[1] == "pairing" and not rest:
        pairing(sys.argv[2], ways)
    else:
        print(__doc__)
        sys.exit(1)
