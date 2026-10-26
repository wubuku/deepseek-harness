import { describe, expect, it, vi } from 'vitest'
import {
  handoffBrowserNativeExecution,
  type BrowserNativeExecutionHandoffCheckpoint,
} from '../browser-native-execution-handoff.ts'

const workspace = {
  workspaceId: 'workspace-1',
  revision: 4,
  fencingToken: 7,
}
const session = { ownerEpoch: 3, nextSeq: 20, durableThroughSeq: 19, pendingEvents: 0, pendingWorkspaceReceipts: 0 }

function options(overrides: Partial<Parameters<typeof handoffBrowserNativeExecution>[0]> = {}) {
  return {
    sessionId: 'session-1',
    ownerId: 'worker-a',
    handoffId: 'handoff-1',
    ownerEpoch: 3,
    flushWorkspace: vi.fn(async () => workspace),
    flushSession: vi.fn(async () => session),
    handoffSession: vi.fn(async (_checkpoint: BrowserNativeExecutionHandoffCheckpoint) => ({ ownerToken: 'next-token', ownerEpoch: 4 })),
    releaseWorkspace: vi.fn(async () => {}),
    classifySessionHandoffError: () => 'rejected' as const,
    ...overrides,
  }
}

describe('Browser-Native execution owner handoff', () => {
  it('flushes Workspace, flushes Session, transfers Session, then releases Workspace', async () => {
    const order: string[] = []
    const result = await handoffBrowserNativeExecution(options({
      flushWorkspace: async () => { order.push('workspace'); return workspace },
      flushSession: async () => { order.push('session'); return session },
      handoffSession: async () => { order.push('handoff'); return { ownerToken: 'next-token', ownerEpoch: 4 } },
      releaseWorkspace: async () => { order.push('release') },
    }))

    expect(order).toEqual(['workspace', 'session', 'handoff', 'release'])
    expect(result.state).toBe('complete')
    if (result.state === 'complete') {
      expect(result.handoffId).toBe('handoff-1')
      expect(result.checkpoint).toMatchObject({
        sessionId: 'session-1', ownerEpoch: 3, nextSessionSeq: 20, durableThroughSeq: 19,
        workspaceId: 'workspace-1', workspaceRevision: 4, workspaceFencingToken: 7,
      })
    }
  })

  it('does not transfer Session ownership when Workspace preparation fails', async () => {
    const input = options({ flushWorkspace: async () => { throw new Error('workspace offline') } })
    const result = await handoffBrowserNativeExecution(input)

    expect(result).toMatchObject({ state: 'preparation-failed', stage: 'workspace' })
    expect(input.flushSession).not.toHaveBeenCalled()
    expect(input.handoffSession).not.toHaveBeenCalled()
    expect(input.releaseWorkspace).not.toHaveBeenCalled()
  })

  it('does not transfer Session ownership when the Session durability watermark lags', async () => {
    const input = options({ flushSession: async () => ({ ...session, durableThroughSeq: 17 }) })
    const result = await handoffBrowserNativeExecution(input)

    expect(result).toMatchObject({ state: 'preparation-failed', stage: 'session' })
    expect(input.handoffSession).not.toHaveBeenCalled()
    expect(input.releaseWorkspace).not.toHaveBeenCalled()
  })

  it('rejects unresolved Workspace receipts and local Session outbox events', async () => {
    for (const pending of [
      { ...session, pendingWorkspaceReceipts: 1 },
      { ...session, pendingEvents: 1 },
    ]) {
      const input = options({ flushSession: async () => pending })
      const result = await handoffBrowserNativeExecution(input)
      expect(result.state).toBe('preparation-failed')
      expect(input.handoffSession).not.toHaveBeenCalled()
      expect(input.releaseWorkspace).not.toHaveBeenCalled()
    }
    const staleOwner = options({ flushSession: async () => ({ ...session, ownerEpoch: 2 }) })
    expect((await handoffBrowserNativeExecution(staleOwner)).state).toBe('preparation-failed')
    expect(staleOwner.handoffSession).not.toHaveBeenCalled()
  })

  it('preserves rejected and unknown Session handoff outcomes without releasing Workspace', async () => {
    const rejected = options({ handoffSession: async () => { throw new Error('HANDOFF_BUSY') } })
    expect(await handoffBrowserNativeExecution(rejected)).toMatchObject({ state: 'session-rejected', handoffId: 'handoff-1' })
    expect(rejected.releaseWorkspace).not.toHaveBeenCalled()

    const unknown = options({
      handoffSession: async () => { throw new TypeError('connection lost') },
      classifySessionHandoffError: () => 'unknown',
    })
    expect(await handoffBrowserNativeExecution(unknown)).toMatchObject({ state: 'session-unknown', handoffId: 'handoff-1' })
    expect(unknown.releaseWorkspace).not.toHaveBeenCalled()
  })

  it('reports Workspace release failure after retaining the new Session owner', async () => {
    const input = options({ releaseWorkspace: async () => { throw new TypeError('release response lost') } })
    const result = await handoffBrowserNativeExecution(input)

    expect(result).toMatchObject({ state: 'workspace-release-unknown', nextOwner: { ownerEpoch: 4 } })
  })
})
