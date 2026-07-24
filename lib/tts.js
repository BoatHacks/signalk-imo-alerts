'use strict'

const { spawn } = require('child_process')

/**
 * Speaks `text` via espeak-ng. Resolves with { spoken: true } on success,
 * or { spoken: false, reason } if espeak-ng is missing or fails - callers
 * should fall back to browser-side playback and log a warning rather than
 * failing silently (see docs/design.md, "graceful degradation").
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.language] - language tag, e.g. 'en'. Used as the
 *   espeak-ng voice if `voice` isn't given.
 * @param {string} [opts.voice] - explicit espeak-ng voice/variant, e.g.
 *   'en-us', 'en+f3', 'en-gb-x-rp'. Takes precedence over `language`;
 *   lets the user pick a specific voice model rather than just a
 *   language, see docs/design.md, "Voice selection".
 * @param {(cmd: string, args: string[]) => import('child_process').ChildProcess} [opts.spawnFn]
 *   injectable for tests
 */
function speak (text, { language = 'en', voice, spawnFn = spawn } = {}) {
  const espeakVoice = voice || language
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn('espeak-ng', ['-v', espeakVoice, text])
    } catch (err) {
      resolve({ spoken: false, reason: `espeak-ng not available: ${err.message}` })
      return
    }

    child.on('error', (err) => {
      resolve({ spoken: false, reason: `espeak-ng failed to start: ${err.message}` })
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ spoken: true })
      } else {
        resolve({ spoken: false, reason: `espeak-ng exited with code ${code}` })
      }
    })
  })
}

module.exports = { speak }
