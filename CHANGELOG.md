# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- One TTS engine (`espeak-ng`) now serves both local-speaker and
  browser playback, rather than two separate ones. `lib/tts.js`
  gained `synthesizeToFile()` (writes to a WAV file via `-w <path>`
  instead of speaking to the local device), and a new
  `GET /voice-clip` endpoint serves it on demand - not cached, since
  message text is usually dynamic (interpolated values), unlike the
  fixed set of tone patterns; the same pattern `/tone-clip` already
  uses for tones. The webapp's test mode and real active-alert
  playback both fetch and play this instead of using the browser's
  own separate Web Speech API voices - genuinely identical audio
  everywhere, not just "the same engine nominally." New `serverVoice`
  plugin config option (an `espeak-ng` voice/variant, e.g. `en-us`,
  `en+f3`) used for both. `/options` exposes the configured
  `{ language, serverVoice }`; `/test-announce` and `/voice-clip`
  both accept a per-call `voice` override, and `/test-announce` now
  returns the pronunciation-substituted `spokenMessage` in its
  response so the browser preview can use exactly that text without
  duplicating substitution logic client-side (`pronunciationSubstitutions`
  is no longer exposed via `/options` at all - substitution now lives
  in exactly one place). Covered by new `test/tts.test.js` and
  additions to `test/routes.test.js`.

  Trade-off worth noting: `espeak-ng` is formant-synthesis and sounds
  more robotic than modern browser/OS TTS voices - this trades voice
  naturalness for guaranteed consistency, which seemed like the right
  call for a safety-alert plugin. See docs/design.md, "Playback".

- `GET /options` now also lists configured `musterListCodes` entries
  (path/zone/pattern), and the test-mode webapp offers each as a
  one-click tone option (labeled by zone/role) alongside the built-in
  codes and free-text custom pattern - no need to retype a
  muster-list pattern to preview it.
- `GET /options` now includes each priority's currently-configured
  default tone (`configuredDefault`: `{ preset, pattern }`), sourced
  from the new `cautionTone`/`warningTone`/`alarmTone`/
  `emergencyAlarmTone` config. The test-mode webapp uses this to show
  a live hint next to the tone selector (e.g. "(currently: 3c)") so
  "Priority default" isn't a black box.
- `cautionTone`, `warningTone`, `alarmTone`, and `emergencyAlarmTone`
  plugin config options: every priority's default tone is now fully
  user-configurable - pick a built-in preset (`1a`/`2`/`3a`/`3b`/`3c`/
  `3d`) or supply a free custom pattern (same text format as
  `musterListCodes`). This matters most for Caution/Warning, which
  have no IMO A.1021(26) table basis at all, but Alarm/Emergency Alarm
  are configurable too since their built-in defaults only reflect one
  of several function-specific cases the real table distinguishes.
  Resolved in `lib/tones.js`'s `resolveClipPath`, which takes an
  optional per-priority tone config (muster-list path overrides still
  take precedence) and falls back to the built-in default when none
  is set.

### Documentation

- Cited IMO MSC.48(66) (LSA Code) §7.2.1.1 as the actual source of the
  1.a general emergency alarm blast pattern ("seven or more short
  blasts followed by one long blast") — A.1021(26) only cross-
  references it. Also noted that §7.2.1.1's "temporarily interrupted
  by a message on the public address system" is direct regulatory
  support for the tone-then-voice sequencing decision, not just this
  plugin's own inference.
- Audited the priority→tone-code defaults against A.1021(26)'s actual
  Tables 7.1.1–7.1.3 (not just Table 7.2's code definitions). Found
  these tables assign codes per specific alarm *function*
  (fire-related vs. machinery/steering/etc.), not per priority tier,
  and that Warning/Caution have no Table 7.2 basis at all. Swapped
  Caution↔Warning defaults (Caution→3.c, Warning→3.a) and documented,
  in `docs/design.md` and inline in `lib/tones.js`, exactly which
  parts of the mapping are standard-grounded and which are this
  plugin's own simplification.

### Fixed

- Pronunciation fixes (`pronunciationSubstitutions` in plugin config)
  weren't applied to a test message typed into the webapp's test
  mode - only real alerts went through the substitution table,
  because `/test-announce` spoke the raw typed text directly instead
  of running it through `applyPronunciation` (now exported from
  `lib/templates.js`). Fixed both playback paths: server-side TTS
  (`/test-announce`) and the webapp's immediate browser-side Web
  Speech preview, which now fetches the configured substitutions via
  `/options` and applies them itself before speaking.

- The PUT handler for acknowledge/silence (`lib/ackListener.js`) used
  a Node-style error-first callback (`callback(null, result)`), but
  `signalk-server`'s `put.js` calls the handler's callback with a
  single argument (`callback(reply)`) — or, for a synchronous handler
  like this one, expects the result returned directly. This meant
  every PUT-based acknowledge/silence actually worked (the alert
  state genuinely changed) but the HTTP response was a 500 with
  "Cannot read properties of null (reading 'state')", traced by
  reading `signalk-server`'s own source against the actual error.
  Found by running a real `signalk-server` instance against this
  plugin and driving it with actual HTTP/WebSocket traffic, not just
  the mocked unit tests — also confirmed via the same live run that
  `/options`, `/active`, `/tone-clip` (all three query modes),
  `/acknowledge`, `/silence`, the full notification pipeline
  (including the pinned Emergency Alarm path), and both graceful TTS/
  tone fallbacks work correctly end-to-end. Fixed by returning the
  result directly instead of using the callback at all, since the
  handler's logic is fully synchronous.

- Browser-side tone preview/playback (`public/app.js`) wasn't audibly
  playing anything, even though the request logic traced through
  correctly on paper. Rewrote `playToneInBrowser` to fetch the clip as
  a blob first (surfacing real HTTP errors instead of a silent
  `<audio>` load failure, and sidestepping range-request/caching
  quirks some embedded/webview browsers have with query-string audio
  URLs) rather than pointing `<audio src>` directly at the endpoint.
  Playback failures now show a visible status message in the test
  form instead of only logging to the console. Also added an error
  callback to the backend's `res.sendFile` in `/tone-clip`, so an
  async send failure there isn't silent either.

- REST routes (`/active`, `/options`, `/tone-clip`, `/test-announce`,
  `/acknowledge`, `/silence`) were registered via a guessed
  `app.getPluginRouter?.() || app.router` fallback, which is not the
  actual Signal K plugin API. Routes could end up mounted at the
  wrong path (or not at all) depending on server version, which is
  what caused the webapp's priority dropdown (and likely the other
  REST-backed features) to come up empty. Fixed by implementing
  `plugin.registerWithRouter(router)` instead — the real convention,
  which the server calls itself and always mounts at
  `/plugins/<id>/`, matching what `signalk-notification-dispatcher`
  and the other plugins already do correctly.

### Changed

- Reduced the 1.a/2 carrier frequency from 1000/800 Hz to 500 Hz
  (both), matching Table 7.2's own 500 Hz baseline used for the
  3.a–3.d waveforms. Regenerated `sounds/tones/1a.wav` and `2.wav`.
  Still this plugin's own synthesis choice — neither MSC.48(66) nor
  A.1021(26) specifies a carrier frequency for 1.a/2.

## [0.1.0] - 2026-07-24

Not yet published to npm.

### Added

- Initial design document (`docs/design.md`) covering priority mapping,
  message templates, playback, repeat/silence/acknowledge behavior,
  concurrency handling, and regulatory grounding (MSC.302(87), IEC 62923,
  SMCP, GMDSS/DSC).
- Core plugin scaffold:
  - `lib/priority.js` — Signal K state ↔ MSC.302(87) priority mapping,
    with a configurable pinned-path Emergency Alarm tier.
  - `lib/templates.js` + `lib/units.js` — message templates (generic
    fallback + per-path overrides) with numeric interpolation via
    Signal K's own `displayUnits` meta.
  - `lib/alertQueue.js` — priority preemption, same-priority
    chronological queueing, shared silence/acknowledge state,
    configurable repeat (30s default).
  - `lib/tts.js` — espeak-ng wrapper with graceful fallback.
  - `lib/tones.js` — IMO A.1021(26) Table 7.2 tone code resolution and
    playback.
  - `index.js` — plugin wiring, `plugin.schema`, initial REST test
    endpoint, minimal demo webapp.
  - CI via Signal K's reusable `plugin-ci.yml`.
- IMO A.1021(26) Table 7.2 tone clips (1.a, 2, 3.a–3.d), generated via
  offline synthesis (`scripts/generate_tones.py`).
- Ack/silence wired to real Signal K mechanisms (`lib/ackListener.js`):
  a PUT handler registered per active alert path, plus a poll fallback
  for updates that don't emit a delta — mirrors
  `signalk-dead-mans-switch`'s reconciliation approach. REST
  `/acknowledge` and `/silence` endpoints.
- Text-based pattern format for 1.b ship-specific muster-list codes
  (`lib/tonePattern.js`): space-separated `<freqHz>:<durationMs>`
  tokens (e.g. `"500:1000 0:250 2000:1000"`), synthesized once per
  distinct pattern and cached on disk by content hash
  (`resolveMusterClipPath` in `lib/tones.js`).
- Full test mode in the demo webapp: a form combining priority, tone
  (built-in code, custom pattern, or the priority's default), message,
  and language. Plays both in-browser (`<audio>` + Web Speech API) and
  server-side via the extended `/test-announce` endpoint. New
  `GET /options` and `GET /tone-clip` REST endpoints support the form.

### Design decisions of note

See `docs/design.md` for the full rationale on each of these:

- Persistence: none — the plugin re-subscribes to `notifications.*` on
  restart rather than keeping its own local queue, per MSC.302(87)
  §12.3/§13.1.2.5.
- Debouncing: none — relies on the alert emitter; confirmed the
  regulations don't take a position on this either way.
- Concurrency: a new higher-priority alert preempts a currently-playing
  lower-priority one; same-priority alerts queue chronologically.
- Tone and voice share a single silence/acknowledge state, per IEC's
  own BAM mariner guidance.

[Unreleased]: https://github.com/BoatHacks/signalk-imo-alerts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BoatHacks/signalk-imo-alerts/releases/tag/v0.1.0
