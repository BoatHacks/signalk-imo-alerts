@no-slop.md

# signalk-imo-alerts

SignalK plugin for spoken alert announcements + IMO A.1021(26) tone patterns,
following MSC.302(87) priorities (caution/warning/alarm/emergency alarm).
Originally called "signalk-voice-alerts", renamed. Repo:
BoatHacks/signalk-imo-alerts.

**Important:** for any "per IMO" claim, verify against the original text of
MSC.302(87) — if it's not available, ask for it to be re-uploaded rather than
answering from memory.

## main branch (notifications.*-based)
- Priority derived from Signal K notification state, with a configurable
  `pinnedEmergencyAlarmPaths` list for true emergency-alarm level.
- Ack/silence via per-path PUT handler + poll fallback (`lib/ackListener.js`),
  same pattern as [[signalk-dead-mans-switch]].
- Message resolution: generic fallback templates + per-path overrides,
  numeric interpolation via SignalK `displayUnits` meta.
- Tone patterns 1.a/1.b/2/3.a-3.d from A.1021(26) Table 7.2, pre-synthesized as
  WAV clips (`scripts/generate_tones.py`); carrier frequency 500Hz for 1.a/2 is
  our own choice, not normative.
- Per-priority configurable default tones (cautionTone/warningTone/alarmTone/
  emergencyAlarmTone) — checked against A.1021(26) Tables 7.1.1-7.1.3: the real
  mapping there is function-dependent (fire vs. machinery etc.), not
  priority-dependent; caution/warning have no table basis at all.
- Crew-list codes (1.b) as plain-text patterns (`freqHz:durationMs` tokens),
  configured per path, synthesized once and cached.
- TTS: espeak-ng, one engine for speaker AND browser (browser plays identical
  audio via `/voice-clip` instead of its own Web Speech voice) — trade-off:
  more robotic, but consistent.
- Pronunciation substitution and tone repeat: configurable per priority
  (warning/caution once, alarm at a configurable interval, emergency alarm
  endlessly without pause); muting stops immediately, no auto-resume timer.
- No own persistence (re-subscribe returns current state), no debouncing
  (relies on the emitter), no audio ducking with other plugins.
- Test webapp with a full test mode (priority/tone/pattern/message/language
  combinable, including configured crew-list codes as one-click options).
- v0.1.0 released (GitHub tag+release), not yet published to npm.
- CI uses SignalK's plugin-ci.yml; tests against a real running signalk-server
  deliberately NOT in CI/repo, ad-hoc manual verification only.

## "alerts-only" branch (alerts.* from signalk-alert-manager as sole source)
- Plan doc at `docs/alerts-only-plan.md`; signalk-alert-manager declared as a
  required companion plugin (`package.json` `signalk.requires`).
- Priority now comes directly from alert-manager's `priority` field — no
  inference, no pinning needed.
- Full IEC-62923 lifecycle handling (unacknowledged/acknowledged/
  rtn-unacknowledged/normal), heartbeat dedup, escalation triggers immediate
  re-announcement.
- rtn-unacknowledged phrasing configurable per priority.
- **Key architectural finding:** `app.alertManager` (plugin API) is
  structurally unreachable from other plugins (signalk-server copies the `app`
  object per plugin) — confirmed live and externally
  (hatlabs/signalk-alert-manager#104/#106); tracked as
  github.com/BoatHacks/signalk-imo-alerts/issues/1. Ack/silence instead go
  through alert-manager's REST API (`lib/alertManagerClient.js`) with a
  user-generated `alertManagerToken`. `lib/ackListener.js` and
  `pinnedEmergencyAlarmPaths` were removed as no longer needed.
- Live-verified end-to-end against a real signalk-server + signalk-alert-manager
  (ack/silence round trip, priority mapping, tone selection including
  crew-list override, repeat behavior with exact timings).
- `docs/alerts-only-plan.md` also documents alert-manager's own
  browser-based, IEC-60601-1-8-based audio scheme for comparison.
- Current state: 83/83 tests passing on the branch. Open: CI against a real
  server as an official step, npm publish, and the merge decision (does
  alerts-only become the new main?).
- Fixed a double-path bug in `docs/openApi.json` (doubled
  `/plugins/signalk-imo-alerts/` prefix) — root cause verified in
  signalk-server's own `swagger.js` (it auto-injects
  `apiDoc.servers=[{url:'/plugins/<id>'}]` when the plugin doesn't specify
  `servers`, but our path keys were already full paths). Fixed by making all 7
  path keys relative (`/active`, `/options`, `/tone-clip`, `/test-announce`,
  `/voice-clip`, `/acknowledge`, `/silence`).
- `/test-announce` now uses the real AlertQueue (synthetic path
  `test.announce.<priority>`) instead of its own broadcast mechanism, so test
  messages follow real priority/repeat/silence rules.
  `AlertQueue.upsert()` has an optional `meta` field for tone/language
  override; `GET /active` returns `revision` + `meta`; `/acknowledge` and
  `/silence` branch by path (`test.announce.*` locally on the queue, real
  alerts still via alert-manager's REST API).
- Fixed a webapp dedup bug (dedup key was `path+message`, now `path+revision`)
  and a real gap: the webapp had no acknowledge/silence buttons at all — added
  to the active-alerts table (also benefits real alarms).
- Live-verified: test entries appear correctly in `/active` with tone override,
  ack/silence on the test path bypasses alert-manager (confirmed via server
  log — no proxy call), real alerts still correctly go through the REST proxy.
  88/88 tests passing.
