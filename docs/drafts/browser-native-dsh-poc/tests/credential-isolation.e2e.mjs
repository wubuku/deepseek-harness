/**
 * Verify that a Worker cannot spend a provider credential and cannot choose an
 * unrestricted destination.
 *
 * The page runs under `connect-src 'self'`, so the Worker has no direct route
 * to any upstream. All external calls go through the PoC backend egress route,
 * which refuses hosts outside its allowlist, rejects browser-supplied
 * `authorization`, does not follow redirects, and redacts the injected
 * credential from the response.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const browserChannel = process.env.DSH_POC_BROWSER ?? 'chrome'
const secretValue = `Bearer poc-egress-${randomBytes(12).toString('hex')}`
const secretDigest = createHash('sha256').update(secretValue).digest('hex').slice(0, 16)

const allowlistedRecords = []
const blockedRecords = []

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
}

let allowlisted
let blocked
let browser
let app
let dataDir
let image

try {
  blocked = createServer((request, response) => {
    blockedRecords.push({
      path: request.url,
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie,
    })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('non-allowlisted-ok')
  })
  const blockedOrigin = await listen(blocked)

  allowlisted = createServer((request, response) => {
    allowlistedRecords.push({
      path: request.url,
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie,
    })
    if (request.url === '/private/echo') {
      if (request.headers.authorization === undefined) {
        response.writeHead(401, { 'content-type': 'text/plain' })
        response.end('missing credential')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ received: 'present' }))
      return
    }
    if (request.url === '/private/leak') {
      response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'upstream=session; Path=/' })
      response.end(`upstream echoed ${String(request.headers.authorization)}`)
      return
    }
    if (request.url === '/private/redirect') {
      response.writeHead(302, { location: `${blockedOrigin}/blocked-target` })
      response.end()
      return
    }
    if (request.url === '/private/direct') {
      response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
      response.end('direct-ok')
      return
    }
    if (request.url.startsWith('/limited')) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('limited-ok')
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('missing')
  })
  const allowlistedOrigin = await listen(allowlisted)

  image = await createRuntimeValidationDist({ roster: 'original' })
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-egress-'))
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    responseHeaders: { 'content-security-policy': "connect-src 'self' data:" },
    egress: {
      allow: [
        {
          capability: 'upstream.private',
          origin: allowlistedOrigin,
          pathPrefix: '/private',
          methods: ['GET'],
          credential: { header: 'authorization', value: secretValue },
        },
        {
          capability: 'upstream.limited',
          origin: allowlistedOrigin,
          pathPrefix: '/limited',
          rateLimit: { windowMs: 60_000, maxRequests: 2 },
        },
      ],
    },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: browserChannel })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const pageErrors = []
  const nonLocalRequests = []
  const requests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.origin.startsWith(origin)) nonLocalRequests.push(`${url.origin}${url.pathname}`)
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = JSON.parse(request.postData() ?? '{}') } catch {}
    requests.push({ path: url.pathname, body })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const targets = {
    proxy: `${origin}/api/browser-native/egress/fetch`,
    allowed: `${allowlistedOrigin}/private/echo`,
    blocked: `${blockedOrigin}/blocked-target`,
    headerInjection: `${allowlistedOrigin}/private/echo`,
    scheme: 'file:///etc/passwd',
    redirect: `${allowlistedOrigin}/private/redirect`,
    leak: `${allowlistedOrigin}/private/leak`,
    direct: `${allowlistedOrigin}/private/direct`,
    pathOutside: `${allowlistedOrigin}/admin/secret`,
    pathBoundary: `${allowlistedOrigin}/privatex/echo`,
    methodDenied: `${allowlistedOrigin}/private/echo`,
    rateLimited: `${allowlistedOrigin}/limited/echo`,
  }
  const probe = await page.evaluate(payload => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({
    action: 'egress-probe',
    targets: payload,
  }), targets)
  assert.equal(probe?.ok, true, JSON.stringify(probe))

  const failures = []
  const check = (condition, label) => { if (!condition) failures.push(label) }

  check(!probe.processEnvKeys.some(key => /API_KEY|SECRET|TOKEN|PASSWORD|AUTH/i.test(key)),
    'Worker realm must not expose credential environment variables')
  check(JSON.stringify(probe).includes(secretValue) === false, 'no probe payload may contain the credential')

  const allowed = JSON.parse(probe.allowlisted.body)
  check(probe.allowlisted.status === 200, 'an allowlisted request must succeed')
  check(allowed.credentialInjected === true, 'the proxy must report credential injection')
  check(allowlistedRecords.filter(record => record.path === '/private/echo').length === 1,
    'the allowlisted upstream must receive exactly one request')
  const echoRecord = allowlistedRecords.find(record => record.path === '/private/echo')
  check(echoRecord?.authorization === secretValue, 'the upstream must receive the injected credential')
  check(echoRecord?.cookie === undefined, 'the proxy must not forward the principal cookie')
  check(JSON.stringify(probe.allowlisted).includes(secretValue) === false,
    'the proxy response must not echo the injected credential')
  check(JSON.parse(allowed.body).received === 'present', 'the upstream must observe the credential')

  check(probe.blockedHost.status === 403, 'a non-allowlisted host must be refused')
  check(probe.blockedHost.code === 'EGRESS_HOST_NOT_ALLOWED', 'the refusal must carry a typed code')
  check(blockedRecords.length === 0, 'a refused host must never receive the request')
  check(probe.injectedHeader.status === 400, 'a browser-supplied authorization header must be refused')
  check(probe.injectedHeader.code === 'EGRESS_FORBIDDEN_HEADER', 'the header refusal must carry a typed code')
  check(allowlistedRecords.filter(record => record.path === '/private/echo').length === 1,
    'a refused header must not reach the upstream')
  check(probe.invalidScheme.status === 400, 'a non-http scheme must be refused')
  check(probe.invalidScheme.code === 'EGRESS_SCHEME_REJECTED', 'the scheme refusal must carry a typed code')

  const redirect = JSON.parse(probe.redirect.body)
  check(probe.redirect.status === 200, 'the redirect status must be returned as data')
  check(redirect.status === 302 && redirect.redirect === true, 'the proxy must report an unfollowed redirect')
  check(blockedRecords.length === 0, 'a redirect must not be followed to a non-allowlisted host')

  const leak = JSON.parse(probe.echoedCredential.body)
  check(probe.echoedCredential.status === 200, 'the leaking upstream must return 200')
  check(String(leak.body).includes('[REDACTED]'), 'an echoed credential must be redacted in the response')
  check(String(leak.body).includes(secretValue) === false, 'the redacted body must not contain the credential')
  check(leak.headers['set-cookie'] === undefined, 'upstream cookie headers must be stripped')

  check(probe.directFetch.ok === false, 'the CSP must block a direct Worker fetch to the allowlisted origin')
  check(allowlistedRecords.every(record => record.path !== '/private/direct'),
    'a CSP-blocked direct fetch must never reach the upstream')

  check(probe.pathOutside.status === 403, 'a path outside the capability prefix must be refused')
  check(probe.pathOutside.code === 'EGRESS_PATH_NOT_ALLOWED', 'the path refusal must carry a typed code')
  check(allowlistedRecords.every(record => record.path !== '/admin/secret'),
    'a path outside the capability prefix must never reach the upstream')
  check(probe.pathBoundary.status === 403, 'a prefix must match on a path segment boundary')
  check(probe.pathBoundary.code === 'EGRESS_PATH_NOT_ALLOWED', 'the boundary refusal must carry a typed code')
  check(allowlistedRecords.every(record => record.path !== '/privatex/echo'),
    'a path that only shares a string prefix must never reach the upstream')
  check(probe.methodDenied.status === 405, 'a method outside the capability grant must be refused')
  check(probe.methodDenied.code === 'EGRESS_METHOD_NOT_ALLOWED', 'the method refusal must carry a typed code')
  check(allowlistedRecords.filter(record => record.path === '/private/echo').length === 1,
    'a denied method must not reach the upstream')

  const rateStatuses = probe.rateLimited.map(attempt => attempt.status)
  check(JSON.stringify(rateStatuses) === JSON.stringify([200, 200, 429, 429]),
    'the capability rate limit must admit two requests and refuse the next two')
  check(probe.rateLimited[2].code === 'EGRESS_RATE_LIMITED' && probe.rateLimited[3].code === 'EGRESS_RATE_LIMITED',
    'a rate-limited request must carry a typed code')
  check(allowlistedRecords.filter(record => record.path === '/limited/echo').length === 2,
    'requests above the capability rate limit must not reach the upstream')

  const audit = app.egress.audit()
  const auditByRequest = new Map(audit.map(entry => [entry.requestId, entry]))
  check(audit.length === 13, 'every egress probe request must have one audit record')
  check(auditByRequest.get('egress-allowlisted')?.decision === 'allow', 'an allowed request must be audited as allow')
  check(auditByRequest.get('egress-allowlisted')?.capability === 'upstream.private',
    'the audit record must name the capability that admitted the request')
  check(auditByRequest.get('egress-allowlisted')?.path === '/private/echo', 'the audit record must name the target path')
  check(auditByRequest.get('egress-path-outside')?.decision === 'deny', 'a denied path must be audited')
  check(auditByRequest.get('egress-path-outside')?.code === 'EGRESS_PATH_NOT_ALLOWED',
    'the audit record must retain the refusal code')
  check(auditByRequest.get('egress-path-outside')?.path === '/admin/secret', 'the audit record must retain the denied path')
  check(auditByRequest.get('egress-method-denied')?.code === 'EGRESS_METHOD_NOT_ALLOWED',
    'a denied method must be audited with its code')
  check(auditByRequest.get('egress-method-denied')?.capability === 'upstream.private',
    'a denied method must be audited with the matched capability')
  check(auditByRequest.get('egress-rate-3')?.code === 'EGRESS_RATE_LIMITED',
    'a rate-limited request must be audited with its code')
  check(auditByRequest.get('egress-rate-3')?.retryAfterMs > 0, 'the audit record must retain the retry delay')
  check(audit.every(entry => typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at))),
    'every audit record must carry a timestamp')
  check(audit.every(entry => !String(entry.path ?? '').includes('?')), 'audit records must not retain query strings')
  check(JSON.stringify(audit).includes(secretValue) === false, 'audit records must never contain the credential')

  const turn = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'EGRESS_LOOP_E2E: Reply with exactly "EGRESS_LOOP_OK"',
    marker: 'Browser-native DSH completed this turn',
  })
  const sessionText = JSON.stringify(turn.session)
  const pageText = await page.evaluate(() => document.body.innerText)
  check(sessionText.includes(secretValue) === false, 'Session events must not contain the credential')
  check(pageText.includes(secretValue) === false, 'page text must not contain the credential')
  check(turn.session.events.length > 0, 'the scripted turn must persist events')
  check(pageErrors.length === 0, 'the page must not report errors')
  check(nonLocalRequests.length === 0, 'the browser must not issue any non-local request')

  const report = {
    result: failures.length === 0 ? 'passed' : 'failed',
    browser: browserChannel,
    scope: 'server-mediated-egress-and-credential-isolation',
    allowlist: [allowlistedOrigin],
    secret: { digest: secretDigest, length: secretValue.length },
    workerRealm: {
      processEnvKeys: probe.processEnvKeys,
      holdsCredential: probe.processEnvKeys.some(key => /API_KEY|SECRET|TOKEN|PASSWORD|AUTH/i.test(key)),
    },
    proxy: {
      allowlisted: {
        status: probe.allowlisted.status,
        credentialInjected: allowed.credentialInjected,
        upstreamAuthorizationPresent: echoRecord?.authorization === secretValue,
        upstreamRequestCount: allowlistedRecords.filter(record => record.path === '/private/echo').length,
      },
      blockedHost: { status: probe.blockedHost.status, code: probe.blockedHost.code, upstreamRequests: blockedRecords.length },
      injectedHeader: { status: probe.injectedHeader.status, code: probe.injectedHeader.code },
      invalidScheme: { status: probe.invalidScheme.status, code: probe.invalidScheme.code },
      redirect: { proxyStatus: probe.redirect.status, targetStatus: redirect.status, followed: false,
        nonAllowlistedRequests: blockedRecords.length },
      echoedCredential: { redacted: String(leak.body).includes('[REDACTED]'),
        secretInResponse: String(leak.body).includes(secretValue),
        setCookieStripped: leak.headers['set-cookie'] === undefined },
      pathPolicy: {
        outside: { status: probe.pathOutside.status, code: probe.pathOutside.code,
          upstreamRequests: allowlistedRecords.filter(record => record.path === '/admin/secret').length },
        boundary: { status: probe.pathBoundary.status, code: probe.pathBoundary.code,
          upstreamRequests: allowlistedRecords.filter(record => record.path === '/privatex/echo').length },
      },
      methodPolicy: {
        status: probe.methodDenied.status,
        code: probe.methodDenied.code,
        upstreamEchoRequests: allowlistedRecords.filter(record => record.path === '/private/echo').length,
      },
      rateLimit: {
        statuses: rateStatuses,
        codes: probe.rateLimited.map(attempt => attempt.code ?? null),
        upstreamRequests: allowlistedRecords.filter(record => record.path === '/limited/echo').length,
      },
      audit: {
        entries: audit.length,
        capability: auditByRequest.get('egress-allowlisted')?.capability ?? null,
        pathDeniedTraceable: auditByRequest.get('egress-path-outside')?.code === 'EGRESS_PATH_NOT_ALLOWED',
        methodDeniedTraceable: auditByRequest.get('egress-method-denied')?.code === 'EGRESS_METHOD_NOT_ALLOWED',
        rateLimitTraceable: auditByRequest.get('egress-rate-3')?.code === 'EGRESS_RATE_LIMITED',
        secretInAudit: JSON.stringify(audit).includes(secretValue),
        queryRetained: audit.some(entry => String(entry.path ?? '').includes('?')),
      },
    },
    csp: {
      directFetchBlocked: probe.directFetch.ok === false,
      directUpstreamRequests: allowlistedRecords.filter(record => record.path === '/private/direct').length,
    },
    loop: {
      turn: turn.session.events.at(-1)?.type === 'turn/end' ? 'completed' : 'unsettled',
      sessionEvents: turn.session.events.length,
      secretInSession: sessionText.includes(secretValue),
    },
    pageErrors,
    nonLocalRequests,
    failures,
  }
  console.log(JSON.stringify(report))
  assert.deepEqual(failures, [])
} finally {
  if (browser !== undefined) await browser.close().catch(() => {})
  if (app !== undefined) await app.close().catch(() => {})
  if (allowlisted !== undefined) await close(allowlisted).catch(() => {})
  if (blocked !== undefined) await close(blocked).catch(() => {})
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  if (image !== undefined) await rm(resolve(image.distRoot, '..'), { recursive: true, force: true }).catch(() => {})
}
