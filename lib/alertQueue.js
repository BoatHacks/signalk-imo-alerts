'use strict'

const STATE = Object.freeze({
  UNACKNOWLEDGED: 'unacknowledged',
  SILENCED: 'silenced', // temporary - see repeat policy below for how it resumes
  ACKNOWLEDGED: 'acknowledged' // full - repeat stays off until state changes again
})

/**
 * Tracks active alerts and decides what should be announced when, per
 * docs/design.md:
 *  - a higher-priority alert preempts (interrupts) a currently-playing
 *    lower-priority announcement
 *  - same-priority alerts queue chronologically
 *  - tone and voice share one silence/acknowledge state (MSC.302(87) /
 *    IEC BAM guidance: "sound will stop when the alert is acknowledged,
 *    temporarily silenced, or when the alert condition ceases to exist")
 *  - no self-persistence: this is in-memory only by design (see
 *    docs/design.md, "Persistence")
 *
 * Repeat behavior is per-priority (see `getRepeatPolicy`), not a single
 * global interval - see docs/alerts-only-plan.md:
 *  - 'once': play tone+voice once, never repeat on its own (Warning,
 *    Caution)
 *  - 'interval': repeat every `intervalSeconds` while unacknowledged
 *    (Alarm)
 *  - 'continuous': repeat back-to-back with no gap while unacknowledged
 *    (Emergency Alarm)
 *
 * For 'interval' and 'continuous', silencing stops playback immediately
 * and does NOT auto-resume after any local timeout - resumption only
 * happens when an external state change (a fresh alerts.* delta with
 * silenced: false) drives a fresh upsert() call. Under alerts-only, alert
 * manager owns the actual silence-duration timer and publishes that
 * transition itself; this plugin never runs its own silence-expiry clock.
 *
 * `announce(entry)` and `interrupt()` are injected so this module stays
 * independent of the actual TTS/tone playback implementation.
 */
class AlertQueue {
  /**
   * @param {object} opts
   * @param {(entry: object) => Promise<void>} opts.announce - play tone+voice
   *   for one entry; resolves when playback finishes naturally.
   * @param {() => void} opts.interrupt - stop whatever is currently playing.
   * @param {(priority: number) => {mode: 'once'|'interval'|'continuous', intervalSeconds?: number}} opts.getRepeatPolicy
   *   - required; the caller decides repeat behavior per priority.
   * @param {(path: string) => number} [opts.now] - injectable clock for tests
   */
  constructor ({ announce, interrupt, getRepeatPolicy, now = () => Date.now() }) {
    this._announce = announce
    this._interrupt = interrupt
    this._getRepeatPolicy = getRepeatPolicy
    this._now = now

    /** @type {Map<string, object>} */
    this.alerts = new Map()
    this._playing = null // path currently announcing, or null
    this._playToken = 0 // increments to make stale playback promises a no-op
    this._sequence = 0 // monotonic counter for _playNext's ordering - see upsert()
  }

  /**
   * Called whenever a (voiceable) alert changes.
   * @param {string} path
   * @param {number} priority
   * @param {object} message - resolved template text + metadata for playback
   */
  /**
   * @param {string} path
   * @param {number} priority
   * @param {object} message - resolved template text + metadata for playback
   * @param {object} [meta] - optional per-entry override consulted by the
   *   injected announce() callback (e.g. a specific tone/language/voice for
   *   a test announcement) - real alerts never set this, so their
   *   announce() always resolves from priority/path/config as usual.
   */
  upsert (path, priority, message, meta = null) {
    if (priority === null || priority === undefined) {
      this.remove(path)
      return
    }

    const existing = this.alerts.get(path)
    // A priority increase (escalation) or a transition out of SILENCED is
    // treated as a fresh occurrence for scheduling purposes: resetting
    // lastAnnounced makes _playNext()/tick() treat it as "never announced
    // yet" so it's picked up as soon as it's not preempted by something
    // still more urgent, rather than staying silent until some later
    // timer happens to reconsider it.
    const isEscalation = existing && priority > existing.priority
    const wasSilenced = existing && existing.state === STATE.SILENCED
    const treatAsFreshOccurrence = isEscalation || wasSilenced
    const entry = {
      path,
      priority,
      message,
      meta,
      state: STATE.UNACKNOWLEDGED,
      firstSeen: existing ? existing.firstSeen : this._now(),
      // queuedAt is distinct from firstSeen: it's "when did this entry
      // last become eligible to play" (as a monotonic sequence number,
      // not a timestamp - wall-clock resolution isn't fine-grained
      // enough to reliably order two entries queued within the same
      // millisecond), used only to order same-priority candidates in
      // _playNext(). Updated on every upsert (including heartbeats/
      // re-upserts, harmlessly - it only matters for entries that are
      // actually eligible, i.e. lastAnnounced === null) and on every
      // 'continuous'-mode loop iteration in _play(), so a looping entry
      // doesn't perpetually win the chronological tiebreak against a
      // same-priority sibling via its stale original firstSeen.
      queuedAt: ++this._sequence,
      lastAnnounced: existing && !treatAsFreshOccurrence ? existing.lastAnnounced : null
    }
    this.alerts.set(path, entry)

    if (isEscalation && this._playing === path) {
      // The entry currently announcing just escalated. _reconsider()'s
      // preemption check compares entry.priority against whatever's
      // currently playing - but that's this same entry (already
      // overwritten above), so the comparison is always false against
      // itself. Handle this case explicitly: the in-flight playback is
      // for the stale (lower) priority, so interrupt and restart
      // immediately with the new priority/message rather than letting
      // the stale announcement finish first.
      this._interrupt()
      this._playing = null
      this._play(entry)
      return
    }

    this._reconsider(entry)
  }

  remove (path) {
    const wasPlaying = this._playing === path
    this.alerts.delete(path)
    if (wasPlaying) {
      this._interrupt()
      this._playing = null
      this._playNext()
    }
  }

  acknowledge (path) {
    const entry = this.alerts.get(path)
    if (!entry) return
    entry.state = STATE.ACKNOWLEDGED
    if (this._playing === path) {
      this._interrupt()
      this._playing = null
      this._playNext()
    }
  }

  silence (path) {
    const entry = this.alerts.get(path)
    if (!entry) return
    entry.state = STATE.SILENCED
    if (this._playing === path) {
      this._interrupt()
      this._playing = null
      this._playNext()
    }
  }

  /** Call periodically (e.g. every second) to handle 'interval'-mode repeat scheduling. */
  tick () {
    const dueForRepeat = [...this.alerts.values()].filter((e) => {
      // SILENCED is deliberately excluded here, not just ACKNOWLEDGED -
      // a silenced alert never auto-resumes via this timer, only via an
      // external upsert() transition (see class doc comment above).
      if (e.state !== STATE.UNACKNOWLEDGED) return false
      const policy = this._getRepeatPolicy(e.priority)
      if (policy.mode !== 'interval') return false // 'once'/'continuous' aren't tick-driven
      return e.lastAnnounced === null || this._now() - e.lastAnnounced >= policy.intervalSeconds * 1000
    })
    for (const entry of dueForRepeat) {
      this._reconsider(entry)
    }
  }

  _reconsider (entry) {
    if (entry.state === STATE.ACKNOWLEDGED) return

    if (this._playing === null) {
      this._play(entry)
      return
    }

    const playingEntry = this.alerts.get(this._playing)
    if (!playingEntry || entry.priority > playingEntry.priority) {
      this._interrupt()
      this._play(entry)
    }
    // same or lower priority than what's playing: it'll be picked up by
    // _playNext() in priority-then-chronological order once the current
    // announcement finishes.
  }

  _play (entry) {
    this._playing = entry.path
    entry.lastAnnounced = this._now()
    const token = ++this._playToken
    Promise.resolve(this._announce(entry)).then(() => {
      if (token !== this._playToken) return // superseded by an interrupt
      if (this._playing === entry.path) {
        this._playing = null
        // 'continuous' mode (Emergency Alarm): a natural, uninterrupted
        // completion immediately becomes eligible again - endless loop,
        // no gap. Re-fetch the current entry rather than trusting the
        // closure-captured one, in case upsert() replaced it (e.g. a
        // message update) while it was playing.
        const current = this.alerts.get(entry.path)
        if (
          current &&
          current.state === STATE.UNACKNOWLEDGED &&
          this._getRepeatPolicy(current.priority).mode === 'continuous'
        ) {
          current.lastAnnounced = null
          current.queuedAt = ++this._sequence
        }
        this._playNext()
      }
    })
  }

  _playNext () {
    // Only entries that have never been announced yet, or that just
    // became eligible again (escalation, un-silenced, or a 'continuous'
    // entry looping), are "queued" in this sense. An already-announced,
    // still-unacknowledged 'interval'-mode entry is "settled" until its
    // own repeat timer (handled by tick(), which calls _reconsider
    // directly) brings it back.
    const candidates = [...this.alerts.values()].filter(
      (e) => e.state === STATE.UNACKNOWLEDGED && e.lastAnnounced === null
    )
    if (candidates.length === 0) return
    candidates.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt)
    this._play(candidates[0])
  }
}

module.exports = { AlertQueue, STATE }
