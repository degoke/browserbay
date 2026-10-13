import assert from 'node:assert/strict'
import test from 'node:test'
import { createBacklogGuard } from './backlog-guard.js'

test('a backlog is only too slow once it has stayed over the cap for the grace period', () => {
  let now = 1_000_000
  const tooSlow = createBacklogGuard({ maxBytes: 100, graceMs: 1000, now: () => now })

  assert.equal(tooSlow(50), false, 'under the cap')
  assert.equal(tooSlow(5_000), false, 'a single huge message is over the cap the moment it is queued, and that is fine')
  now += 999
  assert.equal(tooSlow(5_000), false, 'still within the grace period')
  now += 2
  assert.equal(tooSlow(5_000), true, 'the backlog has not drained for longer than the grace period')
})

test('draining below the cap starts the clock again', () => {
  let now = 1_000_000
  const tooSlow = createBacklogGuard({ maxBytes: 100, graceMs: 1000, now: () => now })
  assert.equal(tooSlow(500), false)
  now += 900
  assert.equal(tooSlow(10), false, 'drained')
  now += 900
  assert.equal(tooSlow(500), false, 'over again, but only just now')
  now += 900
  assert.equal(tooSlow(500), false)
  now += 200
  assert.equal(tooSlow(500), true)
})
