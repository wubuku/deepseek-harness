import { describe, expect, it, vi } from 'vitest'
import { probeBrowserNativeRuntime } from '../browser-native-runtime-probes.ts'

const health = { protocolVersion: 1, ok: true, llmMode: 'scripted', model: 'browser-native-scripted' }
const config = { protocolVersion: 1, llmMode: 'scripted', provider: 'scripted', model: 'browser-native-scripted' }

function backendResponse(path: string, status = 200, body?: unknown): Response {
  const value = body ?? (path.endsWith('/health') ? health : config)
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('Browser-Native runtime probes', () => {
  it('checks same-origin backend protocol and skips OPFS for a memory Workspace', async () => {
    const requested: URL[] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString())
      requested.push(url)
      return backendResponse(url.pathname)
    })
    const probeSessionOutbox = vi.fn(async () => {})
    const probeWorkspaceOpfs = vi.fn(async () => {})

    const result = await probeBrowserNativeRuntime({
      backendOrigin: 'https://dsh.example.test',
      durableWorkspace: false,
      fetcher,
      probeSessionOutbox,
      probeWorkspaceOpfs,
    })

    expect(result).toEqual({
      ok: true,
      checks: { 'session-outbox': 'ready', backend: 'ready', 'workspace-opfs': 'skipped' },
      failures: [],
    })
    expect(requested.map(url => [url.origin, url.pathname])).toEqual([
      ['https://dsh.example.test', '/api/browser-native/health'],
      ['https://dsh.example.test', '/api/browser-native/config'],
    ])
    expect(probeSessionOutbox).toHaveBeenCalledOnce()
    expect(probeWorkspaceOpfs).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'same-origin' && init.redirect === 'error')).toBe(true)
  })

  it('reports a committed outbox abort and backend outage without exposing response data', async () => {
    const secret = 'MODEL_SECRET_MUST_NOT_LEAK'
    const result = await probeBrowserNativeRuntime({
      backendOrigin: 'https://dsh.example.test',
      durableWorkspace: false,
      fetcher: async input => {
        const url = new URL(input.toString())
        return backendResponse(url.pathname, 503, { secret, error: secret })
      },
      probeSessionOutbox: async () => { throw new Error(secret) },
    })

    expect(result.failures).toEqual([
      { check: 'session-outbox', code: 'SESSION_OUTBOX_UNAVAILABLE' },
      { check: 'backend', code: 'BACKEND_UNAVAILABLE' },
    ])
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('rejects mismatched protocol and inconsistent backend configuration', async () => {
    const result = await probeBrowserNativeRuntime({
      backendOrigin: 'https://dsh.example.test',
      durableWorkspace: false,
      fetcher: async input => {
        const url = new URL(input.toString())
        return url.pathname.endsWith('/health')
          ? backendResponse(url.pathname, 200, { ...health, protocolVersion: 2 })
          : backendResponse(url.pathname, 200, { ...config, model: 'other-model' })
      },
      probeSessionOutbox: async () => {},
    })

    expect(result.failures).toEqual([{ check: 'backend', code: 'BACKEND_PROTOCOL_MISMATCH' }])
  })

  it('requires OPFS only when durable Workspace is selected', async () => {
    const probeWorkspaceOpfs = vi.fn(async () => { throw new Error('OPFS unavailable') })
    const result = await probeBrowserNativeRuntime({
      backendOrigin: 'https://dsh.example.test',
      durableWorkspace: true,
      fetcher: async input => backendResponse(new URL(input.toString()).pathname),
      probeSessionOutbox: async () => {},
      probeWorkspaceOpfs,
    })

    expect(result.checks['workspace-opfs']).toBe('failed')
    expect(result.failures).toEqual([{ check: 'workspace-opfs', code: 'OPFS_SYNC_ACCESS_UNAVAILABLE' }])
  })
})
