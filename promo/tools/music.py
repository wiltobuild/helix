"""Original temp music bed, synthesized from scratch (no samples, no commercial recording).

A restrained pad that holds quietly under the Shaw opening, leaves air after "Why not?", then builds
slowly with a soft pulse. It is a placeholder until a licensed or cleared track is supplied.
Usage: python tools/music.py <out/timeline-*.json> <out.wav>
"""
import json
import sys
import wave

import numpy as np

SR = 48000
tl = json.load(open(sys.argv[1]))
cues = {c["id"]: c for c in tl["cues"]}
total = tl["total"]
n = int(total * SR)
t = np.arange(n) / SR
rng = np.random.default_rng(7)


def note(freq, start, dur, amp, attack=2.5, release=3.0, bright=0.35):
    out = np.zeros(n)
    a, b = int(start * SR), min(n, int((start + dur + release) * SR))
    if a >= n:
        return out
    tt = t[a:b] - start
    env = np.minimum(1, tt / attack) * np.where(tt > dur, np.exp(-(tt - dur) / (release / 3)), 1)
    tone = np.zeros_like(tt)
    for det in (-0.0025, 0.0, 0.0031):  # gentle chorus
        f = freq * (1 + det)
        tone += np.sin(2 * np.pi * f * tt) + bright * np.sin(4 * np.pi * f * tt) / 2 + bright**2 * np.sin(6 * np.pi * f * tt) / 3
    out[a:b] = amp * env * tone / 3
    return out


def pluck(freq, start, amp):
    out = np.zeros(n)
    a, b = int(start * SR), min(n, int((start + 2.5) * SR))
    if a >= n:
        return out
    tt = t[a:b] - start
    env = np.exp(-tt * 2.2) * np.minimum(1, tt / 0.01)
    out[a:b] = amp * env * (np.sin(2 * np.pi * freq * tt) + 0.25 * np.sin(4 * np.pi * freq * tt) * np.exp(-tt * 4))
    return out


hz = lambda m: 440 * 2 ** ((m - 69) / 12)
mix = np.zeros(n)
# Opening: a low D drone with a distant fifth, very quiet.
open_end = cues["s05"]["end"] + 2.0 if "s05" in cues else total
mix += note(hz(38), 0.0, open_end, 0.10, attack=4)
mix += note(hz(45), 3.0, open_end - 3, 0.05, attack=5)
mix += note(hz(69), cues["s03"]["start"] if "s03" in cues else 8, open_end - 8, 0.025, attack=4, bright=0.1)
# After the hold: chords enter and a soft pulse builds. Dm(add9) - Bbmaj7 - Gm7 - Asus4.
chords = [[50, 57, 64, 65], [46, 53, 57, 62], [43, 50, 53, 58], [45, 50, 52, 57]]
bass = [38, 34, 31, 33]
build = cues["s06"]["start"] - 0.6 if "s06" in cues else total
bar = 4.0
k = 0
s = build
while s < total:
    level = min(1.0, 0.45 + 0.04 * k)
    for m in chords[k % 4]:
        mix += note(hz(m), s, bar, 0.035 * level, attack=1.2, release=2.5)
    mix += note(hz(bass[k % 4]), s, bar, 0.08 * level, attack=0.8, release=2)
    if k >= 1:
        for beat in range(4):
            mix += pluck(hz(chords[k % 4][beat % 2 + 2] + 12), s + beat * 1.0, 0.03 * level)
    s += bar
    k += 1
# Room: exponentially decaying noise impulse response.
ir_len = int(2.8 * SR)
ir = rng.standard_normal(ir_len) * np.exp(-np.arange(ir_len) / SR * 2.6)
ir /= np.sqrt((ir**2).sum())
size = 1 << int(np.ceil(np.log2(n + ir_len)))
wet = np.fft.irfft(np.fft.rfft(mix, size) * np.fft.rfft(ir, size), size)[:n]
left = 0.65 * mix + 0.55 * wet
right = 0.65 * mix + 0.55 * np.roll(wet, int(0.013 * SR))
st = np.stack([left, right], 1)
fade = np.minimum(1, np.minimum(t / 1.5, (total - t) / 2.0))[:, None]
st *= fade
st *= 10 ** (-10 / 20) / np.abs(st).max()  # peak -10 dBFS: a bed, leaving room for narration
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((st * 32767).astype("<i2").tobytes())
print("wrote", sys.argv[2], f"{total:.1f}s")
