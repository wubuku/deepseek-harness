/** Platform requirements the Browser-Native DSH preview checks before booting. */

/** First missing platform requirement, in gate order. */
export type BrowserNativeSupportIssueCode =
  | 'NON_CHROMIUM_DESKTOP'
  | 'NO_DEDICATED_WORKER'
  | 'NO_MESSAGE_CHANNEL'
  | 'NO_OPFS'
  | 'NO_INDEXED_DB'
  | 'NO_SUBTLE_CRYPTO'

/** Capabilities observed in the page, separated from the decision for testing. */
export interface BrowserNativeSupportEnvironment {
  readonly userAgent: string
  readonly dedicatedWorker: boolean
  readonly messageChannel: boolean
  readonly opfs: boolean
  readonly indexedDb: boolean
  readonly subtleCrypto: boolean
}

/**
 * Decide whether the page can host the Browser-Native DSH preview.
 * @param environment - Platform and capability snapshot from the page.
 * @returns Undefined when supported, otherwise the first missing requirement.
 */
export function browserNativeSupportIssue(
  environment: BrowserNativeSupportEnvironment,
): BrowserNativeSupportIssueCode | undefined {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(environment.userAgent)
  const chromium = /(?:Chrome|Chromium|Edg)\//i.test(environment.userAgent)
  if (!chromium || mobile) return 'NON_CHROMIUM_DESKTOP'
  if (!environment.dedicatedWorker) return 'NO_DEDICATED_WORKER'
  if (!environment.messageChannel) return 'NO_MESSAGE_CHANNEL'
  if (!environment.opfs) return 'NO_OPFS'
  if (!environment.indexedDb) return 'NO_INDEXED_DB'
  if (!environment.subtleCrypto) return 'NO_SUBTLE_CRYPTO'
  return undefined
}
