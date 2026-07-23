'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { resolveToneCode, resolveClipPath, resolveMusterClipPath, TONE_CODE, clipPathFor } = require('../lib/tones')
const { PRIORITY } = require('../lib/priority')

test('resolveToneCode falls back to the priority default with no muster override', () => {
  assert.equal(resolveToneCode(PRIORITY.CAUTION, 'notifications.foo', []), TONE_CODE.SQUARE_PULSE)
  assert.equal(resolveToneCode(PRIORITY.EMERGENCY_ALARM, 'notifications.mob', []), TONE_CODE.GENERAL_EMERGENCY)
})

test('resolveToneCode returns SHIP_SPECIFIC when a muster override matches the path', () => {
  const code = resolveToneCode(PRIORITY.WARNING, 'notifications.fire.engineRoom', [
    { path: 'notifications.fire.engineRoom', pattern: '2000:500 0:200' }
  ])
  assert.equal(code, TONE_CODE.SHIP_SPECIFIC)
})

test('resolveClipPath returns the built-in static clip when no muster override applies', () => {
  const clip = resolveClipPath(PRIORITY.ALARM, 'notifications.foo', [])
  assert.equal(clip, clipPathFor(TONE_CODE.CONTINUOUS))
})

test('resolveMusterClipPath synthesizes once and caches on subsequent calls with the same pattern', () => {
  const pattern = '500:100 0:50 2000:100'
  const first = resolveMusterClipPath(pattern)
  assert.ok(fs.existsSync(first))
  const firstMtime = fs.statSync(first).mtimeMs

  const second = resolveMusterClipPath(pattern)
  assert.equal(second, first, 'same pattern resolves to the same cached path')
  assert.equal(fs.statSync(second).mtimeMs, firstMtime, 'not regenerated on second call')
})

test('resolveClipPath uses the muster pattern clip when a path override matches', () => {
  const pattern = '500:100 0:50 2000:100'
  const clip = resolveClipPath(PRIORITY.WARNING, 'notifications.fire.engineRoom', [
    { path: 'notifications.fire.engineRoom', pattern }
  ])
  assert.equal(clip, resolveMusterClipPath(pattern))
})
