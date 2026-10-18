import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      return join(homedir(), 'node_modules/playwright/index.js')
    }
  })()
const playwright = await import(playwrightModule)
const browserName = optionValue('--browser') ?? process.env.DSH_POC_BROWSER ?? 'chromium'
const mode = optionValue('--llm') ?? process.env.DSH_POC_LLM ?? 'scripted'
const baseUrl = process.env.COPILOTKIT_POC_URL ?? 'http://127.0.0.1:4197/copilotkit-browser-native-dsh-poc/index.html'
const timeoutMs = Number(process.env.COPILOTKIT_POC_E2E_TIMEOUT ?? (mode === 'real' ? '240000' : '30000'))
const artifactsDir = resolve(process.env.COPILOTKIT_POC_ARTIFACT_DIR ?? '/tmp/copilotkit-browser-native-dsh-poc-artifacts')
const browserTypes = playwright.default ?? playwright
const browserType = browserName === 'webkit' ? browserTypes.webkit : browserTypes.chromium
if (browserType === undefined) throw new Error(`Playwright does not export ${browserName}`)
if (!['chromium', 'chrome', 'webkit'].includes(browserName)) throw new Error('--browser must be chromium, chrome, or webkit')
if (!['scripted', 'real'].includes(mode)) throw new Error('--llm must be scripted or real')

function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function withQuery(value, entries) {
  const url = new URL(value)
  for (const [key, item] of Object.entries(entries)) url.searchParams.set(key, item)
  return url.toString()
}

async function waitFor(label, predicate, deadline = Date.now() + timeoutMs) {
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function send(page, prompt) {
  const input = page.getByTestId('copilot-chat-textarea')
  await waitFor('available chat input', () => input.isEnabled())
  await input.fill(prompt)
  await input.press('Enter')
}

async function readSession(sessionId) {
  const response = await fetch(new URL('/api/browser-native/session/read', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), sessionId, offset: 0, length: 10000 }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

function turnForUserMessage(events, userMessage) {
  return events
    .filter(event => event.type === 'turn/start' && event.seq < userMessage.seq)
    .at(-1)
}

async function readSecrets() {
  const values = [process.env.DEEPSEEK_API_KEY, process.env.OPENAI_API_KEY].filter(value => typeof value === 'string' && value.length > 8)
  const envPath = process.env.COPILOTKIT_POC_ENV_FILE
    ?? resolve(import.meta.dirname, '../../../docs/drafts/.env')
  try {
    const contents = await readFile(envPath, 'utf8')
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=(.*)$/)
      const value = match?.[2]?.replace(/^(?:['"])(.*)(?:['"])$/, '$1')
      if (value !== undefined && value.length > 8) values.push(value)
    }
  } catch {
    return [...new Set(values)]
  }
  return [...new Set(values)]
}

const browser = await browserType.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) })
const context = await browser.newContext()
const page = await context.newPage()
const pageErrors = []
const requests = []
page.on('pageerror', error => pageErrors.push(String(error)))
context.on('request', request => requests.push({ url: request.url(), headers: request.headers() }))
try {
  const firstUrl = withQuery(baseUrl, { e2e: randomUUID(), real: mode === 'real' ? '1' : '0' })
  await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.locator('.dsh-workbench').waitFor({ state: 'visible', timeout: timeoutMs })
  await mkdir(artifactsDir, { recursive: true })
  await page.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-workbench.png`), fullPage: true })
  assert.equal(await page.locator('.dsh-saas-panel').isVisible(), true)
  assert.equal(await page.locator('.dsh-chat-panel').isVisible(), true)

  if (mode === 'scripted') {
    await send(page, '请回复一条简短的测试消息。')
    await waitFor('scripted assistant response', async () => (await page.locator('[data-testid="copilot-assistant-message"]').allTextContents()).some(text => text.includes('Browser-native DSH completed this turn')))
  } else {
    await send(page, '请使用 SaaS workspace 工具读取当前项目和开放工作项，然后告诉我有几个项目。')
    const workspaceToolCard = page.locator('[data-testid="saas-workspace-tool-card"]')
    await workspaceToolCard.waitFor({ state: 'visible', timeout: timeoutMs })
    assert.match(await workspaceToolCard.textContent(), /Workspace context loaded/)
    assert.doesNotMatch(await workspaceToolCard.textContent(), /"projects"\s*:/)
    const assistantCountBeforeList = await page.locator('[data-testid="copilot-assistant-message"]').count()
    await send(page, '请把刚才读取到的三个项目名称各写成一条无序列表，不要补充其他内容。')
    await waitFor('assistant bullet-list response', async () => {
      const messages = page.locator('[data-testid="copilot-assistant-message"]')
      return await messages.count() > assistantCountBeforeList && await messages.last().locator('ul > li').count() === 3
    })
    assert.equal(await page.locator('[data-testid="copilot-suggestions"]').evaluate(element => getComputedStyle(element).display), 'none')
    const listStyle = await page.locator('[data-testid="copilot-assistant-message"]').last().locator('ul > li').first().evaluate(element => {
      const style = getComputedStyle(element)
      return { marginTop: style.marginTop, marginBottom: style.marginBottom, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, lineHeight: style.lineHeight }
    })
    assert.ok(Number.parseFloat(listStyle.marginTop) <= 3, `list item top margin should stay compact: ${listStyle.marginTop}`)
    assert.ok(Number.parseFloat(listStyle.marginBottom) <= 3, `list item bottom margin should stay compact: ${listStyle.marginBottom}`)
    assert.equal(listStyle.paddingTop, '0px')
    assert.equal(listStyle.paddingBottom, '0px')
    assert.ok(Number.parseFloat(listStyle.lineHeight) <= 23, `list item line height should remain readable without excess spacing: ${listStyle.lineHeight}`)
    const listRowOffsets = await page.locator('[data-testid="copilot-assistant-message"]').last().locator('ul > li').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
    assert.equal(listRowOffsets.length, 3)
    for (let index = 1; index < listRowOffsets.length; index += 1) {
      assert.ok(listRowOffsets[index] - listRowOffsets[index - 1] <= 24, `list row gap should stay compact: ${listRowOffsets[index] - listRowOffsets[index - 1]}px`)
    }
    const userMessageLayout = await page.locator('[data-testid="copilot-user-message"]').last().evaluate(element => {
      const bubble = element.querySelector('[class~="cpk:prose"]')
      if (!(bubble instanceof HTMLElement)) throw new Error('CopilotKit user message bubble is missing')
      return {
        rowWidth: element.getBoundingClientRect().width,
        bubbleWidth: bubble.getBoundingClientRect().width,
        rowBorder: getComputedStyle(element).borderTopWidth,
        bubbleBorder: getComputedStyle(bubble).borderTopWidth,
      }
    })
    assert.equal(userMessageLayout.rowBorder, '0px')
    assert.equal(userMessageLayout.bubbleBorder, '1px')
    assert.ok(userMessageLayout.bubbleWidth < userMessageLayout.rowWidth)
    await page.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-agentic-ui-message.png`) })

    await send(page, '请调用 saas_create_work_item 工具，projectId 使用 growth，title 使用 "Prepare launch review"，priority 使用 Medium，assignee 使用 You。请展示该工具生成的可编辑聊天操作卡片；不要调用 ask_user_question，也不要直接创建其他内容。')
    const actionCard = page.locator('[data-testid="saas-create-work-item-card"]')
    await actionCard.waitFor({ state: 'visible', timeout: timeoutMs })
    assert.match(await actionCard.textContent(), /Review and adjust this work item/)
    assert.match(await actionCard.textContent(), /Prepare launch review/)
    await waitFor('action confirmation clear of composer', async () => actionCard.getByRole('button', { name: 'Add to workspace' }).evaluate(button => {
      const buttonRect = button.getBoundingClientRect()
      const overlay = document.querySelector('[data-testid="copilot-input-overlay"]')
      if (!(overlay instanceof HTMLElement)) return false
      const overlayRect = overlay.getBoundingClientRect()
      return buttonRect.bottom <= overlayRect.top || buttonRect.top >= overlayRect.bottom
    }))
    await actionCard.getByLabel('Project').selectOption({ label: 'Platform refresh' })
    await actionCard.getByLabel('Work item title').fill('Confirm launch checklist')
    await actionCard.getByLabel('Priority').selectOption('High')
    await actionCard.getByLabel('Assignee').selectOption('Mina')
    assert.match(await actionCard.textContent(), /Platform refresh · Mina · Planned/)
    await page.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-agentic-card.png`) })
    await actionCard.getByRole('button', { name: 'Add to workspace' }).click()
    await page.locator('[data-testid="saas-create-work-item-result"]').waitFor({ state: 'visible', timeout: timeoutMs })
    assert.equal(await page.locator('.dsh-saas-metrics strong').first().textContent(), '4')
    assert.equal(await page.locator('.dsh-work-item-title').first().textContent(), 'Confirm launch checklist')
    assert.match(await page.locator('[data-testid="saas-create-work-item-result"]').textContent(), /High/)
    assert.match(await page.locator('[data-testid="saas-create-work-item-result"]').textContent(), /Mina/)
    assert.doesNotMatch(await page.locator('[data-testid="saas-create-work-item-result"]').textContent(), /"operationId"\s*:/)

    const previousAssistantCount = await page.locator('[data-testid="copilot-assistant-message"]').count()
    await send(page, '刚才我编辑操作卡片并点击 Add to workspace 后，实际新增到左侧工作项列表中的标题是什么？请只回答标题。')
    await waitFor('multi-turn memory of confirmed SaaS action', async () => {
      const messages = await page.locator('[data-testid="copilot-assistant-message"]').allTextContents()
      return messages.length > previousAssistantCount && messages.at(-1)?.includes('Confirm launch checklist')
    })

    await send(page, '请使用 todo_write 工具添加且只添加一个 pending 任务，标题为 "CopilotKit browser-native DSH acceptance"。工具成功后回复标记 COPILOTKIT_DSH_TOOL_OK')
    await waitFor('DSH todo tool and response', async () => (await page.locator('[data-testid="copilot-message-list"]').textContent()).includes('COPILOTKIT_DSH_TOOL_OK'))

    await send(page, '请调用 saas_create_work_item 工具，projectId 使用 growth，title 使用 "Cancel this draft"，priority 使用 Low，assignee 使用 You，并展示可编辑聊天操作卡片。')
    const cancelCard = page.locator('[data-testid="saas-create-work-item-card"]')
    await cancelCard.waitFor({ state: 'visible', timeout: timeoutMs })
    await cancelCard.getByRole('button', { name: 'Cancel' }).click()
    const sessionId = new URL(page.url()).searchParams.get('sessionId')
    assert.ok(sessionId)
    await waitFor('cancelled DSH tool result', async () => {
      const session = await readSession(sessionId)
      return session.events.some(event => event.type === 'tool/result'
        && event.data.message.isError === true
        && event.data.message.content.some(block => block.type === 'text' && block.text.includes('cancelled the SaaS work-item creation')))
    })
    await waitFor('finished cancelled turn', () => page.locator('.copilotKitChat').getAttribute('data-copilot-running').then(value => value === 'false'))
    assert.equal(await page.locator('.dsh-saas-metrics strong').first().textContent(), '4')

    await send(page, '必须调用 ask_user_question 工具，询问是否批准发布启动清单，提供且只提供两个选项：Approve 和 Reject。不要自行选择或回答，等待我选择。收到选择后只用一句话确认，不要再调用工具。')
    const approvalCard = page.locator('[data-testid="hitl-card"]').last()
    await approvalCard.waitFor({ state: 'visible', timeout: timeoutMs })
    assert.match(await approvalCard.textContent(), /Approve/)
    assert.match(await approvalCard.textContent(), /Reject/)
    await page.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-hitl-question.png`) })
    await approvalCard.getByRole('button', { name: 'Approve', exact: true }).click()
    await waitFor('DSH HITL approval result', async () => {
      const session = await readSession(sessionId)
      const call = session.events.filter(event => event.type === 'tool/call' && event.data.name === 'ask_user_question').at(-1)
      return call !== undefined && session.events.some(event => event.type === 'tool/result'
        && event.data.message.toolCallId === call.data.callId
        && event.data.message.isError !== true
        && event.data.message.content.some(block => block.type === 'text' && block.text.includes('Approve')))
    })
    await waitFor('completed HITL approval run', () => page.locator('.copilotKitChat').getAttribute('data-copilot-running').then(value => value === 'false'))
    await page.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-hitl-answer.png`) })

    await send(page, '必须调用 ask_user_question 工具，询问是否批准归档测试工作项，提供且只提供两个选项：Approve 和 Reject。不要自行选择或回答，等待我选择。收到选择后只用一句话确认，不要再调用工具。')
    const rejectionCard = page.locator('[data-testid="hitl-card"]').last()
    await rejectionCard.waitFor({ state: 'visible', timeout: timeoutMs })
    await rejectionCard.getByRole('button', { name: 'Reject', exact: true }).click()
    await waitFor('DSH HITL rejection result', async () => {
      const session = await readSession(sessionId)
      const call = session.events.filter(event => event.type === 'tool/call' && event.data.name === 'ask_user_question').at(-1)
      return call !== undefined && session.events.some(event => event.type === 'tool/result'
        && event.data.message.toolCallId === call.data.callId
        && event.data.message.isError !== true
        && event.data.message.content.some(block => block.type === 'text' && block.text.includes('Reject')))
    })
    await waitFor('completed HITL rejection run', () => page.locator('.copilotKitChat').getAttribute('data-copilot-running').then(value => value === 'false'))

    await send(page, '必须调用 ask_user_question 工具，询问是否继续测试，提供一个选项 Continue。不要自行选择或回答，等待我操作。')
    const cancelledQuestion = page.locator('[data-testid="hitl-card"]').last()
    await cancelledQuestion.waitFor({ state: 'visible', timeout: timeoutMs })
    await cancelledQuestion.getByRole('button', { name: 'Cancel', exact: true }).click()
    await waitFor('cancelled DSH question result', async () => {
      const session = await readSession(sessionId)
      const call = session.events.filter(event => event.type === 'tool/call' && event.data.name === 'ask_user_question').at(-1)
      return call !== undefined && session.events.some(event => event.type === 'tool/result'
        && event.data.message.toolCallId === call.data.callId
        && event.data.message.isError === true)
    })
    await waitFor('completed cancelled-question run', () => page.locator('.copilotKitChat').getAttribute('data-copilot-running').then(value => value === 'false'))

    const recoveryMarker = `HITL_CANCEL_RECOVERY_${randomUUID()}`
    await send(page, `请原样回复 ${recoveryMarker}，不要调用工具。`)
    await waitFor('continued after cancelled DSH question', async () => (await page.locator('[data-testid="copilot-message-list"]').textContent()).includes(recoveryMarker))

    const stopPrompt = '必须调用 ask_user_question 工具，询问是否继续测试，提供且只提供一个选项 Continue。不要自行选择或回答，等待我操作。'
    const stoppedSessionBefore = await readSession(sessionId)
    await send(page, stopPrompt)
    const stoppedQuestion = page.locator('[data-testid="hitl-card"]').last()
    await stoppedQuestion.waitFor({ state: 'visible', timeout: timeoutMs })
    assert.equal(await page.locator('.copilotKitChat').getAttribute('data-copilot-running'), 'true')
    const stopPendingSession = await readSession(sessionId)
    const stoppedToolCall = stopPendingSession.events.filter(event => event.type === 'tool/call' && event.data.name === 'ask_user_question').at(-1)
    assert.ok(stoppedToolCall)
    await page.getByTestId('copilot-send-button').click()
    await waitFor('DSH cancellation after CopilotKit Stop', async () => {
      if (await page.locator('.copilotKitChat').getAttribute('data-copilot-running') !== 'false') return false
      const session = await readSession(sessionId)
      const userMessage = session.events.find(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text' && block.text === stopPrompt))
      if (userMessage === undefined) return false
      const turnEnded = session.events.some(event => event.type === 'turn/end' && event.seq > userMessage.seq)
      const toolSettled = session.events.some(event => event.type === 'tool/result'
        && event.data.message.toolCallId === stoppedToolCall.data.callId)
      return turnEnded && toolSettled
    })
    await page.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-stop-recovery.png`) })
    const stoppedSession = await readSession(sessionId)
    assert.equal(stoppedSession.events.filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === stopPrompt)).length, 1)
    assert.equal(stoppedSession.events.filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === stopPrompt)).length,
    stoppedSessionBefore.events.filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === stopPrompt)).length + 1)
    const secondTab = await context.newPage()
    await secondTab.goto(withQuery(baseUrl, { sessionId, real: '1', e2e: randomUUID() }), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const lockNotice = secondTab.getByTestId('session-lock-notice')
    await lockNotice.waitFor({ state: 'visible', timeout: timeoutMs })
    assert.match(await lockNotice.textContent(), /read-only/)
    assert.equal(await secondTab.locator('.dsh-chat-interaction').getAttribute('inert'), '')
    const blockedPrompt = `SECOND_TAB_WRITE_PROBE_${randomUUID()}`
    const blockedInput = secondTab.getByTestId('copilot-chat-textarea')
    assert.equal(await blockedInput.evaluate(element => element.closest('[inert]') !== null), true)
    assert.equal((await readSession(sessionId)).events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === blockedPrompt)), false)
    await secondTab.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-second-tab-read-only.png`) })
    await secondTab.close()

    const stopRecoveryMarker = `STOP_RECOVERY_${randomUUID()}`
    await send(page, `请原样回复 ${stopRecoveryMarker}，不要调用工具。`)
    await waitFor('continued after Stop', async () => (await page.locator('[data-testid="copilot-message-list"]').textContent()).includes(stopRecoveryMarker))
    await waitFor('completed Stop recovery turn', async () => {
      if (await page.locator('.copilotKitChat').getAttribute('data-copilot-running') !== 'false') return false
      const session = await readSession(sessionId)
      const userMessage = session.events.find(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text' && block.text.includes(stopRecoveryMarker)))
      if (userMessage === undefined) return false
      const turn = turnForUserMessage(session.events, userMessage)
      return turn !== undefined && session.events.some(event => event.type === 'turn/end'
        && event.data.turn === turn.data.turn && event.data.reason.kind === 'completed')
    })

    const session = await readSession(sessionId)
    const eventTypes = session.events.map(event => event.type)
    assert.equal(eventTypes.filter(type => type === 'todo/write').length, 1)
    const toolCalls = session.events.filter(event => event.type === 'tool/call')
    assert.equal(toolCalls.filter(event => event.data.name === 'ask_user_question').length, 4)
    assert.equal(toolCalls.filter(event => event.data.name === 'saas_get_workspace').length >= 1, true)
    assert.equal(toolCalls.filter(event => event.data.name === 'saas_create_work_item').length, 2)
    assert.equal(toolCalls.every(call => session.events.filter(event => event.type === 'tool/result'
      && event.data.message.toolCallId === call.data.callId).length === 1), true)
    assert.equal(session.events.some(event => event.type === 'tool/result' && event.data.message.isError === true), true)
    const createResults = session.events
      .filter(event => event.type === 'tool/result' && event.data.message.isError !== true)
      .flatMap(event => event.data.message.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
    assert.equal(createResults.filter(text => text.includes('"operationId":"saas-create:')).length, 1)
    assert.equal(eventTypes.filter(type => type === 'turn/end').length >= 4, true)
    const stoppedPrompt = session.events.find(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === stopPrompt))
    assert.ok(stoppedPrompt)
    const stoppedTurn = turnForUserMessage(session.events, stoppedPrompt)
    assert.ok(stoppedTurn)
    assert.equal(session.events.find(event => event.type === 'turn/end' && event.data.turn === stoppedTurn.data.turn)?.data.reason.kind, 'aborted')
    const streamedText = session.events
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.stream ?? [])
      .filter(event => event.type === 'text-chunks')
      .flatMap(event => event.texts)
    assert.ok(streamedText.length > 20, 'the DSH Session must retain the real model token stream')
    const submittedPrompts = session.events
      .filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
      .flatMap(event => event.data.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
    assert.equal(new Set(submittedPrompts).size, submittedPrompts.length)
    assert.equal(submittedPrompts.filter(text => text.includes('saas_create_work_item') && text.includes('Prepare launch review')).length, 1)
    assert.equal(submittedPrompts.filter(text => text.includes('CopilotKit browser-native DSH acceptance')).length, 1)
    const llmProxyRequests = requests.filter(request => new URL(request.url).pathname === '/api/browser-native/llm')
    const loopRequests = session.events.filter(event => event.type === 'step/start').length
    const titleRequests = session.events.filter(event => event.type === 'session/title-llm-request').length
    assert.equal(llmProxyRequests.length, loopRequests + titleRequests)
    const sessionText = JSON.stringify(session.events)
    for (const secret of await readSecrets()) assert.equal(sessionText.includes(secret), false)
    await page.goto(withQuery(baseUrl, { sessionId, real: '1', e2e: randomUUID() }), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.locator('.dsh-workbench').waitFor({ state: 'visible', timeout: timeoutMs })
    await waitFor('hydrated Agentic UI history', async () => (await page.locator('[data-testid="copilot-message-list"]').textContent()).includes('Prepare launch review'))
    assert.equal(await page.locator('.dsh-saas-metrics strong').first().textContent(), '4')
    assert.equal(await page.locator('.dsh-work-item-title').first().textContent(), 'Confirm launch checklist')
    assert.equal(await page.locator('[data-testid="copilot-chat-textarea"]').isEnabled(), true)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileLayout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    columns: getComputedStyle(document.querySelector('.dsh-workbench')).gridTemplateColumns,
    workspaceY: document.querySelector('.dsh-saas-panel').getBoundingClientRect().y,
    chatY: document.querySelector('.dsh-chat-panel').getBoundingClientRect().y,
  }))
  assert.equal(mobileLayout.overflow, false)
  assert.ok(mobileLayout.chatY > mobileLayout.workspaceY)
  await page.screenshot({ path: join(artifactsDir, `${browserName}-${mode}-mobile.png`), fullPage: true })

  assert.deepEqual(pageErrors, [])
  assert.equal(requests.some(request => /copilotkit\.com|api\.copilotkit\.ai/i.test(request.url)), false)
  const secrets = await readSecrets()
  for (const request of requests) {
    const wire = `${request.url}\n${JSON.stringify(request.headers)}`
    for (const secret of secrets) assert.equal(wire.includes(secret), false)
  }
  process.stdout.write(`${JSON.stringify({ mode, browser: browserName, url: page.url(), artifactsDir, mobileLayout, pageErrors, llmProxyRequests: requests.filter(request => new URL(request.url).pathname === '/api/browser-native/llm').length, copilotCloudRequests: requests.filter(request => /copilotkit\.com|api\.copilotkit\.ai/i.test(request.url)).length })}\n`)
} finally {
  await context.close()
  await browser.close()
}
