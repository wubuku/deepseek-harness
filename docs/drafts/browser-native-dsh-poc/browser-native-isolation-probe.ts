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
const MAX_EGRESS_BODY_CHARS = 1_000

/** One allowlist decision observed from inside the Dedicated Worker. */
export interface BrowserNativeEgressAttempt {
  readonly label: string
  readonly status?: number
  readonly code?: string
  readonly body?: string
  readonly error?: string
}

/** Absolute targets for the Worker-side egress probe. */
export interface BrowserNativeEgressTargets {
  readonly proxy: string
  readonly allowed: string
  readonly blocked: string
  readonly headerInjection: string
  readonly scheme: string
  readonly redirect: string
  readonly leak: string
  readonly direct: string
  readonly pathOutside: string
  readonly pathBoundary: string
  readonly methodDenied: string
  readonly rateLimited: string
}

/** Allowlist outcomes plus the Worker realm facts that matter for credentials. */
export interface BrowserNativeEgressReport {
  readonly processEnvKeys: readonly string[]
  readonly allowlisted: BrowserNativeEgressAttempt
  readonly blockedHost: BrowserNativeEgressAttempt
  readonly injectedHeader: BrowserNativeEgressAttempt
  readonly invalidScheme: BrowserNativeEgressAttempt
  readonly redirect: BrowserNativeEgressAttempt
  readonly echoedCredential: BrowserNativeEgressAttempt
  readonly directFetch: BrowserNativeEgressAttempt
  readonly pathOutside: BrowserNativeEgressAttempt
  readonly pathBoundary: BrowserNativeEgressAttempt
  readonly methodDenied: BrowserNativeEgressAttempt
  readonly rateLimited: readonly BrowserNativeEgressAttempt[]
}

async function proxyAttempt(
  proxy: string,
  label: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<BrowserNativeEgressAttempt> {
  try {
    const response = await fetch(proxy, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: `egress-${label}`, ...payload }),
    })
    const body = (await response.text()).slice(0, MAX_EGRESS_BODY_CHARS)
    let code: string | undefined
    try {
      code = (JSON.parse(body) as { error?: { code?: string } }).error?.code
    } catch {
      code = undefined
    }
    return { label, status: response.status, ...(code === undefined ? {} : { code }), body }
  } catch (error) {
    return {
      label,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

/**
 * Probe server-mediated egress from the Worker realm.
 * @param targets - Proxy endpoint and per-case absolute URLs.
 * @returns Proxy decisions and the direct-fetch outcome under the page CSP.
 */
export async function runBrowserNativeEgressProbe(
  targets: BrowserNativeEgressTargets,
): Promise<BrowserNativeEgressReport> {
  const globals = globalThis as Record<string, unknown>
  const processValue = globals.process as { env?: Record<string, string | undefined> } | undefined
  const rateLimited: BrowserNativeEgressAttempt[] = []
  for (let index = 1; index <= 4; index += 1) {
    rateLimited.push(await proxyAttempt(targets.proxy, `rate-${String(index)}`, { url: targets.rateLimited }))
  }
  return {
    processEnvKeys: Object.keys(processValue?.env ?? {}).sort(),
    allowlisted: await proxyAttempt(targets.proxy, 'allowlisted', { url: targets.allowed }),
    blockedHost: await proxyAttempt(targets.proxy, 'blocked-host', { url: targets.blocked }),
    injectedHeader: await proxyAttempt(targets.proxy, 'injected-header', {
      url: targets.headerInjection,
      headers: { authorization: 'Bearer worker-supplied' },
    }),
    invalidScheme: await proxyAttempt(targets.proxy, 'invalid-scheme', { url: targets.scheme }),
    redirect: await proxyAttempt(targets.proxy, 'redirect', { url: targets.redirect }),
    echoedCredential: await proxyAttempt(targets.proxy, 'echoed-credential', { url: targets.leak }),
    directFetch: await attempt('direct-fetch', targets.direct, { mode: 'cors' }),
    pathOutside: await proxyAttempt(targets.proxy, 'path-outside', { url: targets.pathOutside }),
    pathBoundary: await proxyAttempt(targets.proxy, 'path-boundary', { url: targets.pathBoundary }),
    methodDenied: await proxyAttempt(targets.proxy, 'method-denied', {
      url: targets.methodDenied,
      method: 'POST',
    }),
    rateLimited,
  }
}

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
