import { describe, expect, it } from 'vitest'
import {
  browserNativeDurableApprovalCopy,
  browserNativeDurableRouteCopy,
  browserNativeFirstUseCopy,
  browserNativeOfflineStatusCopy,
  browserNativeQueueStatusCopy,
  browserNativeRecoveryErrorCopy,
  browserNativeSessionExportCopy,
  browserNativeSessionExportResultCopy,
  browserNativeSessionRetryCopy,
  browserNativeSupportBundleCopy,
  browserNativeSupportBundleResultCopy,
  browserNativeUnsupportedBrowserCopy,
  browserNativeWorkspaceRecoveryExportCopy,
  browserNativeWorkspaceRecoveryResultCopy,
  browserNativeWorkspaceRecoveryWarningCopy,
  browserNativeWorkspaceRefreshCopy,
  browserNativeWorkspaceRetryCopy,
  browserNativeWorkspaceStatusCopy,
  browserNativeWorkspaceSwitcherCopy,
} from '../src/locales/browser-native-workspace.ts'

/** Assert that both locales carry non-empty, distinct text and keep their numbers. */
function expectLocalized(en: string, zh: string, tokens: readonly string[] = []): void {
  expect(en.trim().length).toBeGreaterThan(0)
  expect(zh.trim().length).toBeGreaterThan(0)
  expect(zh).not.toBe(en)
  for (const token of tokens) {
    expect(en).toContain(token)
    expect(zh).toContain(token)
  }
}

describe('browser-native copy', () => {
  it('localizes every workspace state', () => {
    const states = [
      'loading', 'synced', 'dirty', 'syncing', 'error', 'conflict', 'local-corrupt', 'local-newer-version',
      'lease-conflict', 'recovery-conflict', 'recovery-unavailable', 'identity-missing', 'identity-mismatch',
      'read-only', 'stale', 'session-conflict',
    ] as const
    for (const state of states) {
      expectLocalized(
        browserNativeWorkspaceStatusCopy(state, 'en-US', undefined, 0),
        browserNativeWorkspaceStatusCopy(state, 'zh-CN', undefined, 0),
      )
      expectLocalized(
        browserNativeWorkspaceStatusCopy(state, 'en-US', 7, 2),
        browserNativeWorkspaceStatusCopy(state, 'zh-CN', 7, 2),
        ['r7', '2'],
      )
    }
  })

  it('localizes the workspace switcher', () => {
    const en = browserNativeWorkspaceSwitcherCopy('en-US')
    const zh = browserNativeWorkspaceSwitcherCopy('zh-CN')
    for (const key of ['label', 'create', 'empty', 'loadFailed', 'createFailed', 'switchFailed'] as const) {
      expectLocalized(en[key], zh[key])
    }
    expectLocalized(en.fileCount(5), zh.fileCount(5), ['5'])
  })

  it('localizes the admission queue position', () => {
    expectLocalized(
      browserNativeQueueStatusCopy('en-US', 2, 3, 4, 8),
      browserNativeQueueStatusCopy('zh-CN', 2, 3, 4, 8),
      ['2', '3', '4', '8'],
    )
    expectLocalized(
      browserNativeQueueStatusCopy('en-US', 1, 1, 1, undefined),
      browserNativeQueueStatusCopy('zh-CN', 1, 1, 1, undefined),
      ['1'],
    )
  })

  it('localizes every connectivity state', () => {
    for (const state of ['offline', 'replaying', 'online'] as const) {
      expectLocalized(
        browserNativeOfflineStatusCopy('en-US', state, 3),
        browserNativeOfflineStatusCopy('zh-CN', state, 3),
        state === 'online' ? [] : ['3'],
      )
    }
  })

  it('localizes every unsupported-browser reason', () => {
    for (const issue of ['NON_CHROMIUM_DESKTOP', 'NO_DEDICATED_WORKER', 'NO_MESSAGE_CHANNEL', 'NO_OPFS',
      'NO_INDEXED_DB', 'NO_SUBTLE_CRYPTO'] as const) {
      expectLocalized(
        browserNativeUnsupportedBrowserCopy('en-US', issue),
        browserNativeUnsupportedBrowserCopy('zh-CN', issue),
      )
    }
  })

  it('localizes session actions and their results', () => {
    expectLocalized(browserNativeSessionRetryCopy('en-US'), browserNativeSessionRetryCopy('zh-CN'))
    expectLocalized(browserNativeSessionExportCopy('en-US'), browserNativeSessionExportCopy('zh-CN'))
    for (const success of [true, false]) {
      expectLocalized(
        browserNativeSessionExportResultCopy('en-US', success),
        browserNativeSessionExportResultCopy('zh-CN', success),
      )
    }
  })

  it('localizes support-bundle actions and their results', () => {
    expectLocalized(browserNativeSupportBundleCopy('en-US'), browserNativeSupportBundleCopy('zh-CN'))
    for (const success of [true, false]) {
      expectLocalized(
        browserNativeSupportBundleResultCopy('en-US', success),
        browserNativeSupportBundleResultCopy('zh-CN', success),
      )
    }
  })

  it('localizes writer-lease retry and refresh actions', () => {
    expectLocalized(browserNativeWorkspaceRetryCopy('en-US', 1200), browserNativeWorkspaceRetryCopy('zh-CN', 1200), ['2'])
    expectLocalized(browserNativeWorkspaceRetryCopy('en-US', 0), browserNativeWorkspaceRetryCopy('zh-CN', 0))
    for (const stale of [true, false]) {
      expectLocalized(
        browserNativeWorkspaceRefreshCopy('en-US', stale),
        browserNativeWorkspaceRefreshCopy('zh-CN', stale),
      )
    }
  })

  it('localizes recovery guidance and downloads', () => {
    expectLocalized(browserNativeRecoveryErrorCopy('en-US'), browserNativeRecoveryErrorCopy('zh-CN'))
    expectLocalized(
      browserNativeWorkspaceRecoveryWarningCopy('en-US'),
      browserNativeWorkspaceRecoveryWarningCopy('zh-CN'),
      ['64 MiB'],
    )
    expectLocalized(
      browserNativeWorkspaceRecoveryExportCopy('en-US'),
      browserNativeWorkspaceRecoveryExportCopy('zh-CN'),
    )
    for (const success of [true, false]) {
      expectLocalized(
        browserNativeWorkspaceRecoveryResultCopy('en-US', success),
        browserNativeWorkspaceRecoveryResultCopy('zh-CN', success),
      )
    }
  })

  it('localizes the first-use guide field by field', () => {
    const en = browserNativeFirstUseCopy('en-US')
    const zh = browserNativeFirstUseCopy('zh-CN')
    for (const key of ['label', 'title', 'body', 'sampleAction', 'sampleTask', 'dismiss', 'filled',
      'composerMissing'] as const) {
      expectLocalized(en[key], zh[key])
    }
    expect(en.steps).toHaveLength(3)
    expect(zh.steps).toHaveLength(3)
    en.steps.forEach((step, index) => { expectLocalized(step, zh.steps[index] ?? '') })
  })

  it('localizes the durable approval surface with the tool and target', () => {
    const en = browserNativeDurableApprovalCopy('en-US')
    const zh = browserNativeDurableApprovalCopy('zh-CN')
    for (const key of ['waiting', 'approve', 'reject', 'deciding', 'running', 'completed', 'retry'] as const) {
      expectLocalized(en[key], zh[key])
    }
    expectLocalized(en.title('write'), zh.title('write'), ['write'])
    expectLocalized(en.target('/dsh/home/workspace/a.txt'), zh.target('/dsh/home/workspace/a.txt'),
      ['/dsh/home/workspace/a.txt'])
    expectLocalized(en.failed(409), zh.failed(409), ['409'])
    expectLocalized(en.failed(undefined), zh.failed(undefined))
  })

  it('localizes the main composer durable route and its Worker fallback', () => {
    const en = browserNativeDurableRouteCopy('en-US')
    const zh = browserNativeDurableRouteCopy('zh-CN')
    for (const key of ['label', 'durable', 'sessionNotReady', 'waitingWorker', 'queued'] as const) {
      expectLocalized(en[key], zh[key])
    }
    expectLocalized(en.workerFallback('HTTP 503'), zh.workerFallback('HTTP 503'), ['HTTP 503'])
    expectLocalized(en.startUnavailable('timeout'), zh.startUnavailable('timeout'), ['timeout'])
  })

  it('falls back to English for languages without a dictionary', () => {
    expect(browserNativeSessionExportCopy('fr-FR')).toBe(browserNativeSessionExportCopy('en-US'))
    expect(browserNativeWorkspaceStatusCopy('synced', 'fr-FR', undefined, 0))
      .toBe(browserNativeWorkspaceStatusCopy('synced', 'en-US', undefined, 0))
  })
})
