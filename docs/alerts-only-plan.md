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
| `rtn-unacknowledged` | **Open question** — condition cleared but not yet acked. Options: (a) keep repeating the original alert audio since it's still formally unacknowledged, (b) switch to a distinct "condition cleared, please acknowledge" phrasing. Leaning (b) for clarity, but this needs a decision, not a default. |
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
Whether to delete it outright or keep it dormant behind a config
toggle (in case someone wants notifications.* AND alerts.*
simultaneously) is an open question below.

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
- **Removed or dormant**: `lib/ackListener.js`'s PUT-handler-per-path
  registration and poll fallback — superseded by observing `alerts.*`
  deltas directly; ack/silence *actions* redirect to alert manager's
  API instead.
- **Changed**: `handleNotification`/`handleDelta` in `index.js` —
  subscribe to `alerts.*` instead of (or alongside — see open
  questions) `notifications.*`; parse the alert-manager delta shape
  instead of the notification shape.
- **Changed**: `resolveMessage` in `lib/templates.js` — drop
  `humanizePath` fallback and `displayUnits` interpolation for the
  alerts.* path (may still be relevant if notifications.* support is
  kept as a fallback mode — see below).
- **Changed**: `/acknowledge` and `/silence` REST endpoints — become
  thin proxies to `app.alertManager`, not direct `queue.acknowledge/
  silence` calls.
- **Unchanged**: `AlertQueue`'s priority-preemption/chronological
  queueing, repeat scheduling, tone/voice rendering, `musterListCodes`
  path matching, all of `lib/tones.js`/`lib/tonePattern.js`/
  `lib/tts.js`, the whole webapp test-mode infrastructure. This plan
  only touches *where alerts come from and who owns their lifecycle*,
  not how we render them.

## Open questions (need a decision before/while implementing)

1. **Exclusive or dual-mode?** The branch is named `alerts-only`,
   implying `notifications.*` support is dropped entirely on this
   branch. Is that the actual intent, or should this become a
   configurable mode (`alertSource: 'notifications' | 'alerts'`) so
   the plugin still works for people without alert manager installed?
   Dual-mode is more code (two parsers, two priority-resolution paths)
   for a real ongoing maintenance cost; alerts-only is a clean break
   but makes alert manager a hard dependency.
2. **`rtn-unacknowledged` phrasing** — repeat the original message, or
   speak something distinct like "condition cleared, please
   acknowledge"?
3. **Graceful degradation if alert manager isn't installed/enabled** —
   `app.alertManager` will be `undefined`. Should the plugin refuse to
   start with a clear error, or start but do nothing until alert
   manager appears? Given the branch's premise (alerts.* as the *only*
   source), silently doing nothing seems worse than an explicit
   startup warning via `app.setPluginStatus`/`app.debug`.
4. **Escalation double-handling** — alert manager auto-escalates
   unacknowledged warnings to alarm after a timeout and publishes that
   as a priority change on the same path. Our queue's preemption logic
   already reacts correctly to a priority change on `upsert` (higher
   priority preempts), so this should "just work" without special
   casing — worth confirming with a test rather than assuming.
5. **Does our own webapp still need ack/silence buttons**, given alert
   manager ships its own Web UI (`Alert List`, `Alert Banner`, etc.)?
   Keeping ours as a thin proxy is cheap and keeps the "preview/test"
   webapp self-contained, but it's worth asking whether duplicating
   that control surface is desired.

## Testing / verification plan

- Unit tests: new fixtures for `alerts.*`-shaped deltas (replacing/
  augmenting the current notification-shaped ones in
  `test/index`-adjacent tests), priority-string-to-`PRIORITY` mapping,
  heartbeat-dedup behavior (same id/priority/message twice → no
  re-trigger), `rtn-unacknowledged`/`normal` transitions.
- Mock `app.alertManager` for ack/silence-proxy tests (success case,
  and the "alert manager not installed" case).
- Live verification: install `signalk-alert-manager` alongside this
  plugin in the same scratch `signalk-server` sandbox we've used
  before, raise a real alert via its REST API, confirm our plugin
  picks it up from `alerts.*`, renders the right tone/priority, and
  that acknowledging through *our* endpoint is reflected in *alert
  manager's* own `/alerts/{id}` — proving the single-source-of-truth
  property actually holds, not just that our code compiles.

## Suggested implementation order

1. Priority mapping + delta parsing for `alerts.*` (no lifecycle
   changes yet — just get tone/voice triggering on the right priority
   from the new shape).
2. Heartbeat dedup.
3. `normal`/`acknowledged`/`rtn-unacknowledged` state handling.
4. Ack/silence proxy to `app.alertManager`, remove/disable
   `lib/ackListener.js`'s old path.
5. Remove `pinnedEmergencyAlarmPaths`.
6. Update all docs (`docs/design.md`, `README.md`, `docs/openApi.json`,
   `CHANGELOG.md`) and decide the open questions above explicitly
   rather than by accident.
