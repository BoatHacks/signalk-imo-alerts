'use strict'

const { PRIORITY } = require('./priority')

const STATE = Object.freeze({
  UNACKNOWLEDGED: 'unacknowledged',
  SILENCED: 'silenced', // temporary - repeat resumes automatically unless acked first
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
 * `announce(entry)` and `interrupt()` are injected so this module stays
 * independent of the actual TTS/tone playback implementation.
 */
class AlertQueue {
  /**
   * @param {object} opts
   * @param {(entry: object) => Promise<void>} opts.announce - play tone+voice
   *   for one entry; resolves when playback finishes naturally.
   * @param {() => void} opts.interrupt - stop whatever is currently playing.
   * @param {number} [opts.repeatIntervalSeconds] - default 30, per
   *   MSC.302(87)'s own figure for an unacknowledged signal retriggering.
   * @param {boolean} [opts.repeatEnabled]
   * @param {(path: string) => number} [opts.now] - injectable clock for tests
   */
  constructor ({
    announce,
    interrupt,
    repeatIntervalSeconds = 30,
    repeatEnabled = true,
    now = () => Date.now()
  }) {
    this._announce = announce
    this._interrupt = interrupt
    this.repeatIntervalSeconds = repeatIntervalSeconds
    this.repeatEnabled = repeatEnabled
    this._now = now

    /** @type {Map<string, object>} */
    this.alerts = new Map()
    this._playing = null // path currently announcing, or null
    this._playToken = 0 // increments to make stale playback promises a no-op
  }

  /**
   * Called whenever a (voiceable) notification changes.
   * @param {string} path
   * @param {number} priority
   * @param {object} message - resolved template text + metadata for playback
   */
  upsert (path, priority, message) {
    if (priority <= PRIORITY.NONE) {
      this.remove(path)
      return
    }

    const existing = this.alerts.get(path)
    const entry = {
      path,
      priority,
      message,
      state: STATE.UNACKNOWLEDGED,
      firstSeen: existing ? existing.firstSeen : this._now(),
      lastAnnounced: existing ? existing.lastAnnounced : null
    }
    this.alerts.set(path, entry)
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

  /** Call periodically (e.g. every second) to handle repeat scheduling. */
  tick () {
    if (!this.repeatEnabled) return
    const dueForRepeat = [...this.alerts.values()].filter(
      (e) =>
        e.state !== STATE.ACKNOWLEDGED &&
        (e.lastAnnounced === null ||
          this._now() - e.lastAnnounced >= this.repeatIntervalSeconds * 1000)
    )
    for (const entry of dueForRepeat) {
      // a silenced alert becomes due again after the repeat interval -
      // matches MSC.302(87)'s distinct silenced-vs-acknowledged behavior
      entry.state = STATE.UNACKNOWLEDGED
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
        this._playNext()
      }
    })
  }

  _playNext () {
    // Only entries that have never been announced yet are "queued" in the
    // sense of waiting for their first turn. An already-announced,
    // still-unacknowledged entry is "settled" until its own repeat timer
    // (handled by tick(), which calls _reconsider directly) brings it back.
    const candidates = [...this.alerts.values()].filter(
      (e) => e.state === STATE.UNACKNOWLEDGED && e.lastAnnounced === null
    )
    if (candidates.length === 0) return
    candidates.sort((a, b) => b.priority - a.priority || a.firstSeen - b.firstSeen)
    this._play(candidates[0])
  }
}

module.exports = { AlertQueue, STATE }
