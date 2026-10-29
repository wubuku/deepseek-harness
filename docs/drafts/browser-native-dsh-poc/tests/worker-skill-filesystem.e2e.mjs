import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const mode = process.env.DSH_POC_LLM ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-worker-skill-`))
const skillRoot = '/dsh/home/workspace/.agents/skills'
const skillPath = `${skillRoot}/browser-proof/SKILL.md`
const volatileRoot = `${skillRoot}/volatile-proof`
const volatilePath = `${volatileRoot}/SKILL.md`
const initialSkill = [
  '---',
  'name: browser-proof',
  'description: Browser worker integration fixture',
  '---',
  '',
  'Instruction marker: BROWSER_SKILL_BODY_INITIAL',
  '',
].join('\n')
const updatedSkill = [
  '---',
  'name: browser-proof',
  'description: Updated browser worker integration fixture',
  '---',
  '',
  'Updated instruction marker: BROWSER_SKILL_BODY_UPDATED',
  '',
].join('\n')
const volatileSkill = [
  '---',
  'name: volatile-proof',
  'description: Unconfirmed browser skill',
  '---',
  '',
  'Uncommitted instruction marker: BROWSER_SKILL_VOLATILE_BODY',
  '',
].join('\n')
const llmRequests = []
const workspaceCommits = []
const apiRequests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
const consoleErrors = []
const httpErrors = []
let image
let app
let browser
let page
let origin

function requestBody(request) {
  try { return request.postDataJSON() } catch { return undefined }
}

function scenarioMarker(request) {
  return [...(request.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string' && /BROWSER_NATIVE_SKILL_[A-Z_]+/.test(message.content))
    ?.content.match(/BROWSER_NATIVE_SKILL_[A-Z_]+/)?.[0]
}

function requestsFor(marker) {
  return llmRequests.filter(request => request.purpose !== 'session-title' && scenarioMarker(request) === marker)
}

function latestCatalogText(request) {
  return [...(request.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string' && message.content.includes('<available_skills>'))?.content ?? ''
}

function toolNames(request) {
  return (request.tools ?? []).map(tool => (tool.function ?? tool).name).sort()
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

function toolCalls(session, turn) {
  return session.events.filter(event => event.type === 'tool/call' && event.data.turn === turn)
}

function toolResult(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId) === callId)
}

function promptCount(session, marker) {
  return session.events.filter(event => event.type === 'user/message' && eventText(event).includes(marker)).length
}

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function waitForSynced() {
  return await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })
}

async function workspaceManifest(workspaceId) {
  return await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
}

async function remoteFileText(workspaceId, hash) {
  return await page.evaluate(async ({ id, blobHash }) => await (await fetch(
    `/api/browser-native/workspace/blob/${blobHash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).text(), { id: workspaceId, blobHash: hash })
}

async function readSecrets(file) {
  if (file === undefined) return []
  return (await readFile(file, 'utf8')).split(/\r?\n/)
    .map(line => line.match(/^(OPENAI_NEXT_(?:GPT|GROK)_API_KEY)=(.*)$/)?.[2])
    .filter(value => value !== undefined && value.length > 0)
}

async function openSkillPreview() {
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=skill-filesystem&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await waitForSynced()
}

async function seedSkill(content) {
  const directory = await testAction({ action: 'mkdir', path: `${skillRoot}/browser-proof` })
  assert.equal(directory?.ok, true, JSON.stringify(directory))
  const file = await testAction({ action: 'write', path: skillPath, content })
  assert.equal(file?.ok, true, JSON.stringify(file))
  const flush = await testAction({ action: 'flush-workspace' })
  assert.equal(flush?.ok, true, JSON.stringify(flush))
  await waitForSynced()
}

async function runScripted() {
  await openSkillPreview()
  const empty = await sendTurn({
    page, origin, requests: apiRequests,
    prompt: 'BROWSER_NATIVE_SKILL_EMPTY_CATALOG: no skill exists yet.',
    marker: 'BROWSER_NATIVE_SKILL_EMPTY_CATALOG_DONE', timeout: 60_000,
  })
  assert.deepEqual(toolCalls(empty.session, empty.turn), [])
  const emptyRequest = requestsFor('BROWSER_NATIVE_SKILL_EMPTY_CATALOG')[0]
  assert.ok(emptyRequest, 'initial empty-catalog turn must reach the DSH-backed LLM adapter')
  assert.ok(toolNames(emptyRequest).includes('skill'), 'validation profile must publish the real DSH skill tool')
  assert.equal(latestCatalogText(emptyRequest).includes('browser-proof'), false)
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const directory = await testAction({ action: 'mkdir', path: `${skillRoot}/browser-proof` })
  assert.equal(directory?.ok, true, JSON.stringify(directory))
  const emptyRoot = await sendTurn({
    page, origin, requests: apiRequests,
    prompt: 'BROWSER_NATIVE_SKILL_ROOT_CREATED: the configured skill root now exists but is empty.',
    marker: 'BROWSER_NATIVE_SKILL_ROOT_CREATED_DONE', timeout: 60_000,
  })
  assert.deepEqual(toolCalls(emptyRoot.session, emptyRoot.turn), [])
  assert.equal(latestCatalogText(requestsFor('BROWSER_NATIVE_SKILL_ROOT_CREATED')[0]).includes('browser-proof'), false)
  const file = await testAction({ action: 'write', path: skillPath, content: initialSkill })
  assert.equal(file?.ok, true, JSON.stringify(file))
  const initialFlush = await testAction({ action: 'flush-workspace' })
  assert.equal(initialFlush?.ok, true, JSON.stringify(initialFlush))
  await waitForSynced()
  const initialManifest = await workspaceManifest(workspaceId)
  const initialEntry = initialManifest.entries.find(entry => entry.path === '.agents/skills/browser-proof/SKILL.md')
  assert.ok(initialEntry, 'the seeded skill file must be present in the cloud-backed Workspace manifest')
  assert.equal(await remoteFileText(workspaceId, initialEntry.hash), initialSkill)

  const initialCommitCount = workspaceCommits.length
  const loaded = await sendTurn({
    page, origin, requests: apiRequests,
    prompt: 'BROWSER_NATIVE_SKILL_LOAD_INITIAL: load browser-proof.',
    marker: 'BROWSER_NATIVE_SKILL_LOAD_INITIAL_DONE', timeout: 60_000,
  })
  const loadedCalls = toolCalls(loaded.session, loaded.turn)
  assert.deepEqual(loadedCalls.map(event => event.data.name), ['skill'])
  const loadedResult = toolResult(loaded.session, loadedCalls[0].data.callId)
  assert.ok(loadedResult)
  assert.notEqual(loadedResult.data.message.isError, true)
  assert.ok(eventText(loadedResult).includes('BROWSER_SKILL_BODY_INITIAL'))
  assert.equal(workspaceCommits.length, initialCommitCount, 'reading a skill must not create a Workspace write')
  assert.equal(requestsFor('BROWSER_NATIVE_SKILL_LOAD_INITIAL').length, 2,
    'one skill call must produce exactly one continuation request')
  assert.equal(requestsFor('BROWSER_NATIVE_SKILL_LOAD_INITIAL')[0].tools.filter(tool => (tool.function ?? tool).name === 'skill').length, 1)
  assert.ok(requestsFor('BROWSER_NATIVE_SKILL_LOAD_INITIAL')[1].messages.some(message =>
    typeof message.content === 'string' && message.content.includes('BROWSER_SKILL_BODY_INITIAL')),
  'loaded instructions must enter the next DSH model request')
  assert.equal(promptCount(loaded.session, 'BROWSER_NATIVE_SKILL_LOAD_INITIAL'), 1)

  const commitsBeforeEdit = workspaceCommits.length
  const edited = await sendTurn({
    page, origin, requests: apiRequests, sessionId: loaded.sessionId,
    prompt: 'BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD: edit browser-proof and reload it.',
    marker: 'BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD_DONE', timeout: 60_000,
  })
  const editCalls = toolCalls(edited.session, edited.turn)
  assert.deepEqual(editCalls.map(event => event.data.name), ['read', 'edit', 'edit', 'skill'])
  const descriptionEditResult = toolResult(edited.session, editCalls[1].data.callId)
  const bodyEditResult = toolResult(edited.session, editCalls[2].data.callId)
  const reloadedResult = toolResult(edited.session, editCalls[3].data.callId)
  assert.ok(descriptionEditResult)
  assert.equal(descriptionEditResult.data.message.isError, false, eventText(descriptionEditResult))
  assert.ok(bodyEditResult)
  assert.equal(bodyEditResult.data.message.isError, false, eventText(bodyEditResult))
  assert.ok(reloadedResult)
  assert.equal(reloadedResult.data.message.isError, false)
  assert.ok(eventText(reloadedResult).includes('BROWSER_SKILL_BODY_UPDATED'))
  for (const editCall of editCalls.slice(1, 3)) {
    assert.ok(edited.session.events.some(event => event.type === 'browser-native/workspace-receipt'
      && event.data.callId === editCall.data.callId), 'each DSH edit must have a matching Workspace receipt')
  }
  assert.equal(requestsFor('BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD').length, 5,
    'one read, two edits and one skill load must produce exactly four tool continuation requests')
  assert.ok(latestCatalogText(requestsFor('BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD')[2])
    .includes('Updated browser worker integration fixture'), 'the watcher must invalidate the catalog after the DSH write')
  assert.ok(requestsFor('BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD')[4].messages.some(message =>
    typeof message.content === 'string' && message.content.includes('BROWSER_SKILL_BODY_UPDATED')))
  await waitForSynced()
  assert.equal(workspaceCommits.length, commitsBeforeEdit + 2, 'each skill file update must create one Workspace commit')
  const editedCommit = workspaceCommits.slice(commitsBeforeEdit)
    .filter(body => body.changes?.some(change => change.path === '.agents/skills/browser-proof/SKILL.md'))
  assert.equal(editedCommit.length, 2)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await waitForSynced()
  const restored = await testAction({ action: 'read', path: skillPath })
  assert.deepEqual({ ok: restored?.ok, content: restored?.content }, { ok: true, content: updatedSkill })
  const afterRefresh = await sendTurn({
    page, origin, requests: apiRequests, sessionId: edited.sessionId,
    prompt: 'BROWSER_NATIVE_SKILL_AFTER_REFRESH: use the restored browser-proof skill.',
    marker: 'BROWSER_NATIVE_SKILL_AFTER_REFRESH_DONE', timeout: 60_000,
  })
  const restoredCalls = toolCalls(afterRefresh.session, afterRefresh.turn)
  assert.deepEqual(restoredCalls.map(event => event.data.name), ['skill'])
  assert.ok(eventText(toolResult(afterRefresh.session, restoredCalls[0].data.callId)).includes('BROWSER_SKILL_BODY_UPDATED'))
  assert.ok(latestCatalogText(requestsFor('BROWSER_NATIVE_SKILL_AFTER_REFRESH')[0]).includes('browser-proof'))
  assert.equal(promptCount(afterRefresh.session, 'BROWSER_NATIVE_SKILL_AFTER_REFRESH'), 1)

  const removed = await testAction({ action: 'remove', path: skillPath })
  assert.equal(removed?.ok, true, JSON.stringify(removed))
  await testAction({ action: 'flush-workspace' })
  await waitForSynced()
  await page.waitForTimeout(250)
  const deleted = await sendTurn({
    page, origin, requests: apiRequests, sessionId: afterRefresh.sessionId,
    prompt: 'BROWSER_NATIVE_SKILL_AFTER_DELETE: inspect the current skill catalog.',
    marker: 'BROWSER_NATIVE_SKILL_AFTER_DELETE_DONE', timeout: 60_000,
  })
  assert.deepEqual(toolCalls(deleted.session, deleted.turn), [], 'deleted skills must not remain model-invocable')
  assert.equal(latestCatalogText(requestsFor('BROWSER_NATIVE_SKILL_AFTER_DELETE')[0]).includes('browser-proof'), false)

  const volatileDirectory = await testAction({ action: 'mkdir', path: volatileRoot })
  assert.equal(volatileDirectory?.ok, true, JSON.stringify(volatileDirectory))
  await testAction({ action: 'flush-workspace' })
  await waitForSynced()
  const armed = await testAction({ action: 'quota-next-opfs-write' })
  assert.equal(armed?.ok, true, JSON.stringify(armed))
  const volatile = await sendTurn({
    page, origin, requests: apiRequests, sessionId: deleted.sessionId,
    prompt: 'BROWSER_NATIVE_SKILL_VOLATILE: attempt to create an unconfirmed skill.',
    marker: 'BROWSER_NATIVE_SKILL_VOLATILE_DONE', timeout: 60_000,
  })
  const volatileCalls = toolCalls(volatile.session, volatile.turn)
  assert.deepEqual(volatileCalls.map(event => event.data.name), ['write'])
  const volatileResult = toolResult(volatile.session, volatileCalls[0].data.callId)
  assert.ok(volatileResult)
  assert.equal(volatileResult.data.message.isError, true)
  assert.match(eventText(volatileResult), /local Workspace persistence was not confirmed/i)
  const volatileRequests = requestsFor('BROWSER_NATIVE_SKILL_VOLATILE')
  assert.equal(volatileRequests.length, 2)
  assert.equal(volatileRequests[1].tools.some(tool => (tool.function ?? tool).name === 'skill'), false,
    'the skill tool must be withdrawn when local persistence is unconfirmed')
  assert.equal(volatileRequests[1].messages.some(message => typeof message.content === 'string'
    && message.content.includes('BROWSER_SKILL_VOLATILE_BODY')), false)
  assert.equal(latestCatalogText(volatileRequests[1]).includes('- `volatile-proof`'), false,
    'an unconfirmed skill must not appear in the model-visible catalog')
  assert.equal(workspaceCommits.some(body => body.changes?.some(change => change.path === '.agents/skills/volatile-proof/SKILL.md')),
  false, 'an unconfirmed skill must not be sent to the remote Workspace')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await waitForSynced()
  const volatileAfterReload = await testAction({ action: 'read', path: volatilePath })
  assert.equal(volatileAfterReload?.ok, false, 'volatile skill bytes must not survive Worker reconstruction')
  const afterVolatileRefresh = await sendTurn({
    page, origin, requests: apiRequests, sessionId: volatile.sessionId,
    prompt: 'BROWSER_NATIVE_SKILL_AFTER_VOLATILE_REFRESH: inspect restored skills.',
    marker: 'BROWSER_NATIVE_SKILL_AFTER_VOLATILE_REFRESH_DONE', timeout: 60_000,
  })
  assert.deepEqual(toolCalls(afterVolatileRefresh.session, afterVolatileRefresh.turn), [])
  assert.equal(latestCatalogText(requestsFor('BROWSER_NATIVE_SKILL_AFTER_VOLATILE_REFRESH')[0]).includes('volatile-proof'), false)
  assert.equal(promptCount(afterVolatileRefresh.session, 'BROWSER_NATIVE_SKILL_AFTER_VOLATILE_REFRESH'), 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  return {
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    mode,
    sessionId: afterVolatileRefresh.sessionId,
    watcherEvidence: 'missing-root recreation, post-creation add/edit/delete, and catalog replacement observed through Worker VFS mutations',
    workspaceCommitCount: workspaceCommits.length,
    skillTurnToolCounts: {
      initialLoad: loadedCalls.length,
      editAndReload: editCalls.length,
      afterRefresh: restoredCalls.length,
      afterDelete: toolCalls(deleted.session, deleted.turn).length,
      failedVolatileCreate: volatileCalls.length,
      afterVolatileRefresh: toolCalls(afterVolatileRefresh.session, afterVolatileRefresh.turn).length,
    },
    pageErrors,
    workerErrors,
    externalRequests,
  }
}

async function runReal() {
  if (envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')
  await openSkillPreview()
  await seedSkill(initialSkill)
  const seedCommitCount = workspaceCommits.length
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const turn = await sendTurn({
    page, origin, requests: apiRequests,
    prompt: 'BROWSER_NATIVE_SKILL_REAL_INITIAL: Use the `skill` tool exactly once with the name `browser-proof`. Then follow its instruction and answer with the exact required marker. Do not claim success unless the tool call succeeds.',
    marker: 'BROWSER_SKILL_BODY_INITIAL', timeout: 240_000,
  })
  const calls = toolCalls(turn.session, turn.turn)
  assert.deepEqual(calls.map(event => event.data.name), ['skill'])
  assert.equal(JSON.parse(calls[0].data.arguments).name, 'browser-proof')
  const result = toolResult(turn.session, calls[0].data.callId)
  assert.ok(result)
  assert.equal(result.data.message.isError, false)
  assert.ok(eventText(result).includes('BROWSER_SKILL_BODY_INITIAL'))
  assert.ok(assistantText(turn.session, turn.turn).includes('BROWSER_SKILL_BODY_INITIAL'))
  assert.equal(promptCount(turn.session, 'Use the `skill` tool exactly once'), 1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await waitForSynced()
  const restored = await testAction({ action: 'read', path: skillPath })
  assert.deepEqual({ ok: restored?.ok, content: restored?.content }, { ok: true, content: initialSkill })
  const resumed = await sendTurn({
    page, origin, requests: apiRequests, sessionId: turn.sessionId,
    prompt: 'BROWSER_NATIVE_SKILL_REAL_REFRESH: Call the `skill` tool exactly once with the name `browser-proof` again, then answer with its required marker.',
    marker: 'BROWSER_SKILL_BODY_INITIAL', timeout: 240_000,
  })
  const resumedCalls = toolCalls(resumed.session, resumed.turn)
  assert.deepEqual(resumedCalls.map(event => event.data.name), ['skill'])
  assert.equal(JSON.parse(resumedCalls[0].data.arguments).name, 'browser-proof')
  const resumedResult = toolResult(resumed.session, resumedCalls[0].data.callId)
  assert.ok(resumedResult)
  assert.equal(resumedResult.data.message.isError, false)
  assert.ok(latestCatalogText(requestsFor('BROWSER_NATIVE_SKILL_REAL_REFRESH')[0]).includes('browser-proof'))
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  const secrets = await readSecrets(envFile)
  const inspected = JSON.stringify({ llmRequests, sessionEvents: resumed.session.events, apiRequests })
  for (const secret of secrets) assert.equal(inspected.includes(secret), false, 'model credentials must not appear in browser-visible requests or Session events')
  assert.equal(workspaceCommits.length, seedCommitCount, 'skill reads must not create Workspace commits')
  return {
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    mode,
    sessionId: resumed.sessionId,
    realSkillCalls: calls.length + resumedCalls.length,
    workspaceCommitCount: workspaceCommits.length,
    browserRequestOrigins: [...new Set(apiRequests.map(request => request.origin))],
    secretLeakCount: 0,
    pageErrors,
    workerErrors,
    externalRequests,
  }
}

try {
  if (!['scripted', 'real'].includes(mode)) throw new Error('DSH_POC_LLM must be scripted or real')
  if (process.env.DSH_POC_BROWSER !== undefined && process.env.DSH_POC_BROWSER !== 'chrome') {
    throw new Error('this validation runs Chrome only')
  }
  image = await createRuntimeValidationDist({ roster: 'browser-skill' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: mode, envFile })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(url.origin)
    if (!url.pathname.startsWith('/api/browser-native/')) return
    const body = requestBody(request)
    apiRequests.push({ path: url.pathname, origin: url.origin, body })
    if (url.pathname === '/api/browser-native/llm' && body !== undefined) llmRequests.push(body)
    if (url.pathname === '/api/browser-native/workspace/commit' && body !== undefined) workspaceCommits.push(body)
  })
  page.on('response', response => {
    if (response.status() >= 400) httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  const result = mode === 'real' ? await runReal() : await runScripted()
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const bodyText = await page?.locator('body').innerText().catch(() => '') ?? ''
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    apiPaths: apiRequests.map(request => request.path),
    httpErrors,
    pageErrors,
    workerErrors,
    consoleErrors,
    pageTail: bodyText.slice(-2_000),
  })}\n`)
  throw error
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
