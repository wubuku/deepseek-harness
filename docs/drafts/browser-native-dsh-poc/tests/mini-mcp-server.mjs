/**
 * Minimal MCP Streamable HTTP server used by the browser proxy E2E.
 *
 * It implements only `initialize`, `notifications/initialized`,
 * `tools/list` and `tools/call` for one `echo` tool, and records the
 * headers it received so the test can prove cookies and browser origin
 * never reach the upstream. Tool calls answer as SSE to exercise the
 * proxy's streaming path.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const TOOL = {
  name: 'echo',
  description: 'Echo the provided text back with a marker.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

function sendSse(response, message) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  response.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Create the fixture server.
 * @returns {Promise<{ origin: string, requests: object[], close(): Promise<void> }>}
 */
export async function createMiniMcpServer() {
  const requests = []
  const sessions = new Set()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
      })
      if (request.url !== '/mcp') {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      if (request.method === 'DELETE') {
        sendJson(response, 204)
        return
      }
      if (request.method === 'GET') {
        sendJson(response, 405, { error: 'SSE GET is not supported by this fixture' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        sendJson(response, 400, rpcError(undefined, -32700, 'parse error'))
        return
      }
      const id = payload.id
      if (payload.method === 'initialize') {
        const sessionId = randomUUID()
        sessions.add(sessionId)
        sendJson(response, 200, rpcResult(id, {
          protocolVersion: payload.params?.protocolVersion ?? '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-mini-mcp', version: '1.0.0' },
        }), { 'mcp-session-id': sessionId })
        return
      }
      if (payload.method === 'notifications/initialized') {
        sendJson(response, 202)
        return
      }
      const sessionId = request.headers['mcp-session-id']
      if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
        sendJson(response, 400, rpcError(id, -32600, 'unknown MCP session'))
        return
      }
      if (payload.method === 'tools/list') {
        sendJson(response, 200, rpcResult(id, { tools: [TOOL] }))
        return
      }
      if (payload.method === 'tools/call') {
        if (payload.params?.name !== 'echo') {
          sendJson(response, 200, rpcResult(id, { content: [{ type: 'text', text: 'unknown tool' }], isError: true }))
          return
        }
        const text = payload.params?.arguments?.text
        sendSse(response, rpcResult(id, {
          content: [{ type: 'text', text: `MCP_ECHO:${typeof text === 'string' ? text : ''}` }],
          isError: false,
        }))
        return
      }
      sendJson(response, 200, rpcError(id, -32601, `unknown method ${String(payload.method)}`))
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(() => resolveClose()))
    },
  }
}
