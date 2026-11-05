/**
 * Classify durable-write failures and inject them during tests.
 *
 * ENOSPC, EROFS, and I/O timeouts otherwise surface as opaque 500s. Every
 * durable writer calls {@link applyStorageFault} before publishing, which turns
 * a test-injected fault into the same typed failure a real disk error produces.
 * The backend maps that failure to a status and retry advice, so operators see
 * whether freeing space, remounting writable, or retrying later is the remedy.
 *
 * Fault injection is a deployment test hook: it runs before any bytes or
 * temporary file are written, so an injected failure leaves no half-written
 * state and the same request can be retried unchanged.
 */

/** Stable faults that a disk can produce, with the operator-facing remedy. */
const STORAGE_FAULTS = Object.freeze({
  ENOSPC: {
    code: 'STORAGE_DISK_FULL',
    status: 507,
    message: 'the data volume has no free space; free space or grow the volume, then retry',
  },
  EROFS: {
    code: 'STORAGE_READ_ONLY',
    status: 503,
    message: 'the data directory is read-only; restore writable access, then retry',
  },
  ETIMEDOUT: {
    code: 'STORAGE_TIMEOUT',
    status: 503,
    message: 'the data volume did not complete the write before the I/O deadline; retry after the volume responds',
    retryAfterMs: 5_000,
  },
  EBUSY: {
    code: 'STORAGE_TIMEOUT',
    status: 503,
    message: 'the data volume is busy or stalled; retry after I/O pressure drops',
    retryAfterMs: 5_000,
  },
})

/** One durable write rejected by an injected or real disk fault. */
export class StorageFaultError extends Error {
  /**
   * @param systemCode - Disk error code such as `ENOSPC`, `EROFS`, or `ETIMEDOUT`.
   * @param surface - Writer that was stopped, such as `session` or `rotation`.
   */
  constructor(systemCode, surface) {
    const fault = STORAGE_FAULTS[systemCode] ?? STORAGE_FAULTS.ENOSPC
    super(`${surface} write failed: ${fault.message} (${systemCode})`)
    this.name = 'StorageFaultError'
    this.code = fault.code
    this.status = fault.status
    this.retryAfterMs = fault.retryAfterMs
    this.systemCode = systemCode
    this.surface = surface
    this.details = { surface }
  }
}

/** Syscalls a durable writer performs; network failures name `connect` instead. */
const STORAGE_SYSCALLS = new Set([
  'write', 'writev', 'read', 'readv', 'open', 'close', 'fsync', 'fdatasync', 'rename', 'link', 'unlink',
  'mkdir', 'rmdir', 'truncate', 'ftruncate', 'stat', 'lstat', 'fstat', 'copyfile', 'chmod',
])

/**
 * Describe a real or injected disk failure for a client response.
 * @param error - Thrown value from a durable writer.
 * @returns Status, code, message, and retry advice, or undefined for other errors.
 */
export function storageFailure(error) {
  if (error === null || typeof error !== 'object') return undefined
  if (error instanceof StorageFaultError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      details: error.details,
    }
  }
  const systemCode = typeof error.code === 'string' ? error.code : undefined
  const fault = systemCode === undefined ? undefined : STORAGE_FAULTS[systemCode]
  // Network failures also carry ETIMEDOUT; only durable-writer syscalls qualify.
  if (fault === undefined || !STORAGE_SYSCALLS.has(error.syscall)) return undefined
  return {
    code: fault.code,
    message: `durable write failed: ${fault.message} (${systemCode})`,
    status: fault.status,
    retryAfterMs: fault.retryAfterMs,
  }
}

/**
 * Stop one durable write when the deployment's fault hook names its surface.
 *
 * The hook receives a surface name and returns nothing to allow the write, a
 * system code string, or `{ code, delayMs }`. `delayMs` simulates a slow volume
 * before the timeout is reported. The hook runs before the first byte is staged,
 * so callers can retry the same operation without repairing partial state.
 * @param storageFault - Optional hook, usually `options.testHooks.storageFault`.
 * @param surface - Durable writer identity: `session`, `workspace-blob`,
 * `attachment`, `audit`, or `rotation`.
 * @returns Resolves when the write may proceed.
 */
export async function applyStorageFault(storageFault, surface) {
  if (storageFault === undefined) return
  const instruction = await storageFault(surface)
  if (instruction === undefined || instruction === null || instruction === false) return
  const spec = typeof instruction === 'string' ? { code: instruction } : instruction
  const systemCode = typeof spec.code === 'string' && spec.code in STORAGE_FAULTS ? spec.code : 'ENOSPC'
  const delayMs = Number.isFinite(spec.delayMs) && spec.delayMs > 0 ? spec.delayMs : 0
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
  throw new StorageFaultError(systemCode, surface)
}
