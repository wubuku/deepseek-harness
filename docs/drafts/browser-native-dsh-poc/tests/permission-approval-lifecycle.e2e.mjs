import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-permission-')))
let image
let app
let browser
let page

const pageErrors = []
const workerErrors = []
const externalRequests = []
const requests = []

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}
async function permission(sessionId) {
  const response = await testAction({ action: 'permission-state', sessionId })
  assert.equal(response?.ok, true, JSON.stringify(response))
  assert.ok(response.permission)
  return response.permission
}

async function choosePreset(label) {
  await page.locator('button[aria-label^="Access mode"]').first().click()
  await page.getByRole('menuitem', { name: label }).click()
  if (label === 'Full access') {
    const dialog = page.getByRole('dialog', { name: 'Enable Full access?' })
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    await dialog.getByRole('checkbox', { name: 'I understand the risks and want to continue' }).check()
    await dialog.getByRole('button', { name: 'Enable Full access' }).click()
  }
  await page.locator(`button[aria-label="Access mode, current: ${label}"]`).waitFor({ timeout: 15_000 })
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    requests.push({ path: url.pathname, body })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=permission-lifecycle&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const boot = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_PERMISSION_BOOT_E2E：只回复 PERMISSION_BOOT_OK，不调用工具。',
    timeout: 60_000,
  })
  const sessionId = boot.sessionId
  let state = await permission(sessionId)
  assert.equal(state.currentPreset, 'workspace-write')
  assert.equal(state.sandboxMode, 'workspace-write')
  assert.equal(state.approvalPolicy, 'ask')
  assert.deepEqual(state.availablePresets, ['read-only', 'workspace-write', 'danger-full-access'])

  await choosePreset('Read Only')
  state = await permission(sessionId)
  assert.deepEqual({ currentPreset: state.currentPreset, sandboxMode: state.sandboxMode, approvalPolicy: state.approvalPolicy }, {
    currentPreset: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'ask',
  })
  const readOnlyTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_PERMISSION_READ_ONLY_E2E：尝试写文件，然后只回复结果。',
    marker: 'BROWSER_NATIVE_PERMISSION_READ_ONLY_E2E_BLOCKED',
    timeout: 60_000,
  })
  const readOnlyResult = readOnlyTurn.session.events.find(event => event.type === 'tool/result'
    && event.data.turn === readOnlyTurn.turn)
  assert.ok(readOnlyResult)
  assert.equal(readOnlyResult.data.message.isError, true)
  assert.equal((await testAction({ action: 'read', path: '/dsh/home/workspace/browser_native_permission_read_only_e2e.txt' })).ok, false)

  const approvalPrompt = 'BROWSER_NATIVE_PERMISSION_APPROVAL_E2E：请求一次需要审批的 Worker 文件操作。'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(approvalPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const asked = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    return current.events?.find(event => event.type === 'approval/asked')
  }, 'approval request in the Browser Worker Session', 30_000)
  assert.ok(asked)
  const approvalPanel = page.locator('[data-approval-key]')
  await approvalPanel.waitFor({ state: 'visible', timeout: 30_000 })
  await approvalPanel.getByRole('button', { name: 'Reject' }).click()
  const rejectedApproval = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const decided = current.events?.findLast(event => event.type === 'approval/decided')
    return decided?.data.outcome === 'rejected' ? current : undefined
  }, 'rejected approval settlement', 30_000)
  assert.equal(rejectedApproval.events.filter(event => event.type === 'approval/asked').length, 1)
  assert.equal((await testAction({ action: 'read', path: '/dsh/home/workspace/approval-result.txt' })).ok, false)

  await choosePreset('Workspace Write')
  state = await permission(sessionId)
  assert.deepEqual({ currentPreset: state.currentPreset, sandboxMode: state.sandboxMode, approvalPolicy: state.approvalPolicy }, {
    currentPreset: 'workspace-write', sandboxMode: 'workspace-write', approvalPolicy: 'ask',
  })
  const writeTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_PERMISSION_WORKSPACE_WRITE_E2E：写文件，然后只回复结果。',
    marker: 'BROWSER_NATIVE_PERMISSION_WORKSPACE_WRITE_E2E_DONE',
    timeout: 60_000,
  })
  assert.equal((await testAction({ action: 'read', path: '/dsh/home/workspace/browser_native_permission_workspace_write_e2e.txt' })).content, 'BROWSER_NATIVE_PERMISSION_WORKSPACE_WRITE_E2E_WRITE_OK\n')

  await choosePreset('Full access')
  state = await permission(sessionId)
  assert.deepEqual({ currentPreset: state.currentPreset, sandboxMode: state.sandboxMode, approvalPolicy: state.approvalPolicy }, {
    currentPreset: 'danger-full-access', sandboxMode: 'danger-full-access', approvalPolicy: 'never',
  })
  const dangerTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_PERMISSION_DANGER_E2E：写文件，然后只回复结果。',
    marker: 'BROWSER_NATIVE_PERMISSION_DANGER_E2E_DONE',
    timeout: 60_000,
  })
  assert.equal((await testAction({ action: 'read', path: '/dsh/home/workspace/browser_native_permission_danger_e2e.txt' })).ok, true)
  assert.equal(await page.locator('[data-approval-key]').count(), 0)

  const permissionEvents = dangerTurn.session.events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))
  assert.ok(permissionEvents.length >= 9)
  assert.equal(assistantText(dangerTurn.session, dangerTurn.turn).includes('BROWSER_NATIVE_PERMISSION_DANGER_E2E_DONE'), true)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'formal-DSH-permission-presets-in-Browser-Worker',
    sessionId,
    presets: ['read-only', 'workspace-write', 'danger-full-access'],
    approvalPolicyAtDanger: state.approvalPolicy,
    permissionEventCount: permissionEvents.length,
    llmRequestCount: requests.filter(request => request.path.endsWith('/llm')).length,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
