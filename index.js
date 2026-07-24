'use strict'

const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const path = require('path')
const { resolvePriority, shouldVoice, PRIORITY, priorityName } = require('./lib/priority')
const { resolveMessage, applyPronunciation } = require('./lib/templates')
const { AlertQueue } = require('./lib/alertQueue')
const { speak, synthesizeToFile } = require('./lib/tts')
const {
  resolveClipPath,
  resolveMusterClipPath,
  clipPathFor,
  TONE_CODE,
  play: playTone
} = require('./lib/tones')
const { createAckListener } = require('./lib/ackListener')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-imo-alerts',
    name: 'IMO Alerts (voice + tone)',
    description:
      'Spoken alert announcements and IMO A.1021(26) alert tone patterns for Signal K notifications'
  }

  let unsubscribes = []
  let queue = null
  let tickInterval = null
  let config = {}
  let ackListener = null
  // Cached meta.displayUnits per path, populated via sendMeta subscription -
  // see docs/design.md, numeric interpolation.
  const metaByPath = {}

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enabled', default: true },
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
      repeat: {
        type: 'object',
        title: 'Repeat',
        properties: {
          enabled: { type: 'boolean', title: 'Repeat until acknowledged', default: true },
          intervalSeconds: {
            type: 'number',
            title:
              'Repeat interval (seconds) - default mirrors MSC.302(87)\'s 30s figure for an unacknowledged signal',
            default: 30
          }
        }
      },
      pinnedEmergencyAlarmPaths: {
        type: 'array',
        title:
          'Paths always treated as MSC.302(87) Emergency Alarm, regardless of Signal K state (e.g. notifications.mob)',
        items: { type: 'string' },
        default: ['notifications.mob']
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
      repeatIntervalSeconds: config.repeat.intervalSeconds,
      repeatEnabled: config.repeat.enabled
    })

    tickInterval = setInterval(() => queue.tick(), 1000)

    ackListener = createAckListener(app, {
      pluginId: plugin.id,
      getQueue: () => queue
    })
    ackListener.startPolling(() => (queue ? [...queue.alerts.keys()] : []))

    const unsubMeta = app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [{ path: 'notifications.*', policy: 'instant', minPeriod: 200 }]
      },
      unsubscribes,
      (err) => app.error(`subscription error: ${err}`),
      (delta) => handleDelta(delta),
      'all', // sourcePolicy - see signalk-dead-mans-switch precedent
      'all' // sendMeta - needed for displayUnits, see docs/design.md
    )
    unsubscribes.push(unsubMeta)
  }

  plugin.stop = function () {
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    if (tickInterval) clearInterval(tickInterval)
    tickInterval = null
    if (ackListener) ackListener.stop()
    ackListener = null
    queue = null
  }

  function normalizeConfig (options) {
    const o = options || {}
    return {
      enabled: o.enabled !== false,
      language: o.language || 'en',
      serverVoice: o.serverVoice || '',
      playback: {
        server: o.playback?.server !== false,
        browser: o.playback?.browser !== false
      },
      repeat: {
        enabled: o.repeat?.enabled !== false,
        intervalSeconds: o.repeat?.intervalSeconds || 30
      },
      pinnedEmergencyAlarmPaths: o.pinnedEmergencyAlarmPaths || ['notifications.mob'],
      messageOverrides: o.messageOverrides || [],
      pronunciationSubstitutions: o.pronunciationSubstitutions || [],
      musterListCodes: o.musterListCodes || [],
      cautionTone: { preset: o.cautionTone?.preset || '3c', pattern: o.cautionTone?.pattern || '' },
      warningTone: { preset: o.warningTone?.preset || '3a', pattern: o.warningTone?.pattern || '' },
      alarmTone: { preset: o.alarmTone?.preset || '2', pattern: o.alarmTone?.pattern || '' },
      emergencyAlarmTone: {
        preset: o.emergencyAlarmTone?.preset || '1a',
        pattern: o.emergencyAlarmTone?.pattern || ''
      }
    }
  }

  function handleDelta (delta) {
    for (const update of delta.updates || []) {
      for (const pv of update.values || []) {
        if (pv.path.startsWith('notifications.')) {
          handleNotification(pv.path, pv.value)
        }
      }
      for (const meta of update.meta || []) {
        if (meta.value && meta.value.displayUnits) {
          metaByPath[meta.path] = meta.value.displayUnits
        }
      }
    }
  }

  function handleNotification (notificationPath, notification) {
    if (!notification) {
      queue.remove(notificationPath)
      return
    }

    // ack/silence detection, reconciliation-style (see
    // signalk-dead-mans-switch precedent, docs/design.md "Ack/silence
    // detection"): treat an explicit acknowledged flag, or "sound" no
    // longer present in method, as the corresponding signal.
    if (notification.status?.acknowledged === true || notification.method?.includes('sound') === false) {
      queue.acknowledge(notificationPath)
      return
    }

    const priority = resolvePriority(
      notificationPath,
      notification.state,
      config.pinnedEmergencyAlarmPaths
    )
    if (!shouldVoice(priority)) {
      queue.remove(notificationPath)
      return
    }

    const message = resolveMessage({
      path: notificationPath,
      priority,
      notification,
      rawValue: typeof notification.value === 'number' ? notification.value : undefined,
      displayUnits: metaByPath[notificationPath],
      overrides: config.messageOverrides,
      pronunciation: config.pronunciationSubstitutions
    })

    queue.upsert(notificationPath, priority, message)
    ackListener.syncPaths([notificationPath])
  }

  let currentTonePlayback = null

  function priorityToneConfig () {
    return {
      [PRIORITY.CAUTION]: config.cautionTone,
      [PRIORITY.WARNING]: config.warningTone,
      [PRIORITY.ALARM]: config.alarmTone,
      [PRIORITY.EMERGENCY_ALARM]: config.emergencyAlarmTone
    }
  }

  async function announce (entry) {
    const clipPath = resolveClipPath(entry.priority, entry.path, config.musterListCodes, priorityToneConfig())
    await playAnnouncement({
      clipPath,
      message: entry.message,
      language: config.language,
      voice: config.serverVoice
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
    router.get('/active', (req, res) => {
      res.json(
        queue
          ? [...queue.alerts.values()].map((e) => ({
              path: e.path,
              priority: e.priority,
              message: e.message,
              state: e.state
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
          .map((code) => ({ value: code, label: code })),
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

    router.get('/tone-clip', (req, res) => {
      const { code, pattern, priority } = req.query
      try {
        let clipPath
        if (pattern) {
          clipPath = resolveMusterClipPath(pattern)
        } else if (code && code !== 'none') {
          clipPath = clipPathFor(code)
        } else if (priority) {
          clipPath = resolveClipPath(Number(priority), '__test__', [], priorityToneConfig())
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

    router.get('/voice-clip', async (req, res) => {
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

      // respond immediately - server-side playback happens asynchronously
      // and shouldn't hold the HTTP request open. spokenMessage is
      // included so the webapp's browser-side preview can play the exact
      // same pronunciation-substituted text via /voice-clip, without
      // duplicating the substitution logic client-side.
      const spokenMessage = message
        ? applyPronunciation(message, config.pronunciationSubstitutions)
        : null
      res.json({ ok: true, spokenMessage })
      playAnnouncement({ clipPath, message: spokenMessage, language, voice }).catch((err) =>
        app.debug(`test-announce playback error: ${err}`)
      )
    })

    router.post('/acknowledge', (req, res) => {
      const { path: notificationPath } = req.body || {}
      if (typeof notificationPath !== 'string') {
        res.status(400).json({ error: 'expected { path: string }' })
        return
      }
      queue.acknowledge(notificationPath)
      res.json({ ok: true })
    })

    router.post('/silence', (req, res) => {
      const { path: notificationPath } = req.body || {}
      if (typeof notificationPath !== 'string') {
        res.status(400).json({ error: 'expected { path: string }' })
        return
      }
      queue.silence(notificationPath)
      res.json({ ok: true })
    })
  }

  plugin.getOpenApi = () => require('./docs/openApi.json')

  return plugin
}
