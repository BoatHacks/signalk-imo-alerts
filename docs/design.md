# signalk-imo-alerts — Design

## Purpose

A standalone Signal K plugin that produces spoken announcements for
`notifications.*` state changes, harmonizing terminology and alert
behavior with IMO/IEC bridge alert conventions where they apply. Its
scope also includes generating the audible tone patterns specified
in IMO A.1021(26) Table 7.2, played ahead of the spoken message.

## Regulatory grounding

There is no single official document that specifies spoken alert
*wording*. The relevant sources cover different, non-overlapping
things, and this plugin's design synthesizes across them rather than
transcribing any one of them:

- **MSC.302(87) — Code on Alerts and Indicators / Bridge Alert
  Management (BAM)**: the actual harmonization resolution. Governs
  alert *priority*, *classification*, *state model*, and
  *presentation/handling* — not spoken text. Priorities: Caution,
  Warning, Alarm, and — one level above those — **Emergency Alarm**
  ("immediate danger to human life or to the ship... immediate
  action must be taken"). States: Active-unacknowledged,
  Active-silenced, Active-acknowledged, Active-responsibility
  transferred, Rectified-unacknowledged.
- **IEC 62923**: the equipment test standard operationalizing
  MSC.302(87) for bridge hardware (signal cadences, HMI test
  procedures). Not a source of voice wording either.
- **SMCP (IMO Standard Marine Communication Phrases)**: actual
  spoken text, but for human radio/voice communication procedure
  (MAYDAY/PAN PAN/SÉCURITÉ call structure), not automated onboard
  system announcements. Used here only as a style reference: short,
  imperative, unambiguous phrasing.
- **GMDSS/DSC**: defines the distress/urgency/safety alert
  categories (already mapped in `signalk-notification-dispatcher`:
  distress→emergency, urgency→alarm, safety→warn).
- **IMO A.1021(26)**: specifies the actual *audible tone patterns*
  (Table 7.2, Audible Codes) — this is the one source here that
  literally is about sound signal design, not just priority/state.
- **IMO MSC.48(66) — LSA Code, §7.2.1.1** ("General emergency alarm
  system"): the actual definition of the general emergency alarm
  signal — "seven or more short blasts followed by one long blast"
  on the ship's whistle/siren, plus an electrically-operated
  bell/klaxon — and, notably, that the alarm "shall continue to
  function after it has been triggered until it is manually turned
  off or is **temporarily interrupted by a message on the public
  address system**." That last clause is direct regulatory support
  for this plugin's tone-then-voice sequencing (see "Sequencing"
  below) — it isn't just this plugin's own synthesis after all.

Where design decisions below are derived from these sources rather
than directly specified by them, that's called out explicitly.

## Priority mapping

Signal K's native four states don't map 1:1 onto MSC.302(87)'s
priorities, so the mapping is explicit rather than assumed:

| Signal K state | MSC.302(87) priority | Spoken? | Prefix |
|---|---|---|---|
| `alert` | *(no BAM equivalent — informational)* | **No** | — |
| `warn` | Caution | Yes | "Caution." |
| `alarm` | Warning | Yes | "Warning." |
| `emergency` | Alarm | Yes | "Alarm." |
| *(pinned path, any state)* | Emergency alarm | Yes | "Emergency alarm." |

The "pinned to Emergency Alarm" tier is a fully user-configurable
list of notification paths (e.g. `notifications.mob`) that are
always announced at the highest tier regardless of their Signal K
state string — because MSC.302(87)'s Emergency Alarm is a narrower,
more severe category than Signal K's generic `emergency` state, and
that distinction shouldn't be inferred purely from state.

## States: acknowledge vs. silence

Following MSC.302(87)'s distinct `Active-silenced` vs.
`Active-acknowledged` states, the plugin distinguishes two actions:

- **Silence**: stops repeat announcements temporarily; automatically
  resumes repeating if the alert is not also acknowledged before it
  next re-triggers.
- **Acknowledge**: stops repeats fully until the underlying state
  changes again.

Both are detected by listening for the corresponding signal on any
path (PUT handler, subscription with `sourcePolicy: 'all'`, poll
fallback) — the same reconciliation approach used in
`signalk-dead-mans-switch`, rather than requiring interaction through
this plugin's own webapp specifically.

## Message templates

- **Generic fallback**: `"{priority}. {plain-language path
  description}."` — covers any path without a specific override.
- **Specific overrides**: full scripted phrases for known critical
  paths (MOB, fire, anchor drag, etc.), phrased in SMCP's short,
  imperative style rather than a plain sentence.
- **Numeric interpolation**: templates may embed live values from the
  triggering notification/path data (e.g. "Battery voltage 11.2
  volts"). Units follow the admin UI's configured unit preferences,
  read via Signal K's own `sendMeta=all` mechanism (delta
  `meta.displayUnits`: `formula`, `targetUnit`, `symbol`,
  `displayFormat`) — the plugin evaluates that formula rather than
  maintaining its own unit table, so it stays in sync automatically
  if the user changes their preferences.
- **Pronunciation substitution table**: a separate text-substitution
  step applied just before TTS, to fix terms `espeak-ng` is likely to
  mispronounce (path names, unit symbols, abbreviations like "SOG").
  Kept separate from the message templates themselves.

## Playback

- Server-side: Node process driving `espeak-ng`. If `espeak-ng` is
  missing or fails, the plugin falls back to browser-only playback
  and logs a clear warning rather than failing silently.
- Browser-side: companion webapp, for whichever device has the
  dashboard open.
- Both are independently configurable (on/off).

## Repeat behavior

Configurable repeat interval, defaulting to **30 seconds** — this
default mirrors MSC.302(87)'s own figure for an unacknowledged
audible signal restarting after 30 seconds. Repeat can also be
disabled per severity.

## Concurrency (multiple simultaneous active alerts)

Not literally specified by MSC.302(87)/IEC 62923 — those documents
address tone/visual presentation, not spoken sentences. Design
inferred from their stated principles (priority-first ordering; no
merging of different-priority alerts; aggregation only within the
same priority):

- A newly-arriving higher-priority alert preempts (interrupts) a
  currently-playing lower-priority announcement.
- Alerts of the same priority queue chronologically rather than
  interrupting each other.

## Scope

Subscribes to **self-vessel `notifications.*` only** — no
other-vessel / `received.*` handling (that's `notification-dispatcher`'s
domain, not this plugin's).

## Configuration

Native `plugin.schema` config — no custom Preact+htm rule-editor
webapp for this one, unlike some of the other plugins. The companion
webapp exists only for **test mode** (preview/test announcements,
see "Testing / operability" below) and is not the primary
configuration surface.

## Testing / operability

- **REST endpoints**: `/test-announce` triggers a one-off test
  announcement combining any priority, tone (built-in code, custom
  pattern, or the priority's default), message, and language;
  `/options` lists the available priorities and built-in tone codes;
  `/tone-clip` serves a clip's raw audio (built-in, custom pattern,
  or a priority's default) for browser playback. Similar in spirit
  to `signalk-notification-dispatcher`'s `send-alert.sh`.
- **Test mode** in the companion webapp: a form exposing all of the
  above as one combination — priority, tone selection (including a
  free-text pattern field for previewing a muster-list code before
  saving it to config), message, and language — with a "preview tone
  only" button and a "play combination" button. Playback happens
  both in the browser (via the `<audio>` element + Web Speech API,
  immediately) and server-side (via `/test-announce`, if server-side
  playback is enabled in plugin config) — so a muster-list pattern
  can be checked from a laptop before trusting it to whatever the
  Signal K host is actually wired to.

## Alert tone patterns (IMO A.1021(26))

In addition to the spoken announcements above, the plugin generates
the audible tone patterns specified in **IMO A.1021(26) Table 7.2
(Audible Codes)**:

| Code | Pattern |
|---|---|
| 1.a | General emergency alarm — 7 short blasts + 1 prolonged blast, repeated |
| 1.b | Ship-specific codes, per muster list |
| 2 | Continuous tone until acknowledged/silenced |
| 3.a | Distinctive waveform: square pulse train |
| 3.b | Distinctive waveform: sawtooth rise with sharp fall |
| 3.c | Distinctive waveform: grouped/clustered short pulses |
| 3.d | Distinctive waveform: sinusoidal frequency modulation |

The 3.a–3.d waveforms are optional per A.1021(26) (distinguishing
waveforms with a 0.5–2.0 Hz pulse rate, between a 500 Hz baseline and
a 2000 Hz peak); all four are implemented and selectable per
priority/path.

1.a's own pattern ("7 short + 1 prolonged") is a paraphrase of the
actual defining text, which lives in **MSC.48(66) (LSA Code)
§7.2.1.1**, not in A.1021(26) itself: "seven or more short blasts
followed by one long blast." A.1021(26) Table 7.2 just cross-
references this as the general-emergency-alarm audible code; the
regulation's own wording allows *more than seven* short blasts, of
which this plugin's clip uses exactly seven (the stated minimum).

**Full scope implemented** — 1.a, 1.b, 2, and 3.a–3.d are all in
scope, including 1.b ship-specific muster-list codes even though
Signal K has no native source of truth for a muster list. Structure
chosen: a flat, path-first `musterListCodes` list in plugin config
(`{ path, zone, pattern }` per entry) rather than a separate
code-registry/assignment split — simpler, at the cost of duplicating
a pattern's text if the same code is reused across multiple paths.

1.b patterns are entered as **plain text**, not an uploaded audio
file: a space-separated list of `<freqHz>:<durationMs>` tokens, e.g.
`"500:1000 0:250 2000:1000"` (a frequency of `0` means silence for
that duration). This avoids needing file-upload support in
`plugin.schema`/`react-jsonschema-form`, which wasn't confirmed to
exist. Each distinct pattern is synthesized once (`lib/tonePattern.js`)
and cached on disk by content hash (`lib/tones.js`,
`resolveMusterClipPath`) rather than regenerated per alert
occurrence — consistent with the "generated once, then treated as a
static asset" approach used for the built-in 1.a/2/3.a–3.d clips.

**Sequencing**: the tone plays first, then the spoken announcement
follows — not in parallel, and not as a replacement for either tier.
This isn't just this plugin's own synthesis: MSC.48(66) (LSA Code)
§7.2.1.1 describes the general emergency alarm as continuing until
manually turned off or "temporarily interrupted by a message on the
public address system" — i.e. the regulation itself anticipates a
tone being paused for a spoken message, which is exactly this
sequencing (tone, then voice, per occurrence) rather than the two
running concurrently.

**Shared silence/acknowledge state**: the tone does **not** have its
own independent silence/ack state. It shares the same state as the
voice announcement for a given alert. This is grounded directly in
the IEC's own mariner guidance on BAM: "Sound will stop when the
alert is acknowledged, temporarily silenced, or when the alert
condition ceases to exist" — i.e. the audible signal's stop
condition is tied to the alert's state, not tracked separately. The
same source explicitly notes that BAM's rules anticipate optional
speech output of alerts, which is a useful confirmation that voice
announcements aren't an out-of-spec addition.

**Clip production**: tones are pre-recorded audio clips per pattern,
not synthesized live at runtime. The clips are generated once
(offline synthesis, `scripts/generate_tones.py`) and then
shipped/treated as static assets from then on — not sourced from an
existing CC0 library like `signalk-ships-bells`' sound effects. The
3.a–3.d waveforms use the pulse-rate/frequency bounds Table 7.2
actually specifies (0.5–2.0 Hz, 500 Hz baseline, 2000 Hz maximum;
1.0 Hz was chosen within that range as this plugin's own
implementation value). Table 7.2 does **not** specify a carrier
frequency for 1.a/2 — it describes the ship's-horn blast *pattern*
(7 short + 1 prolonged, or continuous), not a tone — so the 500 Hz
used for both is this plugin's own synthesis choice, not a value
taken from either standard (chosen to match Table 7.2's own 500 Hz
baseline for the 3.a–3.d waveforms, for consistency). See
`sounds/tones/README.md` for the generated files.

## Explicitly out of scope (for now)

- **Persistence**: no self-persistence of the announcement queue or
  ack/silence state in this plugin. This isn't an omission — it's
  grounded in MSC.302(87) §12.3 and §13.1.2.5. §12.3 states "a
  system failure of the CAM or the loss of system communication
  between the CAM and the connected systems should not lead to the
  loss of the alert announcement functionality of the individual
  functions", and §13.1.2.5 requires "proper reconnection after
  disconnection or power down at any time and in any alert
  condition with a result of a consistent alert state." The
  responsibility for a consistent post-restart state sits with the
  **reconnection to the source** (re-subscribing to
  `notifications.*`, which reflects Signal K's own current
  notification state), not with this plugin maintaining its own
  local copy. On restart, the plugin re-subscribes and gets the
  actual current state directly — a local queue file would be a
  second, potentially stale source of truth, which the standard's
  model doesn't call for.
- **Debouncing**: no plugin-side debouncing for flapping/oscillating
  paths — relies on the alert emitter to debounce before it reaches
  this plugin. Checked: MSC.302(87), IEC 62923, and IEC PAS 62923-101
  say nothing about debouncing/filtering fluctuating source signals
  — this is a design choice, not something the regulations mandate
  or contradict.
- **Audio ducking**: no coordination with other sound-producing
  plugins (`signalk-dead-mans-switch`, `signalk-ships-bells`) —
  relies on natural priority (voice alerts being rare/urgent) rather
  than active ducking/pausing of other audio.
