# Plan: `alerts.*` as the single source

Branch: `alerts-only`. Goal: stop deriving priority/state from raw
`notifications.*` deltas and MSC.302(87) guesswork, and instead consume
`alerts.*` deltas published by [hatlabs/signalk-alert-manager][sam] as the
single canonical source of truth for what to voice/tone.

[sam]: https://github.com/hatlabs/signalk-alert-manager

This plan is based on reading `signalk-alert-manager`'s README directly
(fetched during this session, not from memory). Quotes below are from
that document.

## Why this is worth doing

Our current design has two structural weaknesses that alert-manager
solves at the source:

1. **Priority is inferred, not given.** We map Signal K's `alert/warn/
   alarm/emergency` notification states onto MSC.302(87)'s
   Caution/Warning/Alarm/Emergency-Alarm tiers, but Signal K's
   `emergency` state doesn't distinguish "genuinely immediate danger to
   life" from "just the top of a 4-level severity scale" — which is why
   we invented `pinnedEmergencyAlarmPaths` as a manual patch. Alert
   manager's own priority field is already `emergency | alarm | warning
   | caution` — a direct MSC.302(87)-shaped enum, set explicitly by
   whatever raised the alert. **The pinned-path hack becomes
   unnecessary entirely.**
2. **We own a competing, weaker copy of lifecycle state.** Our
   `AlertQueue` independently tracks acknowledge/silence, with our own
   PUT-handler-per-path reconciliation (`lib/ackListener.js`) trying to
   infer external ack/silence from raw notification field changes.
   Alert manager already implements the actual IEC 62923 four-state
   lifecycle (unacknowledged / acknowledged / rtn-unacknowledged /
   normal) with persistence, escalation, and an audit trail — things
   we explicitly chose not to build (see "Explicitly out of scope" in
   the main `docs/design.md`: no persistence, no escalation). Instead
   of re-deriving a worse copy of that state, we can treat alert
   manager as authoritative and become a pure **playback/rendering**
   layer: given the current state of an alert, decide what sound to
   make; when the user acts, tell alert manager, not our own queue.

Alert manager's own audio is intentionally basic — "Browser-based audio
alerts with different tones per priority level" with no mention of
IMO A.1021(26) tone patterns, no server-side/local-speaker path, and no
TTS. That's exactly this plugin's reason to exist. The plan below keeps
our tone/voice rendering (the actual value this plugin adds) and
replaces our home-grown lifecycle/priority handling with alert
manager's.

## Data model comparison

| | `notifications.*` (current) | `alerts.*` (alert manager) |
|---|---|---|
| Path | `notifications.<path>` | `alerts.<path>` (same `<path>` convention) |
| Priority | Inferred from `state` (`alert/warn/alarm/emergency`) + our own pinned-path list | Explicit `priority`: `emergency \| alarm \| warning \| caution` |
| Lifecycle | Signal K's basic ack/silence/reactivation, in-memory, no audit trail | Full IEC 62923: `unacknowledged \| acknowledged \| rtn-unacknowledged \| normal`, persisted (SQLite), escalation, history |
| Message | `.message` (freeform) | `.message` (freeform, required) |
| Identity | path only | `id` (UUID) + `path` |
| Silencing | boolean-ish via `method` field manipulation (see current `handleNotification` heuristics) | explicit `silenced: true` + `silencedUntil` timestamp, time-limited by config |
| Source liveness | none | `sourceOnline`, `lastSourceUpdate`, `stale` |
| Grouping | none | optional `group` (e.g. `"engine"`) |
| Extra context | none structured | optional `data` object (arbitrary, non-array) |

Example `alerts.*` delta value (from the README):

```json
{
  "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "path": "propulsion.main.coolantTemperature",
  "$source": "n2k-on-ve.can-bus.115",
  "priority": "alarm",
  "state": "unacknowledged",
  "condition": true,
  "latching": true,
  "silenced": false,
  "message": "Coolant temperature high",
  "raisedAt": "2026-01-13T10:30:00.000Z",
  "sourceOnline": true,
  "lastSourceUpdate": "2026-01-13T10:30:00.000Z",
  "stale": false
}
```

## Priority mapping (new, direct)

Replace `lib/priority.js`'s `resolvePriority(path, state,
pinnedEmergencyAlarmPaths)` with a direct string lookup:

| alert manager `priority` | Our `PRIORITY` |
|---|---|
| `"caution"` | `CAUTION` |
| `"warning"` | `WARNING` |
| `"alarm"` | `ALARM` |
| `"emergency"` | `EMERGENCY_ALARM` |

No more `alert`-state-is-never-voiced special case to hardcode —
alert manager doesn't have a fifth "informational" tier, so every
`alerts.*` delta that reaches us is, by construction, something
alert manager decided was worth alerting on. `pinnedEmergencyAlarmPaths`
config and the whole "is this path pinned" mechanism can be deleted.

## Lifecycle/state mapping

| alert manager `state` | What we do |
|---|---|
| `unacknowledged` | Voice/tone as normal — `queue.upsert(...)` |
| `unacknowledged` + `silenced: true` | Treat as our existing `SILENCED` — stop repeating until `silencedUntil` (or a fresh unsilenced delta) |
| `acknowledged` | Treat as our existing `ACKNOWLEDGED` — `queue.acknowledge(...)` |
| `rtn-unacknowledged` | Condition cleared but not yet acked — still voiced (repeat continues). Whether it repeats the original message verbatim or a distinct "condition cleared, please acknowledge"-style phrase is **configurable per priority** — see Decisions below. |
| `normal` | Terminal — `queue.remove(path)`. README: *"the full alert object is published with `state: 'normal'`... consumers should treat `normal` as 'no active alert for this path'."* |

## Heartbeat dedup

The README is explicit about a failure mode to avoid: *"If a delta
arrives for a path that already has an active alert with the same
priority and message, it acts as a heartbeat."* Our delta handler must
not treat every heartbeat as a fresh occurrence (which would wrongly
reset repeat timers or re-trigger playback). Concretely: only call
`queue.upsert` when `priority`, `state`, or `message` actually changed
from what we already have for that `id`/`path` — track by `id` (stabler
than path alone, since alert manager's `id` persists across a
heartbeat/re-raise but a *different* alert could reuse the same `path`
after the first one clears).

Also: *"Deltas published by the alert manager's own delta publisher
(source label `alert-manager`) are ignored [by alert manager itself]
to prevent feedback loops."* We should apply the same `$source` check
defensively if we ever publish our own deltas back (we don't currently
plan to, but worth guarding against future footguns).

## Ack/Silence: delegate, don't own

Currently `lib/ackListener.js` registers a PUT handler per path and a
poll fallback, both driving our *own* `AlertQueue.acknowledge/silence`
directly. Under alerts-only, the correct direction of control reverses:
when the user acknowledges/silences through *our* webapp or REST
endpoints, we should call alert manager's API — not mutate our queue
directly — and let the resulting `alerts.*` delta (which alert manager
publishes on every state change) update our queue the same way any
other state change does. This keeps exactly one system authoritative
for lifecycle state, matching the README's own framing: *"The
`AlertManager` is the single source of truth... No external actor can
modify alert state directly."*

Two ways to call it, in preference order:
1. **Plugin API** (`app.alertManager.acknowledgeAlert(id, operator)`,
   `app.alertManager.silenceAlert(id, ms)`) — same-process, no auth
   token needed, the README explicitly documents this for other
   plugins. Requires a soft-dependency check (`app.alertManager` may be
   undefined if alert manager isn't installed/enabled) with a clear
   error surfaced through our existing REST endpoints rather than a
   silent no-op.
2. **REST API** (`POST /plugins/signalk-alert-manager/alerts/{id}/
   acknowledge`) — fallback if the plugin API isn't available for some
   reason, but requires the server's admin bearer token, which is
   awkward for one plugin to obtain on behalf of another. Probably not
   worth implementing unless the plugin API path proves insufficient.

This also means `lib/ackListener.js`'s per-path PUT-handler
registration and poll-fallback become dead code under alerts-only —
alert manager already owns PUT-equivalent handling for its own domain.
Per the exclusive-alerts-only decision below (no dual-mode), this gets
deleted outright rather than kept dormant behind a toggle.

## Message resolution

Alert manager's `message` is a required, human-authored string —
already meant to be read, unlike a notification's sometimes-absent
`.message`. Plan: keep our priority-name prefix ("Warning. Coolant
temperature high.") and pronunciation substitution table
(`applyPronunciation`), but **drop** `humanizePath` (no longer needed —
message is never absent, alert manager requires it) and drop numeric
interpolation via `displayUnits` (alerts.* has no single numeric
`value` field — the optional `data` object is arbitrary/free-form, not
a value+unit pair like a notification can carry). If a future need
arises to speak a specific number from `data`, that would need its own
per-alert-type template, out of scope for this pass.

`group` (e.g. `"engine"`, `"navigation"`) isn't used by the current
`musterListCodes` matching (which matches on exact `path`/prefix) —
leave path-based matching as-is for now; `group`-based tone overrides
would be a reasonable future enhancement, not required for this plan.

## What gets removed/changed

- **Removed**: `pinnedEmergencyAlarmPaths` config + matching logic in
  `lib/priority.js` (`isPinned`) — superseded by alert manager's own
  explicit `emergency` priority.
- **Removed**: `lib/ackListener.js`'s PUT-handler-per-path registration
  and poll fallback — superseded by observing `alerts.*` deltas
  directly; ack/silence *actions* redirect to alert manager's API
  instead.
- **Changed**: `handleNotification`/`handleDelta` in `index.js` —
  subscribe to `alerts.*` instead of `notifications.*`; parse the
  alert-manager delta shape instead of the notification shape.
- **Changed**: `resolveMessage` in `lib/templates.js` — drop
  `humanizePath` fallback and `displayUnits` interpolation entirely
  (alert manager's `message` is always present, and `data` isn't a
  value+unit pair the way a notification's `.value` can be).
- **Changed**: `/acknowledge` and `/silence` REST endpoints — become
  thin proxies to `app.alertManager`, not direct `queue.acknowledge/
  silence` calls.
- **Unchanged**: `AlertQueue`'s priority-preemption/chronological
  queueing, repeat scheduling, tone/voice rendering, `musterListCodes`
  path matching, all of `lib/tones.js`/`lib/tonePattern.js`/
  `lib/tts.js`, the whole webapp test-mode infrastructure (buttons
  kept, per decision 5 below). This plan only touches *where alerts
  come from and who owns their lifecycle*, not how we render them.

## Decisions

The five open questions above have been decided:

1. **Exclusive alerts-only.** No `notifications.*` fallback/dual-mode —
   a clean break, matching the branch's premise. Alert manager becomes
   a hard dependency of this branch. Declared in `package.json` via
   `signalk.requires: ["signalk-alert-manager"]` — Signal K's AppStore
   mechanism for a mandatory companion plugin (gives users an "Install
   required plugins" button if it's missing). Deliberately *not* a
   `peerDependencies` entry: Signal K's own publishing docs say not to,
   since it interacts badly with the plugin tree resolver — `requires`
   is AppStore-only semantics, not an npm-level dependency.
2. **`rtn-unacknowledged` phrasing is configurable per priority.** Not
   a single fixed choice — each priority (Caution/Warning/Alarm/
   Emergency Alarm) gets its own setting for whether an `rtn-
   unacknowledged` alert repeats the original message verbatim or
   speaks a distinct "condition cleared, please acknowledge"-style
   phrase. Mirrors the existing per-priority tone configurability
   (`cautionTone`/`warningTone`/`alarmTone`/`emergencyAlarmTone`) —
   same pattern, new axis.
3. **Graceful degradation: start, don't refuse.** If
   `app.alertManager` is `undefined` at startup, the plugin starts
   anyway, logs a clear warning (`app.debug` and/or
   `app.setPluginStatus`), and does nothing until alert manager
   actually appears — rather than refusing to start outright. Needs a
   way to detect alert manager appearing *after* our own startup too
   (it's a separate plugin; load order between two plugins in the same
   signalk-server isn't guaranteed), not just a one-time check.
4. **Escalation re-announces immediately.** When alert manager
   auto-escalates a warning to alarm (or any priority bump on the same
   alert `id`), treat it as a fresh higher-priority occurrence and
   trigger a new tone+voice announcement right away, rather than
   waiting for the normal repeat cycle to notice the priority changed.
   This means the priority-change case needs to explicitly reset
   `lastAnnounced`/bypass the repeat-interval gate in `AlertQueue`,
   not just rely on `upsert`'s existing preemption logic (preemption
   handles *interrupting current playback*, not *whether a new
   announcement is due at all* for an already-`lastAnnounced` entry —
   worth double-checking against the actual `_reconsider`/`upsert`
   logic during implementation, since escalation is a same-`id`
   `upsert` with a higher priority, and the current code's repeat gate
   keys off `lastAnnounced`, not priority-unchanged-since-last-time).
5. **Keep our own ack/silence buttons**, as a thin proxy to alert
   manager's API (`app.alertManager.acknowledgeAlert`/`silenceAlert`).
   Not deferring entirely to alert manager's own Web UI — the
   preview/test webapp stays self-contained.

## Testing / verification plan

- Unit tests: new fixtures for `alerts.*`-shaped deltas (replacing/
  augmenting the current notification-shaped ones in
  `test/index`-adjacent tests), priority-string-to-`PRIORITY` mapping,
  heartbeat-dedup behavior (same id/priority/message twice → no
  re-trigger), `rtn-unacknowledged`/`normal` transitions, per-priority
  `rtn-unacknowledged` phrasing config, escalation forcing an immediate
  re-announcement (not just a silent priority bump).
- Mock `app.alertManager` for ack/silence-proxy tests (success case,
  and the "alert manager not installed" case) and for the
  appears-after-our-startup detection case.
- Live verification: install `signalk-alert-manager` alongside this
  plugin in the same scratch `signalk-server` sandbox we've used
  before, raise a real alert via its REST API, confirm our plugin
  picks it up from `alerts.*`, renders the right tone/priority, that
  escalating a warning triggers an immediate re-announcement, and that
  acknowledging through *our* endpoint is reflected in *alert
  manager's* own `/alerts/{id}` — proving the single-source-of-truth
  property actually holds, not just that our code compiles.

## Suggested implementation order

1. Priority mapping + delta parsing for `alerts.*` (no lifecycle
   changes yet — just get tone/voice triggering on the right priority
   from the new shape).
2. Heartbeat dedup.
3. `normal`/`acknowledged`/`rtn-unacknowledged` state handling,
   including the per-priority `rtn-unacknowledged` phrasing config.
4. Escalation → immediate re-announcement (`AlertQueue` changes to
   bypass the repeat-interval gate on a priority increase for an
   already-seen `id`).
5. Ack/silence proxy to `app.alertManager` (keeping the webapp's own
   buttons, per decision 5), with startup graceful-degradation and
   appears-later detection. Remove/disable `lib/ackListener.js`'s old
   PUT-handler/poll-fallback path.
6. Remove `pinnedEmergencyAlarmPaths`.
7. Update all docs (`docs/design.md`, `README.md`, `docs/openApi.json`,
   `CHANGELOG.md`) to match the decisions above.

