'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveMessage } = require('../lib/templates')
const { PRIORITY } = require('../lib/priority')

test('generic fallback uses the alert message', () => {
  const text = resolveMessage({
    path: 'tanks.fuel.0',
    priority: PRIORITY.WARNING,
    alert: { state: 'unacknowledged', message: 'Fuel tank low' }
  })
  assert.equal(text, 'Warning. Fuel tank low.')
})

test('override template is used and interpolated against alert fields', () => {
  const text = resolveMessage({
    path: 'mob',
    priority: PRIORITY.EMERGENCY_ALARM,
    alert: { state: 'unacknowledged', message: 'ignored', group: 'safety' },
    overrides: [{ pathPattern: 'mob', template: 'Man overboard ({group})' }]
  })
  assert.equal(text, 'Emergency alarm. Man overboard (safety).')
})

test('pronunciation substitution is applied after templating', () => {
  const text = resolveMessage({
    path: 'navigation.speedOverGround',
    priority: PRIORITY.CAUTION,
    alert: { state: 'unacknowledged', message: 'SOG sensor fault' },
    pronunciation: [{ pattern: 'SOG', replacement: 'speed over ground' }]
  })
  assert.equal(text, 'Caution. speed over ground sensor fault.')
})

test('rtn-unacknowledged repeats the original message when not configured for distinct phrasing', () => {
  const text = resolveMessage({
    path: 'tanks.fuel.0',
    priority: PRIORITY.WARNING,
    alert: { state: 'rtn-unacknowledged', message: 'Fuel tank low' },
    rtnPhrasing: { useDistinctPhrase: false }
  })
  assert.equal(text, 'Warning. Fuel tank low.')
})

test('rtn-unacknowledged speaks a distinct default phrase when configured for it', () => {
  const text = resolveMessage({
    path: 'tanks.fuel.0',
    priority: PRIORITY.WARNING,
    alert: { state: 'rtn-unacknowledged', message: 'Fuel tank low' },
    rtnPhrasing: { useDistinctPhrase: true }
  })
  assert.equal(text, 'Warning. Condition cleared, please acknowledge.')
})

test('rtn-unacknowledged uses a custom configured phrase when given', () => {
  const text = resolveMessage({
    path: 'tanks.fuel.0',
    priority: PRIORITY.WARNING,
    alert: { state: 'rtn-unacknowledged', message: 'Fuel tank low' },
    rtnPhrasing: { useDistinctPhrase: true, phrase: 'Fuel tank alarm cleared' }
  })
  assert.equal(text, 'Warning. Fuel tank alarm cleared.')
})

test('an override still takes precedence for a non-rtn state', () => {
  const text = resolveMessage({
    path: 'tanks.fuel.0',
    priority: PRIORITY.WARNING,
    alert: { state: 'unacknowledged', message: 'Fuel tank low' },
    overrides: [{ pathPattern: 'tanks.fuel.0', template: 'Custom: {message}' }]
  })
  assert.equal(text, 'Warning. Custom: Fuel tank low.')
})
