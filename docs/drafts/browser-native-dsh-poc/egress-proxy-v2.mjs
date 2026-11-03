/**
 * Server-side egress proxy for the browser-native DSH PoC.
 *
 * Browser code never holds a provider credential and never chooses an
 * arbitrary destination: each request must match a deployment allowlist entry
 * that names a capability, an origin, a path prefix and the allowed methods.
 * The proxy injects the credential only after that match passes. Responses are
 * redacted so an allowlisted upstream cannot echo the credential back into the
 * Worker, and redirects are never followed.
 */

const ALLOWED_METHODS = new Set(['GET', 'POST'])
const MAX_RESPONSE_BYTES = 64 * 1024
const AUDIT_LIMIT = 200
const REQUEST_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]*$/
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'host',
  'origin',
  'proxy-authorization',
  'referer',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
])
const STRIPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'proxy-authenticate',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'trailer',
  'upgrade',
])
const REDACTED = '[REDACTED]'
const DEFAULT_TIMEOUT_MS = 30_000

/** Typed egress refusal; its message never contains a credential or a URL. */
export class EgressError extends Error {
  /**
   * @param code - Stable error code reported to the client.
   * @param message - Client-safe description.
   * @param status - HTTP status for the proxy response.
   * @param details - Optional non-secret diagnostics such as the rejected host.
   * @param retryAfterMs - Milliseconds until a rate-limited capability may retry.
   */
  constructor(code, message, status = 400, details, retryAfterMs) {
    super(message)
    this.name = 'EgressError'
    this.code = code
    this.status = status
    this.details = details
    this.retryAfterMs = retryAfterMs
  }
}

function parseOrigin(value) {
  let origin
  try {
    origin = new URL(value)
  } catch {
    throw new TypeError('egress allowlist entries need an absolute http(s) origin')
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new TypeError('egress allowlist entries need an http(s) origin')
  }
  if (origin.origin === 'null') throw new TypeError('egress allowlist entries need a concrete host')
  return origin
}

function parsePathPrefix(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`)
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new TypeError(`${label} must be a plain URL path starting with /`)
  }
  if (new URL(value, 'http://egress.invalid').pathname !== value) {
    throw new TypeError(`${label} must be a plain URL path starting with /`)
  }
  return value === '/' ? '/' : value.replace(/\/+$/, '')
}

function parseMethods(value, label) {
  if (value === undefined) return new Set(['GET', 'POST'])
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`)
  const methods = new Set()
  for (const method of value) {
    const normalized = String(method).toUpperCase()
    if (!ALLOWED_METHODS.has(normalized)) throw new TypeError(`${label} may only grant GET or POST`)
    methods.add(normalized)
  }
  return methods
}

function parseRateLimit(value, label) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  if (!Number.isSafeInteger(value.windowMs) || value.windowMs <= 0) {
    throw new TypeError(`${label} windowMs must be a positive safe integer`)
  }
  if (!Number.isSafeInteger(value.maxRequests) || value.maxRequests <= 0) {
    throw new TypeError(`${label} maxRequests must be a positive safe integer`)
  }
  return { windowMs: value.windowMs, maxRequests: value.maxRequests }
}

function assertHeaderName(value, label) {
  const name = String(value).toLowerCase()
  if (!REQUEST_HEADER_PATTERN.test(name)) throw new TypeError(`${label} must be a valid HTTP header name`)
  return name
}

function matchesPathPrefix(pathname, prefix) {
  if (prefix === '/') return pathname.startsWith('/')
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

const ENCODED_PATH_BYTE = /%[0-9A-Fa-f]{2}/

/**
 * Detect a pathname whose percent-decoded form changes path structure.
 *
 * The allowlist compares the raw URL pathname, while an upstream may decode it.
 * Reject encoded separators, NUL, or dot segments before prefix matching so an
 * allowed prefix cannot be turned into a different upstream path.
 * @param pathname - Raw `URL.pathname` from the egress request.
 * @returns Whether one decode pass yields a separator or traversal segment.
 */
function encodedPathEscape(pathname) {
  if (!ENCODED_PATH_BYTE.test(pathname)) return false
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return true
  }
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return true
  return decoded.split('/').some(segment => segment === '.' || segment === '..')
}

function requestIdOf(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && typeof body.requestId === 'string' && body.requestId.length > 0 && body.requestId.length <= 200
    ? body.requestId
    : null
}

/**
 * Describe a client request without reading query parameters, headers or body,
 * so denied requests can still be audited without carrying secrets.
 * @param body - Client JSON.
 * @returns Origin, pathname and method when the URL is parseable; nulls otherwise.
 */
function describeRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.url !== 'string') {
    return { origin: null, path: null, method: null }
  }
  let target
  try {
    target = new URL(body.url)
  } catch {
    return { origin: null, path: null, method: null }
  }
  return {
    origin: target.origin,
    path: target.pathname,
    method: String(body.method ?? 'GET').toUpperCase(),
  }
}

/**
 * Build an egress policy from deployment configuration.
 * @param config - `allow` entries with capability, origin, pathPrefix and optional methods,
 *   credential and rate limit; plus an optional global `rateLimit`, `audit` sink and `timeoutMs`.
 * @returns Policy with an allowlist summary, decision audit ring and `proxy` for forwarding.
 */
export function createEgressPolicy(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('egress config must be an object')
  }
  if (!Array.isArray(config.allow)) throw new TypeError('egress allow must be an array')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new TypeError('egress timeoutMs must be a positive safe integer')
  }
  if (config.audit !== undefined && typeof config.audit !== 'function') {
    throw new TypeError('egress audit must be a function')
  }
  const defaultRateLimit = parseRateLimit(config.rateLimit, 'egress rateLimit')
  const entries = []
  const capabilities = new Set()
  for (const entry of config.allow) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('egress allow entries must be objects')
    }
    if (typeof entry.capability !== 'string' || !CAPABILITY_PATTERN.test(entry.capability)) {
      throw new TypeError('egress allow entries need a lowercase capability name')
    }
    if (capabilities.has(entry.capability)) {
      throw new TypeError(`duplicate egress capability ${entry.capability}`)
    }
    capabilities.add(entry.capability)
    const origin = parseOrigin(entry.origin)
    const pathPrefix = parsePathPrefix(entry.pathPrefix, 'egress pathPrefix')
    const methods = parseMethods(entry.methods, 'egress methods')
    const rateLimit = entry.rateLimit === undefined
      ? defaultRateLimit
      : parseRateLimit(entry.rateLimit, `egress rateLimit for ${entry.capability}`)
    let credential
    if (entry.credential !== undefined) {
      if (entry.credential === null || typeof entry.credential !== 'object' || Array.isArray(entry.credential)) {
        throw new TypeError('egress credential must be an object')
      }
      const header = assertHeaderName(entry.credential.header, 'egress credential header')
      if (header !== 'authorization') throw new TypeError('egress credential header must be authorization')
      if (typeof entry.credential.value !== 'string' || entry.credential.value.length === 0) {
        throw new TypeError('egress credential value must be a non-empty string')
      }
      credential = { header, value: entry.credential.value }
    }
    entries.push({ capability: entry.capability, origin, pathPrefix, methods, credential, rateLimit })
  }
  if (entries.length === 0) throw new TypeError('egress allow must contain at least one entry')
  const byOriginPath = new Set()
  for (const entry of entries) {
    const key = `${entry.origin.origin} ${entry.pathPrefix}`
    if (byOriginPath.has(key)) throw new TypeError(`duplicate egress grant for ${key}`)
    byOriginPath.add(key)
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const redact = (text, credential) => {
    if (credential === undefined) return text
    return text.split(credential.value).join(REDACTED)
  }

  const auditEntries = []
  const record = entry => {
    auditEntries.push(entry)
    if (auditEntries.length > AUDIT_LIMIT) auditEntries.splice(0, auditEntries.length - AUDIT_LIMIT)
    try {
      config.audit?.(entry)
    } catch {
      // An audit sink failure must not change the egress decision.
    }
  }

  const rateBuckets = new Map()
  const checkRateLimit = (entry, now) => {
    if (entry.rateLimit === undefined) return
    const { windowMs, maxRequests } = entry.rateLimit
    const previous = rateBuckets.get(entry.capability)
    const bucket = previous === undefined || now >= previous.windowStart + windowMs
      ? { windowStart: now, count: 0 }
      : previous
    if (bucket.count >= maxRequests) {
      const retryAfterMs = bucket.windowStart + windowMs - now
      throw new EgressError(
        'EGRESS_RATE_LIMITED',
        'egress capability rate limit reached',
        429,
        { capability: entry.capability, retryAfterMs },
        retryAfterMs,
      )
    }
    bucket.count += 1
    rateBuckets.set(entry.capability, bucket)
  }

  /**
   * Validate a client request against the capability allowlist.
   * @param body - Client JSON with `url`, optional `method`, `headers`, and `body`.
   * @returns Validated upstream request description bound to its capability.
   */
  const resolve = body => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new EgressError('EGRESS_INVALID_REQUEST', 'egress request must be an object')
    }
    if (typeof body.url !== 'string' || body.url.length === 0) {
      throw new EgressError('EGRESS_INVALID_REQUEST', 'egress request needs a url string')
    }
    let target
    try {
      target = new URL(body.url)
    } catch {
      throw new EgressError('EGRESS_INVALID_REQUEST', 'egress url is not absolute')
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new EgressError('EGRESS_SCHEME_REJECTED', 'egress url must use http or https', 400, { scheme: target.protocol })
    }
    if (target.username !== '' || target.password !== '') {
      throw new EgressError('EGRESS_URL_CREDENTIALS_REJECTED', 'egress url must not embed credentials')
    }
    if (encodedPathEscape(target.pathname)) {
      throw new EgressError('EGRESS_PATH_NOT_ALLOWED', 'egress path contains an encoded separator or traversal segment', 403, { path: target.pathname })
    }
    const candidates = entries.filter(entry => entry.origin.origin === target.origin)
    if (candidates.length === 0) {
      throw new EgressError('EGRESS_HOST_NOT_ALLOWED', 'egress host is not in the allowlist', 403, { host: target.host })
    }
    const matched = candidates
      .filter(entry => matchesPathPrefix(target.pathname, entry.pathPrefix))
      .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length)[0]
    if (matched === undefined) {
      throw new EgressError('EGRESS_PATH_NOT_ALLOWED', 'egress path is not in the capability allowlist', 403,
        { path: target.pathname })
    }
    const method = String(body.method ?? 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      throw new EgressError('EGRESS_METHOD_NOT_ALLOWED', 'egress method must be GET or POST', 405,
        { method, capability: matched.capability })
    }
    if (!matched.methods.has(method)) {
      throw new EgressError('EGRESS_METHOD_NOT_ALLOWED', 'egress capability does not allow this method', 405,
        { method, capability: matched.capability })
    }
    checkRateLimit(matched, Date.now())
    const headers = {}
    if (body.headers !== undefined) {
      if (body.headers === null || typeof body.headers !== 'object' || Array.isArray(body.headers)) {
        throw new EgressError('EGRESS_INVALID_REQUEST', 'egress headers must be an object')
      }
      for (const [rawName, rawValue] of Object.entries(body.headers)) {
        const name = assertHeaderName(rawName, 'egress request header')
        if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
          throw new EgressError('EGRESS_FORBIDDEN_HEADER', `egress request must not set ${name}`, 400, { header: name })
        }
        if (typeof rawValue !== 'string') {
          throw new EgressError('EGRESS_INVALID_REQUEST', 'egress header values must be strings')
        }
        if (redact(rawValue, matched.credential) !== rawValue) {
          throw new EgressError('EGRESS_FORBIDDEN_HEADER', 'egress request must not carry the credential', 400, { header: name })
        }
        headers[name] = rawValue
      }
    }
    if (body.body !== undefined && typeof body.body !== 'string') {
      throw new EgressError('EGRESS_INVALID_REQUEST', 'egress body must be a string')
    }
    if (method === 'GET' && body.body !== undefined) {
      throw new EgressError('EGRESS_INVALID_REQUEST', 'egress GET must not carry a body')
    }
    if (matched.credential !== undefined) headers[matched.credential.header] = matched.credential.value
    return {
      url: target.toString(),
      origin: target.origin,
      path: target.pathname,
      capability: matched.capability,
      method,
      headers,
      ...(body.body === undefined ? {} : { body: redact(body.body, matched.credential) }),
      credential: matched.credential,
    }
  }

  /**
   * Forward one validated request and return the redacted response.
   * @param body - Client JSON forwarded through `resolve`.
   * @returns Status, filtered headers, redacted text body, and credential evidence.
   */
  const proxy = async body => {
    const startedAt = Date.now()
    let request
    try {
      request = resolve(body)
    } catch (error) {
      const described = describeRequest(body)
      const code = error instanceof EgressError ? error.code : 'EGRESS_INVALID_REQUEST'
      record({
        at: new Date(startedAt).toISOString(),
        requestId: requestIdOf(body),
        decision: 'deny',
        capability: error instanceof EgressError ? error.details?.capability ?? null : null,
        origin: described.origin,
        path: described.path,
        method: described.method,
        code,
        status: error instanceof EgressError ? error.status : 500,
        durationMs: Date.now() - startedAt,
        ...(error instanceof EgressError && error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      })
      throw error
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let upstream
    try {
      upstream = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch {
      const error = new EgressError('EGRESS_UPSTREAM_UNREACHABLE',
        controller.signal.aborted ? 'egress upstream did not respond in time' : 'egress upstream could not be reached',
        502, { host: new URL(request.url).host })
      record({
        at: new Date(startedAt).toISOString(),
        requestId: requestIdOf(body),
        decision: 'deny',
        capability: request.capability,
        origin: request.origin,
        path: request.path,
        method: request.method,
        code: error.code,
        status: error.status,
        durationMs: Date.now() - startedAt,
      })
      throw error
    } finally {
      clearTimeout(timer)
    }
    const headers = {}
    for (const [name, value] of upstream.headers.entries()) {
      if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
      headers[name] = redact(value, request.credential)
    }
    const raw = Buffer.from(await upstream.arrayBuffer())
    const truncated = raw.length > MAX_RESPONSE_BYTES
    const text = redact(raw.subarray(0, MAX_RESPONSE_BYTES).toString('utf8'), request.credential)
    record({
      at: new Date(startedAt).toISOString(),
      requestId: requestIdOf(body),
      decision: 'allow',
      capability: request.capability,
      origin: request.origin,
      path: request.path,
      method: request.method,
      code: null,
      status: upstream.status,
      upstreamStatus: upstream.status,
      durationMs: Date.now() - startedAt,
      credentialInjected: request.credential !== undefined,
      truncated,
    })
    return {
      status: upstream.status,
      origin: request.origin,
      method: request.method,
      credentialInjected: request.credential !== undefined,
      truncated,
      headers,
      body: text,
      redirect: upstream.status >= 300 && upstream.status < 400,
    }
  }

  return {
    allowlist: entries.map(entry => ({
      capability: entry.capability,
      origin: entry.origin.origin,
      pathPrefix: entry.pathPrefix,
      methods: [...entry.methods].sort(),
      ...(entry.rateLimit === undefined ? {} : { rateLimit: entry.rateLimit }),
    })),
    proxy,
    resolve,
    audit: () => auditEntries.map(entry => ({ ...entry })),
  }
}
