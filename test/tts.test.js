'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { speak, synthesizeToFile } = require('../lib/tts')

function makeFakeChild () {
  const child = new EventEmitter()
  return child
}

test('uses language as the espeak-ng voice when no explicit voice given', async () => {
  let capturedArgs
  const spawnFn = (cmd, args) => {
    capturedArgs = args
    const child = makeFakeChild()
    setImmediate(() => child.emit('exit', 0))
    return child
  }
  const result = await speak('hello', { language: 'de', spawnFn })
  assert.equal(result.spoken, true)
  assert.deepEqual(capturedArgs, ['-v', 'de', 'hello'])
})

test('an explicit voice takes precedence over language', async () => {
  let capturedArgs
  const spawnFn = (cmd, args) => {
    capturedArgs = args
    const child = makeFakeChild()
    setImmediate(() => child.emit('exit', 0))
    return child
  }
  const result = await speak('hello', { language: 'en', voice: 'en-us', spawnFn })
  assert.equal(result.spoken, true)
  assert.deepEqual(capturedArgs, ['-v', 'en-us', 'hello'])
})

test('resolves gracefully (not throws) when espeak-ng is missing', async () => {
  const spawnFn = () => {
    throw new Error('ENOENT')
  }
  const result = await speak('hello', { spawnFn })
  assert.equal(result.spoken, false)
  assert.match(result.reason, /not available/)
})

test('resolves gracefully when espeak-ng exits non-zero', async () => {
  const spawnFn = () => {
    const child = makeFakeChild()
    setImmediate(() => child.emit('exit', 1))
    return child
  }
  const result = await speak('hello', { spawnFn })
  assert.equal(result.spoken, false)
  assert.match(result.reason, /exited with code 1/)
})

test('synthesizeToFile passes -w <outputPath> and resolves the same voice precedence as speak', async () => {
  let capturedArgs
  const spawnFn = (cmd, args) => {
    capturedArgs = args
    const child = makeFakeChild()
    setImmediate(() => child.emit('exit', 0))
    return child
  }
  const result = await synthesizeToFile('hello', '/tmp/out.wav', { voice: 'en-us', spawnFn })
  assert.equal(result.synthesized, true)
  assert.deepEqual(capturedArgs, ['-v', 'en-us', '-w', '/tmp/out.wav', 'hello'])
})

test('synthesizeToFile resolves gracefully when espeak-ng is missing', async () => {
  const spawnFn = () => {
    throw new Error('ENOENT')
  }
  const result = await synthesizeToFile('hello', '/tmp/out.wav', { spawnFn })
  assert.equal(result.synthesized, false)
  assert.match(result.reason, /not available/)
})
