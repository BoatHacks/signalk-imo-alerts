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

test('PUT handler is registered once per path and dispatches acknowledge/silence', () => {
  const app = makeFakeApp()
  const queue = makeFakeQueue()
  const listener = createAckListener(app, { pluginId: 'test', getQueue: () => queue })

  listener.syncPaths(['notifications.mob'])
  listener.syncPaths(['notifications.mob']) // second call should be a no-op registration-wise
  assert.equal(Object.keys(app._putHandlers).length, 1)

  const handler = app._putHandlers['notifications.mob']
  const cb = () => {}
  handler(null, 'notifications.mob', { action: 'acknowledge' }, cb)
  handler(null, 'notifications.mob', { action: 'silence' }, cb)

  assert.deepEqual(queue.acked, ['notifications.mob'])
  assert.deepEqual(queue.silenced, ['notifications.mob'])
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
