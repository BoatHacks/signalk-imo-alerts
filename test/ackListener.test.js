'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createAckListener } = require('../lib/ackListener')

function makeFakeApp ({ selfPathValues = {} } = {}) {
  const putHandlers = {}
  return {
    registerPutHandler: (context, path, handler) => {
      putHandlers[path] = handler
    },
    getSelfPath: (path) => Promise.resolve(selfPathValues[path]),
    _putHandlers: putHandlers
  }
}

function makeFakeQueue () {
  const acked = []
  const silenced = []
  return {
    acknowledge: (path) => acked.push(path),
    silence: (path) => silenced.push(path),
    alerts: new Map(),
    acked,
    silenced
  }
}

test('PUT handler is registered once per path, dispatches acknowledge/silence, and returns a result directly', () => {
  const app = makeFakeApp()
  const queue = makeFakeQueue()
  const listener = createAckListener(app, { pluginId: 'test', getQueue: () => queue })

  listener.syncPaths(['notifications.mob'])
  listener.syncPaths(['notifications.mob']) // second call should be a no-op registration-wise
  assert.equal(Object.keys(app._putHandlers).length, 1)

  const handler = app._putHandlers['notifications.mob']
  const ackResult = handler(null, 'notifications.mob', { action: 'acknowledge' })
  const silenceResult = handler(null, 'notifications.mob', { action: 'silence' })

  assert.deepEqual(queue.acked, ['notifications.mob'])
  assert.deepEqual(queue.silenced, ['notifications.mob'])
  // signalk-server's put.js reads .state directly off the handler's return
  // value (no callback) for a synchronous handler like this one - passing
  // null/undefined here throws "Cannot read properties of null/undefined
  // (reading 'state')" server-side, which is exactly the bug this replaced.
  assert.deepEqual(ackResult, { state: 'COMPLETED', statusCode: 200 })
  assert.deepEqual(silenceResult, { state: 'COMPLETED', statusCode: 200 })
})

test('PUT handler returns a result even when the queue is not yet available', () => {
  const app = makeFakeApp()
  const listener = createAckListener(app, { pluginId: 'test', getQueue: () => null })

  listener.syncPaths(['notifications.mob'])
  const handler = app._putHandlers['notifications.mob']
  const result = handler(null, 'notifications.mob', { action: 'acknowledge' })

  assert.deepEqual(result, { state: 'COMPLETED', statusCode: 503 })
})

test('poll fallback acknowledges when method drops "sound" without a delta', async () => {
  const app = makeFakeApp({
    selfPathValues: {
      'notifications.mob': { method: ['visual'], state: 'emergency' }
    }
  })
  const queue = makeFakeQueue()
  const listener = createAckListener(app, {
    pluginId: 'test',
    getQueue: () => queue,
    pollIntervalMs: 5
  })

  listener.startPolling(() => ['notifications.mob'])
  await new Promise((resolve) => setTimeout(resolve, 20))
  listener.stop()

  assert.ok(queue.acked.includes('notifications.mob'))
})
