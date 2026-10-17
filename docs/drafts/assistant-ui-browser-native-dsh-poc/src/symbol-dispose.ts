type DisposableSymbolRegistry = {
  readonly for: (key: string) => symbol
  dispose?: symbol
  asyncDispose?: symbol
}

/**
 * Install explicit-resource-management symbols in browser realms that lack them.
 * @param registry - the realm's Symbol constructor or a compatible symbol registry.
 * @returns Nothing.
 */
export function installDisposableSymbols(registry: DisposableSymbolRegistry): void {
  if (registry.dispose === undefined) {
    Object.defineProperty(registry, 'dispose', {
      configurable: true,
      value: registry.for('Symbol.dispose'),
    })
  }
  if (registry.asyncDispose === undefined) {
    Object.defineProperty(registry, 'asyncDispose', {
      configurable: true,
      value: registry.for('Symbol.asyncDispose'),
    })
  }
}

installDisposableSymbols(Symbol)
