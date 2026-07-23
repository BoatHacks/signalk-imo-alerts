# Tone clips

Pre-recorded audio clips for the IMO A.1021(26) Table 7.2 audible codes,
generated once via offline synthesis (see docs/design.md, "Clip production")
rather than sourced from an existing CC0 library.

Not yet generated. Expected files:

- `1a.wav` - General emergency alarm (7 short blasts + 1 prolonged, repeated)
- `2.wav` - Continuous tone
- `3a.wav` - Square pulse train
- `3b.wav` - Sawtooth rise with sharp fall
- `3c.wav` - Grouped/clustered short pulses
- `3d.wav` - Sinusoidal frequency modulation

`1b` (ship-specific muster-list codes) has no fixed clip - it's resolved
per-installation from the `musterListCodes` plugin config.
