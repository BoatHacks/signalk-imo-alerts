'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveMessage } = require('../lib/templates')
const { PRIORITY } = require('../lib/priority')

test('generic fallback uses notification message when present', () => {
  const text = resolveMessage({
    path: 'notifications.tanks.fuel.0',
    priority: PRIORITY.WARNING,
    notification: { state: 'alarm', message: 'Fuel tank low' }
  })
  assert.equal(text, 'Warning. Fuel tank low.')
})

test('generic fallback humanizes the path when no message given', () => {
  const text = resolveMessage({
    path: 'notifications.tanks.fuel.0',
    priority: PRIORITY.CAUTION,
    notification: { state: 'warn' }
  })
  assert.equal(text, 'Caution. tanks fuel 0.')
})

test('override template is used and interpolated', () => {
  const text = resolveMessage({
    path: 'notifications.mob',
    priority: PRIORITY.EMERGENCY_ALARM,
    notification: { state: 'emergency' },
    overrides: [{ pathPattern: 'notifications.mob', template: 'Man overboard' }]
  })
  assert.equal(text, 'Emergency alarm. Man overboard.')
})

test('numeric interpolation with unit formula', () => {
  const text = resolveMessage({
    path: 'notifications.electrical.batteries.0.voltage',
    priority: PRIORITY.WARNING,
    notification: { state: 'alarm', message: 'Battery voltage' },
    rawValue: 11.234,
    displayUnits: { formula: 'value', symbol: 'volts', displayFormat: '%.1f' }
  })
  assert.equal(text, 'Warning. Battery voltage: 11.2 volts.')
})

test('pronunciation substitution is applied after templating', () => {
  const text = resolveMessage({
    path: 'notifications.navigation.speedOverGround',
    priority: PRIORITY.CAUTION,
    notification: { state: 'warn', message: 'SOG sensor fault' },
    pronunciation: [{ pattern: 'SOG', replacement: 'speed over ground' }]
  })
  assert.equal(text, 'Caution. speed over ground sensor fault.')
})
