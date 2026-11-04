import { describe, expect, it } from 'vitest'
import {
  createBrowserNativeToolPolicy,
  resolveToolPolicyAction,
  type ToolPolicyConfig,
} from '../browser-native-tool-policy.ts'

const ALLOWED = '/dsh/home/workspace/allowed'

const configured = (config: ToolPolicyConfig) => {
  const probe = createBrowserNativeToolPolicy()
  const snapshot = probe.setPolicy(config)
  return { snapshot, resolve: (tool: string, args: unknown) => resolveToolPolicyAction(snapshot, tool, args) }
}

describe('browser-native tool policy path rules', () => {
  it('keeps the tool decision for an unconfigured tool', () => {
    const { resolve } = configured({ tools: { write: 'deny' }, default: 'ask' })
    expect(resolve('write', { file_path: `${ALLOWED}/report.txt` }).action).toBe('deny')
    expect(resolve('read', { file_path: `${ALLOWED}/report.txt` }).action).toBe('ask')
  })

  it('allows a target inside an allowed prefix and denies a sibling prefix', () => {
    const { resolve } = configured({
      tools: { write: 'allow' },
      paths: { write: { allow: [ALLOWED], outside: 'deny' } },
    })
    expect(resolve('write', { file_path: `${ALLOWED}/report.txt` })).toMatchObject({
      action: 'allow',
      path: `${ALLOWED}/report.txt`,
      allowedPaths: [ALLOWED],
    })
    expect(resolve('write', { file_path: `${ALLOWED}-other/report.txt` }).action).toBe('deny')
  })

  it('treats a traversal out of the allowed prefix as outside', () => {
    const { resolve } = configured({
      tools: { write: 'allow' },
      paths: { write: { allow: [ALLOWED], outside: 'deny' } },
    })
    expect(resolve('write', { file_path: `${ALLOWED}/../forbidden.txt` })).toMatchObject({
      action: 'deny',
      path: '/dsh/home/workspace/forbidden.txt',
    })
    expect(resolve('write', { file_path: `${ALLOWED}/sub/../ok.txt` }).action).toBe('allow')
  })

  it('counts a missing or non-string target as outside', () => {
    const { resolve } = configured({
      tools: { write: 'allow' },
      paths: { write: { allow: [ALLOWED], outside: 'deny' } },
    })
    expect(resolve('write', {}).action).toBe('deny')
    expect(resolve('write', undefined).action).toBe('deny')
    expect(resolve('write', { file_path: 42 }).action).toBe('deny')
  })

  it('honours a configured argument name', () => {
    const { resolve } = configured({
      tools: { grep: 'allow' },
      paths: { grep: { argument: 'path', allow: [ALLOWED], outside: 'ask' } },
    })
    expect(resolve('grep', { path: `${ALLOWED}/src` }).action).toBe('allow')
    expect(resolve('grep', { path: '/elsewhere' }).action).toBe('ask')
  })

  it('accepts ask as the outside decision', () => {
    const { resolve } = configured({
      tools: { write: 'allow' },
      paths: { write: { allow: [ALLOWED], outside: 'ask' } },
    })
    expect(resolve('write', { file_path: '/elsewhere/report.txt' }).action).toBe('ask')
  })

  it('omits paths from the snapshot when none are configured', () => {
    const { snapshot } = configured({ tools: { write: 'allow' }, default: 'deny' })
    expect(snapshot).toEqual({ tools: { write: 'allow' }, default: 'deny' })
  })

  it('rejects malformed path rules at the configuration boundary', () => {
    const probe = createBrowserNativeToolPolicy()
    expect(() => probe.setPolicy({ paths: { write: { allow: [], outside: 'deny' } } }))
      .toThrow(/non-empty array/)
    expect(() => probe.setPolicy({ paths: { write: { allow: [ALLOWED], outside: 'cancel' } } }))
      .toThrow(/outside must be one of allow, ask, deny/)
    expect(() => probe.setPolicy({ paths: { write: { allow: [''], outside: 'deny' } } }))
      .toThrow(/non-empty strings/)
    expect(() => probe.setPolicy({ paths: { write: { allow: [ALLOWED], outside: 'deny', argument: '' } } }))
      .toThrow(/argument must be a non-empty string/)
  })
})
