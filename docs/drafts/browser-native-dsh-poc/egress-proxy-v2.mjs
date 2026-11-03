/**
 * Server-side egress proxy for the browser-native DSH PoC.
 *
 * Browser code never holds a provider credential and never chooses an
 * arbitrary destination: each request must name an origin in the deployment
 * allowlist, and the proxy injects the credential after the allowlist passes.
 * Responses are redacted so an allowlisted upstream cannot echo the credential
 * back into the Worker, and redirects are never followed.
 */

const ALLOWED_METHODS = new Set(['GET', 'POST'])
const MAX_RESPONSE_BYTES = 64 * 1024
const REQUEST_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]*$/
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
   */
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'EgressError'
    this.code = code
    this.status = status
    this.details = details
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

function assertHeaderName(value, label) {
  const name = String(value).toLowerCase()
  if (!REQUEST_HEADER_PATTERN.test(name)) throw new TypeError(`${label} must be a valid HTTP header name`)
  return name
}

/**
 * Build an egress policy from deployment configuration.
 * @param config - `allow` entries with an `origin` and an optional credential to inject.
 * @returns Policy with `allowlist` and `proxy` for validated forwarding.
 */
export function createEgressPolicy(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('egress config must be an object')
  }
  if (!Array.isArray(config.allow)) throw new TypeError('egress allow must be an array')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new TypeError('egress timeoutMs must be a positive safe integer')
  }
  const entries = new Map()
  for (const entry of config.allow) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('egress allow entries must be objects')
    }
    const origin = parseOrigin(entry.origin)
    if (entries.has(origin.origin)) throw new TypeError(`duplicate egress allow entry for ${origin.origin}`)
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
    entries.set(origin.origin, { origin, credential })
  }
  if (entries.size === 0) throw new TypeError('egress allow must contain at least one origin')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const redact = (text, credential) => {
    if (credential === undefined) return text
    return text.split(credential.value).join(REDACTED)
  }

  /**
   * Validate a client request against the allowlist.
   * @param body - Client JSON with `url`, optional `method`, `headers`, and `body`.
   * @returns Validated upstream request description.
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
    const entry = entries.get(target.origin)
    if (entry === undefined) {
      throw new EgressError('EGRESS_HOST_NOT_ALLOWED', 'egress host is not in the allowlist', 403, { host: target.host })
    }
    const method = String(body.method ?? 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      throw new EgressError('EGRESS_METHOD_NOT_ALLOWED', 'egress method must be GET or POST', 405, { method })
    }
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
        if (redact(rawValue, entry.credential) !== rawValue) {
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
    if (entry.credential !== undefined) headers[entry.credential.header] = entry.credential.value
    return {
      url: target.toString(),
      origin: target.origin,
      method,
      headers,
      ...(body.body === undefined ? {} : { body: redact(body.body, entry.credential) }),
      credential: entry.credential,
    }
  }

  /**
   * Forward one validated request and return the redacted response.
   * @param body - Client JSON forwarded through `resolve`.
   * @returns Status, filtered headers, redacted text body, and credential evidence.
   */
  const proxy = async body => {
    const request = resolve(body)
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
      throw new EgressError('EGRESS_UPSTREAM_UNREACHABLE',
        controller.signal.aborted ? 'egress upstream did not respond in time' : 'egress upstream could not be reached',
        502, { host: new URL(request.url).host })
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

  return { allowlist: [...entries.keys()].sort(), proxy, resolve }
}
