/**
 * Session-scoped long-term memory slice for the Browser-Native PoC.
 *
 * The store is a provider over OPFS keyed by Workspace and Session ids; the
 * `memory` tool is the only consumer. Every write appends a `memory/entry`
 * event so the durable log records what reached the model as a tool result;
 * recall has no pre-step injection path. Scopes are never shared: a store read
 * whose file header names another Session fails closed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '../../../packages/core/tools/src/index.ts'
import type { StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { BrowserNativeWorkspaceRuntime } from './browser-native-workspace.ts'
import type {} from '@deepseek-ai/dsh-session'

const ROOT_DIRECTORY = 'dsh-browser-native-memory-v1'
const MAX_ENTRIES_PER_SESSION = 256
const MAX_ENTRY_TEXT_CHARS = 4096
const MAX_RECALL_ENTRIES = 12
const MAX_RECALL_CHARS = 8192
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type MemoryErrorCode =
  | 'MEMORY_ENTRY_TOO_LARGE'
  | 'MEMORY_STORE_CORRUPT'
  | 'MEMORY_ISOLATION_VIOLATION'
  | 'MEMORY_SCOPE_INVALID'
  | 'MEMORY_WRITE_FAILED'

class BrowserNativeMemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message)
    this.name = 'BrowserNativeMemoryError'
  }
}

/** One durable memory entry owned by a single Session. */
export interface BrowserNativeMemoryEntry {
  readonly id: string
  readonly text: string
  readonly tags: readonly string[]
  readonly createdAt: string
}

/** Provider/file identity of one memory scope. */
interface MemoryScope {
  readonly workspaceId: string
  readonly sessionId: string
}

interface MemoryFile {
  readonly version: 1
  readonly workspaceId: string
  readonly sessionId: string
  readonly entries: readonly BrowserNativeMemoryEntry[]
}

/** Probe surface exposed only through the PoC Worker test port. */
export interface BrowserNativeMemoryProbe {
  readonly factory: StaticModuleFactory
  /** Return live Session id or throw when no Session is mounted. */
  currentSession(): string
  inspect(sessionId: string): Promise<{ workspaceId: string; sessionId: string; entries: number; bytes: number; file: string }>
  list(): Promise<readonly string[]>
  writeIsolated(sessionId: string, text: string): Promise<void>
  readIsolated(sessionId: string): Promise<readonly BrowserNativeMemoryEntry[]>
  tamperRead(targetSessionId: string, headerSessionId: string): Promise<{ readonly code?: MemoryErrorCode }>
  benchmark(sessionId: string, iterations: number): Promise<{
    writeMs: readonly number[]
    readMs: readonly number[]
    bytes: number
    entries: number
  }>
}

/** Optional Worker-only hook exposing the memory probe to the test port. */
export interface BrowserNativeMemoryTestHooks {
  readonly onModuleReady?: (probe: BrowserNativeMemoryProbe) => void
}

/** Static module and probe sharing one OPFS memory provider. */
export interface BrowserNativeMemoryModule {
  readonly factory: StaticModuleFactory
  readonly probe: BrowserNativeMemoryProbe
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function workspaceIdOf(workspace: BrowserNativeWorkspaceRuntime): string {
  const id = workspace.getWorkspaceId()
  if (id === undefined || !WORKSPACE_ID_PATTERN.test(id)) {
    throw new BrowserNativeMemoryError('MEMORY_SCOPE_INVALID', 'Workspace identity is unavailable')
  }
  return id
}

function assertSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new BrowserNativeMemoryError('MEMORY_SCOPE_INVALID', `Session id ${JSON.stringify(value)} is invalid`)
  }
  return value
}

function fileName(scope: MemoryScope): string {
  return `${assertSessionId(scope.sessionId)}.json`
}

function parseEntry(value: unknown): BrowserNativeMemoryEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.text !== 'string'
    || typeof value.createdAt !== 'string' || !Array.isArray(value.tags)
    || !value.tags.every(tag => typeof tag === 'string')) {
    throw new BrowserNativeMemoryError('MEMORY_STORE_CORRUPT', 'memory entry is malformed')
  }
  return { id: value.id, text: value.text, tags: value.tags, createdAt: value.createdAt }
}

function parseMemoryFile(value: unknown, scope: MemoryScope): MemoryFile {
  if (!isRecord(value) || value.version !== 1 || typeof value.workspaceId !== 'string'
    || typeof value.sessionId !== 'string' || !Array.isArray(value.entries)) {
    throw new BrowserNativeMemoryError('MEMORY_STORE_CORRUPT', 'memory file is malformed')
  }
  if (value.workspaceId !== scope.workspaceId || value.sessionId !== scope.sessionId) {
    throw new BrowserNativeMemoryError(
      'MEMORY_ISOLATION_VIOLATION',
      `memory file for Session "${scope.sessionId}" declares another scope`,
    )
  }
  return { version: 1, workspaceId: value.workspaceId, sessionId: value.sessionId, entries: value.entries.map(parseEntry) }
}

async function memoryDirectory(workspaceId: string): Promise<FileSystemDirectoryHandle> {
  const storage = globalThis.navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw new BrowserNativeMemoryError('MEMORY_WRITE_FAILED', 'OPFS is unavailable in this Worker')
  }
  const root = await storage.getDirectory()
  const namespace = await root.getDirectoryHandle(ROOT_DIRECTORY, { create: true })
  return await namespace.getDirectoryHandle(workspaceId, { create: true })
}

/** OPFS-backed provider: one JSON file per (Workspace, Session) pair. */
class BrowserNativeMemoryStore {
  async read(scope: MemoryScope): Promise<MemoryFile> {
    const directory = await memoryDirectory(scope.workspaceId)
    let handle: FileSystemFileHandle
    try {
      handle = await directory.getFileHandle(fileName(scope))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return { version: 1, workspaceId: scope.workspaceId, sessionId: scope.sessionId, entries: [] }
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await (await handle.getFile()).text())
    } catch (error) {
      throw new BrowserNativeMemoryError('MEMORY_STORE_CORRUPT', `memory file for Session "${scope.sessionId}" is unreadable: ${String(error)}`)
    }
    return parseMemoryFile(parsed, scope)
  }

  async write(scope: MemoryScope, file: MemoryFile): Promise<void> {
    const directory = await memoryDirectory(scope.workspaceId)
    const handle = await directory.getFileHandle(fileName(scope), { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(JSON.stringify(file))
    } finally {
      await writable.close()
    }
  }

  async writeEntry(scope: MemoryScope, text: string, tags: readonly string[]): Promise<{ entry: BrowserNativeMemoryEntry; total: number }> {
    if (text.length === 0) throw new BrowserNativeMemoryError('MEMORY_ENTRY_TOO_LARGE', 'memory text must be non-empty')
    if (text.length > MAX_ENTRY_TEXT_CHARS) {
      throw new BrowserNativeMemoryError('MEMORY_ENTRY_TOO_LARGE', `memory text exceeds ${String(MAX_ENTRY_TEXT_CHARS)} characters`)
    }
    const current = await this.read(scope)
    const entry: BrowserNativeMemoryEntry = Object.freeze({
      id: crypto.randomUUID(),
      text,
      tags: Object.freeze([...tags]),
      createdAt: new Date().toISOString(),
    })
    const entries = [...current.entries, entry].slice(-MAX_ENTRIES_PER_SESSION)
    await this.write(scope, { version: 1, workspaceId: scope.workspaceId, sessionId: scope.sessionId, entries })
    return { entry, total: entries.length }
  }

  async recall(scope: MemoryScope, query: string, limit: number): Promise<{
    entries: readonly BrowserNativeMemoryEntry[]
    total: number
    omitted: number
  }> {
    const file = await this.read(scope)
    const tokens = query.toLowerCase().split(/\s+/u).filter(token => token.length > 0)
    const scored = file.entries
      .map(entry => ({
        entry,
        score: tokens.length === 0 ? 1 : tokens.filter(token => entry.text.toLowerCase().includes(token)
          || entry.tags.some(tag => tag.toLowerCase().includes(token))).length,
      }))
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
    const selected: BrowserNativeMemoryEntry[] = []
    let chars = 0
    let omitted = 0
    for (const { entry } of scored) {
      const size = entry.text.length + entry.tags.join(',').length
      if (selected.length >= limit || chars + size > MAX_RECALL_CHARS) {
        omitted += 1
        continue
      }
      selected.push(entry)
      chars += size
    }
    return { entries: selected, total: scored.length, omitted }
  }

  async forget(scope: MemoryScope, id: string): Promise<{ removed: boolean; total: number }> {
    const file = await this.read(scope)
    const entries = file.entries.filter(entry => entry.id !== id)
    if (entries.length !== file.entries.length) {
      await this.write(scope, { version: 1, workspaceId: scope.workspaceId, sessionId: scope.sessionId, entries })
    }
    return { removed: entries.length !== file.entries.length, total: entries.length }
  }

  async inspect(scope: MemoryScope): Promise<{ entries: number; bytes: number }> {
    const file = await this.read(scope)
    return { entries: file.entries.length, bytes: new TextEncoder().encode(JSON.stringify(file)).byteLength }
  }

  async list(workspaceId: string): Promise<readonly string[]> {
    const directory = await memoryDirectory(workspaceId)
    const names: string[] = []
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind === 'file' && name.endsWith('.json')) names.push(name)
    }
    return names.sort()
  }
}

const MEMORY_ACTIONS = ['write', 'recall', 'forget'] as const

type MemoryAction = typeof MEMORY_ACTIONS[number]

interface MemoryToolArgs {
  readonly action: MemoryAction
  readonly text?: string
  readonly tags?: readonly string[]
  readonly query?: string
  readonly id?: string
  readonly limit?: number
}

interface MemoryToolResult {
  readonly action: MemoryAction
  readonly entries: readonly BrowserNativeMemoryEntry[]
  readonly total: number
  readonly omitted: number
}

function parseMemoryToolArgs(value: unknown): MemoryToolArgs {
  if (!isRecord(value) || !MEMORY_ACTIONS.includes(value.action as MemoryAction)) {
    throw new BrowserNativeMemoryError('MEMORY_SCOPE_INVALID', 'memory action must be write, recall, or forget')
  }
  const action = value.action as MemoryAction
  if (value.text !== undefined && typeof value.text !== 'string') {
    throw new BrowserNativeMemoryError('MEMORY_ENTRY_TOO_LARGE', 'memory text must be a string')
  }
  if (value.query !== undefined && typeof value.query !== 'string') {
    throw new BrowserNativeMemoryError('MEMORY_SCOPE_INVALID', 'memory query must be a string')
  }
  if (value.id !== undefined && typeof value.id !== 'string') {
    throw new BrowserNativeMemoryError('MEMORY_SCOPE_INVALID', 'memory id must be a string')
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || !value.tags.every(tag => typeof tag === 'string'))) {
    throw new BrowserNativeMemoryError('MEMORY_SCOPE_INVALID', 'memory tags must be an array of strings')
  }
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1)) {
    throw new BrowserNativeMemoryError('MEMORY_SCOPE_INVALID', 'memory limit must be a positive integer')
  }
  return {
    action,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(Array.isArray(value.tags) ? { tags: value.tags as string[] } : {}),
    ...(typeof value.query === 'string' ? { query: value.query } : {}),
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
  }
}

function parseMemoryToolResult(value: unknown): MemoryToolResult {
  if (!isRecord(value) || !MEMORY_ACTIONS.includes(value.action as MemoryAction)
    || !Array.isArray(value.entries) || typeof value.total !== 'number' || typeof value.omitted !== 'number') {
    throw new BrowserNativeMemoryError('MEMORY_STORE_CORRUPT', 'memory tool result is malformed')
  }
  return {
    action: value.action as MemoryAction,
    entries: value.entries.map(parseEntry),
    total: value.total,
    omitted: value.omitted,
  }
}

/**
 * Create the Worker-only memory provider and the `memory` tool consumer.
 * @param workspace - Runtime that owns the current Workspace identity.
 * @param testHooks - Optional hook receiving the probe when the test port is enabled.
 * @returns Memoized static module plus its scoped test operations.
 */
export function createBrowserNativeMemoryModule(
  workspace: BrowserNativeWorkspaceRuntime,
  testHooks: BrowserNativeMemoryTestHooks = {},
): BrowserNativeMemoryModule {
  const store = new BrowserNativeMemoryStore()
  let liveContext: Context | undefined
  const scopeFor = (sessionId: string): MemoryScope => ({
    workspaceId: workspaceIdOf(workspace),
    sessionId: assertSessionId(sessionId),
  })
  const currentSession = (): string => {
    const sessions = liveContext?.get('sessions') as { list(): readonly { id: unknown }[] } | undefined
    const session = sessions?.list().at(-1)
    if (session === undefined) throw new Error('browser-native memory: no live Session is mounted')
    return String(session.id)
  }
  const probe: BrowserNativeMemoryProbe = {
    factory: () => module,
    currentSession,
    inspect: async sessionId => {
      const scope = scopeFor(sessionId)
      const summary = await store.inspect(scope)
      return { ...scope, ...summary, file: fileName(scope) }
    },
    list: async () => await store.list(workspaceIdOf(workspace)),
    writeIsolated: async (sessionId, text) => {
      await store.writeEntry(scopeFor(sessionId), text, ['isolated-probe'])
    },
    readIsolated: async sessionId => (await store.read(scopeFor(sessionId))).entries,
    tamperRead: async (targetSessionId, headerSessionId) => {
      const scope = scopeFor(targetSessionId)
      const header = scopeFor(headerSessionId)
      const entry = parseEntry({
        id: crypto.randomUUID(),
        text: 'tampered memory marker',
        tags: [],
        createdAt: new Date().toISOString(),
      })
      await store.write(scope, {
        version: 1,
        workspaceId: scope.workspaceId,
        sessionId: header.sessionId,
        entries: [entry],
      })
      try {
        await store.read(scope)
        return {}
      } catch (error) {
        if (error instanceof BrowserNativeMemoryError) return { code: error.code }
        throw error
      }
    },
    benchmark: async (sessionId, iterations) => {
      const scope = scopeFor(sessionId)
      const writeMs: number[] = []
      const readMs: number[] = []
      for (let index = 0; index < iterations; index += 1) {
        const writeStarted = performance.now()
        await store.writeEntry(scope, `benchmark entry ${String(index)}: alpha beta gamma memory probe`, [])
        writeMs.push(Math.max(0, performance.now() - writeStarted))
        const readStarted = performance.now()
        await store.read(scope)
        readMs.push(Math.max(0, performance.now() - readStarted))
      }
      const summary = await store.inspect(scope)
      return { writeMs, readMs, bytes: summary.bytes, entries: summary.entries }
    },
  }
  const memoryTool: ToolDefinition = {
    name: 'memory',
    description: [
      'Persist and recall facts for THIS Session only. Entries survive page reloads in the Worker',
      'OPFS and are never shared with another Session or Workspace. Recall returns matching entries',
      'as a tool result; every write is recorded in the Session log.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...MEMORY_ACTIONS],
          description: 'write one entry, recall matching entries, or remove one entry by id.',
        },
        text: { type: 'string', description: 'Entry text for action=write.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels for action=write.' },
        query: { type: 'string', description: 'Case-insensitive keyword query for action=recall; empty returns recent entries.' },
        id: { type: 'string', description: 'Entry id for action=forget.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RECALL_ENTRIES,
          description: `Maximum entries for action=recall (1-${String(MAX_RECALL_ENTRIES)}).`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'entries', 'total', 'omitted'],
        properties: {
          action: { type: 'string', enum: [...MEMORY_ACTIONS] },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text', 'tags', 'createdAt'],
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                createdAt: { type: 'string' },
              },
            },
          },
          total: { type: 'integer' },
          omitted: { type: 'integer' },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const result = parseMemoryToolResult(value)
        const header = result.action === 'recall'
          ? `Recalled ${String(result.entries.length)} of ${String(result.total)} matching memory entries.`
          : result.action === 'write'
            ? `Stored memory entry; ${String(result.total)} entries in this Session.`
            : `Memory removal applied; ${String(result.total)} entries remain.`
        return [{
          type: 'text',
          text: [header, ...result.entries.map(entry => `- [${entry.id}] ${entry.text}`)].join('\n'),
        }]
      },
    },
    execute: async (rawArgs: unknown, exec: ToolRunContext) => {
      const args = parseMemoryToolArgs(rawArgs)
      if (exec.agent === undefined) throw new Error('memory requires an owning agent Session')
      const scope: MemoryScope = { workspaceId: workspaceIdOf(workspace), sessionId: String(exec.agent.session.id) }
      if (args.action === 'write') {
        if (args.text === undefined) throw new BrowserNativeMemoryError('MEMORY_ENTRY_TOO_LARGE', 'text is required for action=write')
        const result = await store.writeEntry(scope, args.text, args.tags ?? [])
        // Append after the durable store so the log never claims an entry that was not written.
        exec.agent.session.append('memory/entry', {
          id: result.entry.id,
          text: result.entry.text,
          tags: result.entry.tags,
          createdAt: result.entry.createdAt,
        })
        return { action: 'write', entries: [result.entry], total: result.total, omitted: 0 }
      }
      if (args.action === 'recall') {
        const limit = Math.min(MAX_RECALL_ENTRIES, Math.max(1, args.limit ?? MAX_RECALL_ENTRIES))
        return { action: 'recall', ...await store.recall(scope, args.query ?? '', limit) }
      }
      if (args.id === undefined) throw new Error('id is required for action=forget')
      const result = await store.forget(scope, args.id)
      return { action: 'forget', entries: [], total: result.total, omitted: 0 }
    },
    presentCall: (rawArgs: unknown) => {
      const args = parseMemoryToolArgs(rawArgs)
      return {
        card: 'generic',
        title: `Memory ${args.action}`,
        kind: 'other',
        rawInput: {
          action: args.action,
          text: args.text,
          tags: args.tags,
          query: args.query,
          id: args.id,
          limit: args.limit,
        },
      }
    },
  }
  const module = {
    default: {
      name: 'browser-native-memory',
      inject: ['tools'],
      apply(ctx: Context): void {
        ctx.effect(() => {
          liveContext = ctx
          return () => {
            if (liveContext === ctx) liveContext = undefined
          }
        }, 'browser-native memory probe')
        ctx.tools.register(memoryTool)
      },
    },
  }
  testHooks.onModuleReady?.(probe)
  return { factory: () => module, probe }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** A Session-scoped memory entry became durable. */
    'memory/entry': {
      readonly id: string
      readonly text: string
      readonly tags: readonly string[]
      readonly createdAt: string
    }
  }
}
