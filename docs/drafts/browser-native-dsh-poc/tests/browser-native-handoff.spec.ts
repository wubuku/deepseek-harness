import { describe, expect, it } from 'vitest'
import { BrowserNativeHandoffCoordinator } from '../browser-native-handoff.ts'

const checkpoint = {
  sessionId: 'session-1',
  ownerId: 'browser-worker-1',
  epoch: 1,
  nextSessionSeq: 12,
  workspaceRevision: 4,
  pendingOperationIds: ['operation-1'],
  pendingExecutionIds: ['tool-1'],
} as const

describe('Browser-to-Cloud handoff fencing', () => {
  it('requires a checkpoint and fences the old Worker after transfer', () => {
    const coordinator = new BrowserNativeHandoffCoordinator('session-1')
    const browser = coordinator.claim('browser-worker-1')
    const receipt = coordinator.handoff(browser, checkpoint, 'cloud-worker-1')

    expect(receipt.previous).toEqual(browser)
    expect(receipt.next).toMatchObject({ ownerId: 'cloud-worker-1', epoch: 2, fencingToken: 2 })
    expect(() => coordinator.assertCurrent(browser)).toThrow(/stale/)
    expect(() => coordinator.handoff(browser, checkpoint, 'cloud-worker-2')).toThrow(/stale/)
    expect(() => coordinator.assertCurrent(receipt.next)).not.toThrow()
  })

  it('rejects a checkpoint from another Session or owner', () => {
    const coordinator = new BrowserNativeHandoffCoordinator('session-1')
    const browser = coordinator.claim('browser-worker-1')
    expect(() => coordinator.handoff(browser, { ...checkpoint, sessionId: 'session-2' }, 'cloud-worker-1')).toThrow(/checkpoint/)
    expect(() => coordinator.handoff(browser, { ...checkpoint, ownerId: 'other-worker' }, 'cloud-worker-1')).toThrow(/checkpoint/)
  })

  it('does not allow two active owners and advances fencing after release', () => {
    const coordinator = new BrowserNativeHandoffCoordinator('session-1')
    const first = coordinator.claim('browser-worker-1')
    expect(() => coordinator.claim('cloud-worker-1')).toThrow(/active/)
    coordinator.release(first)
    const second = coordinator.claim('cloud-worker-1')
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
  })
})
