'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

function makeFakeApp () {
  return {
    subscriptionmanager: { subscribe: () => () => {} },
    error: () => {},
    debug: () => {},
    getSelfPath: () => Promise.resolve(undefined),
    registerPutHandler: () => {}
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
    assert.deepEqual(res.body, { ok: true })
  })

  await t.test('POST /test-announce with an invalid custom pattern is a 400', () => {
    const req = { body: { priority: 2, tonePattern: 'not-a-pattern' } }
    const res = makeFakeRes()
    router._routes['POST /test-announce'](req, res)
    assert.equal(res.statusCode, 400)
  })
})
