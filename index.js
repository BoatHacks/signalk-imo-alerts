'use strict'

const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const path = require('path')
const { resolvePriority, shouldVoice, PRIORITY, priorityName } = require('./lib/priority')
const { resolveMessage, applyPronunciation } = require('./lib/templates')
const { AlertQueue } = require('./lib/alertQueue')
const { speak, synthesizeToFile } = require('./lib/tts')
const { createClient: createAlertManagerClient } = require('./lib/alertManagerClient')
const {
  resolveClipPath,
  resolveMusterClipPath,
  clipPathFor,
  TONE_CODE,
  TONE_CODE_DESCRIPTION,
  play: playTone
} = require('./lib/tones')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-imo-alerts',
    name: 'IMO Alerts (voice + tone)',
    description:
      'Spoken alert announcements and IMO A.1021(26) alert tone patterns, sourced from alerts.* (signalk-alert-manager)'
  }

  let unsubscribes = []
  let queue = null
  let tickInterval = null
  let config = {}
  // alert.id (alert manager's own UUID) keyed by our path, so /acknowledge
  // and /silence can resolve a path (what the webapp sends) to the id
  // app.alertManager's API actually needs. Also tracks the last-seen
  // priority/state/message per path, for heartbeat dedup - see
  // docs/alerts-only-plan.md, "Heartbeat dedup".
  const alertTrackingByPath = new Map()
  let warnedNoToken = false // edge-triggered, log once

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enabled', default: true },
      alertManagerToken: {
        type: 'string',
        title:
          'signalk-alert-manager access token (required for acknowledge/silence - reading alerts.* works without it). ' +
          'alert manager\'s REST API requires the server\'s normal admin auth; there is no in-process bypass ' +
          '(app.alertManager, which its own docs mention, is unreachable from other plugins - see ' +
          'BoatHacks/signalk-imo-alerts#1). Generate one via Admin UI > Security > Devices, or the ' +
          'signalk-generate-token CLI, and paste it here.'
      },
      language: {
        type: 'string',
        title: 'Message language (used as the espeak-ng voice if "Voice" below is unset)',
        default: 'en'
      },
      serverVoice: {
        type: 'string',
        title:
          'TTS voice/model (espeak-ng voice or variant, e.g. "en-us", "en+f3", "en-gb-x-rp" - run `espeak-ng --voices` on the host to list available ones), used for both local-speaker and browser playback - the browser plays the exact same rendered audio the server would speak, rather than using its own separate voice. Defaults to the language field above if left blank.'
      },
      playback: {
        type: 'object',
        title: 'Playback',
        properties: {
          server: { type: 'boolean', title: 'Play server-side (espeak-ng)', default: true },
          browser: { type: 'boolean', title: 'Play in companion webapp', default: true }
        }
      },
      alarmRepeatIntervalSeconds: {
        type: 'number',
        title:
          'Alarm-priority repeat interval (seconds) - repeats tone+voice at this interval while unacknowledged. ' +
          'Warning/Caution play once (no repeat); Emergency alarm repeats continuously with no gap. ' +
          'All three stop immediately when silenced and only resume on an explicit un-silence, never on a timer ' +
          '(alert manager owns the actual silence duration) - default mirrors MSC.302(87)\'s 30s figure.',
        default: 30
      },
      messageOverrides: {
        type: 'array',
        title: 'Per-path message template overrides',
        items: {
          type: 'object',
          properties: {
            pathPattern: { type: 'string', title: 'Path or prefix* pattern' },
            template: {
              type: 'string',
              title: 'Template ({value}, {path}, {message} placeholders supported)'
            }
          }
        }
      },
      pronunciationSubstitutions: {
        type: 'array',
        title: 'Pronunciation fixes applied before TTS',
        items: {
          type: 'object',
          properties: {
            pattern: { type: 'string', title: 'Regex pattern to match' },
            replacement: { type: 'string', title: 'Replacement text' }
          }
        }
      },
      cautionTone: {
        type: 'object',
        title:
          'Caution-priority tone (no IMO A.1021(26) table basis for this priority - fully your choice)',
        properties: {
          preset: {
            type: 'string',
            title: 'Built-in pattern, or "custom" to use the pattern field below',
            enum: ['1a', '2', '3a', '3b', '3c', '3d', 'custom'],
            default: '3c'
          },
          pattern: {
            type: 'string',
            title:
              'Custom pattern (used when preset = "custom"): space-separated <freqHz>:<durationMs> tokens, e.g. "500:1000 0:250 2000:1000" (freq 0 = silence)'
          }
        }
      },
      warningTone: {
        type: 'object',
        title:
          'Warning-priority tone (no IMO A.1021(26) table basis for this priority - fully your choice)',
        properties: {
          preset: {
            type: 'string',
            title: 'Built-in pattern, or "custom" to use the pattern field below',
            enum: ['1a', '2', '3a', '3b', '3c', '3d', 'custom'],
            default: '3a'
          },
          pattern: {
            type: 'string',
            title:
              'Custom pattern (used when preset = "custom"): space-separated <freqHz>:<durationMs> tokens, e.g. "500:1000 0:250 2000:1000" (freq 0 = silence)'
          }
        }
      },
      alarmTone: {
        type: 'object',
        title:
          'Alarm-priority tone (default "2" reflects fire-detection-alarm rows in IMO A.1021(26) Table 7.1.2; most other Alarm-tier functions there actually use "3" instead - override if that fits your use better)',
        properties: {
          preset: {
            type: 'string',
            title: 'Built-in pattern, or "custom" to use the pattern field below',
            enum: ['1a', '2', '3a', '3b', '3c', '3d', 'custom'],
            default: '2'
          },
          pattern: {
            type: 'string',
            title:
              'Custom pattern (used when preset = "custom"): space-separated <freqHz>:<durationMs> tokens, e.g. "500:1000 0:250 2000:1000" (freq 0 = silence)'
          }
        }
      },
      emergencyAlarmTone: {
        type: 'object',
        title:
          'Emergency alarm-priority tone (default "1a" reflects the general-emergency-alarm row in IMO A.1021(26) Table 7.1.1; other Emergency-Alarm-tier functions there actually use "2" instead - override if that fits your use better)',
        properties: {
          preset: {
            type: 'string',
            title: 'Built-in pattern, or "custom" to use the pattern field below',
            enum: ['1a', '2', '3a', '3b', '3c', '3d', 'custom'],
            default: '1a'
          },
          pattern: {
            type: 'string',
            title:
              'Custom pattern (used when preset = "custom"): space-separated <freqHz>:<durationMs> tokens, e.g. "500:1000 0:250 2000:1000" (freq 0 = silence)'
          }
        }
      },
      cautionRtnPhrasing: {
        type: 'object',
        title:
          'Caution: how to voice an alert whose condition cleared but hasn\'t been acknowledged yet (alert manager\'s "rtn-unacknowledged" state)',
        properties: {
          useDistinctPhrase: {
            type: 'boolean',
            title: 'Speak a distinct phrase instead of repeating the original message',
            default: false
          },
          phrase: {
            type: 'string',
            title: 'Custom phrase (used when the above is enabled); default: "Condition cleared, please acknowledge"'
          }
        }
      },
      warningRtnPhrasing: {
        type: 'object',
        title:
          'Warning: how to voice an alert whose condition cleared but hasn\'t been acknowledged yet (alert manager\'s "rtn-unacknowledged" state)',
        properties: {
          useDistinctPhrase: {
            type: 'boolean',
            title: 'Speak a distinct phrase instead of repeating the original message',
            default: false
          },
          phrase: {
            type: 'string',
            title: 'Custom phrase (used when the above is enabled); default: "Condition cleared, please acknowledge"'
          }
        }
      },
      alarmRtnPhrasing: {
        type: 'object',
        title:
          'Alarm: how to voice an alert whose condition cleared but hasn\'t been acknowledged yet (alert manager\'s "rtn-unacknowledged" state)',
        properties: {
          useDistinctPhrase: {
            type: 'boolean',
            title: 'Speak a distinct phrase instead of repeating the original message',
            default: false
          },
          phrase: {
            type: 'string',
            title: 'Custom phrase (used when the above is enabled); default: "Condition cleared, please acknowledge"'
          }
        }
      },
      emergencyAlarmRtnPhrasing: {
        type: 'object',
        title:
          'Emergency alarm: how to voice an alert whose condition cleared but hasn\'t been acknowledged yet (alert manager\'s "rtn-unacknowledged" state)',
        properties: {
          useDistinctPhrase: {
            type: 'boolean',
            title: 'Speak a distinct phrase instead of repeating the original message',
            default: false
          },
          phrase: {
            type: 'string',
            title: 'Custom phrase (used when the above is enabled); default: "Condition cleared, please acknowledge"'
          }
        }
      },
      musterListCodes: {
        type: 'array',
        title: 'IMO A.1021(26) 1.b ship-specific muster-list tone patterns',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', title: 'Notification path' },
            zone: { type: 'string', title: 'Zone / role' },
            pattern: {
              type: 'string',
              title:
                'Tone pattern: space-separated <freqHz>:<durationMs> tokens, e.g. "500:1000 0:250 2000:1000" (freq 0 = silence)'
            }
          }
        }
      }
    }
  }

  plugin.start = function (options) {
    config = normalizeConfig(options)
    if (!config.enabled) return

    queue = new AlertQueue({
      announce: (entry) => announce(entry),
      interrupt: () => interruptPlayback(),
      getRepeatPolicy: (priority) => repeatPolicyForPriority(priority)
    })

    // Graceful degradation (see docs/alerts-only-plan.md, decision 3):
    // reading alerts.* works regardless of any of this - only the
    // ack/silence REST proxy needs a token, so that's what we check for
    // and warn about, once, rather than repeatedly.
    tickInterval = setInterval(() => {
      queue.tick()
    }, 1000)
    checkAlertManagerTokenConfigured()

    const unsub = app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [{ path: 'alerts.*', policy: 'instant', minPeriod: 200 }]
      },
      unsubscribes,
      (err) => app.error(`subscription error: ${err}`),
      (delta) => handleAlertDelta(delta)
    )
    unsubscribes.push(unsub)
  }

  plugin.stop = function () {
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    if (tickInterval) clearInterval(tickInterval)
    tickInterval = null
    alertTrackingByPath.clear()
    queue = null
  }

  // app.alertManager (the plugin API alert manager's own README documents)
  // is structurally unreachable from other plugins - confirmed live and
  // independently upstream, see docs/alerts-only-plan.md and
  // BoatHacks/signalk-imo-alerts#1. Ack/silence go through alert manager's
  // REST API instead (lib/alertManagerClient.js), which needs a token we
  // can only check for locally - we can't detect "is alert manager
  // actually running" proactively without making an authenticated request
  // ourselves, so this only checks what we actually can: whether a token
  // is configured at all. Reading (the alerts.* subscription) works
  // regardless of this - only ack/silence need the token.
  function checkAlertManagerTokenConfigured () {
    if (config.alertManagerToken || warnedNoToken) return
    warnedNoToken = true
    app.debug(
      'no alertManagerToken configured - acknowledge/silence will not work until one is set ' +
        '(see plugin.schema: generate a token via Admin UI > Security > Devices, or signalk-generate-token)'
    )
    app.setPluginStatus?.('Reading alerts.* OK, but no alertManagerToken configured for ack/silence')
  }

  function normalizeConfig (options) {
    const o = options || {}
    return {
      enabled: o.enabled !== false,
      alertManagerToken: o.alertManagerToken || '',
      language: o.language || 'en',
      serverVoice: o.serverVoice || '',
      playback: {
        server: o.playback?.server !== false,
        browser: o.playback?.browser !== false
      },
      alarmRepeatIntervalSeconds: o.alarmRepeatIntervalSeconds || 30,
      messageOverrides: o.messageOverrides || [],
      pronunciationSubstitutions: o.pronunciationSubstitutions || [],
      musterListCodes: o.musterListCodes || [],
      cautionTone: { preset: o.cautionTone?.preset || '3c', pattern: o.cautionTone?.pattern || '' },
      warningTone: { preset: o.warningTone?.preset || '3a', pattern: o.warningTone?.pattern || '' },
      alarmTone: { preset: o.alarmTone?.preset || '2', pattern: o.alarmTone?.pattern || '' },
      emergencyAlarmTone: {
        preset: o.emergencyAlarmTone?.preset || '1a',
        pattern: o.emergencyAlarmTone?.pattern || ''
      },
      cautionRtnPhrasing: normalizeRtnPhrasing(o.cautionRtnPhrasing),
      warningRtnPhrasing: normalizeRtnPhrasing(o.warningRtnPhrasing),
      alarmRtnPhrasing: normalizeRtnPhrasing(o.alarmRtnPhrasing),
      emergencyAlarmRtnPhrasing: normalizeRtnPhrasing(o.emergencyAlarmRtnPhrasing)
    }
  }

  function normalizeRtnPhrasing (o) {
    return {
      useDistinctPhrase: Boolean(o?.useDistinctPhrase),
      phrase: o?.phrase || ''
    }
  }

  function priorityRtnPhrasingConfig () {
    return {
      [PRIORITY.CAUTION]: config.cautionRtnPhrasing,
      [PRIORITY.WARNING]: config.warningRtnPhrasing,
      [PRIORITY.ALARM]: config.alarmRtnPhrasing,
      [PRIORITY.EMERGENCY_ALARM]: config.emergencyAlarmRtnPhrasing
    }
  }

  function handleAlertDelta (delta) {
    for (const update of delta.updates || []) {
      for (const pv of update.values || []) {
        if (pv.path.startsWith('alerts.')) {
          handleAlert(pv.path, pv.value)
        }
      }
    }
  }

  /**
   * @param {string} deltaPath - the full 'alerts.<path>' delta path
   * @param {object|null} alert - the alerts.* value object (see
   *   docs/alerts-only-plan.md for the full shape), or null/absent if
   *   ever published that way (defensive - alert manager normally
   *   publishes a terminal { state: 'normal', ... } object instead)
   */
  function handleAlert (deltaPath, alert) {
    const alertPath = alert?.path || deltaPath.slice('alerts.'.length)

    if (!alert) {
      queue.remove(alertPath)
      alertTrackingByPath.delete(alertPath)
      return
    }

    // Heartbeat dedup (see docs/alerts-only-plan.md): a delta for a path
    // whose id/priority/state/message/silenced are all unchanged from what
    // we already have is just a liveness heartbeat, not a real change -
    // ignore it rather than re-triggering playback or resetting timers.
    const tracked = alertTrackingByPath.get(alertPath)
    const isHeartbeat =
      tracked &&
      tracked.id === alert.id &&
      tracked.priority === alert.priority &&
      tracked.state === alert.state &&
      tracked.message === alert.message &&
      tracked.silenced === alert.silenced
    if (isHeartbeat) return

    alertTrackingByPath.set(alertPath, {
      id: alert.id,
      priority: alert.priority,
      state: alert.state,
      message: alert.message,
      silenced: alert.silenced
    })

    if (alert.state === 'normal') {
      queue.remove(alertPath)
      alertTrackingByPath.delete(alertPath)
      return
    }

    const priority = resolvePriority(alert.priority)
    if (!shouldVoice(priority)) {
      // unrecognized/missing priority - mirror alert manager's own
      // behavior of silently ignoring a malformed alert
      queue.remove(alertPath)
      return
    }

    if (alert.state === 'acknowledged') {
      queue.acknowledge(alertPath)
      return
    }

    // remaining states: 'unacknowledged' or 'rtn-unacknowledged'
    if (alert.silenced) {
      queue.silence(alertPath)
      return
    }

    const message = resolveMessage({
      path: alertPath,
      priority,
      alert,
      overrides: config.messageOverrides,
      pronunciation: config.pronunciationSubstitutions,
      rtnPhrasing: priorityRtnPhrasingConfig()[priority]
    })

    queue.upsert(alertPath, priority, message)
  }

  let currentTonePlayback = null

  function alertManagerClient () {
    const port = Number(process.env?.PORT) || app.config?.settings?.port || 3000
    return createAlertManagerClient({ port, token: config.alertManagerToken })
  }

  // /test-announce entries share the real queue (see there) under a
  // synthetic path, so ack/silence can tell them apart from real
  // alerts.*-backed ones that need proxying to alert manager's REST API.
  function isTestPath (path) {
    return path.startsWith('test.announce.')
  }

  // Per-priority repeat behavior (see docs/alerts-only-plan.md and
  // lib/alertQueue.js's class doc comment for the full rationale):
  //  - Warning/Caution: play once, no repeat.
  //  - Alarm: repeat at the configured interval while unacknowledged.
  //  - Emergency alarm: repeat continuously (no gap) while unacknowledged -
  //    always on, not configurable/disableable, given the severity.
  // All three stop immediately when silenced and only resume on an
  // explicit un-silence transition, never on a local timer.
  function repeatPolicyForPriority (priority) {
    if (priority === PRIORITY.EMERGENCY_ALARM) {
      return { mode: 'continuous' }
    }
    if (priority === PRIORITY.ALARM) {
      return { mode: 'interval', intervalSeconds: config.alarmRepeatIntervalSeconds }
    }
    return { mode: 'once' } // Caution, Warning
  }

  function priorityToneConfig () {
    return {
      [PRIORITY.CAUTION]: config.cautionTone,
      [PRIORITY.WARNING]: config.warningTone,
      [PRIORITY.ALARM]: config.alarmTone,
      [PRIORITY.EMERGENCY_ALARM]: config.emergencyAlarmTone
    }
  }

  async function announce (entry) {
    // entry.meta carries a per-entry override (used by /test-announce so
    // a test can pick an arbitrary tone/language/voice regardless of
    // configured defaults) - real alerts never set this, so they always
    // resolve from priority/path/config as before.
    const clipPath =
      entry.meta && entry.meta.clipPath !== undefined
        ? entry.meta.clipPath
        : resolveClipPath(entry.priority, entry.path, config.musterListCodes, priorityToneConfig())
    await playAnnouncement({
      clipPath,
      message: entry.message,
      language: (entry.meta && entry.meta.language) || config.language,
      voice: (entry.meta && entry.meta.voice) || config.serverVoice
    })
  }

  /**
   * Plays a tone clip (if any) followed by a spoken message (if any),
   * server-side. Used both for real alerts (via the queue) and for
   * one-off test/demo playback (see /test-announce).
   */
  async function playAnnouncement ({ clipPath, message, language, voice }) {
    if (config.playback.server && clipPath) {
      currentTonePlayback = playTone(clipPath)
      const toneResult = await currentTonePlayback.promise
      currentTonePlayback = null
      if (!toneResult.played) {
        app.debug(`tone playback unavailable, falling back to browser playback: ${toneResult.reason}`)
      }
    }

    if (config.playback.server && message) {
      const result = await speak(message, {
        language: language || config.language,
        voice: voice || config.serverVoice || undefined
      })
      if (!result.spoken) {
        app.debug(`espeak-ng unavailable, falling back to browser playback: ${result.reason}`)
      }
    }
    // browser-side playback: the companion webapp polls /plugins/<id>/active
    // and speaks client-side via the Web Speech API - see public/app.js
  }

  function interruptPlayback () {
    if (currentTonePlayback) currentTonePlayback.stop()
    currentTonePlayback = null
  }

  plugin.registerWithRouter = function (router) {
    // Routes needed for the companion webapp to passively play incoming
    // alert tone+voice without an admin login: registerWithRouter's routes
    // are admin-gated by default (plugin.registerWithRouter's own docs),
    // but router.access('readonly') (added in a July 2026 signalk-server
    // release, see SignalK/signalk-server#2498) opens a route to
    // unauthenticated readers when the server's allow_readonly setting
    // permits it - the same setting that already lets webapps like
    // Instrument Panel work without login. Older servers lack
    // router.access entirely, so feature-detect and fall back to the plain
    // (admin-gated) router rather than throwing during registration.
    // Mutating routes (/acknowledge, /silence) and test-only routes
    // (/options, /test-announce) deliberately stay admin-gated.
    const readable = typeof router.access === 'function' ? router.access('readonly') : router

    readable.get('/active', (req, res) => {
      res.json(
        queue
          ? [...queue.alerts.values()].map((e) => ({
              path: e.path,
              priority: e.priority,
              message: e.message,
              state: e.state,
              // monotonic, changes on every fresh occurrence (including a
              // repeated manual /test-announce submission with identical
              // priority/message) - a more robust "is this actually new"
              // signal for the webapp than path+message, which wouldn't
              // change on a deliberate resubmission
              revision: e.queuedAt,
              // only present for /test-announce entries (see there) - lets
              // the browser reconstruct the same tone-clip URL the server
              // used, instead of falling back to the priority default and
              // silently mismatching a test's chosen tone override
              toneCode: e.meta ? e.meta.toneCode : undefined,
              tonePattern: e.meta ? e.meta.tonePattern : undefined,
              language: e.meta ? e.meta.language : undefined,
              voice: e.meta ? e.meta.voice : undefined
            }))
          : []
      )
    })

    router.get('/options', (req, res) => {
      const toneConfig = priorityToneConfig()
      res.json({
        priorities: [PRIORITY.CAUTION, PRIORITY.WARNING, PRIORITY.ALARM, PRIORITY.EMERGENCY_ALARM].map(
          (value) => ({
            value,
            label: priorityName(value),
            // the currently configured default for this priority (see
            // cautionTone/warningTone/alarmTone/emergencyAlarmTone in
            // plugin.schema) - lets the webapp show what "Priority
            // default" actually resolves to right now
            configuredDefault: toneConfig[value]
          })
        ),
        // 1b (SHIP_SPECIFIC) isn't listed as a fixed code - it needs a
        // pattern, entered separately (see tonePattern field/param).
        toneCodes: Object.values(TONE_CODE)
          .filter((code) => code !== TONE_CODE.SHIP_SPECIFIC)
          .map((code) => ({ value: code, label: code, description: TONE_CODE_DESCRIPTION[code] || null })),
        // musterListCodes configured in plugin config (1.b ship-specific
        // codes) - exposed so the test-mode webapp can offer them as
        // selectable tone options too, not just the built-in codes.
        musterListCodes: config.musterListCodes.map((m) => ({
          path: m.path,
          zone: m.zone || null,
          pattern: m.pattern
        })),
        // configured voice/language settings, so the webapp can default
        // its test-mode voice fields to whatever's actually configured
        // rather than leaving them blank
        voice: {
          language: config.language,
          serverVoice: config.serverVoice
        }
      })
    })

    readable.get('/tone-clip', (req, res) => {
      const { code, pattern, priority, path: notificationPath } = req.query
      try {
        let clipPath
        if (pattern) {
          clipPath = resolveMusterClipPath(pattern)
        } else if (code && code !== 'none') {
          clipPath = clipPathFor(code)
        } else if (priority) {
          clipPath = resolveClipPath(
            Number(priority),
            notificationPath || '__test__',
            config.musterListCodes,
            priorityToneConfig()
          )
        } else {
          res.status(400).json({ error: 'expected a code, pattern, or priority query param' })
          return
        }
        if (!clipPath || !fs.existsSync(clipPath)) {
          res.status(404).json({ error: 'clip not found' })
          return
        }
        res.type('audio/wav')
        res.sendFile(path.resolve(clipPath), (err) => {
          if (err && !res.headersSent) {
            app.debug(`tone-clip sendFile error: ${err.message}`)
            res.status(500).json({ error: 'failed to send clip' })
          }
        })
      } catch (err) {
        res.status(400).json({ error: err.message })
      }
    })

    readable.get('/voice-clip', async (req, res) => {
      const { message, language, voice } = req.query
      if (!message) {
        res.status(400).json({ error: 'expected a message query param' })
        return
      }

      // synthesized fresh per request (not cached) - message text is
      // usually dynamic (interpolated values), unlike the fixed set of
      // tone patterns - see lib/tts.js, synthesizeToFile. Deliberately
      // does NOT apply pronunciationSubstitutions itself: a real alert's
      // message (from /active) is already substituted once via
      // resolveMessage, and re-applying here would risk double
      // substitution - callers needing substitution (test mode) get the
      // already-substituted text back from /test-announce instead.
      const tmpPath = path.join(os.tmpdir(), `signalk-imo-alerts-voice-${crypto.randomUUID()}.wav`)
      const result = await synthesizeToFile(message, tmpPath, {
        language: language || config.language,
        voice: voice || config.serverVoice || undefined
      })

      if (!result.synthesized) {
        res.status(503).json({ error: `speech synthesis unavailable: ${result.reason}` })
        return
      }

      res.type('audio/wav')
      res.sendFile(path.resolve(tmpPath), (err) => {
        if (err && !res.headersSent) {
          app.debug(`voice-clip sendFile error: ${err.message}`)
          res.status(500).json({ error: 'failed to send clip' })
        }
        fs.unlink(tmpPath, () => {}) // best-effort cleanup, not cached
      })
    })

    router.post('/test-announce', (req, res) => {
      const { priority, message, toneCode, tonePattern, language, voice } = req.body || {}
      if (typeof priority !== 'number') {
        res.status(400).json({ error: 'expected { priority: number, ... }' })
        return
      }

      let clipPath
      try {
        if (tonePattern) {
          clipPath = resolveMusterClipPath(tonePattern)
        } else if (toneCode === 'none') {
          clipPath = null
        } else if (toneCode) {
          clipPath = clipPathFor(toneCode)
        } else {
          clipPath = resolveClipPath(priority, '__test__', [], priorityToneConfig())
        }
      } catch (err) {
        res.status(400).json({ error: `invalid tone pattern: ${err.message}` })
        return
      }

      const spokenMessage = message
        ? applyPronunciation(message, config.pronunciationSubstitutions)
        : null

      // Pushed into the SAME queue real alerts.* alerts use (one slot per
      // priority, so different-priority tests can coexist and preempt each
      // other the same way real alerts would) rather than a separate
      // one-off playback path. This gets tone-then-voice playback,
      // priority preemption, and the per-priority repeat policy for free -
      // and critically, browser broadcast: any open webapp tab's existing
      // /active polling picks this up and plays it exactly like a real
      // alert, with no separate broadcast mechanism needed. clipPath/
      // language/voice are carried as a per-entry override (entry.meta,
      // see announce()) so a test can use an arbitrary tone/voice
      // regardless of configured defaults - real alerts never set this.
      const testPath = `test.announce.${priority}`
      queue.upsert(testPath, priority, spokenMessage, {
        clipPath,
        toneCode: toneCode || undefined,
        tonePattern: tonePattern || undefined,
        language,
        voice
      })

      res.json({ ok: true, path: testPath, spokenMessage })
    })

    router.post('/acknowledge', async (req, res) => {
      const { path: alertPath } = req.body || {}
      if (typeof alertPath !== 'string') {
        res.status(400).json({ error: 'expected { path: string }' })
        return
      }

      // /test-announce entries live in the same queue as real alerts (see
      // there for why) but aren't backed by a real alerts.* delta, so
      // there's no alert-manager id to proxy to - acknowledge them
      // directly on the local queue instead.
      if (isTestPath(alertPath)) {
        queue.acknowledge(alertPath)
        res.json({ ok: true })
        return
      }

      const tracked = alertTrackingByPath.get(alertPath)
      if (!tracked) {
        res.status(404).json({ error: `no known alert for path "${alertPath}"` })
        return
      }
      // Proxy to alert manager's REST API rather than mutating our own
      // queue directly - it's the single source of truth
      // (docs/alerts-only-plan.md, "Ack/Silence: delegate, don't own").
      // Our queue updates itself from the resulting alerts.* delta, the
      // same way any other state change does. NOT app.alertManager - see
      // lib/alertManagerClient.js and BoatHacks/signalk-imo-alerts#1 for
      // why that doesn't work.
      const client = alertManagerClient()
      const result = await client.acknowledgeAlert(tracked.id)
      if (!result.ok) {
        res.status(result.status).json({ error: result.error })
        return
      }
      res.json({ ok: true })
    })

    router.post('/silence', async (req, res) => {
      const { path: alertPath, durationSeconds } = req.body || {}
      if (typeof alertPath !== 'string') {
        res.status(400).json({ error: 'expected { path: string }' })
        return
      }

      if (isTestPath(alertPath)) {
        queue.silence(alertPath)
        res.json({ ok: true })
        return
      }

      const tracked = alertTrackingByPath.get(alertPath)
      if (!tracked) {
        res.status(404).json({ error: `no known alert for path "${alertPath}"` })
        return
      }
      // Unlike the old (unreachable) plugin API, alert manager's REST
      // silence endpoint already defaults to its own configured maximum
      // per priority when duration is omitted - no need to duplicate
      // those defaults (120s/30s) here ourselves.
      const client = alertManagerClient()
      const result = await client.silenceAlert(tracked.id, typeof durationSeconds === 'number' ? durationSeconds : undefined)
      if (!result.ok) {
        res.status(result.status).json({ error: result.error })
        return
      }
      res.json({ ok: true })
    })
  }

  plugin.getOpenApi = () => require('./docs/openApi.json')

  return plugin
}
