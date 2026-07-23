'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolvePriority, shouldVoice, priorityName, PRIORITY } = require('../lib/priority')

test('alert state is never voiced', () => {
  const p = resolvePriority('notifications.foo', 'alert', [])
  assert.equal(shouldVoice(p), false)
})

test('warn/alarm/emergency map to caution/warning/alarm', () => {
  assert.equal(resolvePriority('notifications.foo', 'warn', []), PRIORITY.CAUTION)
  assert.equal(resolvePriority('notifications.foo', 'alarm', []), PRIORITY.WARNING)
  assert.equal(resolvePriority('notifications.foo', 'emergency', []), PRIORITY.ALARM)
})

test('pinned paths are always Emergency Alarm regardless of state', () => {
  const p = resolvePriority('notifications.mob', 'warn', ['notifications.mob'])
  assert.equal(p, PRIORITY.EMERGENCY_ALARM)
})

test('pinned path glob matching', () => {
  const p = resolvePriority('notifications.tanks.fuel.0', 'alarm', ['notifications.tanks.*'])
  assert.equal(p, PRIORITY.EMERGENCY_ALARM)
})

test('priorityName returns MSC.302(87) terms', () => {
  assert.equal(priorityName(PRIORITY.CAUTION), 'Caution')
  assert.equal(priorityName(PRIORITY.EMERGENCY_ALARM), 'Emergency alarm')
  assert.equal(priorityName(PRIORITY.NONE), null)
})
