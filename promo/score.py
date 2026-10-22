"""Synthesizes the Helix promo score (64 s, 120 BPM, D minor) to score.wav.

Cue sheet shared with film.html:
  0  tension drone + ticking        6 / 10  stat hits
 13  riser, 15.6 silence             16  BRAAM, title, theme begins
 24  ostinato (plan graph)           32  full drums (board)
 42  tape stop (rewind), 44 re-entry 50 / 52 / 54  value-prop hits
 56  final hit, D major              64  end
"""
import sys, wave
import numpy as np

SR = 44100
DUR = 64.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N); R = np.zeros(N)          # dry bus
VL = np.zeros(N); VR = np.zeros(N)        # reverb send

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
NOTE = {n: i for i, n in enumerate(['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'])}
def m(name):  # 'D2' -> midi
    return 12 * (int(name[-1]) + 1) + NOTE[name[:-1]]

def lowpass(x, cutoff, order=2):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / (1 + (f / cutoff) ** (2 * order)), len(x))

def highpass(x, cutoff, order=2):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR) + 1e-9
    return np.fft.irfft(X / (1 + (cutoff / f) ** (2 * order)), len(x))

def add(sig, t0, gain=1.0, pan=0.0, send=0.3):
    i = int(t0 * SR)
    if i >= N: return
    sig = sig[:N - i]
    gl = gain * np.sqrt((1 - pan) / 2); gr = gain * np.sqrt((1 + pan) / 2)
    L[i:i+len(sig)] += sig * gl; R[i:i+len(sig)] += sig * gr
    VL[i:i+len(sig)] += sig * gl * send; VR[i:i+len(sig)] += sig * gr * send

def tt(d): return np.arange(int(d * SR)) / SR

def saw(f, t, phase=0.0):
    x = (f * t + phase) % 1.0
    return 2 * x - 1

def adsr(t, a, d, s, r, dur):
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = np.clip((t - dur) / r, 0, 1)
    return e * (1 - rel)

# ---------- instruments ----------
def supersaw(midi, dur, cutoff=1800, voices=5, detune=0.12, a=0.6, r=1.5):
    t = tt(dur + r)
    out = np.zeros(len(t))
    for v in range(voices):
        cents = (v - (voices - 1) / 2) * detune * 100 / max(1, (voices - 1) / 2) / 10
        out += saw(hz(midi) * 2 ** (cents / 1200), t, rng.random())
    out = lowpass(out / voices, cutoff)
    return out * adsr(t, a, 1.0, 0.85, r, dur)

def strings(notes, t0, dur, gain=0.16, cutoff=2200):
    gain *= 1.5
    for k, n in enumerate(notes):
        add(supersaw(m(n), dur, cutoff), t0, gain, pan=(k / max(1, len(notes) - 1) - 0.5) * 0.8, send=0.55)

def brass(n, t0, dur, gain=0.2):
    t = tt(dur + 0.6)
    f = hz(m(n))
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.clip(t / 0.5, 0, 1)
    ph = np.cumsum(f * vib) / SR
    x = sum(saw(1, ph * k if k != 1 else ph, 0) * w for k, w in [(1, 1.0)])
    x = x + 0.5 * saw(1.003, ph) + 0.5 * saw(0.997, ph)
    env = adsr(t, 0.12, 0.4, 0.8, 0.5, dur)
    x = lowpass(x, 900 + 1400 * float(np.mean(env)), 2)
    x = np.tanh(x * 1.6) * env
    add(x, t0, gain, pan=-0.15, send=0.6)

def boom(t0, gain=1.0, f0=90, f1=32, decay=1.8):
    t = tt(decay * 2.5)
    f = f1 + (f0 - f1) * np.exp(-t * 9)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    n = lowpass(rng.standard_normal(len(t)), 2500) * np.exp(-t * 25) * 0.6
    add(np.tanh((x + n) * 1.8), t0, gain * 0.4, send=0.5)

def braam(t0, root='D', gain=0.5, dur=3.2):
    t = tt(dur + 1.5)
    out = np.zeros(len(t))
    for n, w in [(root + '1', 1.0), (root + '2', 0.9), ('A2', 0.6), (root + '3', 0.5), ('F3' if root == 'D' else 'F#3', 0.35)]:
        for d in (-0.3, 0.0, 0.3):
            out += w * saw(hz(m(n)) * 2 ** (d / 100), t, rng.random())
    env = adsr(t, 0.03, 0.9, 0.45, 1.5, dur)
    # opening-then-closing filter, done in two bands blended over time
    bright = lowpass(out, 2400); dark = lowpass(out, 380)
    mix = np.exp(-t * 1.4)
    x = np.tanh((bright * mix + dark * (1 - mix)) * 0.9) * env
    add(x, t0, gain, send=0.6)
    boom(t0, 0.9)

def timpani(t0, n='D2', gain=0.5):
    t = tt(1.6)
    f = hz(m(n))
    x = (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 1.5 * t)) * np.exp(-t * 3.2)
    x += lowpass(rng.standard_normal(len(t)), 1200) * np.exp(-t * 40) * 0.5
    add(x, t0, gain, pan=0.1, send=0.45)

def taiko(t0, gain=0.6, pan=0.0):
    t = tt(0.9)
    f = 48 + 70 * np.exp(-t * 30)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6)
    x += lowpass(rng.standard_normal(len(t)), 1800) * np.exp(-t * 35) * 0.45
    add(np.tanh(x * 1.5), t0, gain * 0.8, pan=pan, send=0.35)

def snare(t0, gain=0.25, pan=0.0):
    t = tt(0.4)
    x = highpass(rng.standard_normal(len(t)), 900) * np.exp(-t * 18)
    x += np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25) * 0.6
    add(x, t0, gain, pan=pan, send=0.4)

def tick(t0, gain=0.08, pan=0.0):
    t = tt(0.05)
    x = highpass(rng.standard_normal(len(t)), 5000) * np.exp(-t * 160)
    add(x, t0, gain, pan=pan, send=0.15)

def pluck(n, t0, gain=0.14, cutoff=1300):
    t = tt(0.4)
    x = saw(hz(m(n)), t) * 0.6 + saw(hz(m(n)) * 1.004, t) * 0.4
    x = lowpass(x, cutoff) * np.exp(-t * 11)
    add(x, t0, gain, pan=-0.25, send=0.2)

def riser(t0, dur, gain=0.35):
    t = tt(dur)
    k = t / dur
    noise = highpass(rng.standard_normal(len(t)), 1500) * (k ** 2.2) * 0.5
    f = 200 * 2 ** (k * 4)
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * (k ** 1.5) * 0.35
    tone += np.sin(2 * np.pi * np.cumsum(f * 1.5) / SR) * (k ** 2) * 0.2
    add(noise + tone, t0, gain, send=0.5)

def whoosh_rev(t_end, dur=1.6, gain=0.5):
    """Reverse cymbal-like swell that lands on t_end."""
    t = tt(dur)
    x = highpass(rng.standard_normal(len(t)), 3000) * np.exp(-t * 3.5)
    add(x[::-1], t_end - dur, gain, send=0.4)

def choir(notes, t0, dur, gain=0.12):
    for k, n in enumerate(notes):
        t = tt(dur + 2)
        f = hz(m(n))
        vib = 1 + 0.006 * np.sin(2 * np.pi * (4.6 + k * 0.3) * t)
        ph = np.cumsum(f * vib) / SR
        x = sum(np.sin(2 * np.pi * ph * h) / h ** 1.3 for h in range(1, 7))
        # 'ah' formants via spectral emphasis
        x = lowpass(x, 1100) + 0.3 * highpass(lowpass(x, 1300), 700)
        add(x * adsr(t, 1.2, 1.0, 0.9, 2.0, dur), t0, gain, pan=(k - len(notes) / 2) * 0.25, send=0.8)

def drone(t0, dur, gain=0.25):
    t = tt(dur)
    x = np.sin(2 * np.pi * hz(m('D1')) * t) + 0.6 * lowpass(saw(hz(m('D2')), t) + saw(hz(m('D2')) * 1.006, t), 300)
    pulse = 0.75 + 0.25 * np.sin(2 * np.pi * 0.5 * t)
    env = np.clip(t / 3, 0, 1) * np.clip((dur - t) / 0.5, 0, 1)
    add(x * env * pulse, t0, gain, send=0.4)

# ---------- arrangement ----------
B = 0.5  # one beat

# 0-16: tension
drone(0, 16.0, 0.28)
for i in range(int(13.0 / (B / 2))):
    t0 = i * B / 2
    tick(t0, 0.05 + 0.06 * (t0 / 13) + (0.04 if i % 2 == 0 else 0), pan=0.3 if i % 2 else -0.3)
for i in range(6, 13):  # low heartbeat pulses
    boom(i * 1.0 + (0 if i % 2 == 0 else 0.25), 0.18, 70, 40, 0.3)
boom(6.0, 1.0); strings(['D3', 'A3', 'D4'], 6.0, 3.6, 0.10, 900)
boom(10.0, 1.0); strings(['A#2', 'F3', 'D4'], 10.0, 3.0, 0.10, 900)
riser(12.6, 3.0, 0.45)
whoosh_rev(15.6, 1.8, 0.4)

# 16: the drop
braam(16.0, 'D', 0.55)
timpani(16.0, 'D2', 0.6)
prog = [  # (start, dur, chord)
    (16, 4, ['D3', 'F3', 'A3', 'D4']), (20, 4, ['A#2', 'D3', 'F3', 'A#3']),
    (24, 4, ['F2', 'C3', 'F3', 'A3']), (28, 4, ['C3', 'E3', 'G3', 'C4']),
    (32, 4, ['D3', 'F3', 'A3', 'D4']), (36, 4, ['A#2', 'D3', 'F3', 'A#3']),
    (40, 2, ['F2', 'C3', 'F3', 'A3']),
    (44, 3, ['C3', 'E3', 'G3', 'C4']), (47, 3, ['D3', 'F3', 'A3', 'D4']),
    (50, 2, ['A#2', 'D3', 'F3', 'A#3']), (52, 2, ['C3', 'E3', 'G3', 'C4']), (54, 2, ['C3', 'F3', 'G3', 'C4']),
]
for s, d, ch in prog:
    strings(ch, s, d, 0.13, 2000 if s < 32 else 2800)
    add(supersaw(m(ch[0]) - 12, d, 400, 3), s, 0.22, send=0.2)   # bass

# timpani rolls at phrase starts
for s in (20, 24, 28):
    timpani(s, 'D2' if s != 28 else 'C2', 0.45)

# 24-42 and 44-56: ostinato in 16ths
ost = ['D3', 'D3', 'A3', 'D3', 'F3', 'D3', 'A3', 'D3']
roots = {24: 'F', 28: 'C', 32: 'D', 36: 'A#', 40: 'F', 44: 'C', 47: 'D', 50: 'A#', 52: 'C', 54: 'C'}
def ost_note(t0, i):
    root = [v for k, v in sorted(roots.items()) if k <= t0][-1]
    shift = {'D': 0, 'F': 3, 'C': -2, 'A#': -4}[root]
    n = m(ost[i % 8]) + shift
    names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
    return names[n % 12] + str(n // 12 - 1)
for seg0, seg1 in ((24, 41.5), (44, 56)):
    i = 0; t0 = seg0
    while t0 < seg1 - 1e-6:
        pluck(ost_note(t0, i), t0, 0.12 if seg0 == 24 else 0.15, 1100 + (t0 - 24) * 40)
        t0 += B / 2; i += 1

# 32-42 and 44-56: drums
for seg0, seg1 in ((32, 42), (44, 56)):
    t0 = seg0
    while t0 < seg1 - 1e-6:
        bar = t0 - seg0
        for off, g in [(0, 0.7), (0.75, 0.4), (1.0, 0.55), (1.5, 0.45), (1.75, 0.35)]:
            if t0 + off < seg1: taiko(t0 + off, g, pan=(-0.2 if off % 1 else 0.2))
        snare(t0 + 0.5, 0.18); snare(t0 + 1.5, 0.22)
        for k in range(8):
            if t0 + k * 0.25 < seg1: tick(t0 + k * 0.25, 0.06, pan=0.4)
        t0 += 2.0
# fills
for k in range(8): snare(41.0 + k * 0.125, 0.12 + k * 0.03, pan=(k % 2 - 0.5))
for k in range(8): snare(55.0 + k * 0.125, 0.14 + k * 0.035, pan=(k % 2 - 0.5))

# heroic theme (horns)
theme = [('D4', 24, 1.5), ('A4', 25.5, 0.5), ('G4', 26, 1.0), ('F4', 27, 1.0),
         ('E4', 28, 1.5), ('F4', 29.5, 0.5), ('G4', 30, 2.0),
         ('D4', 32, 1.5), ('A4', 33.5, 0.5), ('C5', 34, 1.0), ('A#4', 35, 1.0),
         ('A4', 36, 1.5), ('F4', 37.5, 0.5), ('A#4', 38, 2.0), ('A4', 40, 2.0),
         ('G4', 44, 1.5), ('A4', 45.5, 0.5), ('C5', 46, 1.0), ('D5', 47, 3.0)]
for n, s, d in theme:
    brass(n, s, d, 0.26)
    brass(n[:-1] + str(int(n[-1]) - 1), s, d, 0.15)

# 42: rewind -> reverse swell into 44
whoosh_rev(44.0, 1.4, 0.5)
boom(44.0, 0.8)

# 50-54 value-prop hits
for s, n in ((50, 'A#1'), (52, 'C2'), (54, 'C2')):
    boom(s, 0.9); timpani(s, n.replace('1', '2'), 0.5)
choir(['D4', 'F4', 'A4'], 48, 8, 0.07)
riser(53.6, 2.4, 0.35)

# 56: finale, Picardy D major
braam(56.0, 'D', 0.6, dur=5.0)
timpani(56.0, 'D2', 0.7)
strings(['D3', 'F#3', 'A3', 'D4', 'F#4'], 56.0, 5.5, 0.13, 2600)
choir(['D4', 'F#4', 'A4', 'D5'], 56.0, 5.0, 0.08)
brass('D4', 56.0, 5.0, 0.2); brass('A3', 56.0, 5.0, 0.15)
add(supersaw(m('D1'), 5.5, 300, 3), 56.0, 0.3, send=0.2)

# ---------- tape stop for the rewind at 42.0 ----------
def tape_stop(ch, a, b):
    seg_len = int((b - a) * SR); i0 = int(a * SR)
    tt_ = np.arange(seg_len) / seg_len
    rate = (1 - tt_) ** 1.8
    pos = np.cumsum(rate)
    src = ch[i0:i0 + seg_len + 10]
    out = np.interp(pos, np.arange(len(src)), src) * (1 - tt_ ** 3)
    ch[i0:i0 + seg_len] = out
    ch[i0 + seg_len:int(44.0 * SR)] *= 0.0
for ch in (L, R, VL, VR):
    tape_stop(ch, 42.0, 43.1)

# ---------- reverb (stereo convolution) ----------
def reverb_ir(seconds=2.8, seed=0):
    r = np.random.default_rng(seed)
    t = tt(seconds)
    ir = r.standard_normal(len(t)) * np.exp(-t * 2.4)
    ir = lowpass(ir, 6000)
    ir[:int(0.012 * SR)] = 0
    return ir / np.sqrt(np.sum(ir ** 2))
def conv(x, ir):
    n = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
    y = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)
    return y[:len(x)]
wl = conv(VL, reverb_ir(seed=1)); wr = conv(VR, reverb_ir(seed=2))
outL = L + wl * 0.9; outR = R + wr * 0.9

# fade the final tail
t = np.arange(N) / SR
fade = np.clip((63.8 - t) / 3.0, 0, 1) ** 1.5
outL *= fade; outR *= fade

# master: gentle bus compression via tanh + normalize
mx = max(np.max(np.abs(outL)), np.max(np.abs(outR)))
outL = np.tanh(outL / mx * 1.4) ; outR = np.tanh(outR / mx * 1.4)
mx = max(np.max(np.abs(outL)), np.max(np.abs(outR)))
outL *= 0.89 / mx; outR *= 0.89 / mx

out = sys.argv[1] if len(sys.argv) > 1 else 'score.wav'
data = (np.stack([outL, outR], 1) * 32767).astype('<i2')
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data.tobytes())
print('wrote', out)
