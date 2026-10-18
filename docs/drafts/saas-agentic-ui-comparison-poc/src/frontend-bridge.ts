/** Exact DSH call identity and cancellation for all three presentation adapters. */
import { z } from 'zod'

const requestSchema = z.object({
  type: z.literal('browser-native-frontend-tool-request'),
  requestId: z.string().min(1), sessionId: z.string().min(1), callId: z.string().min(1),
  name: z.string().min(1), arguments: z.unknown(),
})
export type Invocation = z.infer<typeof requestSchema>
export interface PendingCall extends Invocation { readonly signal: AbortSignal }
type Handler = (args: unknown, invocation: PendingCall) => Promise<unknown> | unknown
interface Waiter { call: PendingCall; abort: AbortController }

export class FrontendBridge {
  private handlers = new Map<string, Handler>()
  private pending = new Map<string, Waiter>()
  private completed = new Map<string, { fingerprint: string; response: { ok: boolean; result?: unknown; error?: string } }>()
  private listeners = new Set<() => void>()
  private snapshot: readonly PendingCall[] = []
  private disposed = false

  constructor(private readonly port: Pick<MessagePort, 'postMessage'>) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = (): readonly PendingCall[] => this.snapshot

  register(name: string, handler: Handler): () => void {
    if (this.handlers.has(name)) throw new Error(`duplicate page handler: ${name}`)
    this.handlers.set(name, handler)
    return () => { if (this.handlers.get(name) === handler) this.handlers.delete(name) }
  }

  handleRequest(value: unknown): void {
    const request = requestSchema.parse(value)
    const fingerprint = JSON.stringify([request.sessionId, request.name, request.arguments])
    const done = this.completed.get(request.callId)
    if (done !== undefined) {
      this.respond(request.requestId, done.fingerprint === fingerprint ? done.response : { ok: false, error: 'DSH call identity conflict' })
      return
    }
    const current = this.pending.get(request.callId)
    if (current !== undefined) {
      if (current.call.requestId !== request.requestId) this.respond(request.requestId, { ok: false, error: 'duplicate active DSH call id' })
      return
    }
    const handler = this.handlers.get(request.name)
    if (this.disposed || handler === undefined) {
      this.respond(request.requestId, { ok: false, error: 'page capability unavailable' })
      return
    }
    const abort = new AbortController()
    const call: PendingCall = { ...request, signal: abort.signal }
    this.pending.set(request.callId, { call, abort })
    this.publish()
    Promise.resolve().then(() => {
      if (!this.pending.has(request.callId) || abort.signal.aborted) return undefined
      return handler(request.arguments, call)
    }).then(
      result => { if (result !== undefined) this.resolve(request.callId, result) },
      error => { this.reject(request.callId, error) },
    )
  }

  resolve(callId: string, result: unknown): boolean { return this.settle(callId, { ok: true, result }) }
  reject(callId: string, error: unknown): boolean { return this.settle(callId, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  cancel(callId: string): boolean {
    const pending = this.pending.get(callId)
    if (pending === undefined) return false
    pending.abort.abort(new Error('用户停止了操作'))
    return this.reject(callId, new Error('用户停止了操作'))
  }
  dispose(): void {
    this.disposed = true
    for (const callId of this.pending.keys()) this.cancel(callId)
    this.handlers.clear()
    this.listeners.clear()
  }
  private settle(callId: string, response: { ok: boolean; result?: unknown; error?: string }): boolean {
    const pending = this.pending.get(callId)
    if (pending === undefined) return false
    this.pending.delete(callId)
    this.completed.set(callId, { fingerprint: JSON.stringify([pending.call.sessionId, pending.call.name, pending.call.arguments]), response })
    this.respond(pending.call.requestId, response)
    this.publish()
    return true
  }
  private respond(requestId: string, response: { ok: boolean; result?: unknown; error?: string }): void {
    this.port.postMessage({ type: 'browser-native-frontend-tool-response', requestId, ...response })
  }
  private publish(): void { this.snapshot = [...this.pending.values()].map(value => value.call); for (const listener of this.listeners) listener() }
}
