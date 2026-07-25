'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('../lib/alertManagerClient')

test('acknowledgeAlert POSTs to the right path with a Bearer token', async () => {
  let capturedUrl, capturedOpts
  const fetchFn = async (url, opts) => {
    capturedUrl = url
    capturedOpts = opts
    return { ok: true, status: 200 }
  }
  const client = createClient({ port: 3000, token: 'abc123', fetchFn })
  const result = await client.acknowledgeAlert('alert-id-1')

  assert.equal(result.ok, true)
  assert.equal(capturedUrl, 'http://localhost:3000/plugins/signalk-alert-manager/alerts/alert-id-1/acknowledge')
  assert.equal(capturedOpts.method, 'POST')
  assert.equal(capturedOpts.headers.Authorization, 'Bearer abc123')
})

test('silenceAlert omits duration when not given, letting alert manager use its own configured default', async () => {
  let capturedOpts
  const fetchFn = async (url, opts) => {
    capturedOpts = opts
    return { ok: true, status: 200 }
  }
  const client = createClient({ port: 3000, token: 'abc123', fetchFn })
  await client.silenceAlert('alert-id-1')

  assert.equal(capturedOpts.body, undefined)
})

test('silenceAlert includes duration in seconds when given', async () => {
  let capturedOpts
  const fetchFn = async (url, opts) => {
    capturedOpts = opts
    return { ok: true, status: 200 }
  }
  const client = createClient({ port: 3000, token: 'abc123', fetchFn })
  await client.silenceAlert('alert-id-1', 45)

  assert.deepEqual(JSON.parse(capturedOpts.body), { duration: 45 })
})

test('without a configured token, fails fast with a clear error and never calls fetch', async () => {
  let fetchCalled = false
  const fetchFn = async () => {
    fetchCalled = true
    return { ok: true, status: 200 }
  }
  const client = createClient({ port: 3000, token: '', fetchFn })
  const result = await client.acknowledgeAlert('alert-id-1')

  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.match(result.error, /no alertManagerToken configured/)
  assert.equal(fetchCalled, false)
})

test('a non-ok HTTP response is surfaced with its status and body text', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 401,
    text: async () => 'Unauthorized'
  })
  const client = createClient({ port: 3000, token: 'bad-token', fetchFn })
  const result = await client.acknowledgeAlert('alert-id-1')

  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.match(result.error, /401/)
  assert.match(result.error, /Unauthorized/)
})

test('a network/fetch failure (e.g. alert manager not running) resolves as a 503, not a throw', async () => {
  const fetchFn = async () => {
    throw new Error('ECONNREFUSED')
  }
  const client = createClient({ port: 3000, token: 'abc123', fetchFn })
  const result = await client.acknowledgeAlert('alert-id-1')

  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.match(result.error, /could not reach signalk-alert-manager/)
})
