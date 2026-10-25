import { describe, expect, it } from 'vitest'
import { BrowserNativeExecutionLifecycle } from '../browser-native-execution-lifecycle.ts'

describe('Browser-Native execution lifecycle', () => {
  it('does not treat a cancel request as a confirmed side-effect outcome', () => {
    const lifecycle = new BrowserNativeExecutionLifecycle('tool-1')
    expect(lifecycle.cancel()).toBe(true)
    expect(lifecycle.cancel()).toBe(false)
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'cancelling', cancelRequested: true })

    lifecycle.dispose('Worker was terminated')
    expect(lifecycle.snapshot()).toMatchObject({
      phase: 'disposed',
      outcome: { settlement: 'unknown', source: 'dispose' },
    })
    expect(lifecycle.settle({ settlement: 'confirmed', source: 'provider' })).toBe(false)
    lifecycle.recordLateResult()
    expect(lifecycle.snapshot()).toMatchObject({ lateResults: 1 })
  })

  it('accepts one provider settlement and makes repeated settlement idempotent', () => {
    const lifecycle = new BrowserNativeExecutionLifecycle('llm-1')
    expect(lifecycle.settle({ settlement: 'failed', source: 'provider', message: 'upstream failed' })).toBe(true)
    expect(lifecycle.settle({ settlement: 'confirmed', source: 'provider' })).toBe(false)
    expect(lifecycle.dispose()).toMatchObject({ settlement: 'failed', source: 'provider' })
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'settled', disposeCount: 1 })
  })

  it('turns owner fencing into unknown and does not revive a disposed execution', () => {
    const lifecycle = new BrowserNativeExecutionLifecycle('hitl-1')
    expect(lifecycle.markOwnerLost()).toMatchObject({ settlement: 'unknown', source: 'owner-lost' })
    expect(lifecycle.markOwnerLost()).toMatchObject({ settlement: 'unknown', source: 'owner-lost' })

    const disposed = new BrowserNativeExecutionLifecycle('hitl-2')
    disposed.dispose()
    expect(disposed.markOwnerLost()).toMatchObject({ settlement: 'unknown', source: 'dispose' })
  })
})
