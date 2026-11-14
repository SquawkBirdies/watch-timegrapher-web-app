"""Synthesise a noisy stereo tick recording with known rate and beat error.
usage: synth.py out.wav bph rate_s_per_day beat_offset_ms tick_gain seconds [seed]
beat_offset_ms: tock displacement from the midpoint between ticks (positive = late).
"""
import sys
import numpy as np
from scipy.io import wavfile
from scipy import signal

out, bph, rate, boff, gain, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
seed = int(sys.argv[7]) if len(sys.argv) > 7 else 1
rng = np.random.default_rng(seed)
fs = 48000
n = int(dur * fs)
# background: pink-ish noise + 60 Hz buzz bursts in a narrow band on one channel
def pink(n):
    w = rng.standard_normal(n)
    b, a = signal.butter(1, 300, fs=fs)
    return 0.6 * signal.lfilter(b, a, w) * 8 + 0.25 * w
x = np.stack([pink(n), pink(n)], axis=1) * 1e-3
T = (3600.0 / bph) / (1 + rate / 86400.0)
sos = signal.butter(4, [3000, 14000], btype="band", fs=fs, output="sos")
def burst(amp, decay_ms, length_ms=6.0):
    m = int(length_ms * 1e-3 * fs)
    b = rng.standard_normal(m) * np.exp(-np.arange(m) / (decay_ms * 1e-3 * fs))
    return amp * signal.sosfilt(sos, b)
k = 0
t = 0.137
while t < dur - 0.05:
    off = boff * 1e-3 if (k % 2) else 0.0
    for dt, amp, dec in ((-0.0070, 0.25, 0.3), (-0.0045, 0.45, 0.4), (0.0, 1.0, 0.5)):
        pos = (t + off + dt) * fs
        i0 = int(np.floor(pos)); fr = pos - i0
        b = burst(amp * gain * 1e-3 * (1.0 if k % 2 == 0 else 0.8), dec)
        # fractional delay by linear interpolation of the burst
        bb = np.zeros(len(b) + 1); bb[:-1] += b * (1 - fr); bb[1:] += b * fr
        for c, g in ((0, 1.0), (1, 0.8)):
            x[i0:i0 + len(bb), c] += g * bb
    k += 1
    t = 0.137 + k * T
# mains buzz: 3.5 kHz tone bursts every 1/60 s on channel 1
tb = np.arange(int(0.001 * fs)) / fs
bz = 1.5e-3 * np.sin(2 * np.pi * 3500 * tb) * np.hanning(len(tb))
for i in range(int(dur * 59.994)):
    p = int(i / 59.994 * fs)
    if p + len(bz) < n:
        x[p:p + len(bz), 1] += bz
wavfile.write(out, fs, x.astype(np.float32))
print("wrote", out, "true period %.6f ms" % (T * 1e3))
