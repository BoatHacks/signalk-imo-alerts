# signalk-imo-alerts

A Signal K plugin that produces spoken alert announcements and generates
IMO A.1021(26) alert tone patterns, harmonized with MSC.302(87) (Bridge
Alert Management) priority/state concepts where they apply.

**This branch (`alerts-only`)** consumes `alerts.*` deltas published by
[signalk-alert-manager](https://github.com/hatlabs/signalk-alert-manager)
as its single source of truth, instead of the `main` branch's
`notifications.*`-based design. Requires `signalk-alert-manager` to be
installed and enabled (declared via `signalk.requires` in
`package.json`). See [docs/alerts-only-plan.md](docs/alerts-only-plan.md)
for the full plan, decisions, and a real bug this surfaced upstream
([BoatHacks/signalk-imo-alerts#1](https://github.com/BoatHacks/signalk-imo-alerts/issues/1)).

See [docs/design.md](docs/design.md) for the design rationale that still
applies (message templates, tone patterns, playback, voice) - note it
still describes `notifications.*` in places; `docs/alerts-only-plan.md`
is authoritative for anything about where alerts come from and how
their lifecycle is handled on this branch. See [CHANGELOG.md](CHANGELOG.md)
for what's landed so far.

## Status

Implemented so far:

- `alerts.*` subscription with heartbeat dedup (a repeat delta with
  unchanged id/priority/state/message/silenced doesn't re-trigger
  playback) and full IEC 62923 lifecycle handling (`unacknowledged`,
  `acknowledged`, `rtn-unacknowledged`, `normal`) (`index.js`)
- Direct priority mapping from alert manager's own `caution`/`warning`/
  `alarm`/`emergency` field (`lib/priority.js`) - no more inferring
  priority from Signal K notification states or a pinned-path hack
- Escalation (alert manager auto-escalating an unacknowledged warning
  to alarm) forces an immediate re-announcement rather than waiting
  out the normal repeat interval (`lib/alertQueue.js`)
- Message templates: generic fallback (alert manager's own `message`,
  always present) + per-path overrides, with per-priority configurable
  phrasing for `rtn-unacknowledged` alerts (`lib/templates.js`)
- Alert queue: priority preemption, same-priority chronological
  queueing, shared silence/acknowledge state, per-priority repeat
  policy (`lib/alertQueue.js`) - Warning plays once, Alarm repeats at
  a configurable interval, Emergency Alarm loops continuously with no
  gap; silencing stops any of these immediately and only resumes on
  an explicit un-silence transition, never a local timer
- espeak-ng TTS wrapper with graceful fallback (`lib/tts.js`)
- Tone pattern lookup and playback for IMO A.1021(26) Table 7.2
  (`lib/tones.js`), with the actual clips generated via
  `scripts/generate_tones.py` (`sounds/tones/*.wav`)
- Ack/silence proxy to alert manager's REST API
  (`lib/alertManagerClient.js`) - requires a user-generated access
  token (`alertManagerToken` config); alert manager's own documented
  plugin API (`app.alertManager`) turned out to be unreachable from
  other plugins, see the issue linked above
- 1.b ship-specific muster-list codes: entered as a text pattern
  (`"<freqHz>:<durationMs> ..."`), parsed and synthesized once per
  distinct pattern, then cached (`lib/tonePattern.js`, `lib/tones.js`)
- Caution/Warning/Alarm/Emergency Alarm tones are all fully
  user-configurable (`cautionTone` / `warningTone` / `alarmTone` /
  `emergencyAlarmTone` in `plugin.schema`): pick a built-in preset or
  supply a free custom pattern per priority
- One TTS engine (`espeak-ng`) serves both local-speaker and browser
  playback: the browser fetches and plays the exact same rendered
  audio the server would speak, via `GET /voice-clip` (not cached -
  message text is dynamic, unlike tones), the same pattern
  `/tone-clip` uses for tones. Voice configurable via `language` +
  `serverVoice` (`lib/tts.js`'s `synthesizeToFile`, `index.js`,
  `public/app.js`)
- Plugin wiring, `plugin.schema`, REST endpoints
  (`/active`, `/options`, `/tone-clip`, `/voice-clip`,
  `/test-announce`, `/acknowledge`, `/silence`), and a full
  test-mode webapp: a form combining priority/tone/custom-pattern/
  message/language/voice (including every configured
  `musterListCodes` entry as a one-click tone option). `/test-announce`
  pushes into the same alert queue real alerts use (synthetic path
  `test.announce.<priority>`), so a test follows the real
  priority/repeat/silence rules and plays in every open webapp tab via
  `/active`'s existing polling - no separate broadcast mechanism
  needed. The active-alerts table now has Acknowledge/Silence buttons
  per row too, since an Alarm/Emergency-priority test will otherwise
  keep repeating/looping until dealt with

Not yet done: automated CI verification against a real signalk-server
instance (manual live-server checks have been done repeatedly, ad hoc,
and deliberately kept out of the repo/CI - see CHANGELOG.md); npm
publish for this branch; merging back to `main` (or deciding this
becomes the new `main`, given `signalk-alert-manager` is now a hard
dependency - not yet decided).

## Development

```sh
npm test
```

88 tests currently passing. To regenerate the built-in tone clips
(`sounds/tones/*.wav`) after changing `scripts/generate_tones.py`:

```sh
python3 scripts/generate_tones.py
```
