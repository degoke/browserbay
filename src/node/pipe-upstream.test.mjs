import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createPipeUpstream } from './pipe-upstream.mjs'

function setup() {
  const input = new PassThrough()
  const output = new PassThrough()
  const messages = []
  let closes = 0
  const upstream = createPipeUpstream({
    input,
    output,
    onMessage: (text) => messages.push(text),
    onClose: () => closes++
  })
  const written = []
  output.on('data', (chunk) => written.push(chunk.toString('utf8')))
  return { input, output, upstream, messages, written, closes: () => closes }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('messages are split on NUL, however the bytes arrive', async () => {
  const { input, messages } = setup()
  input.write(Buffer.from('{"id":1}\0{"id":2}\0{"id'))
  input.write(Buffer.from('":3}'))
  input.write(Buffer.from('\0'))
  await tick()
  assert.deepEqual(messages, ['{"id":1}', '{"id":2}', '{"id":3}'])
})

test('a character split across two chunks is decoded whole', async () => {
  const { input, messages } = setup()
  const bytes = Buffer.from('{"title":"café — 日本語"}\0')
  const split = bytes.indexOf(0xc3) + 1 // between the two bytes of "é"
  input.write(bytes.subarray(0, split))
  input.write(bytes.subarray(split))
  await tick()
  assert.deepEqual(messages, ['{"title":"café — 日本語"}'])
})

test('empty segments are ignored, and an unfinished message waits for its NUL', async () => {
  const { input, messages } = setup()
  input.write(Buffer.from('\0\0{"a":1}\0\0'))
  input.write(Buffer.from('{"b":'))
  await tick()
  assert.deepEqual(messages, ['{"a":1}'])
  input.write(Buffer.from('2}\0'))
  await tick()
  assert.deepEqual(messages, ['{"a":1}', '{"b":2}'])
})

test('a message of tens of megabytes arrives intact', async () => {
  const { input, messages } = setup()
  const big = JSON.stringify({ id: 7, result: { value: 'é'.repeat(20_000_000) } })
  const bytes = Buffer.from(`${big}\0`)
  for (let offset = 0; offset < bytes.length; offset += 65_536) input.write(bytes.subarray(offset, offset + 65_536))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(messages.length, 1)
  assert.equal(messages[0], big)
})

test('send writes the message and a NUL, and nothing once the browser is gone', async () => {
  const { input, upstream, written, closes } = setup()
  upstream.send('{"id":1,"method":"Browser.getVersion"}')
  upstream.send('{"id":2}')
  await tick()
  assert.equal(written.join(''), '{"id":1,"method":"Browser.getVersion"}\0{"id":2}\0')

  input.end()
  await tick()
  assert.equal(closes(), 1)
  upstream.send('{"id":3}')
  await tick()
  assert.ok(!written.join('').includes('"id":3'))
})

test('the browser going away is reported once, however it ends', async () => {
  const { input, closes } = setup()
  input.end()
  input.destroy()
  await tick()
  assert.equal(closes(), 1)

  const failing = setup()
  failing.input.destroy(new Error('read failed'))
  await tick()
  assert.equal(failing.closes(), 1)
})
