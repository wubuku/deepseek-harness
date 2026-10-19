/** Exact-call mailbox; CopilotKit results settle it only on the next protocol segment. */
import { FrontendBridge, type PendingCall } from '../src/frontend-bridge.ts'
export type { PendingCall }

/** Keep the Worker waiter open until CopilotKit submits its original call result. */
export class FrontendBridgeWithSegments extends FrontendBridge {
  context: unknown = []
  readonly executions: { callId: string; name: string; channel: string }[] = []

  /** Require the original pending call before executing a framework-owned callback.
   * @param callId - Original DSH call identity, never a newly generated id.
   * @param name - Registered tool expected by that waiter.
   * @param execute - Framework callback using the existing SaaS command.
   * @returns The callback result, without settling the Worker waiter.
   */
  executeNative(callId: string, name: string, execute: (call: PendingCall) => Promise<unknown>): Promise<unknown> {
    const call = this.getSnapshot().find(item => item.callId === callId && item.name === name)
    if (!call || call.signal.aborted) return Promise.reject(new Error('原 DSH 调用已结束，不能执行迟到操作'))
    this.executions.push({ callId, name, channel: 'copilot-native' })
    return execute(call)
  }
}

export { FrontendBridgeWithSegments as FrontendBridge }
