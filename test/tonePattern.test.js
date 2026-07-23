'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parsePattern, synthesizeWav, SAMPLE_RATE } = require('../lib/tonePattern')

test('parses a simple pattern into freq/duration segments', () => {
  const segments = parsePattern('500:1000 0:250 2000:1000')
  assert.deepEqual(segments, [
    { freqHz: 500, durationMs: 1000 },
    { freqHz: 0, durationMs: 250 },
    { freqHz: 2000, durationMs: 1000 }
  ])
})

test('rejects malformed tokens', () => {
  assert.throws(() => parsePattern('500-1000'), /invalid tone pattern token/)
  assert.throws(() => parsePattern('abc:1000'), /invalid tone pattern token/)
  assert.throws(() => parsePattern(''), /empty tone pattern/)
})

test('rejects zero/negative durations', () => {
  assert.throws(() => parsePattern('500:0'), /invalid duration/)
})

test('synthesizeWav produces a valid RIFF/WAVE header and correct data length', () => {
  const segments = parsePattern('500:1000 0:250')
  const wav = synthesizeWav(segments)

  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt16LE(22), 1, 'mono channel count')
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE)

  const expectedSamples = Math.round((SAMPLE_RATE * 1000) / 1000) + Math.round((SAMPLE_RATE * 250) / 1000)
  const dataSize = wav.readUInt32LE(40)
  assert.equal(dataSize, expectedSamples * 2)
  assert.equal(wav.length, 44 + expectedSamples * 2)
})
