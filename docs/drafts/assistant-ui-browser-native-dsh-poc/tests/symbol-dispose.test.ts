import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installDisposableSymbols } from '../src/symbol-dispose.ts'

test('installs shared explicit-resource-management symbols when a realm lacks them', () => {
  const registry: { for: (key: string) => symbol; dispose?: symbol; asyncDispose?: symbol } = {
    for: key => Symbol.for(key),
  }

  installDisposableSymbols(registry)

  assert.equal(registry.dispose, Symbol.for('Symbol.dispose'))
  assert.equal(registry.asyncDispose, Symbol.for('Symbol.asyncDispose'))

  let disposed = false
  const disposeSymbol = registry.dispose
  assert.ok(disposeSymbol)
  const resource = { [disposeSymbol]: () => { disposed = true } }
  resource[disposeSymbol]()
  assert.equal(disposed, true)
})

test('preserves explicit-resource-management symbols already provided by a realm', () => {
  const dispose = Symbol('dispose')
  const asyncDispose = Symbol('asyncDispose')
  const registry = {
    for: (key: string) => Symbol.for(key),
    dispose,
    asyncDispose,
  }

  installDisposableSymbols(registry)

  assert.equal(registry.dispose, dispose)
  assert.equal(registry.asyncDispose, asyncDispose)
})
