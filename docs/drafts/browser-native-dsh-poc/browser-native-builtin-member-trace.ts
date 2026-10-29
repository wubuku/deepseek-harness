/** One observed call into a Node filesystem builtin shim. */
export interface BrowserNativeBuiltinMemberCall {
  /** Builtin module name reported by the shim. */
  readonly specifier: 'node:fs' | 'node:fs/promises'
  /** Public API member entered by the caller. */
  readonly member: string
  /** Number of calls observed for this builtin member. */
  readonly calls: number
}

/** Bounded, content-free summary of observed Node filesystem builtin calls. */
export interface BrowserNativeBuiltinMemberTraceSnapshot {
  /** Distinct builtin/member pairs retained by the trace. */
  readonly members: readonly BrowserNativeBuiltinMemberCall[]
  /** Calls not retained after the unique-member capacity was reached. */
  readonly droppedCalls: number
}

/** Recorder passed to the Worker Host only by the PoC test channel. */
export interface BrowserNativeBuiltinMemberTrace {
  /** Record one public shim method entry without its arguments. */
  record(specifier: BrowserNativeBuiltinMemberCall['specifier'], member: string): void
  /** Return a sorted copy without call arguments, paths, or file contents. */
  snapshot(): BrowserNativeBuiltinMemberTraceSnapshot
}

interface MutableCall {
  readonly specifier: BrowserNativeBuiltinMemberCall['specifier']
  readonly member: string
  calls: number
}

/** Create a bounded recorder for Worker filesystem builtin call names. */
export function createBrowserNativeBuiltinMemberTrace(capacity = 2_048): BrowserNativeBuiltinMemberTrace {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) {
    throw new RangeError('browser-native builtin trace capacity must be an integer from 1 through 100000')
  }

  const calls = new Map<string, MutableCall>()
  let droppedCalls = 0
  return {
    record(specifier, member) {
      const key = `${specifier}\u0000${member}`
      const existing = calls.get(key)
      if (existing !== undefined) {
        existing.calls += 1
        return
      }
      if (calls.size >= capacity) {
        droppedCalls += 1
        return
      }
      calls.set(key, { specifier, member, calls: 1 })
    },
    snapshot: () => ({
      members: [...calls.values()]
        .map(call => ({ ...call }))
        .sort((left, right) => left.specifier.localeCompare(right.specifier) || left.member.localeCompare(right.member)),
      droppedCalls,
    }),
  }
}
