'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { PRIORITY } = require('./priority')
const { parsePattern, synthesizeWav } = require('./tonePattern')

// IMO A.1021(26) Table 7.2 audible codes. The built-in codes (1.a/2/3.a-3.d)
// are pre-recorded static assets (offline-synthesized once, see
// docs/design.md). 1.b (ship-specific muster-list codes) has no fixed
// clip - it's entered as a text pattern in plugin config (see
// lib/tonePattern.js) and synthesized once per distinct pattern, then
// cached on disk for reuse - not regenerated per alert occurrence.
const TONE_CODE = Object.freeze({
  GENERAL_EMERGENCY: '1a', // 7 short + 1 prolonged blast, repeated
  SHIP_SPECIFIC: '1b', // per muster-list config, text pattern -> cached clip
  CONTINUOUS: '2', // continuous tone until ack/silence
  SQUARE_PULSE: '3a',
  SAWTOOTH: '3b',
  CLUSTERED_PULSES: '3c',
  SINE_FM: '3d'
})

// Default tone per MSC.302(87) priority. NOTE: A.1021(26) Tables 7.1.1-7.1.3
// only assign audible codes to the Alarm and Emergency Alarm tiers, and even
// then per specific alarm function (fire-related vs. machinery/steering/etc.),
// not per priority alone - see docs/design.md, "Alert tone patterns" for the
// full breakdown. Warning and Caution have NO Table 7.2 basis whatsoever; the
// defaults below for those two are entirely this plugin's own synthesis, not
// derived from the standard.
const DEFAULT_TONE_FOR_PRIORITY = Object.freeze({
  [PRIORITY.CAUTION]: TONE_CODE.CLUSTERED_PULSES,
  [PRIORITY.WARNING]: TONE_CODE.SQUARE_PULSE,
  [PRIORITY.ALARM]: TONE_CODE.CONTINUOUS,
  [PRIORITY.EMERGENCY_ALARM]: TONE_CODE.GENERAL_EMERGENCY
})

const SOUNDS_DIR = path.join(__dirname, '..', 'sounds', 'tones')
const MUSTER_CACHE_DIR = path.join(os.tmpdir(), 'signalk-imo-alerts-muster')

/**
 * Resolve which tone code to use for an alert.
 * @param {number} priority
 * @param {string} notificationPath - notification path, to check muster-list overrides
 * @param {Array<{path: string, pattern: string}>} [musterListCodes]
 */
function resolveToneCode (priority, notificationPath, musterListCodes = []) {
  const musterOverride = musterListCodes.find((m) => m.path === notificationPath)
  if (musterOverride) return TONE_CODE.SHIP_SPECIFIC
  return DEFAULT_TONE_FOR_PRIORITY[priority] || null
}

/**
 * Resolve the actual clip file to play for an alert: either a built-in
 * static clip, or a muster-list text pattern synthesized once and cached.
 * @param {number} priority
 * @param {string} notificationPath
 * @param {Array<{path: string, zone?: string, pattern: string}>} [musterListCodes]
 * @returns {string|null} absolute path to a .wav file, or null if none applies
 */
function resolveClipPath (priority, notificationPath, musterListCodes = []) {
  const musterOverride = musterListCodes.find((m) => m.path === notificationPath)
  if (musterOverride) {
    return resolveMusterClipPath(musterOverride.pattern)
  }
  const toneCode = DEFAULT_TONE_FOR_PRIORITY[priority]
  return toneCode ? clipPathFor(toneCode) : null
}

/**
 * Synthesizes (or reuses a cached synthesis of) a muster-list text
 * pattern, e.g. "500:1000 0:250 2000:1000". Cached by content hash so a
 * given pattern is only synthesized once, not per alert occurrence.
 * @param {string} pattern
 * @returns {string} absolute path to the cached .wav file
 */
function resolveMusterClipPath (pattern) {
  const hash = crypto.createHash('sha1').update(pattern).digest('hex').slice(0, 16)
  const cachedPath = path.join(MUSTER_CACHE_DIR, `${hash}.wav`)
  if (!fs.existsSync(cachedPath)) {
    fs.mkdirSync(MUSTER_CACHE_DIR, { recursive: true })
    const segments = parsePattern(pattern)
    const wav = synthesizeWav(segments)
    fs.writeFileSync(cachedPath, wav)
  }
  return cachedPath
}

function clipPathFor (toneCode) {
  return path.join(SOUNDS_DIR, `${toneCode}.wav`)
}

/**
 * Plays a clip file. Returns a controller with `.promise` (resolves when
 * playback finishes) and `.stop()` (for preemption).
 * @param {string} clipPath - absolute path to a .wav file
 * @param {(cmd: string, args: string[]) => import('child_process').ChildProcess} [spawnFn]
 */
function play (clipPath, spawnFn = spawn) {
  let child
  let resolved = false
  const promise = new Promise((resolve) => {
    try {
      child = spawnFn('aplay', [clipPath])
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

module.exports = { TONE_CODE, resolveToneCode, resolveClipPath, resolveMusterClipPath, clipPathFor, play }
