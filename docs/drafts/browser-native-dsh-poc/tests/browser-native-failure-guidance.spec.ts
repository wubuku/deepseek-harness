import { describe, expect, it } from 'vitest'
import {
  browserNativeFailureActionResultCopy,
  browserNativeFailureCodeForState,
  browserNativeFailureGuidanceCopy,
} from '../../../../apps/web/src/locales/browser-native-failure-guidance.ts'

describe('browser-native failure guidance', () => {
  it('explains a write-lease conflict and offers a reload', () => {
    const guidance = browserNativeFailureGuidanceCopy('en', 'SESSION_ALREADY_OWNED')
    expect(guidance.title).toBe('This Session is open in another tab')
    expect(guidance.action).toBe('reload')
    expect(guidance.actionLabel).toBe('Reload and take over')
    expect(guidance.explanation).toContain('Only one tab')
    expect(guidance.diagnostics).toBe(false)
    expect(browserNativeFailureGuidanceCopy('zh', 'SESSION_ALREADY_OWNED').title).toBe('该会话已在另一个标签页写入')
  })

  it('routes an exhausted token budget to an administrator and the diagnostics bundle', () => {
    const guidance = browserNativeFailureGuidanceCopy('en', 'TOKEN_BUDGET_EXCEEDED', { sessionId: 's-1', turn: 3 })
    expect(guidance.action).toBe('contact-admin')
    expect(guidance.diagnostics).toBe(true)
    expect(guidance.copyText).toContain('s-1')
    expect(guidance.copyText).toContain('TOKEN_BUDGET_EXCEEDED')
    expect(guidance.copyText).toContain('turn 3')
    expect(guidance.copyText).not.toContain('{session}')
    const zh = browserNativeFailureGuidanceCopy('zh', 'TOKEN_BUDGET_EXCEEDED', { sessionId: 's-1' })
    expect(zh.actionLabel).toBe('复制管理员说明')
    expect(zh.copyText).toContain('s-1')
  })

  it('routes a read-only share to a copyable access request', () => {
    const guidance = browserNativeFailureGuidanceCopy('en', 'SESSION_READ_ONLY', { sessionId: 's-2' })
    expect(guidance.action).toBe('request-access')
    expect(guidance.copyText).toContain('s-2')
    expect(guidance.copyText).toContain('editor access')
    expect(browserNativeFailureGuidanceCopy('zh', 'SESSION_READ_ONLY').actionLabel).toBe('复制权限申请')
  })

  it('maps blocking Workspace states to the same codes', () => {
    expect(browserNativeFailureCodeForState('session-conflict')).toBe('SESSION_ALREADY_OWNED')
    expect(browserNativeFailureCodeForState('lease-conflict')).toBe('SESSION_EDITOR_LEASE_HELD')
    expect(browserNativeFailureCodeForState('read-only')).toBe('SESSION_READ_ONLY')
    expect(browserNativeFailureCodeForState('stale')).toBe('WORKSPACE_SNAPSHOT_STALE')
    expect(browserNativeFailureCodeForState('synced')).toBeUndefined()
  })

  it('keeps one retry and the diagnostics bundle for unknown codes', () => {
    const guidance = browserNativeFailureGuidanceCopy('en', undefined)
    expect(guidance.code).toBe('UNKNOWN_FAILURE')
    expect(guidance.action).toBe('retry')
    expect(guidance.diagnostics).toBe(true)
    expect(browserNativeFailureGuidanceCopy('en', 'UNLISTED_CODE').code).toBe('UNLISTED_CODE')
    expect(browserNativeFailureGuidanceCopy('en', 'UNLISTED_CODE').action).toBe('retry')
  })

  it('does not offer a blind retry for codes that need intervention', () => {
    for (const code of ['SESSION_ALREADY_OWNED', 'SESSION_READ_ONLY', 'TOKEN_BUDGET_EXCEEDED', 'UPSTREAM_LLM_AUTH_FAILED']) {
      expect(browserNativeFailureGuidanceCopy('en', code).action).not.toBe('retry')
    }
    expect(browserNativeFailureGuidanceCopy('en', 'UPSTREAM_LLM_TIMEOUT').action).toBe('retry')
  })

  it('reports the copy and diagnostics outcomes', () => {
    expect(browserNativeFailureActionResultCopy('en', 'request-access', true, 'SESSION_READ_ONLY')).toContain('copied')
    expect(browserNativeFailureActionResultCopy('zh', 'request-access', false, 'SESSION_READ_ONLY')).toContain('SESSION_READ_ONLY')
    expect(browserNativeFailureActionResultCopy('en', 'diagnostics', true, 'X')).toContain('exported')
    expect(browserNativeFailureActionResultCopy('zh', 'diagnostics', false, 'X')).toContain('X')
  })
})
