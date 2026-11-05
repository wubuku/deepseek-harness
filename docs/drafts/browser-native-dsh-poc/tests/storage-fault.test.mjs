/**
 * Storage faults are typed, retryable, and leave audit chains verifiable.
 *
 * Each injected disk failure must name its surface and map to an HTTP status an
 * operator can act on. A failed audit append must not tear the ledger: the next
 * append continues from the previous tail, and restore still verifies.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createObservabilityJournal } from '../observability-journal.mjs'
import { applyStorageFault, StorageFaultError, storageFailure } from '../storage-fault.mjs'

const directories = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-storage-fault-'))
  directories.push(directory)
  return directory
}

after(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

describe('storage fault mapping', () => {
  test('no configured fault lets the write proceed', async () => {
    await applyStorageFault(undefined, 'session')
    await applyStorageFault(async () => undefined, 'session')
    await applyStorageFault(async () => false, 'session')
  })

  test('each disk code maps to an actionable status and retry advice', async () => {
    const cases = [
      ['ENOSPC', 'STORAGE_DISK_FULL', 507, undefined],
      ['EROFS', 'STORAGE_READ_ONLY', 503, undefined],
      ['ETIMEDOUT', 'STORAGE_TIMEOUT', 503, 5_000],
      ['EBUSY', 'STORAGE_TIMEOUT', 503, 5_000],
    ]
    for (const [systemCode, code, status, retryAfterMs] of cases) {
      await assert.rejects(
        applyStorageFault(async () => systemCode, 'rotation'),
        error => {
          assert.equal(error instanceof StorageFaultError, true)
          assert.equal(error.systemCode, systemCode)
          assert.equal(error.surface, 'rotation')
          assert.equal(error.status, status)
          assert.equal(error.retryAfterMs, retryAfterMs)
          const described = storageFailure(error)
          assert.equal(described.code, code)
          assert.equal(described.status, status)
          assert.equal(described.details.surface, 'rotation')
          return true
        },
      )
    }
  })

  test('a slow volume delays the reported timeout', async () => {
    const startedAt = Date.now()
    await assert.rejects(
      applyStorageFault(async () => ({ code: 'ETIMEDOUT', delayMs: 40 }), 'workspace-blob'),
      error => error.code === 'STORAGE_TIMEOUT',
    )
    assert.ok(Date.now() - startedAt >= 30)
  })

  test('real filesystem failures map while network timeouts do not', () => {
    assert.equal(storageFailure({ code: 'ENOSPC', syscall: 'write' }).code, 'STORAGE_DISK_FULL')
    assert.equal(storageFailure({ code: 'EROFS', syscall: 'open' }).code, 'STORAGE_READ_ONLY')
    assert.equal(storageFailure({ code: 'ETIMEDOUT', syscall: 'write' }).code, 'STORAGE_TIMEOUT')
    assert.equal(storageFailure({ code: 'ETIMEDOUT', syscall: 'connect' }), undefined)
    assert.equal(storageFailure({ code: 'CUSTOM' }), undefined)
    assert.equal(storageFailure(undefined), undefined)
  })
})

describe('audit journal under disk faults', () => {
  test('a rejected append leaves no torn line and the next append verifies', async () => {
    const dataDir = await temporaryDirectory()
    let fail = true
    const journal = createObservabilityJournal({
      dataDir,
      now: () => 1_700_000_000_000,
      storageFault: async surface => {
        assert.equal(surface, 'audit')
        if (!fail) return undefined
        fail = false
        return 'ENOSPC'
      },
    })

    await journal.appendAccessDenial({ at: 1, code: 'DENIED_ONE', status: 403 })
    assert.deepEqual(journal.status().healthy, false)
    assert.equal(journal.status().writeFailures, 1)
    const afterFailure = await readFile(join(dataDir, 'observability', 'access-denials.jsonl')).catch(() => undefined)
    assert.equal(afterFailure, undefined, 'a rejected append must not create a ledger line')

    await journal.appendAccessDenial({ at: 2, code: 'DENIED_TWO', status: 403 })
    await journal.close()
    assert.deepEqual(journal.status().healthy, true)

    const restored = await journal.restore()
    assert.equal(restored.integrity.accessDenials.verified, true)
    assert.equal(restored.accessDenials.length, 1)
    assert.equal(restored.accessDenials[0].code, 'DENIED_TWO')
    assert.equal(restored.integrity.accessDenials.entries, 1)
  })

  test('a metrics snapshot failure does not break the next append', async () => {
    const dataDir = await temporaryDirectory()
    let fail = true
    const journal = createObservabilityJournal({
      dataDir,
      storageFault: async surface => {
        if (!fail) return undefined
        fail = false
        return { code: 'EROFS' }
      },
    })
    await journal.persistMetrics({ activeRequests: 0 })
    assert.equal(journal.status().writeFailures, 1)
    await journal.appendUsage({ at: 1, totalTokens: 2 })
    await journal.persistMetrics({ activeRequests: 1 })
    await journal.close()
    assert.equal(journal.status().healthy, true)
    const restored = await journal.restore()
    assert.equal(restored.metrics?.view.activeRequests, 1)
    assert.equal(restored.integrity.usage.verified, true)
  })
})
