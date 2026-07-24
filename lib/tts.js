'use strict'

const { spawn } = require('child_process')

function resolveVoice ({ language = 'en', voice }) {
  return voice || language
}

/**
 * Speaks `text` via espeak-ng, direct to the local speaker. Resolves with
 * { spoken: true } on success, or { spoken: false, reason } if espeak-ng
 * is missing or fails - callers should fall back to browser-side playback
 * and log a warning rather than failing silently (see docs/design.md,
 * "graceful degradation").
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
function speak (text, opts = {}) {
  const { spawnFn = spawn } = opts
  const espeakVoice = resolveVoice(opts)
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

/**
 * Synthesizes `text` via espeak-ng directly to a WAV file, rather than
 * playing it through the local speaker - used to serve the exact same
 * rendered audio to the browser (see docs/design.md, "Voice selection":
 * one engine, one voice, for both server and browser playback, the same
 * way /tone-clip already does for tones). Not cached: unlike tone
 * patterns, message text is usually dynamic (interpolated values change
 * per occurrence), so there's no fixed set of clips to cache - synthesis
 * happens fresh per request, same cost as speaking it locally already
 * did.
 *
 * @param {string} text
 * @param {string} outputPath - where to write the WAV file
 * @param {object} [opts]
 * @param {string} [opts.language]
 * @param {string} [opts.voice]
 * @param {(cmd: string, args: string[]) => import('child_process').ChildProcess} [opts.spawnFn]
 */
function synthesizeToFile (text, outputPath, opts = {}) {
  const { spawnFn = spawn } = opts
  const espeakVoice = resolveVoice(opts)
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn('espeak-ng', ['-v', espeakVoice, '-w', outputPath, text])
    } catch (err) {
      resolve({ synthesized: false, reason: `espeak-ng not available: ${err.message}` })
      return
    }

    child.on('error', (err) => {
      resolve({ synthesized: false, reason: `espeak-ng failed to start: ${err.message}` })
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ synthesized: true })
      } else {
        resolve({ synthesized: false, reason: `espeak-ng exited with code ${code}` })
      }
    })
  })
}

module.exports = { speak, synthesizeToFile }
