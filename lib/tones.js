'use strict'

const path = require('path')
const { spawn } = require('child_process')
const { PRIORITY } = require('./priority')

// IMO A.1021(26) Table 7.2 audible codes. Clips are pre-recorded static
// assets (offline-synthesized once, see docs/design.md) rather than
// generated at runtime.
const TONE_CODE = Object.freeze({
  GENERAL_EMERGENCY: '1a', // 7 short + 1 prolonged blast, repeated
  SHIP_SPECIFIC: '1b', // per muster-list config, no fixed clip
  CONTINUOUS: '2', // continuous tone until ack/silence
  SQUARE_PULSE: '3a',
  SAWTOOTH: '3b',
  CLUSTERED_PULSES: '3c',
  SINE_FM: '3d'
})

const DEFAULT_TONE_FOR_PRIORITY = Object.freeze({
  [PRIORITY.CAUTION]: TONE_CODE.SQUARE_PULSE,
  [PRIORITY.WARNING]: TONE_CODE.CLUSTERED_PULSES,
  [PRIORITY.ALARM]: TONE_CODE.CONTINUOUS,
  [PRIORITY.EMERGENCY_ALARM]: TONE_CODE.GENERAL_EMERGENCY
})

const SOUNDS_DIR = path.join(__dirname, '..', 'sounds', 'tones')

/**
 * Resolve which tone code to use for an alert.
 * @param {number} priority
 * @param {string} path - notification path, to check muster-list overrides
 * @param {Array<{path: string, toneCode: string}>} [musterListCodes]
 */
function resolveToneCode (priority, notificationPath, musterListCodes = []) {
  const musterOverride = musterListCodes.find((m) => m.path === notificationPath)
  if (musterOverride) return TONE_CODE.SHIP_SPECIFIC
  return DEFAULT_TONE_FOR_PRIORITY[priority] || null
}

function clipPathFor (toneCode) {
  return path.join(SOUNDS_DIR, `${toneCode}.wav`)
}

/**
 * Plays the clip for a tone code. Returns a controller with `.promise`
 * (resolves when playback finishes) and `.stop()` (for preemption).
 * @param {string} toneCode
 * @param {(cmd: string, args: string[]) => import('child_process').ChildProcess} [spawnFn]
 */
function play (toneCode, spawnFn = spawn) {
  const clip = clipPathFor(toneCode)
  let child
  let resolved = false
  const promise = new Promise((resolve) => {
    try {
      child = spawnFn('aplay', [clip])
    } catch (err) {
      resolve({ played: false, reason: `player not available: ${err.message}` })
      return
    }
    child.on('error', (err) => {
      if (resolved) return
      resolved = true
      resolve({ played: false, reason: `player failed: ${err.message}` })
    })
    child.on('exit', (code) => {
      if (resolved) return
      resolved = true
      resolve({ played: code === 0, reason: code === 0 ? null : `player exited with code ${code}` })
    })
  })

  return {
    promise,
    stop () {
      if (child && !child.killed) child.kill()
    }
  }
}

module.exports = { TONE_CODE, resolveToneCode, clipPathFor, play }
