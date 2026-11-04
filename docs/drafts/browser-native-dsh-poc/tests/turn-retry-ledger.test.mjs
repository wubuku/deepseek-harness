import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TurnRetryLedger } from '../turn-retry-ledger.mjs'

const INTENT = { sessionId: 'sess-retry-a', turn: 3, prompt: 'retry the failed turn' }

test('concurrent duplicate retry requests create exactly one intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-turn-retry-'))
  try {
    const ledger = new TurnRetryLedger({ dir, now: () => 1_700_000_000_000 })
    await ledger.load()
    const results = await Promise.all([
      ledger.request(INTENT),
      ledger.request(INTENT),
      ledger.request({ ...INTENT }),
    ])
    assert.equal(results.filter(result => result.created).length, 1)
    assert.equal(new Set(results.map(result => result.record.retryId)).size, 1)
    assert.equal((await ledger.list({ sessionId: INTENT.sessionId })).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settlement is idempotent and keeps the first timestamp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-turn-retry-'))
  try {
    let now = 1_700_000_000_000
    const ledger = new TurnRetryLedger({ dir, now: () => now })
    await ledger.load()
    const { record } = await ledger.request(INTENT)
    const first = await ledger.settle({ retryId: record.retryId })
    assert.equal(first.settled, true)
    assert.equal(first.record.settledAt, 1_700_000_000_000)
    now += 5_000
    const second = await ledger.settle({ retryId: record.retryId })
    assert.equal(second.settled, false)
    assert.equal(second.record.settledAt, 1_700_000_000_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a new prompt for the same failed turn is a distinct intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-turn-retry-'))
  try {
    const ledger = new TurnRetryLedger({ dir })
    await ledger.load()
    const first = await ledger.request(INTENT)
    const second = await ledger.request({ ...INTENT, prompt: 'a different retry prompt' })
    assert.equal(first.created, true)
    assert.equal(second.created, true)
    assert.notEqual(first.record.retryId, second.record.retryId)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('intents survive a reload from the same directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-turn-retry-'))
  try {
    const first = new TurnRetryLedger({ dir })
    await first.load()
    const created = await first.request(INTENT)
    const reopened = new TurnRetryLedger({ dir })
    await reopened.load()
    const duplicate = await reopened.request(INTENT)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.record.retryId, created.record.retryId)
    assert.equal(duplicate.record.requestedAt, created.record.requestedAt)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unknown settlement and malformed inputs fail loud', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-turn-retry-'))
  try {
    const ledger = new TurnRetryLedger({ dir })
    await ledger.load()
    await assert.rejects(ledger.settle({ retryId: 'missing' }), /is unknown/)
    await assert.rejects(ledger.request({ ...INTENT, sessionId: '' }), /sessionId must be a non-empty string/)
    await assert.rejects(ledger.request({ ...INTENT, turn: 0 }), /turn must be a positive integer/)
    await assert.rejects(ledger.request({ ...INTENT, prompt: '' }), /prompt must be a non-empty string/)
    await assert.rejects(ledger.request({ ...INTENT, prompt: 'x'.repeat(16_385) }), /at most 16384 characters/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
