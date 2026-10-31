"""Original score for the promo, synthesized from scratch (no samples, no commercial recording).

A hushed drone under the Shaw quote; a low impact as the HELIX card lands; strings and a pulse that
build through the body; risers into the big moments; a full climax on "Helix brings the team
together"; and a final hit with a long shimmering tail under the end card.
Usage: python3 tools/music.py <out/timeline-*.json> <out.wav>
"""
import json
import sys
import wave

import numpy as np

SR = 48000
tl = json.load(open(sys.argv[1]))
cues = {c["id"]: c for c in tl["cues"]}
segs = {s["id"]: s for s in tl["segments"]}
total = tl["total"]
n = int(total * SR)
t = np.arange(n) / SR
rng = np.random.default_rng(11)
hz = lambda m: 440 * 2 ** ((m - 69) / 12)

intro = segs.get("helix-intro", {}).get("start", cues.get("s06", {"start": 20})["start"] - 4)
body = cues["s06"]["start"] - 0.5 if "s06" in cues else intro + 6
climax = segs.get("idea", {}).get("start", total - 20)
final = segs.get("end", {}).get("start", total - 12)
mix_l = np.zeros(n)
mix_r = np.zeros(n)


def place(sig, start, pan=0.0, amp=1.0):
    a = int(start * SR)
    if a >= n or a + len(sig) <= 0:
        return
    sig = sig[: n - a]
    gl, gr = np.sqrt(0.5 * (1 - pan)), np.sqrt(0.5 * (1 + pan))
    mix_l[a : a + len(sig)] += amp * gl * sig
    mix_r[a : a + len(sig)] += amp * gr * sig


def env(length, attack, release, hold=None):
    tt = np.arange(int(length * SR)) / SR
    hold = length - release if hold is None else hold
    e = np.minimum(1, tt / max(attack, 1e-3))
    return e * np.where(tt > hold, np.exp(-(tt - hold) / max(release / 4, 1e-3)), 1)


def strings(freq, dur, attack=1.5, release=3.0, bright=8):
    """Detuned saw-like ensemble: additive harmonics with gentle vibrato."""
    length = dur + release
    tt = np.arange(int(length * SR)) / SR
    out = np.zeros_like(tt)
    for det in (-0.004, -0.0012, 0.0015, 0.0042):
        f = freq * (1 + det) * (1 + 0.0025 * np.sin(2 * np.pi * 5.1 * tt + det * 900))
        phase = 2 * np.pi * np.cumsum(f) / SR
        for h in range(1, bright + 1):
            out += np.sin(h * phase) / (h**1.35)
    return out / 4 * env(length, attack, release, hold=dur)


def pluck(freq, decay=2.6):
    tt = np.arange(int(2.5 * SR)) / SR
    e = np.exp(-tt * decay) * np.minimum(1, tt / 0.004)
    return e * (np.sin(2 * np.pi * freq * tt) + 0.35 * np.sin(4 * np.pi * freq * tt) * np.exp(-tt * 5) + 0.12 * np.sin(6 * np.pi * freq * tt) * np.exp(-tt * 8))


def boom(size=1.0):
    """Cinematic low impact: pitch-dropping sine body plus a soft noise thump."""
    tt = np.arange(int(4.5 * SR)) / SR
    f = 30 + 45 * np.exp(-tt * 6)
    body_ = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 1.1)
    noise = rng.standard_normal(len(tt))
    for _ in range(3):  # crude low-pass
        noise = np.convolve(noise, np.ones(24) / 24, mode="same")
    thump = noise * np.exp(-tt * 9) * 2.2
    return size * (body_ + thump)


def riser(dur):
    """Filtered-noise swell that brightens into the next hit."""
    tt = np.arange(int(dur * SR)) / SR
    noise = rng.standard_normal(len(tt))
    k = (tt / dur) ** 2
    smooth = np.convolve(noise, np.ones(40) / 40, mode="same")
    sig = (1 - k) * smooth * 3 + k * noise * 0.6
    return sig * k * 0.5


def drone(freq, start, dur, amp):
    place(strings(freq, dur, attack=4, release=4, bright=3), start, 0, amp)


# 1. The quote: hushed low D drone and a distant fifth.
place(strings(hz(38), intro + 2, attack=5, release=3, bright=2), 0, -0.1, 0.10)
place(strings(hz(45), intro - 2, attack=6, release=3, bright=2), 3, 0.1, 0.05)
place(strings(hz(62), intro - 8, attack=5, release=3, bright=3), 8, 0.2, 0.02)

# 2. HELIX lands: riser, impact, a held open chord under the card.
place(riser(3.0), intro - 3.0, 0, 0.35)
place(boom(1.0), intro, 0, 0.32)
for m, p in [(50, -0.3), (57, 0.3), (62, -0.1), (69, 0.2)]:
    place(strings(hz(m), body - intro, attack=1.2, release=2.0, bright=6), intro, p, 0.03)

# 3. The body: chords, bass and a pulse that build toward the climax.
chords = [[50, 57, 62, 65], [46, 53, 58, 62], [41, 53, 57, 60], [48, 55, 60, 64]]  # Dm Bb F C
bass = [38, 34, 29, 36]
bar = 3.6
k = 0
s = body
while s < climax:
    level = 0.45 + 0.55 * ((s - body) / max(climax - body, 1))
    ch = chords[k % 4]
    for i, m in enumerate(ch):
        place(strings(hz(m), bar, attack=0.9, release=1.6, bright=7), s, (-0.4, 0.4, -0.2, 0.2)[i], 0.05 * level)
    place(strings(hz(bass[k % 4]), bar, attack=0.4, release=1.0, bright=4), s, 0, 0.15 * level)
    step = bar / 8
    if k >= 1:
        for j in range(8):
            m = ch[(j * 3) % 4] + 12 + (12 if level > 0.75 and j % 2 else 0)
            place(pluck(hz(m)), s + j * step, (-0.5 if j % 2 else 0.5), 0.04 * level)
    if k >= 3:  # heartbeat kick on beats 1 and 3
        for j in (0, 4):
            place(boom(0.25), s + j * step, 0, 0.3 * level)
    s += bar
    k += 1

# 4. Climax: riser, impact, wide high strings over the two closing lines.
place(riser(4.0), climax - 4.0, 0, 0.5)
place(boom(1.2), climax, 0, 0.36)
span = final - climax
for i, m in enumerate([38, 50, 57, 62, 65, 69, 74, 77]):
    place(strings(hz(m), span, attack=0.6, release=2.5, bright=8), climax, (-0.6 + 0.17 * i), 0.034 if m > 45 else 0.11)
for j in range(int(span / 0.3)):
    m = [74, 77, 81, 86][j % 4]
    place(pluck(hz(m), decay=3.2), climax + j * 0.3, (-0.6 if j % 2 else 0.6), 0.02)

# 5. Final: impact and a long shimmering tail under the HELIX end card.
place(riser(3.0), final - 3.0, 0, 0.4)
place(boom(1.3), final, 0, 0.38)
tail = total - final
for i, m in enumerate([38, 50, 57, 62, 69, 74]):
    place(strings(hz(m), tail - 3, attack=0.8, release=4.0, bright=6), final, (-0.5 + 0.2 * i), 0.03 if m > 45 else 0.1)
for j in range(int((tail - 4) / 0.45)):
    m = [86, 81, 77, 74, 69][j % 5]
    place(pluck(hz(m), decay=2.0), final + 0.6 + j * 0.45, (-0.5 if j % 2 else 0.5), 0.016 * (1 - j * 0.45 / tail))

# Room: two decorrelated noise impulse responses for a wide hall.
ir_len = int(3.6 * SR)
size = 1 << int(np.ceil(np.log2(n + ir_len)))
out = []
for seed, mix in ((1, mix_l), (2, mix_r)):
    ir = np.random.default_rng(seed).standard_normal(ir_len) * np.exp(-np.arange(ir_len) / SR * 2.0)
    ir /= np.sqrt((ir**2).sum())
    wet = np.fft.irfft(np.fft.rfft(mix, size) * np.fft.rfft(ir, size), size)[:n]
    out.append(0.7 * mix + 0.6 * wet)
st = np.stack(out, 1)
fade = np.minimum(1, np.minimum(t / 2.0, (total - t) / 4.0))[:, None]
st *= fade
# Loudness, not peak, sets the level: aim for about -18 dBFS RMS, then a soft limiter.
rms = np.sqrt((st**2).mean())
st *= 10 ** (-18 / 20) / rms
st = np.tanh(st * 1.4) / 1.4
st *= min(1.0, 10 ** (-1 / 20) / np.abs(st).max())  # true ceiling -1 dBFS
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((st * 32767).astype("<i2").tobytes())
print("wrote", sys.argv[2], f"{total:.1f}s")
