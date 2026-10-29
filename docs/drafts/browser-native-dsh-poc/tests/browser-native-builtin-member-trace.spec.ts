import { describe, expect, it } from 'vitest'
import { createBrowserNativeBuiltinMemberTrace } from '../browser-native-builtin-member-trace.ts'

describe('Browser-Native Node builtin member trace', () => {
  it('records calls by builtin member without accepting call arguments', () => {
    const trace = createBrowserNativeBuiltinMemberTrace()

    trace.record('node:fs/promises', 'readFile')
    trace.record('node:fs/promises', 'readFile')
    trace.record('node:fs', 'statSync')

    expect(trace.snapshot().members).toEqual([
      { specifier: 'node:fs', member: 'statSync', calls: 1 },
      { specifier: 'node:fs/promises', member: 'readFile', calls: 2 },
    ])
  })

  it('counts repeated members and reports calls omitted after the unique-member cap', () => {
    const trace = createBrowserNativeBuiltinMemberTrace(1)

    trace.record('node:fs/promises', 'readFile')
    trace.record('node:fs/promises', 'readFile')
    trace.record('node:fs/promises', 'writeFile')
    trace.record('node:fs/promises', 'writeFile')

    expect(trace.snapshot()).toEqual({
      members: [{ specifier: 'node:fs/promises', member: 'readFile', calls: 2 }],
      droppedCalls: 2,
    })
  })

  it('rejects invalid capacities', () => {
    expect(() => createBrowserNativeBuiltinMemberTrace(0)).toThrow('capacity must be an integer from 1 through 100000')
    expect(() => createBrowserNativeBuiltinMemberTrace(100_001)).toThrow('capacity must be an integer from 1 through 100000')
  })
})
