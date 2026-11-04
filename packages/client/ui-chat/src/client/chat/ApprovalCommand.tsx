/** Chat-owned approval detail resolving a correlated Tool call's arguments. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import css from './ApprovalCommand.module.css'

interface ApprovalToolCall {
  readonly callId: string
  readonly argsRaw: string
}

/**
 * Parse a correlated Tool call's arguments as a non-empty object.
 * @param call - Tool call arguments, when a correlated call exists.
 * @returns parsed arguments, or undefined for absent, malformed, or empty ones.
 */
export function argumentsOf(call: ApprovalToolCall | undefined): Record<string, unknown> | undefined {
  if (call === undefined) return undefined
  try {
    const args: unknown = JSON.parse(call.argsRaw)
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
    const record = args as Record<string, unknown>
    return Object.keys(record).length === 0 ? undefined : record
  } catch {
    return undefined
  }
}

/**
 * Render the correlated Tool call behind an approval: its shell command when it
 * has one, otherwise every argument so the card shows what will be executed.
 * @param props - Approval identity and Session-standard Chat selector hook.
 * @returns command text, an argument block, or null when nothing is correlated.
 */
export function ApprovalCommand({ callId, useChat }: PropsRuntime<'conversation.approval.detail'>) {
  const call = useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root) && root.phase === 'start') return root
    }
    return undefined
  })
  if (call === undefined) return null
  const args = argumentsOf(call)
  if (args === undefined) return null
  if (typeof args.command === 'string') return args.command
  return (
    <pre data-approval-arguments="" className={css.arguments}>
      {JSON.stringify(args, null, 2)}
    </pre>
  )
}
