'use strict'

const path = require('path')
const { resolvePriority, shouldVoice, PRIORITY } = require('./lib/priority')
const { resolveMessage } = require('./lib/templates')
const { AlertQueue } = require('./lib/alertQueue')
const { speak } = require('./lib/tts')
const { resolveClipPath, play: playTone } = require('./lib/tones')
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
        title: 'Voice language (espeak-ng voice code)',
        default: 'en'
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

    registerRoutes()
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
      musterListCodes: o.musterListCodes || []
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
  let currentSpeechAbort = null

  async function announce (entry) {
    const clipPath = resolveClipPath(entry.priority, entry.path, config.musterListCodes)
    if (config.playback.server && clipPath) {
      currentTonePlayback = playTone(clipPath)
      await currentTonePlayback.promise
      currentTonePlayback = null
    }

    if (config.playback.server) {
      const result = await speak(entry.message, { language: config.language })
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

  function registerRoutes () {
    const router = app.getPluginRouter?.() || app.router // signalk-server convention varies by version
    if (!router) return

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

    router.post('/test-announce', (req, res) => {
      const { priority, message } = req.body || {}
      if (typeof priority !== 'number' || typeof message !== 'string') {
        res.status(400).json({ error: 'expected { priority: number, message: string }' })
        return
      }
      queue.upsert('test.announce', priority, message)
      res.json({ ok: true })
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
