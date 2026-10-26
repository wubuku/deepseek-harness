/** Runtime checks required before the Browser-Native preview creates a DSH Host. */

export type BrowserNativeRuntimeProbeFailureCode =
  | 'SESSION_OUTBOX_UNAVAILABLE'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_PROTOCOL_MISMATCH'
  | 'BACKEND_RESPONSE_INVALID'
  | 'OPFS_SYNC_ACCESS_UNAVAILABLE'

export interface BrowserNativeRuntimeProbeFailure {
  readonly check: 'session-outbox' | 'backend' | 'workspace-opfs'
  readonly code: BrowserNativeRuntimeProbeFailureCode
}

export interface BrowserNativeRuntimeProbeReport {
  readonly ok: boolean
  readonly checks: Readonly<Record<'session-outbox' | 'backend' | 'workspace-opfs', 'ready' | 'skipped' | 'failed' | 'not-run'>>
  readonly failures: readonly BrowserNativeRuntimeProbeFailure[]
}

/** Inputs supplied by the Worker that owns the outbox and optional OPFS access. */
export interface BrowserNativeRuntimeProbeOptions {
  readonly backendOrigin: string
  readonly durableWorkspace: boolean
  readonly probeSessionOutbox: () => Promise<void>
  readonly fetcher?: typeof fetch
  readonly probeWorkspaceOpfs?: () => Promise<void>
}

interface JsonRecord {
  readonly [key: string]: unknown
}

class ProbeFailure extends Error {
  constructor(readonly code: BrowserNativeRuntimeProbeFailureCode) {
    super(code)
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function fetchJson(fetcher: typeof fetch, url: URL): Promise<JsonRecord> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetcher(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new ProbeFailure('BACKEND_UNAVAILABLE')
    const value: unknown = await response.json()
    if (!isRecord(value)) throw new ProbeFailure('BACKEND_RESPONSE_INVALID')
    return value
  } catch (error) {
    if (error instanceof ProbeFailure) throw error
    throw new ProbeFailure('BACKEND_UNAVAILABLE')
  } finally {
    clearTimeout(timeout)
  }
}

async function probeBackend(origin: string, fetcher: typeof fetch): Promise<void> {
  let health: JsonRecord
  let config: JsonRecord
  try {
    [health, config] = await Promise.all([
      fetchJson(fetcher, new URL('/api/browser-native/health', origin)),
      fetchJson(fetcher, new URL('/api/browser-native/config', origin)),
    ])
  } catch (error) {
    if (error instanceof ProbeFailure) throw error
    throw new ProbeFailure('BACKEND_UNAVAILABLE')
  }
  if (health.protocolVersion !== 1 || config.protocolVersion !== 1) {
    throw new ProbeFailure('BACKEND_PROTOCOL_MISMATCH')
  }
  if (health.ok !== true || (health.llmMode !== 'real' && health.llmMode !== 'scripted')
    || typeof health.model !== 'string' || health.model.length === 0
    || config.llmMode !== health.llmMode || config.model !== health.model
    || typeof config.provider !== 'string' || config.provider.length === 0) {
    throw new ProbeFailure('BACKEND_RESPONSE_INVALID')
  }
}

async function probeOpfsSyncAccessHandle(): Promise<void> {
  const storage = navigator.storage as Storage & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
  if (typeof storage.getDirectory !== 'function') throw new Error('OPFS unavailable')

  const root = await storage.getDirectory()
  const name = `dsh-runtime-probe-${crypto.randomUUID()}`
  let handle: FileSystemFileHandle | undefined
  let access: FileSystemSyncAccessHandle | undefined
  let failure: unknown
  try {
    handle = await root.getFileHandle(name, { create: true })
    access = await handle.createSyncAccessHandle()
    const expected = new Uint8Array([0x44, 0x53, 0x48, 0x01])
    if (access.write(expected, { at: 0 }) !== expected.byteLength) throw new Error('OPFS short write')
    access.flush()
    const actual = new Uint8Array(expected.byteLength)
    if (access.read(actual, { at: 0 }) !== expected.byteLength
      || actual.some((byte, index) => byte !== expected[index])) {
      throw new Error('OPFS readback mismatch')
    }
    access.truncate(0)
    access.flush()
    if (access.getSize() !== 0) throw new Error('OPFS truncate failed')
  } catch (error) {
    failure = error
  } finally {
    try {
      access?.close()
    } catch (error) {
      failure ??= error
    }
    if (handle !== undefined) {
      try {
        await root.removeEntry(name)
      } catch (error) {
        failure ??= error
      }
    }
  }
  if (failure !== undefined) throw failure
}

async function check(
  id: BrowserNativeRuntimeProbeFailure['check'],
  operation: () => Promise<void>,
): Promise<{ readonly id: BrowserNativeRuntimeProbeFailure['check']; readonly failure?: BrowserNativeRuntimeProbeFailure }> {
  try {
    await operation()
    return { id }
  } catch (error) {
    const code = id === 'session-outbox'
      ? 'SESSION_OUTBOX_UNAVAILABLE'
      : id === 'backend'
        ? error instanceof ProbeFailure ? error.code : 'BACKEND_UNAVAILABLE'
        : 'OPFS_SYNC_ACCESS_UNAVAILABLE'
    return { id, failure: { check: id, code } }
  }
}

/**
 * Check required startup dependencies without opening a DSH Host or sending model traffic.
 * @param options - Worker-owned outbox, backend origin, and selected Workspace mode.
 * @returns Stable pass/fail evidence without backend response bodies or storage details.
 */
export async function probeBrowserNativeRuntime(
  options: BrowserNativeRuntimeProbeOptions,
): Promise<BrowserNativeRuntimeProbeReport> {
  const fetcher = options.fetcher ?? fetch
  const tasks = [
    check('session-outbox', options.probeSessionOutbox),
    check('backend', async () => await probeBackend(options.backendOrigin, fetcher)),
  ] as const
  const results = await Promise.all(tasks)
  const opfs = options.durableWorkspace
    ? await check('workspace-opfs', options.probeWorkspaceOpfs ?? probeOpfsSyncAccessHandle)
    : { id: 'workspace-opfs' as const }
  const checks = {
    'session-outbox': results[0].failure === undefined ? 'ready' as const : 'failed' as const,
    backend: results[1].failure === undefined ? 'ready' as const : 'failed' as const,
    'workspace-opfs': options.durableWorkspace
      ? opfs.failure === undefined ? 'ready' as const : 'failed' as const
      : 'skipped' as const,
  }
  const failures = results.flatMap(result => result.failure === undefined ? [] : [result.failure])
  if (opfs.failure !== undefined) failures.push(opfs.failure)
  return { ok: failures.length === 0, checks, failures }
}
