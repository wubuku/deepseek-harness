export interface BrowserNativeFrontendToolRequest {
  readonly type: 'browser-native-frontend-tool-request'
  readonly requestId: string
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
}

export interface BrowserNativeFrontendToolCancel {
  readonly type: 'browser-native-frontend-tool-cancel'
  readonly sessionId: string
  readonly callId: string
}

export interface BrowserNativeFrontendToolResponse {
  readonly type: 'browser-native-frontend-tool-response'
  readonly requestId: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

interface PendingResponse {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly signal?: AbortSignal
}

let controlPort: MessagePort | undefined
const pendingResponses = new Map<string, PendingResponse>()

/** Attach the page-owned bridge used by Worker-side DSH tools and question answerers. */
export function setCopilotKitControlPort(port: MessagePort): void {
  controlPort?.close()
  controlPort = port
  controlPort.addEventListener('message', event => {
    const data = event.data as BrowserNativeFrontendToolResponse | null
    if (data?.type !== 'browser-native-frontend-tool-response') return
    const pending = pendingResponses.get(data.requestId)
    if (pending === undefined) return
    pendingResponses.delete(data.requestId)
    if (data.ok) pending.resolve(data.result)
    else pending.reject(new Error(data.error ?? 'Browser-native frontend tool failed'))
  })
  controlPort.start()
}

/** Ask the page to execute a CopilotKit-owned capability and await its result. */
export function requestCopilotKitFrontendTool(input: {
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly signal?: AbortSignal
}): Promise<unknown> {
  const port = controlPort
  if (port === undefined) return Promise.reject(new Error('CopilotKit frontend bridge is not connected'))
  const requestId = globalThis.crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const pending: PendingResponse = { resolve, reject, signal: input.signal }
    pendingResponses.set(requestId, pending)
    const abort = (): void => {
      if (!pendingResponses.delete(requestId)) return
      port.postMessage({
        type: 'browser-native-frontend-tool-cancel',
        sessionId: input.sessionId,
        callId: input.callId,
      } satisfies BrowserNativeFrontendToolCancel)
      reject(input.signal?.reason ?? new Error('Browser-native frontend tool was cancelled'))
    }
    if (input.signal?.aborted === true) {
      abort()
      return
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    port.postMessage({
      type: 'browser-native-frontend-tool-request',
      requestId,
      sessionId: input.sessionId,
      callId: input.callId,
      name: input.name,
      arguments: input.arguments,
    } satisfies BrowserNativeFrontendToolRequest)
  })
}
