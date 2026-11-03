/** Worker-realm reachability probe for network, credential and cross-origin access. */

/** One fetch attempt performed inside the Dedicated Worker realm. */
export interface BrowserNativeIsolationFetch {
  readonly label: string
  readonly ok: boolean
  readonly status?: number
  readonly type?: string
  readonly body?: string
  readonly error?: string
}

/** Globals and network outcomes that decide what a Worker-side tool can reach. */
export interface BrowserNativeIsolationReport {
  readonly realm: {
    readonly origin: string
    readonly crossOriginIsolated: boolean
    readonly hasDocument: boolean
    readonly hasWindow: boolean
    readonly hasProcess: boolean
    readonly hasLocalStorage: boolean
    readonly hasSessionStorage: boolean
    readonly hasCookieStore: boolean
    readonly hasIndexedDB: boolean
    readonly hasFetch: boolean
    readonly hasRequire: boolean
    readonly processEnvKeys: readonly string[]
  }
  readonly sameOrigin?: BrowserNativeIsolationFetch
  readonly cors?: BrowserNativeIsolationFetch
  readonly noCors?: BrowserNativeIsolationFetch
  readonly cookie?: BrowserNativeIsolationFetch
  readonly corp?: BrowserNativeIsolationFetch
  readonly noCorp?: BrowserNativeIsolationFetch
}

const MAX_BODY_CHARS = 200

async function attempt(
  label: string,
  url: string | undefined,
  init: RequestInit,
): Promise<BrowserNativeIsolationFetch | undefined> {
  if (url === undefined) return undefined
  try {
    const response = await fetch(url, init)
    let body: string
    try {
      body = (await response.text()).slice(0, MAX_BODY_CHARS)
    } catch (error) {
      body = `body-unreadable: ${error instanceof Error ? error.name : 'unknown'}`
    }
    return { label, ok: true, status: response.status, type: response.type, body }
  } catch (error) {
    return {
      label,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

/**
 * Probe the Worker realm and its outbound reachability.
 * @param urls - Absolute HTTP(S) targets keyed by case; missing keys are skipped.
 * @returns Realm facts plus each fetch outcome, including opaque and blocked results.
 */
export async function runBrowserNativeIsolationProbe(
  urls: Readonly<Record<string, string>>,
): Promise<BrowserNativeIsolationReport> {
  const globals = globalThis as Record<string, unknown>
  const processValue = globals.process as { env?: Record<string, string | undefined> } | undefined
  return {
    realm: {
      origin: self.location.origin,
      crossOriginIsolated: self.crossOriginIsolated,
      hasDocument: typeof globals.document !== 'undefined',
      hasWindow: typeof globals.window !== 'undefined',
      hasProcess: typeof globals.process !== 'undefined',
      hasLocalStorage: typeof globals.localStorage !== 'undefined',
      hasSessionStorage: typeof globals.sessionStorage !== 'undefined',
      hasCookieStore: typeof globals.cookieStore !== 'undefined',
      hasIndexedDB: typeof globals.indexedDB !== 'undefined',
      hasFetch: typeof globals.fetch === 'function',
      hasRequire: typeof globals.require === 'function',
      processEnvKeys: Object.keys(processValue?.env ?? {}).sort(),
    },
    sameOrigin: await attempt('same-origin', urls.sameOrigin, { mode: 'cors' }),
    cors: await attempt('cors', urls.cors, { mode: 'cors' }),
    noCors: await attempt('no-cors-opaque', urls.noCors, { mode: 'no-cors', credentials: 'include' }),
    cookie: await attempt('cross-origin-credentials', urls.cookie, { mode: 'cors', credentials: 'include' }),
    corp: await attempt('corp-opaque', urls.corp, { mode: 'no-cors' }),
    noCorp: await attempt('cors-without-corp', urls.noCorp, { mode: 'cors' }),
  }
}
