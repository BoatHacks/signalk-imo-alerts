# Tone clips

Pre-recorded audio clips for the IMO A.1021(26) Table 7.2 audible codes,
generated once via offline synthesis (`scripts/generate_tones.py`) rather
than sourced from an existing CC0 library or synthesized live at runtime -
see docs/design.md, "Clip production".

- `1a.wav` - General emergency alarm (7 short blasts + 1 prolonged)
- `2.wav` - Continuous tone
- `3a.wav` - Square pulse train
- `3b.wav` - Sawtooth rise with sharp fall
- `3c.wav` - Grouped/clustered short pulses
- `3d.wav` - Sinusoidal frequency modulation

3.a-3.d use the pulse-rate/frequency bounds actually specified in Table
7.2 (0.5-2.0 Hz pulse rate, 500 Hz baseline, 2000 Hz maximum; 1.0 Hz was
chosen as this plugin's own implementation value within that range).
Table 7.2 does not specify a carrier frequency for 1.a/2 (it describes
the ship's-horn blast *pattern*, not a tone) - the 1000 Hz / 800 Hz used
there are this plugin's own synthesis choices, not values from the
standard.

`1b` (ship-specific muster-list codes) has no fixed clip - it's resolved
per-installation from the `musterListCodes` plugin config, not generated
here.

Regenerate with:

```sh
python3 scripts/generate_tones.py
```
