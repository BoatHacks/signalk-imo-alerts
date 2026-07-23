# signalk-imo-alerts

A Signal K plugin that produces spoken alert announcements and generates
IMO A.1021(26) alert tone patterns for `notifications.*` state changes,
harmonized with MSC.302(87) (Bridge Alert Management) priority/state
concepts where they apply.

See [docs/design.md](docs/design.md) for the full design rationale,
including which parts are grounded in the actual regulatory text and which
are this plugin's own synthesis.

## Status

Early scaffold. Implemented so far:

- Signal K state -> MSC.302(87) priority mapping (`lib/priority.js`)
- Message templates: generic fallback + per-path overrides + numeric
  interpolation via Signal K's own `displayUnits` meta (`lib/templates.js`,
  `lib/units.js`)
- Alert queue: priority preemption, same-priority chronological queueing,
  shared silence/acknowledge state, configurable repeat (`lib/alertQueue.js`)
- espeak-ng TTS wrapper with graceful fallback (`lib/tts.js`)
- Tone pattern lookup for IMO A.1021(26) Table 7.2 (`lib/tones.js`) -
  clip files themselves not yet generated, see `sounds/tones/README.md`
- Plugin wiring, `plugin.schema`, REST test endpoint, minimal demo webapp

Not yet done: actual tone clip generation, ack/silence detection wired up
to real Signal K PUT handlers/subscriptions (currently only reacts to
`status.acknowledged`/`method` on the notification itself), muster-list
code UI polish, CI verification against a real signalk-server instance.

## Development

```sh
npm test
```
