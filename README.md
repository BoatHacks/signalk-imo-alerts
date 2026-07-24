# signalk-imo-alerts

A Signal K plugin that produces spoken alert announcements and generates
IMO A.1021(26) alert tone patterns for `notifications.*` state changes,
harmonized with MSC.302(87) (Bridge Alert Management) priority/state
concepts where they apply.

See [docs/design.md](docs/design.md) for the full design rationale,
including which parts are grounded in the actual regulatory text and which
are this plugin's own synthesis. See [CHANGELOG.md](CHANGELOG.md) for
what's landed so far.

## Status

Early scaffold. Implemented so far:

- Signal K state -> MSC.302(87) priority mapping (`lib/priority.js`)
- Message templates: generic fallback + per-path overrides + numeric
  interpolation via Signal K's own `displayUnits` meta (`lib/templates.js`,
  `lib/units.js`)
- Alert queue: priority preemption, same-priority chronological queueing,
  shared silence/acknowledge state, configurable repeat (`lib/alertQueue.js`)
- espeak-ng TTS wrapper with graceful fallback (`lib/tts.js`)
- Tone pattern lookup and playback for IMO A.1021(26) Table 7.2
  (`lib/tones.js`), with the actual clips generated via
  `scripts/generate_tones.py` (`sounds/tones/*.wav`)
- Ack/silence reconciliation: PUT handler registered per active alert
  path, plus a poll fallback for updates that don't emit a delta
  (`lib/ackListener.js`), mirroring `signalk-dead-mans-switch`
- 1.b ship-specific muster-list codes: entered as a text pattern
  (`"<freqHz>:<durationMs> ..."`), parsed and synthesized once per
  distinct pattern, then cached (`lib/tonePattern.js`, `lib/tones.js`)
- Plugin wiring, `plugin.schema`, REST endpoints
  (`/active`, `/options`, `/tone-clip`, `/test-announce`,
  `/acknowledge`, `/silence`), and a full test-mode webapp: a form
  combining priority/tone/custom-pattern/message/language, playing
  both in-browser and (if enabled) server-side

Not yet done: CI verification against a real signalk-server instance,
actual release/publish.

## Development

```sh
npm test
```

35 tests currently passing. To regenerate the built-in tone clips
(`sounds/tones/*.wav`) after changing `scripts/generate_tones.py`:

```sh
python3 scripts/generate_tones.py
```
