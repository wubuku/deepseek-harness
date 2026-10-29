import { describe, expect, it } from 'vitest'
import {
  BrowserNativeSessionProjectionStore,
  type BrowserNativeSessionProjectionSource,
} from '../browser-native-session-projection.ts'

interface ProjectionValue {
  readonly status: 'idle' | 'running'
  readonly text: string
}

function source(initial: Record<string, unknown>): {
  readonly source: BrowserNativeSessionProjectionSource
  readonly set: (sessionId: string, value: unknown) => void
  readonly remove: (sessionId: string) => void
  readonly fail: (error: Error) => void
} {
  const values = new Map(Object.entries(initial))
  const listeners = new Set<(sessionId: string, value: unknown) => void>()
  let failure: Error | undefined
  return {
    source: {
      snapshot(sessionId) {
        if (failure !== undefined) throw failure
        return values.get(sessionId)
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(sessionId, value) {
      values.set(sessionId, value)
      for (const listener of [...listeners]) listener(sessionId, value)
    },
    remove(sessionId) {
      values.delete(sessionId)
      for (const listener of [...listeners]) listener(sessionId, undefined)
    },
    fail(error) { failure = error },
  }
}

function narrow(value: unknown): ProjectionValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if ((record.status !== 'idle' && record.status !== 'running') || typeof record.text !== 'string') return undefined
  return { status: record.status, text: record.text }
}

describe('Browser-Native Session projection store', () => {
  it('seeds the selected Session and filters a process-wide feed', () => {
    const values = source({
      alpha: { status: 'idle', text: 'alpha baseline' },
      beta: { status: 'running', text: 'beta baseline' },
    })
    const store = new BrowserNativeSessionProjectionStore({ narrow })
    let notifications = 0
    store.subscribe(() => { notifications += 1 })
    store.attach(values.source)
    store.bind('alpha')

    expect(store.read()).toEqual({ status: 'idle', text: 'alpha baseline' })
    expect(notifications).toBe(1)
    values.set('beta', { status: 'idle', text: 'beta update' })
    expect(store.read()).toEqual({ status: 'idle', text: 'alpha baseline' })
    expect(notifications).toBe(1)
    const alphaLive = { status: 'running' as const, text: 'alpha update' }
    values.set('alpha', alphaLive)
    expect(store.read()).toEqual({ status: 'running', text: 'alpha update' })
    expect(notifications).toBe(2)
    values.set('alpha', alphaLive)
    expect(notifications).toBe(2)
  })

  it('clears the old Session before seeding the next one and ignores late updates', () => {
    const values = source({
      alpha: { status: 'running', text: 'alpha' },
      beta: { status: 'idle', text: 'beta' },
    })
    const store = new BrowserNativeSessionProjectionStore({ narrow })
    const reads: Array<ProjectionValue | undefined> = []
    store.subscribe(() => { reads.push(store.read()) })
    store.attach(values.source)
    store.bind('alpha')
    store.bind('beta')

    expect(reads).toEqual([
      { status: 'running', text: 'alpha' },
      undefined,
      { status: 'idle', text: 'beta' },
    ])
    values.set('alpha', { status: 'idle', text: 'late alpha' })
    expect(store.read()).toEqual({ status: 'idle', text: 'beta' })
    expect(reads).toHaveLength(3)
  })

  it('reseed clears removed values, detaches safely, and reattaches from baseline', () => {
    const values = source({ alpha: { status: 'idle', text: 'alpha' } })
    const failures: string[] = []
    const store = new BrowserNativeSessionProjectionStore({
      narrow,
      onReadFailure: error => failures.push(error.message),
    })
    store.attach(values.source)
    store.bind('alpha')
    values.remove('alpha')
    expect(store.read()).toBeUndefined()
    values.set('alpha', { status: 'running', text: 'recreated' })
    expect(store.read()).toEqual({ status: 'running', text: 'recreated' })
    store.detach(values.source)
    expect(store.read()).toBeUndefined()
    values.set('alpha', { status: 'idle', text: 'ignored while detached' })
    expect(store.read()).toBeUndefined()
    store.attach(values.source)
    expect(store.read()).toEqual({ status: 'idle', text: 'ignored while detached' })
    values.fail(new Error('projection unavailable'))
    store.reseed()
    store.reseed()
    expect(failures).toEqual(['Session projection read failed: projection unavailable'])
  })

  it('retains the last value when a reseed read fails and reports once', () => {
    const values = source({ alpha: { status: 'idle', text: 'stable' } })
    const failures: string[] = []
    const store = new BrowserNativeSessionProjectionStore({
      narrow,
      onReadFailure: error => failures.push(error.message),
    })
    store.attach(values.source)
    store.bind('alpha')
    values.fail(new Error('authority unavailable'))
    store.reseed()
    store.reseed()
    expect(store.read()).toEqual({ status: 'idle', text: 'stable' })
    expect(failures).toEqual(['Session projection read failed: authority unavailable'])
  })
})
