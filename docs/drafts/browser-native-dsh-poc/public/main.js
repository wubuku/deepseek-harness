const sessionInput = document.querySelector('#session-id')
const promptInput = document.querySelector('#prompt')
const status = document.querySelector('#status')
const eventsOutput = document.querySelector('#events')
const finalOutput = document.querySelector('#final')
const startButton = document.querySelector('#start')
const closeButton = document.querySelector('#close')
const stopButton = document.querySelector('#stop')
const resumeButton = document.querySelector('#resume')
const resetButton = document.querySelector('#reset')

let worker
let lastState = { sessionId: '', events: [], final: '', status: 'idle', owner: undefined }
const seenToolCallIds = new Set()

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function setStatus(value) {
  lastState = { ...lastState, status: value }
  status.textContent = value
}

function renderEvents() {
  eventsOutput.textContent = JSON.stringify(lastState.events, null, 2)
  finalOutput.textContent = lastState.final || 'No final response yet.'
}

function sessionId() {
  if (sessionInput.value.trim().length > 0) return sessionInput.value.trim()
  const value = `browser-native-${crypto.randomUUID()}`
  sessionInput.value = value
  localStorage.setItem('browser-native-dsh-poc-session', value)
  return value
}

function installWorker({ resume = false } = {}) {
  worker?.terminate()
  seenToolCallIds.clear()
  const id = sessionId()
  lastState = { ...lastState, sessionId: id }
  const currentWorker = new Worker('./worker.js', { type: 'module' })
  worker = currentWorker
  currentWorker.onmessage = event => {
    if (worker !== currentWorker) return
    const message = event.data
    if (message.type === 'ready') {
      setStatus(resume ? 'resuming-worker' : 'starting-worker')
      currentWorker.postMessage({ type: 'start', sessionId: id, prompt: promptInput.value })
    } else if (message.type === 'status') {
      setStatus(message.value)
    } else if (message.type === 'owner') {
      lastState = { ...lastState, owner: message.owner }
    } else if (message.type === 'events') {
      lastState = { ...lastState, events: message.events }
      renderEvents()
    } else if (message.type === 'event') {
      lastState = { ...lastState, events: [...lastState.events, message.event] }
      renderEvents()
    } else if (message.type === 'durable') {
      setStatus(`durable through seq ${message.durableThroughSeq}`)
    } else if (message.type === 'tool-call') {
      if (!hasExactKeys(message, ['type', 'protocolVersion', 'kind', 'call']) || message.protocolVersion !== 1 || message.kind !== 'browser-tool-call'
        || !hasExactKeys(message.call, ['callId', 'name', 'args'])
        || typeof message.call.callId !== 'string' || message.call.callId.length === 0
        || message.call.callId.length > 512
        || typeof message.call.name !== 'string'
        || !hasExactKeys(message.call.args, ['text'])) {
        setStatus('error: INVALID_REQUEST: invalid browser tool envelope')
        return
      }
      if (seenToolCallIds.has(message.call.callId)) {
        setStatus('error: INVALID_REQUEST: duplicate browser tool call')
        return
      }
      seenToolCallIds.add(message.call.callId)
      setStatus(`browser tool: ${message.call.name}`)
      void executeBrowserTool(message.call).then(result => {
        if (worker !== currentWorker) return
        currentWorker.postMessage({
        type: 'tool-result',
        protocolVersion: 1,
        kind: 'browser-tool-result',
        ...result,
        })
      })
    } else if (message.type === 'final') {
      lastState = { ...lastState, final: message.content, events: message.events }
      setStatus('completed')
      renderEvents()
    } else if (message.type === 'resumed') {
      lastState = { ...lastState, final: message.final, events: message.events }
      setStatus('resumed-from-flushed-session')
      renderEvents()
    } else if (message.type === 'closed') {
      worker = undefined
      setStatus('worker-closed-gracefully')
    } else if (message.type === 'error') {
      setStatus(`error: ${message.code}: ${message.message}`)
    }
  }
  currentWorker.onerror = event => {
    if (worker === currentWorker) setStatus(`worker error: ${event.message}`)
  }
}

async function executeBrowserTool(call) {
  if (!hasExactKeys(call, ['callId', 'name', 'args'])) {
    return { callId: call?.callId, ok: false, error: { code: 'INVALID_REQUEST', message: 'browser tool call is invalid' } }
  }
  if (call.name !== 'browser_echo') return { callId: call.callId, ok: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'unknown browser tool' } }
  if (typeof call.callId !== 'string' || call.callId.length === 0
    || call.callId.length > 512 || !hasExactKeys(call.args, ['text'])
    || typeof call.args.text !== 'string' || call.args.text.length === 0
    || new TextEncoder().encode(call.args.text).byteLength > 65536) {
    return { callId: call.callId, ok: false, error: { code: 'INVALID_REQUEST', message: 'browser_echo text is invalid' } }
  }
  await new Promise(resolve => setTimeout(resolve, 25))
  return { callId: call.callId, ok: true, result: { text: call.args.text, length: call.args.text.length } }
}

startButton.addEventListener('click', () => {
  lastState = { ...lastState, events: [], final: '' }
  renderEvents()
  installWorker()
})
closeButton.addEventListener('click', () => {
  worker?.postMessage({ type: 'close' })
  setStatus('closing-worker')
})
resumeButton.addEventListener('click', () => installWorker({ resume: true }))
stopButton.addEventListener('click', () => {
  worker?.terminate()
  worker = undefined
  setStatus('worker-terminated-without-close')
})
resetButton.addEventListener('click', () => {
  worker?.terminate()
  worker = undefined
  const value = `browser-native-${crypto.randomUUID()}`
  sessionInput.value = value
  localStorage.setItem('browser-native-dsh-poc-session', value)
  lastState = { sessionId: value, events: [], final: '', status: 'idle', owner: undefined }
  renderEvents()
  setStatus('new-session-ready')
})

sessionInput.value = localStorage.getItem('browser-native-dsh-poc-session') ?? `browser-native-${crypto.randomUUID()}`
localStorage.setItem('browser-native-dsh-poc-session', sessionInput.value)
lastState = { ...lastState, sessionId: sessionInput.value }
renderEvents()

window.__browserNativePoc = {
  start: () => startButton.click(),
  close: () => closeButton.click(),
  stop: () => stopButton.click(),
  resume: () => resumeButton.click(),
  executeTool: executeBrowserTool,
  state: () => structuredClone(lastState),
}
