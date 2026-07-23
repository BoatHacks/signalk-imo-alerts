'use strict'

// Text-based format for 1.b ship-specific muster-list tone patterns, e.g.:
//   "500:1000 0:250 2000:1000"
// Each token is <frequency in Hz>:<duration in ms>. A frequency of 0 means
// silence for that duration. This lets a muster-list code be entered
// directly in plugin config as plain text, rather than requiring an
// uploaded audio file (see docs/design.md, "1.b ship-specific codes").

const SAMPLE_RATE = 44100

/**
 * @param {string} text
 * @returns {Array<{freqHz: number, durationMs: number}>}
 * @throws {Error} if any token is malformed
 */
function parsePattern (text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    throw new Error('empty tone pattern')
  }
  return tokens.map((token) => {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(token)
    if (!match) {
      throw new Error(`invalid tone pattern token "${token}", expected <freqHz>:<durationMs>`)
    }
    const freqHz = Number(match[1])
    const durationMs = Number(match[2])
    if (durationMs <= 0) {
      throw new Error(`invalid duration in token "${token}"`)
    }
    return { freqHz, durationMs }
  })
}

/**
 * Synthesizes a mono 16-bit PCM WAV buffer from a parsed pattern.
 * @param {Array<{freqHz: number, durationMs: number}>} segments
 * @param {object} [opts]
 * @param {number} [opts.amplitude]
 * @param {number} [opts.fadeMs] - fade in/out per segment, to avoid clicks
 */
function synthesizeWav (segments, { amplitude = 0.6, fadeMs = 5 } = {}) {
  const samples = []
  for (const { freqHz, durationMs } of segments) {
    const n = Math.round((SAMPLE_RATE * durationMs) / 1000)
    const fadeN = Math.min(Math.round((SAMPLE_RATE * fadeMs) / 1000), Math.floor(n / 2))
    for (let i = 0; i < n; i++) {
      let s = freqHz > 0 ? amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) : 0
      if (fadeN > 0) {
        if (i < fadeN) s *= i / fadeN
        else if (i > n - fadeN) s *= (n - i) / fadeN
      }
      samples.push(s)
    }
  }
  return encodeWav(samples)
}

function encodeWav (samples) {
  const numSamples = samples.length
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const byteRate = SAMPLE_RATE * blockAlign
  const dataSize = numSamples * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample)
  }
  return buffer
}

module.exports = { parsePattern, synthesizeWav, SAMPLE_RATE }
