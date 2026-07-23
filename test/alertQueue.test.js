'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AlertQueue, STATE } = require('../lib/alertQueue')
const { PRIORITY } = require('../lib/priority')

function makeQueue (overrides = {}) {
  const announced = []
  const interrupted = []
  let resolveCurrent = null

  const queue = new AlertQueue({
    announce: (entry) => {
      announced.push(entry.path)
      return new Promise((resolve) => {
        resolveCurrent = resolve
      })
    },
    interrupt: () => {
      interrupted.push(true)
      if (resolveCurrent) {
        const r = resolveCurrent
        resolveCurrent = null
        r()
      }
    },
    repeatIntervalSeconds: 30,
    ...overrides
  })

  return { queue, announced, interrupted, finishCurrent: () => resolveCurrent && resolveCurrent() }
}

test('first alert plays immediately', () => {
  const { queue, announced } = makeQueue()
  queue.upsert('a', PRIORITY.CAUTION, 'msg a')
  assert.deepEqual(announced, ['a'])
})

test('higher priority preempts a currently-playing lower priority', () => {
  const { queue, announced, interrupted } = makeQueue()
  queue.upsert('low', PRIORITY.CAUTION, 'low msg')
  queue.upsert('high', PRIORITY.ALARM, 'high msg')
  assert.deepEqual(announced, ['low', 'high'])
  assert.equal(interrupted.length, 1)
})

test('same-priority alerts queue chronologically rather than interrupting', async () => {
  const { queue, announced, interrupted, finishCurrent } = makeQueue()
  queue.upsert('first', PRIORITY.WARNING, 'first msg')
  queue.upsert('second', PRIORITY.WARNING, 'second msg')
  assert.deepEqual(announced, ['first'])
  assert.equal(interrupted.length, 0)

  finishCurrent()
  await Promise.resolve() // let the announce().then() microtask run
  assert.deepEqual(announced, ['first', 'second'])
})

test('acknowledge stops repeats and interrupts if currently playing', () => {
  const { queue, interrupted } = makeQueue()
  queue.upsert('a', PRIORITY.ALARM, 'msg')
  queue.acknowledge('a')
  assert.equal(interrupted.length, 1)
  assert.equal(queue.alerts.get('a').state, STATE.ACKNOWLEDGED)
})

test('silence is temporary and resumes on next tick after the repeat interval', () => {
  let now = 0
  const { queue, announced } = makeQueue({ now: () => now })
  queue.upsert('a', PRIORITY.ALARM, 'msg')
  queue.silence('a')
  assert.equal(queue.alerts.get('a').state, STATE.SILENCED)

  now += 10 * 1000
  queue.tick()
  assert.equal(queue.alerts.get('a').state, STATE.SILENCED, 'not due yet')

  now += 25 * 1000 // total 35s > 30s repeat interval
  queue.tick()
  assert.equal(queue.alerts.get('a').state, STATE.UNACKNOWLEDGED)
  assert.deepEqual(announced, ['a', 'a'])
})

test('priority NONE (signalk alert state) is never enqueued', () => {
  const { queue, announced } = makeQueue()
  queue.upsert('a', PRIORITY.NONE, 'should not speak')
  assert.deepEqual(announced, [])
  assert.equal(queue.alerts.has('a'), false)
})
