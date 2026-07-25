'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolvePriority, shouldVoice, priorityName, PRIORITY } = require('../lib/priority')

test('caution/warning/alarm/emergency map directly to PRIORITY tiers', () => {
  assert.equal(resolvePriority('caution'), PRIORITY.CAUTION)
  assert.equal(resolvePriority('warning'), PRIORITY.WARNING)
  assert.equal(resolvePriority('alarm'), PRIORITY.ALARM)
  assert.equal(resolvePriority('emergency'), PRIORITY.EMERGENCY_ALARM)
})

test('an unrecognized or missing priority resolves to null and is never voiced', () => {
  assert.equal(resolvePriority('nonsense'), null)
  assert.equal(resolvePriority(undefined), null)
  assert.equal(shouldVoice(resolvePriority('nonsense')), false)
})

test('every real priority is voiced', () => {
  assert.equal(shouldVoice(resolvePriority('caution')), true)
  assert.equal(shouldVoice(resolvePriority('emergency')), true)
})

test('priorityName returns MSC.302(87) terms', () => {
  assert.equal(priorityName(PRIORITY.CAUTION), 'Caution')
  assert.equal(priorityName(PRIORITY.EMERGENCY_ALARM), 'Emergency alarm')
  assert.equal(priorityName(null), null)
})
