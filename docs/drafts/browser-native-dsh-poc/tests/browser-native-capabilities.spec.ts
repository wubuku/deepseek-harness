import { describe, expect, it } from 'vitest'
import {
  BROWSER_NATIVE_PROFILE_MANIFEST,
  evaluateBrowserNativeProfile,
  formatBrowserNativePreflightFailure,
  publishBrowserNativeTools,
  type BrowserNativeProfileManifest,
} from '../browser-native-capabilities.ts'
import {
  assertBrowserNativeToolSchemas,
  BrowserNativeCapabilityPublication,
} from '../browser-native-capability-publication.ts'

describe('browser-native capability preflight', () => {
  it('accepts the checked-in Browser-Native profile and exposes only adapted tools', () => {
    const result = evaluateBrowserNativeProfile()
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(BROWSER_NATIVE_PROFILE_MANIFEST.tools.map(tool => tool.name)).toEqual([
      'bash', 'read', 'write', 'edit', 'grep', 'glob', 'todo_write', 'ask_user_question', 'working_directory',
    ])
    expect(BROWSER_NATIVE_PROFILE_MANIFEST.plugins.map(plugin => plugin.id)).toContain('compaction-basic')
    expect(BROWSER_NATIVE_PROFILE_MANIFEST.plugins.map(plugin => plugin.id)).toContain('command-compact')
    expect(BROWSER_NATIVE_PROFILE_MANIFEST.plugins.map(plugin => plugin.id)).toContain('tool-result-pruner')
    expect(result.providedCapabilities).toContain('restricted-shell')
    expect(result.providedCapabilities).not.toContain('host-subprocess')
    expect(publishBrowserNativeTools(BROWSER_NATIVE_PROFILE_MANIFEST)).toHaveLength(9)
  })

  it('fails before boot when a plugin requires an unsupported host capability', () => {
    const manifest: BrowserNativeProfileManifest = {
      ...BROWSER_NATIVE_PROFILE_MANIFEST,
      plugins: [...BROWSER_NATIVE_PROFILE_MANIFEST.plugins, {
        id: 'host-shell-plugin',
        packageName: '@example/host-shell-plugin',
        required: ['host-subprocess'],
      }],
    }
    const result = evaluateBrowserNativeProfile(manifest)
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([expect.objectContaining({
      kind: 'missing-capability',
      pluginId: 'host-shell-plugin',
      capability: 'host-subprocess',
    })])
    expect(formatBrowserNativePreflightFailure(result)).toContain('host-shell-plugin')
    expect(formatBrowserNativePreflightFailure(result)).toContain('host-subprocess')
  })

  it('rejects duplicate plugin declarations and unknown tool capabilities', () => {
    const manifest: BrowserNativeProfileManifest = {
      ...BROWSER_NATIVE_PROFILE_MANIFEST,
      plugins: [BROWSER_NATIVE_PROFILE_MANIFEST.plugins[0], BROWSER_NATIVE_PROFILE_MANIFEST.plugins[0]],
      tools: [...BROWSER_NATIVE_PROFILE_MANIFEST.tools, { name: 'unknown_tool', capability: 'unknown' as never }],
    }
    const result = evaluateBrowserNativeProfile(manifest)
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.kind)).toEqual(['duplicate-plugin', 'unknown-tool-capability'])
  })

  it('keeps staged, degraded and denied capabilities out of the model roster', () => {
    const staged = {
      ...BROWSER_NATIVE_PROFILE_MANIFEST,
      tools: [{ name: 'staged_tool', capability: 'structured-file-tools' as const }],
    }
    const stagedCapabilities = {
      'structured-file-tools': {
        id: 'structured-file-tools' as const,
        status: 'adapted' as const,
        provider: 'test',
        detail: 'module exists but probe did not run',
        lifecycle: 'staged' as const,
        evidence: [{ kind: 'method' as const, id: 'test.method' }],
        permission: 'granted' as const,
      },
    }
    expect(publishBrowserNativeTools(staged, stagedCapabilities)).toEqual([])

    const deniedCapabilities = {
      'structured-file-tools': {
        id: 'structured-file-tools' as const,
        status: 'adapted' as const,
        provider: 'test',
        detail: 'probe passed but user denied',
        lifecycle: 'live' as const,
        evidence: [{ kind: 'probe' as const, id: 'test.probe' }],
        permission: 'denied' as const,
      },
    }
    expect(publishBrowserNativeTools(staged, deniedCapabilities)).toEqual([])

    const preflight = evaluateBrowserNativeProfile(staged, stagedCapabilities)
    expect(preflight.ok).toBe(false)
    expect(preflight.issues).toEqual([expect.objectContaining({ kind: 'unpublished-tool', toolName: 'staged_tool' })])
  })

  it('publishes only after activation and withdraws every Workspace-backed tool on local durability loss', () => {
    const publication = new BrowserNativeCapabilityPublication()
    const transitions: string[][] = []
    const unsubscribe = publication.subscribe(() => {
      transitions.push([...publication.publishedToolNames()].sort())
    })

    expect(publication.publishedToolNames()).toEqual(new Set())
    publication.activate()
    expect(publication.publishedToolNames()).toEqual(new Set([
      'bash', 'read', 'write', 'edit', 'grep', 'glob', 'todo_write', 'ask_user_question', 'working_directory',
    ]))
    expect(publication.unavailableWorkspaceToolNames()).toEqual([])

    publication.degradeWorkspace()
    expect(publication.unavailableWorkspaceToolNames().sort()).toEqual([
      'bash', 'edit', 'glob', 'grep', 'read', 'working_directory', 'write',
    ])
    expect(publication.publishedToolNames()).toEqual(new Set(['todo_write', 'ask_user_question']))
    expect(publication.isToolPublished('write')).toBe(false)
    expect(publication.isToolPublished('todo_write')).toBe(true)
    expect(transitions).toHaveLength(2)

    publication.degradeWorkspace()
    expect(transitions).toHaveLength(2)
    unsubscribe()
  })

  it('publishes only read-only file tools for an observer and none after its snapshot becomes stale', () => {
    const publication = new BrowserNativeCapabilityPublication()
    publication.activate()
    publication.setWorkspaceReadOnly()

    expect(publication.publishedToolNames()).toEqual(new Set([
      'read', 'grep', 'glob', 'todo_write', 'ask_user_question',
    ]))
    expect(publication.unavailableWorkspaceToolNames().sort()).toEqual([
      'bash', 'edit', 'working_directory', 'write',
    ])
    expect(() => assertBrowserNativeToolSchemas([{ name: 'read' }], publication)).not.toThrow()
    expect(() => assertBrowserNativeToolSchemas([{ name: 'write' }], publication))
      .toThrow('not currently published')

    publication.markWorkspaceStale()
    expect(publication.publishedToolNames()).toEqual(new Set(['todo_write', 'ask_user_question']))
    expect(publication.isToolPublished('read')).toBe(false)
  })

  it('rejects duplicate, unknown, and withdrawn schemas instead of silently filtering them', () => {
    const publication = new BrowserNativeCapabilityPublication()
    publication.activate()
    expect(() => assertBrowserNativeToolSchemas([{ name: 'read' }], publication)).not.toThrow()
    expect(() => assertBrowserNativeToolSchemas([{ name: 'read' }, { name: 'read' }], publication))
      .toThrow('duplicate tool schema "read"')
    expect(() => assertBrowserNativeToolSchemas([{ name: 'unknown' }], publication))
      .toThrow('tool schema "unknown" is not currently published')

    publication.degradeWorkspace()
    expect(() => assertBrowserNativeToolSchemas([{ name: 'write' }], publication))
      .toThrow('tool schema "write" is not currently published')
    expect(() => assertBrowserNativeToolSchemas([{ name: 'todo_write' }], publication)).not.toThrow()
  })

  it('publishes CPU contention probes only when the dedicated validation profile enables them', () => {
    const publication = new BrowserNativeCapabilityPublication()
    publication.activate()

    expect(publication.isToolPublished('browser_cpu_blocking_probe')).toBe(false)
    expect(() => assertBrowserNativeToolSchemas([{ name: 'browser_cpu_blocking_probe' }], publication))
      .toThrow('not currently published')

    publication.enableCpuContentionValidation()

    expect(publication.isToolPublished('browser_cpu_blocking_probe')).toBe(true)
    expect(publication.isToolPublished('browser_cpu_cooperative_probe')).toBe(true)
    expect(() => assertBrowserNativeToolSchemas([
      { name: 'browser_cpu_blocking_probe' },
      { name: 'browser_cpu_cooperative_probe' },
    ], publication)).not.toThrow()
  })

  it('keeps pre-activation Workspace degradation latched when startup probes later pass', () => {
    const publication = new BrowserNativeCapabilityPublication()
    publication.degradeWorkspace()
    publication.activate()

    expect(publication.publishedToolNames()).toEqual(new Set(['todo_write', 'ask_user_question']))
    expect(publication.unavailableWorkspaceToolNames().sort()).toEqual([
      'bash', 'edit', 'glob', 'grep', 'read', 'working_directory', 'write',
    ])
  })
})
