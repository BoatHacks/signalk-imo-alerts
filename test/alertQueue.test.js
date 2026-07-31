'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AlertQueue, STATE } = require('../lib/alertQueue')
const { PRIORITY } = require('../lib/priority')

function makeQueue ({ policyByPriority = {}, now } = {}) {
  const announced = []
  const interrupted = []
  let resolveCurrent = null

  const defaultPolicy = { mode: 'interval', intervalSeconds: 30 }

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
    getRepeatPolicy: (priority) => policyByPriority[priority] || defaultPolicy,
    now
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

test('a null priority (unrecognized/missing) is never enqueued', () => {
  const { queue, announced } = makeQueue()
  queue.upsert('a', null, 'should not speak')
  assert.deepEqual(announced, [])
  assert.equal(queue.alerts.has('a'), false)
})

test('escalation (priority increase) while idle re-announces immediately, not waiting for tick', async () => {
  const { queue, announced, finishCurrent } = makeQueue()
  queue.upsert('a', PRIORITY.WARNING, 'warning msg')
  assert.deepEqual(announced, ['a'])
  finishCurrent() // settle - nothing else queued, now idle
  await Promise.resolve() // let the announce().then() microtask run

  queue.upsert('a', PRIORITY.ALARM, 'escalated msg')
  assert.deepEqual(announced, ['a', 'a'], 'escalation re-announced without waiting for the repeat interval')
  assert.equal(queue.alerts.get('a').priority, PRIORITY.ALARM)
})

test('escalation while a lower/no-priority alert is playing preempts immediately', () => {
  const { queue, announced, interrupted } = makeQueue()
  queue.upsert('low', PRIORITY.CAUTION, 'low msg')
  assert.deepEqual(announced, ['low'])

  queue.upsert('low', PRIORITY.ALARM, 'escalated low msg')
  assert.deepEqual(announced, ['low', 'low'], 'escalation preempted its own stale lower-priority playback')
  assert.equal(interrupted.length, 1)
})

test('escalation while a higher-priority alert is playing waits for it, but is picked up immediately after (not after a further repeat interval)', async () => {
  const { queue, announced, finishCurrent } = makeQueue()
  queue.upsert('urgent', PRIORITY.EMERGENCY_ALARM, 'urgent msg')
  queue.upsert('other', PRIORITY.WARNING, 'other msg')
  assert.deepEqual(announced, ['urgent'])

  queue.upsert('other', PRIORITY.ALARM, 'escalated other msg') // still < EMERGENCY_ALARM
  assert.deepEqual(announced, ['urgent'], 'no immediate interrupt - urgent is still higher priority')

  finishCurrent() // urgent's announcement completes
  await Promise.resolve() // let the announce().then() microtask run
  assert.deepEqual(
    announced,
    ['urgent', 'other'],
    'escalated entry picked up right after, not delayed by the repeat interval'
  )
})

// --- Per-priority repeat policy ------------------------------------------

test('"once" mode plays a single time and is never picked up again by tick, no matter how much time passes', () => {
  let now = 0
  const { queue, announced } = makeQueue({
    policyByPriority: { [PRIORITY.WARNING]: { mode: 'once' } },
    now: () => now
  })
  queue.upsert('a', PRIORITY.WARNING, 'warning msg')
  assert.deepEqual(announced, ['a'])

  now += 10 * 24 * 60 * 60 * 1000 // 10 days
  queue.tick()
  assert.deepEqual(announced, ['a'], 'still just the one announcement')
  assert.equal(queue.alerts.get('a').state, STATE.UNACKNOWLEDGED, 'still logically active/unacknowledged')
})

test('"interval" mode repeats at the configured interval while unacknowledged', async () => {
  let now = 0
  const { queue, announced, finishCurrent } = makeQueue({
    policyByPriority: { [PRIORITY.ALARM]: { mode: 'interval', intervalSeconds: 30 } },
    now: () => now
  })
  queue.upsert('a', PRIORITY.ALARM, 'alarm msg')
  assert.deepEqual(announced, ['a'])
  finishCurrent() // the first playback completes naturally, as it would in reality
  await Promise.resolve()

  now += 10 * 1000
  queue.tick()
  assert.deepEqual(announced, ['a'], 'not due yet')

  now += 25 * 1000 // total 35s > 30s interval
  queue.tick()
  assert.deepEqual(announced, ['a', 'a'])
})

test('"interval" mode: silencing stops it immediately and it never auto-resumes via tick, even after a long time', () => {
  let now = 0
  const { queue, announced, interrupted } = makeQueue({
    policyByPriority: { [PRIORITY.ALARM]: { mode: 'interval', intervalSeconds: 30 } },
    now: () => now
  })
  queue.upsert('a', PRIORITY.ALARM, 'alarm msg')
  queue.silence('a')
  assert.equal(interrupted.length, 1, 'stops immediately')
  assert.equal(queue.alerts.get('a').state, STATE.SILENCED)

  now += 10 * 24 * 60 * 60 * 1000 // 10 days - alert manager's own silence duration is irrelevant here,
  // this plugin must never run its own silence-expiry timer
  queue.tick()
  assert.equal(queue.alerts.get('a').state, STATE.SILENCED, 'still silenced - no local auto-resume')
  assert.deepEqual(announced, ['a'], 'no further announcements from tick alone')
})

test('"interval" mode: an explicit un-silence transition (upsert) resumes it immediately', () => {
  const { queue, announced, interrupted } = makeQueue({
    policyByPriority: { [PRIORITY.ALARM]: { mode: 'interval', intervalSeconds: 30 } }
  })
  queue.upsert('a', PRIORITY.ALARM, 'alarm msg')
  queue.silence('a')
  assert.equal(interrupted.length, 1)

  // represents a fresh alerts.* delta reporting silenced: false again
  queue.upsert('a', PRIORITY.ALARM, 'alarm msg')
  assert.deepEqual(announced, ['a', 'a'], 'resumed immediately, not after any wait')
  assert.equal(queue.alerts.get('a').state, STATE.UNACKNOWLEDGED)
})

test('"continuous" mode repeats back-to-back with no gap, driven by playback completion, not tick', async () => {
  const { queue, announced, finishCurrent } = makeQueue({
    policyByPriority: { [PRIORITY.EMERGENCY_ALARM]: { mode: 'continuous' } }
  })
  queue.upsert('a', PRIORITY.EMERGENCY_ALARM, 'mob msg')
  assert.deepEqual(announced, ['a'])

  finishCurrent()
  await Promise.resolve()
  assert.deepEqual(announced, ['a', 'a'], 'looped immediately on natural completion')

  finishCurrent()
  await Promise.resolve()
  assert.deepEqual(announced, ['a', 'a', 'a'], 'keeps looping')

  // tick() should never have been needed for any of this
  queue.tick()
  assert.deepEqual(announced, ['a', 'a', 'a'], 'tick() alone does not add another iteration mid-loop')
})

test('"continuous" mode: silencing stops the loop immediately and it never auto-resumes via tick', () => {
  const { queue, announced, interrupted } = makeQueue({
    policyByPriority: { [PRIORITY.EMERGENCY_ALARM]: { mode: 'continuous' } }
  })
  queue.upsert('a', PRIORITY.EMERGENCY_ALARM, 'mob msg')
  queue.silence('a')
  assert.equal(interrupted.length, 1, 'stops immediately, mid-loop')
  assert.equal(queue.alerts.get('a').state, STATE.SILENCED)

  queue.tick()
  assert.equal(queue.alerts.get('a').state, STATE.SILENCED)
  assert.deepEqual(announced, ['a'], 'no further iterations from tick alone')
})

test('"continuous" mode: an explicit un-silence transition (upsert) resumes the loop immediately', () => {
  const { queue, announced } = makeQueue({
    policyByPriority: { [PRIORITY.EMERGENCY_ALARM]: { mode: 'continuous' } }
  })
  queue.upsert('a', PRIORITY.EMERGENCY_ALARM, 'mob msg')
  queue.silence('a')

  queue.upsert('a', PRIORITY.EMERGENCY_ALARM, 'mob msg') // fresh un-silenced delta
  assert.deepEqual(announced, ['a', 'a'], 'loop resumed immediately')
  assert.equal(queue.alerts.get('a').state, STATE.UNACKNOWLEDGED)
})

test('"continuous" mode: a same-priority sibling gets a fair turn between loop iterations rather than being starved', async () => {
  const { queue, announced, finishCurrent } = makeQueue({
    policyByPriority: { [PRIORITY.EMERGENCY_ALARM]: { mode: 'continuous' } }
  })
  queue.upsert('first', PRIORITY.EMERGENCY_ALARM, 'first msg')
  queue.upsert('second', PRIORITY.EMERGENCY_ALARM, 'second msg')
  assert.deepEqual(announced, ['first'])

  finishCurrent() // first's iteration completes and loops - but second is waiting (never yet played)
  await Promise.resolve()
  assert.deepEqual(announced, ['first', 'second'], 'second gets its first turn before first loops again')

  finishCurrent() // second's first playback completes
  await Promise.resolve()
  assert.deepEqual(
    announced,
    ['first', 'second', 'first'],
    'first (now the only one with lastAnnounced reset from its own loop) gets picked up again'
  )
})
