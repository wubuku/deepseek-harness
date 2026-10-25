import { describe, expect, it } from 'vitest'
import {
  BROWSER_NATIVE_PROFILE_MANIFEST,
  evaluateBrowserNativeProfile,
  formatBrowserNativePreflightFailure,
  publishBrowserNativeTools,
  type BrowserNativeProfileManifest,
} from '../browser-native-capabilities.ts'

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
})
