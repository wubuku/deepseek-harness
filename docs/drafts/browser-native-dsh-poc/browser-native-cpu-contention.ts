const MIN_DURATION_MS = 20
const MAX_DURATION_MS = 2_000
const MAX_SLICE_MS = 50
const WORK_BATCH = 2_048

export interface BrowserNativeCpuContentionInput {
  readonly mode: 'blocking' | 'cooperative'
  readonly durationMs: number
  readonly sliceMs?: number
  readonly sessionId: string
  readonly callId: string
  readonly signal: AbortSignal
}

export interface BrowserNativeCpuContentionEvent {
  readonly type: 'browser-native-cpu-contention-stage'
  readonly stage: 'started' | 'completed' | 'cancelled'
  readonly mode: BrowserNativeCpuContentionInput['mode']
  readonly sessionId: string
  readonly callId: string
  readonly at: number
  readonly elapsedMs?: number
}

export interface BrowserNativeCpuContentionResult {
  readonly mode: BrowserNativeCpuContentionInput['mode']
  readonly elapsedMs: number
  readonly iterations: number
  readonly checksum: number
}

/** Run a bounded CPU workload, optionally yielding to the Worker task queue. */
export async function runBrowserNativeCpuContentionWorkload(
  input: BrowserNativeCpuContentionInput,
  emit: (event: BrowserNativeCpuContentionEvent) => void,
): Promise<BrowserNativeCpuContentionResult> {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < MIN_DURATION_MS || input.durationMs > MAX_DURATION_MS) {
    throw new RangeError(`durationMs must be an integer between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}`)
  }
  const sliceMs = input.sliceMs ?? 10
  if (input.mode === 'cooperative' && (!Number.isSafeInteger(sliceMs) || sliceMs < 1 || sliceMs > MAX_SLICE_MS)) {
    throw new RangeError(`sliceMs must be an integer between 1 and ${MAX_SLICE_MS}`)
  }

  const startedAt = performance.now()
  const deadline = startedAt + input.durationMs
  emit({
    type: 'browser-native-cpu-contention-stage',
    stage: 'started',
    mode: input.mode,
    sessionId: input.sessionId,
    callId: input.callId,
    at: Date.now(),
  })

  let iterations = 0
  let accumulator = 0
  const runBatch = (): void => {
    for (let index = 0; index < WORK_BATCH; index += 1) {
      accumulator = Math.imul(accumulator ^ index, 0x45d9f3b)
      iterations += 1
    }
  }
  const checkCancellation = (): void => {
    if (!input.signal.aborted) return
    emit({
      type: 'browser-native-cpu-contention-stage',
      stage: 'cancelled',
      mode: input.mode,
      sessionId: input.sessionId,
      callId: input.callId,
      at: Date.now(),
      elapsedMs: Math.round(performance.now() - startedAt),
    })
    throw input.signal.reason ?? new DOMException('CPU probe cancelled', 'AbortError')
  }

  if (input.mode === 'blocking') {
    while (performance.now() < deadline) runBatch()
  } else {
    while (performance.now() < deadline) {
      checkCancellation()
      const sliceDeadline = Math.min(deadline, performance.now() + sliceMs)
      while (performance.now() < sliceDeadline) runBatch()
      await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    }
    checkCancellation()
  }

  const elapsedMs = Math.round(performance.now() - startedAt)
  emit({
    type: 'browser-native-cpu-contention-stage',
    stage: 'completed',
    mode: input.mode,
    sessionId: input.sessionId,
    callId: input.callId,
    at: Date.now(),
    elapsedMs,
  })
  return { mode: input.mode, elapsedMs, iterations, checksum: accumulator }
}
