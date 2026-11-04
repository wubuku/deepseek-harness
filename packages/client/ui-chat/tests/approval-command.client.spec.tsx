// @vitest-environment jsdom
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApprovalCommand, argumentsOf } from '../src/client/chat/ApprovalCommand.tsx'

function props(
  nodes: readonly unknown[],
  callId = 'call-1',
): PropsRuntime<'conversation.approval.detail'> {
  const snapshot = {
    nodes: { values: () => nodes },
  } as unknown as ChatSnapshot
  const useChat = ((selector: (value: ChatSnapshot) => unknown) => selector(snapshot)) as UseChat
  return { callId, useChat } as PropsRuntime<'conversation.approval.detail'>
}

describe('argumentsOf', () => {
  it('parses non-empty argument objects and rejects other JSON values', () => {
    expect(argumentsOf(undefined)).toBeUndefined()
    expect(argumentsOf({ callId: 'c1', argsRaw: '{' })).toBeUndefined()
    expect(argumentsOf({ callId: 'c1', argsRaw: '{}' })).toBeUndefined()
    expect(argumentsOf({ callId: 'c1', argsRaw: '[]' })).toBeUndefined()
    expect(argumentsOf({ callId: 'c1', argsRaw: '{"file_path":"/dsh/home/a.txt","content":"A"}' }))
      .toEqual({ file_path: '/dsh/home/a.txt', content: 'A' })
  })
})

describe('ApprovalCommand', () => {
  it('renders the running correlated Tool command', () => {
    render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{"command":"wrong"}'), callId: 'other', argsRaw: '{"command":"wrong"}' } } },
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{"command":"pnpm test"}'), callId: 'call-1', argsRaw: '{"command":"pnpm test"}' } } },
    ] as never)} />)

    expect(screen.getByText('pnpm test')).toBeTruthy()
  })

  it('renders every argument when the correlated Tool call has no command', () => {
    const { container } = render(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{"file_path":"/dsh/home/a.txt","content":"A"}'), callId: 'call-1', argsRaw: '{"file_path":"/dsh/home/a.txt","content":"A"}' } } },
    ] as never)} />)

    const block = container.querySelector('[data-approval-arguments]')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('/dsh/home/a.txt')
    expect(block?.textContent).toContain('"content": "A"')
  })

  it('omits absent, uncorrelated, preparing, and settled Tool calls', () => {
    const { container, rerender } = render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: undefined } },
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{}'), callId: 'other', argsRaw: '{}' } } },
      { kind: 'tool-call', data: { root: { phase: 'preparing', args: PartialArguments.EMPTY, callId: 'call-1', name: 'bash' } } },
      {
        kind: 'tool-call',
        data: { root: { kind: 'tool-result', callId: 'call-1', argsRaw: '{"command":"ignored"}' } },
      },
    ] as never)} />)
    expect(container.textContent).toBe('')

    rerender(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{}'), callId: 'call-1', argsRaw: '{}' } } },
    ] as never)} />)
    expect(container.textContent).toBe('')
  })
})
