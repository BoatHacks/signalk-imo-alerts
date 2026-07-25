'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

function makeFakeApp () {
  let deltaHandler = null
  return {
    subscriptionmanager: {
      subscribe: (sub, unsubs, errCb, deltaCb) => {
        deltaHandler = deltaCb
        return () => {}
      }
    },
    error: () => {},
    debug: () => {},
    setPluginStatus: () => {},
    // test helper: simulate an incoming alerts.<path> delta, the same
    // shape signalk-alert-manager actually publishes
    _emitAlert (alertPath, value) {
      deltaHandler({
        updates: [{ values: [{ path: `alerts.${alertPath}`, value }] }]
      })
    }
  }
}

// A full, valid alerts.* value object with sensible defaults - see
// docs/alerts-only-plan.md for the shape. Individual fields overridable.
function makeAlert (overrides = {}) {
  return {
    id: 'test-id-1',
    path: 'tanks.fuel.0',
    $source: 'test-source',
    priority: 'warning',
    state: 'unacknowledged',
    condition: true,
    latching: true,
    silenced: false,
    message: 'Fuel tank low',
    raisedAt: new Date().toISOString(),
    sourceOnline: true,
    lastSourceUpdate: new Date().toISOString(),
    stale: false,
    ...overrides
  }
}

function makeFakeRouter () {
  const routes = {}
  return {
    get: (p, h) => {
      routes[`GET ${p}`] = h
    },
    post: (p, h) => {
      routes[`POST ${p}`] = h
    },
    _routes: routes
  }
}

function makeFakeRes () {
  const res = {
    statusCode: 200,
    body: null,
    sentFile: null,
    status (code) {
      this.statusCode = code
      return this
    },
    json (body) {
      this.body = body
      return this
    },
    type () {
      return this
    },
    sendFile (p) {
      this.sentFile = p
    }
  }
  return res
}

test('routes: /options, /tone-clip, /test-announce', async (t) => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({})
  plugin.registerWithRouter(router) // signalk-server calls this itself, mounted at /plugins/<id>/
  t.after(() => plugin.stop())

  await t.test('GET /options lists priorities and tone codes, excluding 1b', () => {
    const req = {}
    const res = makeFakeRes()
    router._routes['GET /options'](req, res)
    assert.equal(res.body.priorities.length, 4)
    assert.ok(res.body.toneCodes.every((t) => t.value !== '1b'))
    assert.ok(res.body.toneCodes.some((t) => t.value === '1a'))
    assert.ok(res.body.toneCodes.every((t) => typeof t.description === 'string' && t.description.length > 0))
  })

  await t.test('GET /options includes each priority\'s currently configured default tone', () => {
    const req = {}
    const res = makeFakeRes()
    router._routes['GET /options'](req, res)
    const byLabel = Object.fromEntries(res.body.priorities.map((p) => [p.label, p.configuredDefault]))
    assert.equal(byLabel.Caution.preset, '3c')
    assert.equal(byLabel.Warning.preset, '3a')
    assert.equal(byLabel.Alarm.preset, '2')
    assert.equal(byLabel['Emergency alarm'].preset, '1a')
  })

  await t.test('GET /tone-clip?code=1a serves the built-in clip', () => {
    const req = { query: { code: '1a' } }
    const res = makeFakeRes()
    router._routes['GET /tone-clip'](req, res)
    assert.ok(res.sentFile.endsWith(path.join('sounds', 'tones', '1a.wav')))
  })

  await t.test('GET /tone-clip?pattern=... serves a synthesized muster clip', () => {
    const req = { query: { pattern: '500:100 0:50' } }
    const res = makeFakeRes()
    router._routes['GET /tone-clip'](req, res)
    assert.ok(res.sentFile.endsWith('.wav'))
  })

  await t.test('GET /tone-clip with no params is a 400', () => {
    const req = { query: {} }
    const res = makeFakeRes()
    router._routes['GET /tone-clip'](req, res)
    assert.equal(res.statusCode, 400)
  })

  await t.test('POST /test-announce without a priority is a 400', () => {
    const req = { body: { message: 'hi' } }
    const res = makeFakeRes()
    router._routes['POST /test-announce'](req, res)
    assert.equal(res.statusCode, 400)
  })

  await t.test('POST /test-announce with a valid priority responds ok', () => {
    const req = { body: { priority: 2, message: 'test message', toneCode: 'none' } }
    const res = makeFakeRes()
    router._routes['POST /test-announce'](req, res)
    assert.deepEqual(res.body, { ok: true, spokenMessage: 'test message' })
  })

  await t.test('POST /test-announce with an invalid custom pattern is a 400', () => {
    const req = { body: { priority: 2, tonePattern: 'not-a-pattern' } }
    const res = makeFakeRes()
    router._routes['POST /test-announce'](req, res)
    assert.equal(res.statusCode, 400)
  })
})

test('GET /tone-clip?priority=X&path=Y picks up a matching musterListCodes override (not just the priority default)', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  const musterPattern = '2000:500 0:200'
  plugin.start({
    musterListCodes: [{ path: 'notifications.fire.engineRoom', zone: 'Engine Room', pattern: musterPattern }]
  })
  plugin.registerWithRouter(router)

  const { resolveMusterClipPath } = require('../lib/tones')
  const { PRIORITY } = require('../lib/priority')

  const req = { query: { priority: String(PRIORITY.WARNING), path: 'notifications.fire.engineRoom' } }
  const res = makeFakeRes()
  router._routes['GET /tone-clip'](req, res)

  assert.equal(res.sentFile, path.resolve(resolveMusterClipPath(musterPattern)))

  plugin.stop()
})

test('GET /tone-clip?priority=X&path=Y falls back to the priority default when no muster override matches that path', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({
    musterListCodes: [{ path: 'notifications.fire.engineRoom', zone: 'Engine Room', pattern: '2000:500 0:200' }]
  })
  plugin.registerWithRouter(router)

  const { clipPathFor } = require('../lib/tones')
  const { PRIORITY } = require('../lib/priority')

  const req = { query: { priority: String(PRIORITY.WARNING), path: 'notifications.tanks.fuel.0' } }
  const res = makeFakeRes()
  router._routes['GET /tone-clip'](req, res)

  assert.equal(res.sentFile, path.resolve(clipPathFor('3a'))) // Warning's default preset

  plugin.stop()
})

test('GET /options exposes configured musterListCodes', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({
    musterListCodes: [
      { path: 'notifications.fire.engineRoom', zone: 'Engine Room fire party', pattern: '2000:500 0:200' }
    ]
  })
  plugin.registerWithRouter(router)

  const req = {}
  const res = makeFakeRes()
  router._routes['GET /options'](req, res)

  assert.deepEqual(res.body.musterListCodes, [
    { path: 'notifications.fire.engineRoom', zone: 'Engine Room fire party', pattern: '2000:500 0:200' }
  ])

  plugin.stop()
})

test('GET /options exposes configured voice/language settings', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({ language: 'de', serverVoice: 'de+f3' })
  plugin.registerWithRouter(router)

  const req = {}
  const res = makeFakeRes()
  router._routes['GET /options'](req, res)

  assert.deepEqual(res.body.voice, {
    language: 'de',
    serverVoice: 'de+f3'
  })

  plugin.stop()
})

test('GET /options no longer exposes pronunciationSubstitutions (substitution now happens purely server-side)', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({
    pronunciationSubstitutions: [{ pattern: 'SOG', replacement: 'speed over ground' }]
  })
  plugin.registerWithRouter(router)

  const req = {}
  const res = makeFakeRes()
  router._routes['GET /options'](req, res)

  assert.equal(res.body.pronunciationSubstitutions, undefined)

  plugin.stop()
})

test('POST /test-announce returns the pronunciation-substituted spokenMessage for the browser to preview', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({
    pronunciationSubstitutions: [{ pattern: 'SOG', replacement: 'speed over ground' }]
  })
  plugin.registerWithRouter(router)

  const req = { body: { priority: 2, message: 'SOG sensor fault', toneCode: 'none' } }
  const res = makeFakeRes()
  router._routes['POST /test-announce'](req, res)

  assert.deepEqual(res.body, { ok: true, spokenMessage: 'speed over ground sensor fault' })

  plugin.stop()
})

test('GET /voice-clip requires a message query param', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  const req = { query: {} }
  const res = makeFakeRes()
  await router._routes['GET /voice-clip'](req, res)
  assert.equal(res.statusCode, 400)

  plugin.stop()
})

test('GET /voice-clip never crashes regardless of whether espeak-ng is actually installed', async () => {
  // deliberately doesn't assert 200 vs 503 - whether espeak-ng is present
  // varies by environment (this sandbox has it; CI may not), and that
  // specific behavior is already covered deterministically, with a
  // mocked spawnFn, in test/tts.test.js. This just confirms the route
  // itself degrades to a clean response either way, never an unhandled
  // exception or a hang.
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const pluginFactory = require('../index.js')
  const plugin = pluginFactory(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  const req = { query: { message: 'test message' } }
  const res = makeFakeRes()
  await router._routes['GET /voice-clip'](req, res)
  assert.ok([200, 503].includes(res.statusCode), `expected 200 or 503, got ${res.statusCode}`)

  plugin.stop()
})

test('POST /acknowledge without a path is a 400', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  const req = { body: {} }
  const res = makeFakeRes()
  await router._routes['POST /acknowledge'](req, res)
  assert.equal(res.statusCode, 400)

  plugin.stop()
})

test('POST /acknowledge is a 400 (no fetch attempted) when no alertManagerToken is configured', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({}) // no alertManagerToken
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert({ id: 'abc-123' }))

  const originalFetch = global.fetch
  let fetchCalled = false
  global.fetch = async () => {
    fetchCalled = true
    return { ok: true, status: 200 }
  }
  try {
    const req = { body: { path: 'tanks.fuel.0' } }
    const res = makeFakeRes()
    await router._routes['POST /acknowledge'](req, res)
    assert.equal(res.statusCode, 400)
    assert.equal(fetchCalled, false)
  } finally {
    global.fetch = originalFetch
  }

  plugin.stop()
})

test('POST /acknowledge for an unknown path is a 404', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({ alertManagerToken: 'test-token' })
  plugin.registerWithRouter(router)

  const req = { body: { path: 'never.seen.this.path' } }
  const res = makeFakeRes()
  await router._routes['POST /acknowledge'](req, res)
  assert.equal(res.statusCode, 404)

  plugin.stop()
})

test('POST /acknowledge calls alert manager\'s REST API with a Bearer token and the tracked id', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({ alertManagerToken: 'test-token' })
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert({ id: 'abc-123' }))

  const originalFetch = global.fetch
  let capturedUrl, capturedOpts
  global.fetch = async (url, opts) => {
    capturedUrl = url
    capturedOpts = opts
    return { ok: true, status: 200 }
  }
  try {
    const req = { body: { path: 'tanks.fuel.0' } }
    const res = makeFakeRes()
    await router._routes['POST /acknowledge'](req, res)

    assert.deepEqual(res.body, { ok: true })
    assert.equal(capturedUrl, 'http://localhost:3000/plugins/signalk-alert-manager/alerts/abc-123/acknowledge')
    assert.equal(capturedOpts.headers.Authorization, 'Bearer test-token')
  } finally {
    global.fetch = originalFetch
  }

  plugin.stop()
})

test('POST /acknowledge surfaces alert manager\'s error status/body on failure', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({ alertManagerToken: 'bad-token' })
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert({ id: 'abc-123' }))

  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' })
  try {
    const req = { body: { path: 'tanks.fuel.0' } }
    const res = makeFakeRes()
    await router._routes['POST /acknowledge'](req, res)
    assert.equal(res.statusCode, 401)
  } finally {
    global.fetch = originalFetch
  }

  plugin.stop()
})

test('POST /silence omits duration when not given, letting alert manager use its own configured default', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({ alertManagerToken: 'test-token' })
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert({ id: 'warn-id', priority: 'warning' }))

  const originalFetch = global.fetch
  let capturedUrl, capturedOpts
  global.fetch = async (url, opts) => {
    capturedUrl = url
    capturedOpts = opts
    return { ok: true, status: 200 }
  }
  try {
    const res = makeFakeRes()
    await router._routes['POST /silence']({ body: { path: 'tanks.fuel.0' } }, res)
    assert.equal(capturedUrl, 'http://localhost:3000/plugins/signalk-alert-manager/alerts/warn-id/silence')
    assert.equal(capturedOpts.body, undefined)
  } finally {
    global.fetch = originalFetch
  }

  plugin.stop()
})

test('POST /silence includes an explicit durationSeconds override in the request body', async () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({ alertManagerToken: 'test-token' })
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert({ id: 'warn-id' }))

  const originalFetch = global.fetch
  let capturedOpts
  global.fetch = async (url, opts) => {
    capturedOpts = opts
    return { ok: true, status: 200 }
  }
  try {
    const res = makeFakeRes()
    await router._routes['POST /silence']({ body: { path: 'tanks.fuel.0', durationSeconds: 45 } }, res)
    assert.deepEqual(JSON.parse(capturedOpts.body), { duration: 45 })
  } finally {
    global.fetch = originalFetch
  }

  plugin.stop()
})

test('alerts.* delta handling: unacknowledged alert becomes active with priority-prefixed message', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert())

  const res = makeFakeRes()
  router._routes['GET /active'](null, res)
  assert.deepEqual(res.body, [
    { path: 'tanks.fuel.0', priority: 2, message: 'Warning. Fuel tank low.', state: 'unacknowledged' }
  ])

  plugin.stop()
})

test('alerts.* delta handling: state normal clears the alert', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert())
  app._emitAlert('tanks.fuel.0', makeAlert({ state: 'normal' }))

  const res = makeFakeRes()
  router._routes['GET /active'](null, res)
  assert.deepEqual(res.body, [])

  plugin.stop()
})

test('alerts.* delta handling: silenced flag maps to our silenced state', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert())
  app._emitAlert('tanks.fuel.0', makeAlert({ silenced: true }))

  const res = makeFakeRes()
  router._routes['GET /active'](null, res)
  assert.equal(res.body[0].state, 'silenced')

  plugin.stop()
})

test('alerts.* delta handling: an unrecognized priority is ignored, not voiced', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert({ priority: 'nonsense' }))

  const res = makeFakeRes()
  router._routes['GET /active'](null, res)
  assert.deepEqual(res.body, [])

  plugin.stop()
})

test('alerts.* delta handling: a heartbeat (identical id/priority/state/message/silenced) does not re-trigger', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({})
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert())
  const res1 = makeFakeRes()
  router._routes['GET /active'](null, res1)
  const firstEntry = res1.body[0]

  // identical heartbeat delta
  app._emitAlert('tanks.fuel.0', makeAlert())
  const res2 = makeFakeRes()
  router._routes['GET /active'](null, res2)

  assert.deepEqual(res2.body[0], firstEntry, 'entry unchanged by a heartbeat')

  plugin.stop()
})

test('alerts.* delta handling: rtn-unacknowledged speaks a distinct configured phrase', () => {
  const app = makeFakeApp()
  const router = makeFakeRouter()
  const plugin = require('../index.js')(app)
  plugin.start({ warningRtnPhrasing: { useDistinctPhrase: true, phrase: 'Fuel tank alarm cleared' } })
  plugin.registerWithRouter(router)

  app._emitAlert('tanks.fuel.0', makeAlert({ state: 'rtn-unacknowledged' }))

  const res = makeFakeRes()
  router._routes['GET /active'](null, res)
  assert.equal(res.body[0].message, 'Warning. Fuel tank alarm cleared.')

  plugin.stop()
})
