interface MatchRequest {
  readonly requestId: number
  readonly pattern: string
  readonly lines: readonly string[]
}

const regexCache = new Map<string, RegExp>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRequest(value: unknown): MatchRequest | undefined {
  if (!isRecord(value) || value.type !== 'match' || !Number.isSafeInteger(value.requestId)
    || typeof value.pattern !== 'string' || new TextEncoder().encode(value.pattern).byteLength > 4 * 1024
    || !Array.isArray(value.lines) || value.lines.length > 32
    || !value.lines.every((line): line is string => typeof line === 'string')) return undefined
  const lines = value.lines
  const encoder = new TextEncoder()
  let bytes = 0
  for (const line of lines) {
    const lineBytes = encoder.encode(line).byteLength
    if (lineBytes > 64 * 1024) return undefined
    bytes += lineBytes
    if (bytes > 256 * 1024) return undefined
  }
  return { requestId: Number(value.requestId), pattern: value.pattern, lines }
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = parseRequest(event.data)
  if (request === undefined) {
    self.postMessage({ type: 'error', errorCode: 'SEARCH_REGEX_PROTOCOL_ERROR' })
    return
  }
  let regex = regexCache.get(request.pattern)
  if (regex === undefined) {
    try {
      regex = new RegExp(request.pattern, 'u')
    } catch {
      self.postMessage({ type: 'result', requestId: request.requestId, ok: false, errorCode: 'SEARCH_INVALID_PATTERN' })
      return
    }
    regexCache.set(request.pattern, regex)
    if (regexCache.size > 8) {
      const oldest = regexCache.keys().next().value
      if (oldest !== undefined) regexCache.delete(oldest)
    }
  }
  self.postMessage({ type: 'started', requestId: request.requestId })
  const indices: number[] = []
  for (let index = 0; index < request.lines.length; index += 1) {
    const line = request.lines[index]
    if (line !== undefined && regex.test(line)) indices.push(index)
  }
  self.postMessage({ type: 'result', requestId: request.requestId, ok: true, indices })
})
