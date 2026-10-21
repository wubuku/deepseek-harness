import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installDisposableSymbols } from '../symbol-dispose.ts'

test('installs missing symbols without replacing symbols already provided by a realm', () => {
  const registry: { for: (key: string) => symbol; dispose?: symbol; asyncDispose?: symbol } = { for: key => Symbol.for(key) }
  installDisposableSymbols(registry)
  assert.equal(registry.dispose, Symbol.for('Symbol.dispose'))
  assert.equal(registry.asyncDispose, Symbol.for('Symbol.asyncDispose'))
  const dispose = Symbol('existing dispose')
  const asyncDispose = Symbol('existing async dispose')
  const existingRegistry = { for: (key: string) => Symbol.for(key), dispose, asyncDispose }
  installDisposableSymbols(existingRegistry)
  assert.equal(existingRegistry.dispose, dispose)
  assert.equal(existingRegistry.asyncDispose, asyncDispose)
})
