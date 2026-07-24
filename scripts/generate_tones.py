#!/usr/bin/env python3
"""
Generates the IMO A.1021(26) Table 7.2 audible-code tone clips as static
.wav assets (see docs/design.md, "Clip production": pre-recorded clips,
generated once via offline synthesis, not synthesized live at runtime).

Run once: python3 scripts/generate_tones.py
Output: sounds/tones/{1a,2,3a,3b,3c,3d}.wav

Frequency/pulse-rate parameters for 3.a-3.d come directly from Table 7.2:
"distinguishable waveforms with a pulse rate of 0.5-2.0 Hz between a
baseline of 500 Hz and a maximum of 2000 Hz." A pulse rate of 1.0 Hz
(mid-range) is used here as this plugin's own implementation choice,
since the standard gives a range, not a fixed value.

1.a's blast *pattern* is defined in IMO MSC.48(66) (LSA Code) §7.2.1.1,
not in A.1021(26) itself: "seven or more short blasts followed by one
long blast." This script uses exactly seven (the stated minimum).
Neither document specifies a carrier frequency for codes 1.a/2 (they
describe the ship's actual horn/klaxon blast pattern, not a tone), so
the 500 Hz used for both is this plugin's own synthesis choice, not a
value taken from either standard (chosen to match Table 7.2's own
500 Hz baseline for the 3.a-3.d waveforms, for consistency).

1.b (ship-specific muster-list codes) has no fixed clip - resolved
per-installation from plugin config - so it isn't generated here.
"""

import math
import struct
import wave
import os

SAMPLE_RATE = 44100
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'sounds', 'tones')

FREQ_LO = 500.0   # Table 7.2 baseline
FREQ_HI = 2000.0  # Table 7.2 maximum
PULSE_RATE_HZ = 1.0  # within the specified 0.5-2.0 Hz range


def write_wav(name, samples):
    path = os.path.join(OUT_DIR, name)
    with wave.open(path, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)  # 16-bit
        f.setframerate(SAMPLE_RATE)
        frames = b''.join(struct.pack('<h', max(-32767, min(32767, int(s * 32767)))) for s in samples)
        f.writeframes(frames)
    print(f'wrote {path} ({len(samples) / SAMPLE_RATE:.2f}s)')


def tone(freq, duration, amplitude=0.6, fade=0.005):
    n = int(SAMPLE_RATE * duration)
    fade_n = int(SAMPLE_RATE * fade)
    out = []
    for i in range(n):
        s = amplitude * math.sin(2 * math.pi * freq * i / SAMPLE_RATE)
        if i < fade_n:
            s *= i / fade_n
        elif i > n - fade_n:
            s *= (n - i) / fade_n
        out.append(s)
    return out


def silence(duration):
    return [0.0] * int(SAMPLE_RATE * duration)


def generate_1a():
    """General emergency alarm: 7 short blasts + 1 prolonged blast, per
    MSC.48(66) (LSA Code) §7.2.1.1's minimum ("seven or more short
    blasts followed by one long blast")."""
    samples = []
    for _ in range(7):
        samples += tone(500, 0.5)
        samples += silence(0.3)
    samples += tone(500, 2.0)
    return samples


def generate_2():
    """Continuous tone (played once per announce cycle; repeat scheduling
    in lib/alertQueue.js handles re-triggering until acknowledged/silenced,
    per MSC.302(87)'s own model)."""
    return tone(500, 3.0)


def generate_3a():
    """Square pulse train: abrupt switching between baseline and maximum."""
    samples = []
    half_period = 1 / PULSE_RATE_HZ / 2
    for _ in range(4):
        samples += tone(FREQ_LO, half_period, fade=0.002)
        samples += tone(FREQ_HI, half_period, fade=0.002)
    return samples


def generate_3b():
    """Sawtooth rise (linear 500Hz -> 2000Hz) with a sharp fall back."""
    period = 1 / PULSE_RATE_HZ
    n_per_period = int(SAMPLE_RATE * period)
    samples = []
    phase = 0.0
    for _cycle in range(4):
        for i in range(n_per_period):
            t = i / n_per_period
            freq = FREQ_LO + (FREQ_HI - FREQ_LO) * t
            phase += 2 * math.pi * freq / SAMPLE_RATE
            samples.append(0.6 * math.sin(phase))
        # sharp fall: phase reset happens naturally at next cycle's low freq
    return samples


def generate_3c():
    """Grouped/clustered short pulses (bursts of the maximum frequency)."""
    samples = []
    for _ in range(4):
        for _ in range(3):
            samples += tone(FREQ_HI, 0.08, fade=0.005)
            samples += silence(0.05)
        samples += silence(1 / PULSE_RATE_HZ - 3 * 0.13)
    return samples


def generate_3d():
    """Sinusoidal frequency modulation between baseline and maximum."""
    duration = 4 / PULSE_RATE_HZ
    n = int(SAMPLE_RATE * duration)
    mid = (FREQ_HI + FREQ_LO) / 2
    dev = (FREQ_HI - FREQ_LO) / 2
    samples = []
    phase = 0.0
    for i in range(n):
        t = i / SAMPLE_RATE
        freq = mid + dev * math.sin(2 * math.pi * PULSE_RATE_HZ * t)
        phase += 2 * math.pi * freq / SAMPLE_RATE
        samples.append(0.6 * math.sin(phase))
    return samples


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    write_wav('1a.wav', generate_1a())
    write_wav('2.wav', generate_2())
    write_wav('3a.wav', generate_3a())
    write_wav('3b.wav', generate_3b())
    write_wav('3c.wav', generate_3c())
    write_wav('3d.wav', generate_3d())


if __name__ == '__main__':
    main()
