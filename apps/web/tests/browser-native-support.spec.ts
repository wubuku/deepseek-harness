import { describe, expect, it } from 'vitest'
import {
  browserNativeSupportIssue,
  type BrowserNativeSupportEnvironment,
} from '../src/browser-native-support.ts'

const chromiumDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
const edgeDesktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0'
const safariDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const firefoxDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0'
const androidChrome = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36'

const supported: BrowserNativeSupportEnvironment = {
  userAgent: chromiumDesktop,
  dedicatedWorker: true,
  messageChannel: true,
  opfs: true,
  indexedDb: true,
  subtleCrypto: true,
}

describe('browserNativeSupportIssue', () => {
  it('accepts Chromium desktop browsers with every required capability', () => {
    expect(browserNativeSupportIssue(supported)).toBeUndefined()
    expect(browserNativeSupportIssue({ ...supported, userAgent: edgeDesktop })).toBeUndefined()
  })

  it('rejects Safari, Firefox, and mobile browsers before capability checks', () => {
    for (const userAgent of [safariDesktop, firefoxDesktop, androidChrome]) {
      expect(browserNativeSupportIssue({ ...supported, userAgent })).toBe('NON_CHROMIUM_DESKTOP')
    }
  })

  it('reports the first missing capability in gate order', () => {
    expect(browserNativeSupportIssue({ ...supported, dedicatedWorker: false })).toBe('NO_DEDICATED_WORKER')
    expect(browserNativeSupportIssue({ ...supported, messageChannel: false })).toBe('NO_MESSAGE_CHANNEL')
    expect(browserNativeSupportIssue({ ...supported, opfs: false })).toBe('NO_OPFS')
    expect(browserNativeSupportIssue({ ...supported, indexedDb: false })).toBe('NO_INDEXED_DB')
    expect(browserNativeSupportIssue({ ...supported, subtleCrypto: false })).toBe('NO_SUBTLE_CRYPTO')
  })
})
