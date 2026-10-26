import type { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import type { VfsBigIntStats, VfsFileBacking, VfsOpenFile } from '../../../packages/experimental/webworker-runtime/src/storage/types.ts'
import {
  createSyncAccessChunkBackedFile,
  replaceUtf8CopyOnWriteAsync,
  type ChunkBackedFile,
  type ChunkEditStage,
} from './browser-native-chunk-editor.ts'

const WORKSPACE_ROOT = '/dsh/home/workspace'
const MAX_SEARCH_FILES = 10_000
const MAX_SEARCH_BYTES = 32 * 1024 * 1024
const MAX_SEARCH_MATCHES = 5_000
const MAX_SEARCH_LINES = 250_000
const MAX_SEARCH_DURATION_MS = 30_000
const MAX_GLOB_RESULTS = 5_000
const MAX_SEARCH_PATTERN_BYTES = 4 * 1024
const MAX_INCLUDE_PATTERN_BYTES = 4 * 1024
const MAX_GLOB_ALTERNATIVES = 128
const SEARCH_CHUNK_BYTES = 64 * 1024
const MAX_MATCHED_LINE_BYTES = 64 * 1024
const MAX_REGEX_BATCH_LINES = 32
const MAX_REGEX_BATCH_BYTES = 256 * 1024
const MAX_REGEX_BATCH_DURATION_MS = 1_000
const MAX_EDIT_ARGUMENT_BYTES = 256 * 1024
const MAX_EDIT_FILE_BYTES = 64 * 1024 * 1024
const EDIT_CHUNK_BYTES = 1024 * 1024
const MAX_EDIT_RESULT_BYTES = 256 * 1024
const EDIT_DIRECTORY_PREFIX = 'dsh-browser-native-edit-'
const encoder = new TextEncoder()
const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
const activeEditDirectories = new Set<string>()

export interface BrowserNativeGrepMatch {
  readonly path: string
  readonly lineNumber: number
  readonly line: string
}
export interface BrowserNativeGrepInput {
  readonly pattern: string
  readonly path?: string
  readonly include?: string
}

export interface BrowserNativeGlobInput {
  readonly pattern: string
  readonly path?: string
}

interface BrowserNativeEditInput {
  readonly filePath: string
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
}

export interface BrowserNativeEditResult {
  readonly path: string
  readonly before: string
  readonly after: string
}

export class BrowserNativeFileToolError extends Error {
  constructor(message: string, readonly code: string) {
    super(`${code}: ${message}`)
    this.name = 'BrowserNativeFileToolError'
  }
}

/** One cancellable, bounded regex execution worker used by a grep operation. */
export interface BrowserNativeRegexMatcher {
  /** Validate a pattern in the isolated worker without scanning workspace data. */
  validate(pattern: string, signal: AbortSignal, timeoutMs: number): Promise<void>
  /** Match a bounded group of decoded lines and return their matching indexes. */
  match(pattern: string, lines: readonly string[], signal: AbortSignal, timeoutMs: number, onStarted?: () => void): Promise<readonly number[]>
  /** Stop the matcher worker and release its message handlers. */
  dispose(): void
}

/** Create a matcher for one validated grep pattern. */
export type BrowserNativeRegexMatcherFactory = () => BrowserNativeRegexMatcher

interface PendingRegexMatch {
  readonly requestId: number
  readonly lineCount: number
  readonly signal: AbortSignal
  readonly onStarted?: () => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (indices: readonly number[]) => void
  readonly reject: (error: Error) => void
  readonly onAbort: () => void
  started: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class WorkerRegexMatcher implements BrowserNativeRegexMatcher {
  private readonly worker: Worker
  private requestId = 0
  private pending: PendingRegexMatch | undefined
  private disposed = false

  constructor() {
    if (typeof Worker === 'undefined') {
      throw new BrowserNativeFileToolError('isolated regex Workers are unavailable', 'SEARCH_REGEX_WORKER_UNAVAILABLE')
    }
    try {
      this.worker = new Worker(new URL('./browser-native-regex-worker.ts', import.meta.url), {
        type: 'module',
        name: 'dsh-browser-native-grep-regex',
      })
    } catch (error) {
      throw new BrowserNativeFileToolError(`cannot start an isolated regex Worker: ${String(error)}`, 'SEARCH_REGEX_WORKER_UNAVAILABLE')
    }
    this.worker.onmessage = event => { this.handleMessage(event.data) }
    this.worker.onerror = event => {
      event.preventDefault()
      this.fail(new BrowserNativeFileToolError('isolated regex Worker failed', 'SEARCH_REGEX_WORKER_FAILED'))
    }
    this.worker.onmessageerror = () => {
      this.fail(new BrowserNativeFileToolError('isolated regex Worker returned an unreadable response', 'SEARCH_REGEX_PROTOCOL_ERROR'))
    }
  }

  async validate(pattern: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    await this.match(pattern, [], signal, timeoutMs)
  }

  match(pattern: string, lines: readonly string[], signal: AbortSignal, timeoutMs: number, onStarted?: () => void): Promise<readonly number[]> {
    if (this.disposed) return Promise.reject(new BrowserNativeFileToolError('regex Worker is closed', 'SEARCH_REGEX_WORKER_FAILED'))
    if (signal.aborted) return Promise.reject(new BrowserNativeFileToolError('search was aborted', 'SEARCH_ABORTED'))
    if (this.pending !== undefined) return Promise.reject(new BrowserNativeFileToolError('regex Worker already has a request', 'SEARCH_REGEX_PROTOCOL_ERROR'))
    const encodedBytes = lines.reduce((total, line) => total + encoder.encode(line).byteLength, 0)
    if (encoder.encode(pattern).byteLength > MAX_SEARCH_PATTERN_BYTES || lines.length > MAX_REGEX_BATCH_LINES
      || encodedBytes > MAX_REGEX_BATCH_BYTES || lines.some(line => encoder.encode(line).byteLength > MAX_MATCHED_LINE_BYTES)) {
      return Promise.reject(new BrowserNativeFileToolError('regex Worker input exceeds its message budget', 'SEARCH_REGEX_INPUT_TOO_LARGE'))
    }
    const requestId = ++this.requestId
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.finishPending(new BrowserNativeFileToolError('search was aborted', 'SEARCH_ABORTED'))
        this.dispose()
      }
      const timer = setTimeout(() => {
        this.finishPending(new BrowserNativeFileToolError('regex matching exceeded its Worker time budget', 'SEARCH_REGEX_TIMEOUT'))
        this.dispose()
      }, timeoutMs)
      this.pending = { requestId, lineCount: lines.length, signal, ...(onStarted === undefined ? {} : { onStarted }), timer, resolve, reject, onAbort, started: false }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        this.worker.postMessage({ type: 'match', requestId, pattern, lines })
      } catch (error) {
        this.fail(new BrowserNativeFileToolError(`cannot send regex work to Worker: ${String(error)}`, 'SEARCH_REGEX_WORKER_FAILED'))
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.pending !== undefined) this.finishPending(new BrowserNativeFileToolError('regex Worker was closed', 'SEARCH_REGEX_WORKER_FAILED'))
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.onmessageerror = null
    this.worker.terminate()
  }

  private handleMessage(value: unknown): void {
    const pending = this.pending
    if (!isRecord(value) || pending === undefined || value.requestId !== pending.requestId) {
      this.fail(new BrowserNativeFileToolError('regex Worker returned an invalid response', 'SEARCH_REGEX_PROTOCOL_ERROR'))
      return
    }
    if (value.type === 'started') {
      if (pending.started) {
        this.fail(new BrowserNativeFileToolError('regex Worker repeated its start response', 'SEARCH_REGEX_PROTOCOL_ERROR'))
        return
      }
      pending.started = true
      try {
        pending.onStarted?.()
      } catch (error) {
        this.fail(new BrowserNativeFileToolError(`matcher start observer failed: ${String(error)}`, 'SEARCH_REGEX_WORKER_FAILED'))
      }
      return
    }
    if (value.type !== 'result' || typeof value.ok !== 'boolean') {
      this.fail(new BrowserNativeFileToolError('regex Worker returned an invalid result', 'SEARCH_REGEX_PROTOCOL_ERROR'))
      return
    }
    if (!value.ok) {
      const code = value.errorCode === 'SEARCH_INVALID_PATTERN' ? value.errorCode : 'SEARCH_REGEX_WORKER_FAILED'
      this.fail(new BrowserNativeFileToolError('regex Worker could not process the search pattern', code))
      return
    }
    if (!Array.isArray(value.indices) || value.indices.some((index, position) =>
      !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= pending.lineCount
        || (position > 0 && Number(index) <= Number(value.indices[position - 1])))) {
      this.fail(new BrowserNativeFileToolError('regex Worker returned invalid match indexes', 'SEARCH_REGEX_PROTOCOL_ERROR'))
      return
    }
    this.finishPending(undefined, value.indices.map(Number))
  }

  private finishPending(error?: Error, indices: readonly number[] = []): void {
    const pending = this.pending
    if (pending === undefined) return
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)
    if (error === undefined) pending.resolve(indices)
    else pending.reject(error)
  }

  private fail(error: Error): void {
    this.finishPending(error)
    this.dispose()
  }
}

function createWorkerRegexMatcher(): BrowserNativeRegexMatcher {
  return new WorkerRegexMatcher()
}

async function yieldToWorker(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return true
  await new Promise<void>(resolve => { setTimeout(resolve, delayMs) })
  return signal.aborted
}

function parseGrepInput(value: unknown): BrowserNativeGrepInput {
  if (!isRecord(value) || typeof value.pattern !== 'string') {
    throw new BrowserNativeFileToolError('pattern must be a string', 'SEARCH_INVALID_ARGUMENT')
  }
  if (value.pattern.length === 0) throw new BrowserNativeFileToolError('pattern must be a non-empty string', 'SEARCH_INVALID_ARGUMENT')
  if (encoder.encode(value.pattern).byteLength > MAX_SEARCH_PATTERN_BYTES) {
    throw new BrowserNativeFileToolError(`pattern exceeds the ${String(MAX_SEARCH_PATTERN_BYTES)}-byte browser limit`, 'SEARCH_PATTERN_TOO_LARGE')
  }
  if (value.path !== undefined && typeof value.path !== 'string') {
    throw new BrowserNativeFileToolError('path must be a string when given', 'SEARCH_INVALID_ARGUMENT')
  }
  if (value.include !== undefined && typeof value.include !== 'string') {
    throw new BrowserNativeFileToolError('include must be a string when given', 'SEARCH_INVALID_ARGUMENT')
  }
  if (typeof value.include === 'string' && (value.include.trim().length === 0 || value.include.startsWith('!'))) {
    throw new BrowserNativeFileToolError('include must be one non-empty positive glob', 'SEARCH_INVALID_ARGUMENT')
  }
  if (typeof value.include === 'string' && encoder.encode(value.include).byteLength > MAX_INCLUDE_PATTERN_BYTES) {
    throw new BrowserNativeFileToolError(`include exceeds the ${String(MAX_INCLUDE_PATTERN_BYTES)}-byte browser limit`, 'SEARCH_PATTERN_TOO_LARGE')
  }
  return {
    pattern: value.pattern,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.include === undefined ? {} : { include: value.include }),
  }
}

function parseGlobInput(value: unknown): BrowserNativeGlobInput {
  if (!isRecord(value) || typeof value.pattern !== 'string' || value.pattern.trim().length === 0) {
    throw new BrowserNativeFileToolError('pattern must be a non-empty string', 'SEARCH_INVALID_ARGUMENT')
  }
  if (value.path !== undefined && typeof value.path !== 'string') {
    throw new BrowserNativeFileToolError('path must be a string when given', 'SEARCH_INVALID_ARGUMENT')
  }
  if (encoder.encode(value.pattern).byteLength > MAX_SEARCH_PATTERN_BYTES) {
    throw new BrowserNativeFileToolError(`pattern exceeds the ${String(MAX_SEARCH_PATTERN_BYTES)}-byte browser limit`, 'SEARCH_PATTERN_TOO_LARGE')
  }
  return { pattern: value.pattern, ...(value.path === undefined ? {} : { path: value.path }) }
}

function parseEditInput(value: unknown): BrowserNativeEditInput {
  if (!isRecord(value) || typeof value.file_path !== 'string' || typeof value.old_string !== 'string'
    || typeof value.new_string !== 'string') {
    throw new BrowserNativeFileToolError('file_path, old_string and new_string must be strings', 'FS_IO_ERROR')
  }
  if (value.file_path.trim().length === 0) throw new BrowserNativeFileToolError('file_path must be a non-empty string', 'FS_IO_ERROR')
  if (value.old_string.length === 0) throw new BrowserNativeFileToolError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  if (value.old_string === value.new_string) throw new BrowserNativeFileToolError('old_string and new_string must differ', 'FS_IO_ERROR')
  if (value.replace_all !== undefined && typeof value.replace_all !== 'boolean') {
    throw new BrowserNativeFileToolError('replace_all must be a boolean when given', 'FS_IO_ERROR')
  }
  if (encoder.encode(value.old_string).byteLength + encoder.encode(value.new_string).byteLength > MAX_EDIT_ARGUMENT_BYTES) {
    throw new BrowserNativeFileToolError(`edit arguments exceed the ${String(MAX_EDIT_ARGUMENT_BYTES)}-byte browser limit`, 'EDIT_PAYLOAD_TOO_LARGE')
  }
  return {
    filePath: value.file_path,
    oldString: value.old_string,
    newString: value.new_string,
    replaceAll: value.replace_all === true,
  }
}

function absoluteWorkspacePath(input: string | undefined): string {
  if (input === undefined || input === '') return WORKSPACE_ROOT
  const candidate = input.startsWith('/') ? input : `${WORKSPACE_ROOT}/${input}`
  const parts = candidate.split('/')
  if (parts.some(part => part === '..')) {
    throw new BrowserNativeFileToolError('path cannot escape the Worker workspace', 'SEARCH_INVALID_PATH')
  }
  const normalized = parts.filter(part => part !== '' && part !== '.').join('/')
  const absolute = `/${normalized}`
  if (absolute !== WORKSPACE_ROOT && !absolute.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new BrowserNativeFileToolError('path must stay under the Worker workspace', 'SEARCH_INVALID_PATH')
  }
  return absolute
}

function relativeWorkspacePath(path: string): string {
  return path === WORKSPACE_ROOT ? '.' : path.slice(WORKSPACE_ROOT.length + 1)
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{')
  if (start < 0) return [pattern]
  let depth = 0
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const body = pattern.slice(start + 1, index)
        const alternatives = body.split(',')
        if (alternatives.length < 2) return [pattern]
        const expanded = alternatives.flatMap(alternative => expandBraces(`${pattern.slice(0, start)}${alternative}${pattern.slice(index + 1)}`))
        if (expanded.length > MAX_GLOB_ALTERNATIVES) {
          throw new BrowserNativeFileToolError(`glob expands to more than ${String(MAX_GLOB_ALTERNATIVES)} alternatives`, 'SEARCH_PATTERN_TOO_COMPLEX')
        }
        return expanded
      }
    }
  }
  return [pattern]
}

function globRegex(pattern: string): string {
  const source = expandBraces(pattern).map(alternative => {
    let output = ''
    for (let index = 0; index < alternative.length; index += 1) {
      const char = alternative[index]
      if (char === '*' && alternative[index + 1] === '*') {
        index += 1
        if (alternative[index + 1] === '/') index += 1
        output += '.*'
      } else if (char === '*') {
        output += '[^/]*'
      } else if (char === '?') {
        output += '[^/]'
      } else {
        output += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char
      }
    }
    return alternative.includes('/') ? output : `(?:.*/)?${output}`
  }).join('|')
  return `^(?:${source})$`
}

function fileBytes(vfs: MemoryVfs, path: string): Uint8Array {
  const value = vfs.readFileSync(path)
  return typeof value === 'string' ? encoder.encode(value) : value
}

async function* walkFiles(vfs: MemoryVfs, root: string, signal: AbortSignal, yieldDelayMs: number): AsyncGenerator<string> {
  const rootStat = vfs.statSync(root)
  if (rootStat.isFile()) {
    yield root
    return
  }
  const pending = [root]
  let fileCount = 0
  while (pending.length > 0) {
    if (signal.aborted) return
    const current = pending.pop()
    if (current === undefined) continue
    const stat = vfs.statSync(current)
    if (stat.isFile()) {
      fileCount += 1
      if (fileCount > MAX_SEARCH_FILES) {
        throw new BrowserNativeFileToolError(`search would inspect more than ${String(MAX_SEARCH_FILES)} files`, 'SEARCH_RESULT_OVERFLOW')
      }
      yield current
      if (fileCount % 16 === 0 && await yieldToWorker(signal, yieldDelayMs)) return
      continue
    }
    const names = vfs.readdirSync(current)
    if (names.length > MAX_SEARCH_FILES) {
      throw new BrowserNativeFileToolError(`directory contains more than ${String(MAX_SEARCH_FILES)} entries`, 'SEARCH_RESULT_OVERFLOW')
    }
    for (let index = names.length - 1; index >= 0; index -= 1) {
      if (signal.aborted) return
      const name = names[index]
      if (name === undefined) continue
      const child = `${current}/${name}`
      if (IGNORED_DIRECTORY_NAMES.has(name) && vfs.statSync(child).isDirectory()) continue
      pending.push(child)
      if (index % 64 === 0 && await yieldToWorker(signal, yieldDelayMs)) return
    }
  }
}

interface BrowserNativeSearchBudget {
  scannedBytes: number
  scannedLines: number
  readonly deadline: number
}

interface PendingSearchLine {
  readonly lineNumber: number
  readonly text: string
  readonly bytes: number
}

function assertSearchActive(signal: AbortSignal, budget: BrowserNativeSearchBudget): void {
  if (signal.aborted) throw new BrowserNativeFileToolError('search was aborted', 'SEARCH_ABORTED')
  if (performance.now() >= budget.deadline) {
    throw new BrowserNativeFileToolError('search exceeded its Worker time budget', 'SEARCH_TIMEOUT')
  }
}

async function searchFile(
  vfs: MemoryVfs,
  path: string,
  pattern: string,
  matcher: BrowserNativeRegexMatcher,
  matches: BrowserNativeGrepMatch[],
  budget: BrowserNativeSearchBudget,
  signal: AbortSignal,
  yieldDelayMs: number,
  onMatcherStarted?: () => void,
): Promise<void> {
  const file = vfs.openFileSync(path, 'r')
  const size = file.stat().size
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let position = 0
  let lineNumber = 1
  let pending = ''
  let batch: PendingSearchLine[] = []
  let batchBytes = 0

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return
    assertSearchActive(signal, budget)
    const rows = batch
    batch = []
    batchBytes = 0
    const remainingMs = budget.deadline - performance.now()
    const indexes = await matcher.match(pattern, rows.map(row => row.text), signal,
      Math.min(MAX_REGEX_BATCH_DURATION_MS, remainingMs), onMatcherStarted)
    assertSearchActive(signal, budget)
    for (const index of indexes) {
      const row = rows[index]
      if (row === undefined) throw new BrowserNativeFileToolError('regex Worker returned an unknown line index', 'SEARCH_REGEX_PROTOCOL_ERROR')
      matches.push({ path: relativeWorkspacePath(path), lineNumber: row.lineNumber, line: row.text })
      if (matches.length > MAX_SEARCH_MATCHES) {
        throw new BrowserNativeFileToolError(`search returned more than ${String(MAX_SEARCH_MATCHES)} matches`, 'SEARCH_RESULT_OVERFLOW')
      }
    }
  }

  const consumeLine = async (line: string): Promise<void> => {
    assertSearchActive(signal, budget)
    budget.scannedLines += 1
    if (budget.scannedLines > MAX_SEARCH_LINES) {
      throw new BrowserNativeFileToolError(`search would inspect more than ${String(MAX_SEARCH_LINES)} lines`, 'SEARCH_RESULT_OVERFLOW')
    }
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    const bytes = encoder.encode(normalized).byteLength
    if (bytes > MAX_MATCHED_LINE_BYTES) {
      throw new BrowserNativeFileToolError(`matched line in ${relativeWorkspacePath(path)} exceeds the ${String(MAX_MATCHED_LINE_BYTES)}-byte result limit`, 'SEARCH_LINE_TOO_LONG')
    }
    batch.push({ lineNumber, text: normalized, bytes })
    batchBytes += bytes
    if (batch.length >= MAX_REGEX_BATCH_LINES || batchBytes >= MAX_REGEX_BATCH_BYTES) await flushBatch()
  }

  try {
    while (position < size) {
      assertSearchActive(signal, budget)
      const bytes = file.read(position, Math.min(SEARCH_CHUNK_BYTES, size - position))
      if (bytes.byteLength === 0) break
      position += bytes.byteLength
      budget.scannedBytes += bytes.byteLength
      if (budget.scannedBytes > MAX_SEARCH_BYTES) {
        throw new BrowserNativeFileToolError(`search exceeded the ${String(MAX_SEARCH_BYTES)}-byte scan limit`, 'SEARCH_RESULT_OVERFLOW')
      }
      if (bytes.includes(0)) {
        throw new BrowserNativeFileToolError(`cannot search binary file ${relativeWorkspacePath(path)} as UTF-8 text`, 'SEARCH_BINARY_FILE')
      }
      let text: string
      try {
        text = decoder.decode(bytes, { stream: position < size })
      } catch (error) {
        throw new BrowserNativeFileToolError(`cannot decode ${relativeWorkspacePath(path)} as UTF-8 text: ${String(error)}`, 'SEARCH_BINARY_FILE')
      }
      pending += text
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        await consumeLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        lineNumber += 1
        if (lineNumber % 128 === 0 && await yieldToWorker(signal, yieldDelayMs)) {
          throw new BrowserNativeFileToolError('search was aborted', 'SEARCH_ABORTED')
        }
        newline = pending.indexOf('\n')
      }
      if (encoder.encode(pending).byteLength > MAX_MATCHED_LINE_BYTES) {
        throw new BrowserNativeFileToolError(`line in ${relativeWorkspacePath(path)} exceeds the ${String(MAX_MATCHED_LINE_BYTES)}-byte search limit`, 'SEARCH_LINE_TOO_LONG')
      }
      if (await yieldToWorker(signal, yieldDelayMs)) throw new BrowserNativeFileToolError('search was aborted', 'SEARCH_ABORTED')
    }
    try {
      pending += decoder.decode()
    } catch (error) {
      throw new BrowserNativeFileToolError(`cannot decode ${relativeWorkspacePath(path)} as UTF-8 text: ${String(error)}`, 'SEARCH_BINARY_FILE')
    }
    if (pending.length > 0) await consumeLine(pending)
    await flushBatch()
  } catch (error) {
    if (error instanceof BrowserNativeFileToolError) throw error
    throw new BrowserNativeFileToolError(`cannot search ${relativeWorkspacePath(path)}: ${String(error)}`, 'SEARCH_FAILED')
  } finally {
    file.close()
  }
}

/** Execute a bounded grep over the Worker VFS without spawning a host process. */
export async function executeBrowserNativeGrep(
  vfs: MemoryVfs,
  value: unknown,
  signal: AbortSignal,
  yieldDelayMs = 0,
  options: { readonly matcherFactory?: BrowserNativeRegexMatcherFactory; readonly onMatcherStarted?: () => void } = {},
): Promise<{ readonly matches: readonly BrowserNativeGrepMatch[] }> {
  const input = parseGrepInput(value)
  const root = absoluteWorkspacePath(input.path)
  const include = input.include === undefined ? undefined : globRegex(input.include)
  const matches: BrowserNativeGrepMatch[] = []
  const budget: BrowserNativeSearchBudget = { scannedBytes: 0, scannedLines: 0, deadline: performance.now() + MAX_SEARCH_DURATION_MS }
  const matcher = (options.matcherFactory ?? createWorkerRegexMatcher)()
  let fileBatch: string[] = []

  const validatePattern = async (pattern: string): Promise<void> => {
    assertSearchActive(signal, budget)
    await matcher.validate(pattern, signal, Math.min(MAX_REGEX_BATCH_DURATION_MS, budget.deadline - performance.now()))
    assertSearchActive(signal, budget)
  }

  const processFileBatch = async (): Promise<void> => {
    if (fileBatch.length === 0) return
    const files = fileBatch
    fileBatch = []
    let included = new Set<number>(files.map((_file, index) => index))
    if (include !== undefined) {
      assertSearchActive(signal, budget)
      const remainingMs = budget.deadline - performance.now()
      const indexes = await matcher.match(include, files.map(relativeWorkspacePath), signal,
        Math.min(MAX_REGEX_BATCH_DURATION_MS, remainingMs), options.onMatcherStarted)
      included = new Set(indexes)
    }
    for (let index = 0; index < files.length; index += 1) {
      assertSearchActive(signal, budget)
      if (!included.has(index)) continue
      const file = files[index]
      if (file !== undefined) {
        await searchFile(vfs, file, input.pattern, matcher, matches, budget, signal, yieldDelayMs, options.onMatcherStarted)
      }
    }
  }

  try {
    await validatePattern(input.pattern)
    if (include !== undefined) await validatePattern(include)
    for await (const file of walkFiles(vfs, root, signal, yieldDelayMs)) {
      assertSearchActive(signal, budget)
      fileBatch.push(file)
      if (fileBatch.length >= MAX_REGEX_BATCH_LINES) await processFileBatch()
    }
    await processFileBatch()
  } catch (error) {
    if (signal.aborted) return { matches: [] }
    throw error
  } finally {
    matcher.dispose()
  }
  return { matches }
}

/** Execute the browser-native replacement for the process-backed glob tool. */
export async function executeBrowserNativeGlob(
  vfs: MemoryVfs,
  value: unknown,
  signal: AbortSignal,
  yieldDelayMs = 0,
  options: { readonly matcherFactory?: BrowserNativeRegexMatcherFactory; readonly onMatcherStarted?: () => void } = {},
): Promise<{ readonly root: string; readonly paths: readonly string[] }> {
  const input = parseGlobInput(value)
  const rootPath = absoluteWorkspacePath(input.path)
  const pattern = globRegex(input.pattern)
  const budget: BrowserNativeSearchBudget = { scannedBytes: 0, scannedLines: 0, deadline: performance.now() + MAX_SEARCH_DURATION_MS }
  const matcher = (options.matcherFactory ?? createWorkerRegexMatcher)()
  const paths: Array<{ readonly path: string; readonly mtimeMs: number }> = []
  let fileBatch: string[] = []

  const validatePattern = async (): Promise<void> => {
    assertSearchActive(signal, budget)
    await matcher.validate(pattern, signal, Math.min(MAX_REGEX_BATCH_DURATION_MS, budget.deadline - performance.now()))
    assertSearchActive(signal, budget)
  }

  const processFileBatch = async (): Promise<void> => {
    if (fileBatch.length === 0) return
    assertSearchActive(signal, budget)
    const files = fileBatch
    fileBatch = []
    const remainingMs = budget.deadline - performance.now()
    const indexes = await matcher.match(pattern, files.map(relativeWorkspacePath), signal,
      Math.min(MAX_REGEX_BATCH_DURATION_MS, remainingMs), options.onMatcherStarted)
    assertSearchActive(signal, budget)
    for (const index of indexes) {
      const path = files[index]
      if (path === undefined) throw new BrowserNativeFileToolError('regex Worker returned an unknown path index', 'SEARCH_REGEX_PROTOCOL_ERROR')
      if (paths.length >= MAX_GLOB_RESULTS) {
        throw new BrowserNativeFileToolError(`glob returned more than ${String(MAX_GLOB_RESULTS)} paths`, 'SEARCH_RESULT_OVERFLOW')
      }
      const stats = vfs.statSync(path)
      paths.push({ path: relativeWorkspacePath(path), mtimeMs: Number(stats.mtimeMs) })
    }
  }

  try {
    await validatePattern()
    for await (const path of walkFiles(vfs, rootPath, signal, yieldDelayMs)) {
      assertSearchActive(signal, budget)
      fileBatch.push(path)
      if (fileBatch.length >= MAX_REGEX_BATCH_LINES) await processFileBatch()
    }
    await processFileBatch()
    paths.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    return { root: input.path ?? '.', paths: paths.map(item => item.path) }
  } catch (error) {
    if (signal.aborted) return { root: input.path ?? '.', paths: [] }
    throw error
  } finally {
    matcher.dispose()
  }
}

/** Reject edit arguments that could create an unbounded durable diff in the PoC Session log. */
export function assertBrowserNativeEditSafe(vfs: MemoryVfs, value: unknown, signal: AbortSignal): void {
  if (!isRecord(value) || typeof value.file_path !== 'string' || typeof value.old_string !== 'string' || typeof value.new_string !== 'string') return
  const argumentBytes = encoder.encode(value.old_string).byteLength + encoder.encode(value.new_string).byteLength
  if (argumentBytes > MAX_EDIT_ARGUMENT_BYTES) {
    throw new BrowserNativeFileToolError(`edit arguments exceed the ${String(MAX_EDIT_ARGUMENT_BYTES)}-byte browser limit`, 'EDIT_PAYLOAD_TOO_LARGE')
  }
  const target = absoluteWorkspacePath(value.file_path)
  if (!vfs.existsSync(target) || vfs.statSync(target).isDirectory()) return
  const size = vfs.statSync(target).size
  if (size > MAX_EDIT_FILE_BYTES) {
    throw new BrowserNativeFileToolError(`edit input exceeds the ${String(MAX_EDIT_FILE_BYTES)}-byte browser preflight limit`, 'EDIT_PAYLOAD_TOO_LARGE')
  }
  if (signal.aborted) return
  const bytes = fileBytes(vfs, target)
  if (bytes.includes(0)) {
    throw new BrowserNativeFileToolError(`cannot edit binary file ${relativeWorkspacePath(target)} as UTF-8 text`, 'EDIT_BINARY_FILE')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new BrowserNativeFileToolError(`cannot edit ${relativeWorkspacePath(target)} as UTF-8 text: ${String(error)}`, 'EDIT_BINARY_FILE')
  }
  let position = 0
  while ((position = text.indexOf(value.old_string, position)) >= 0) {
    const lineStart = text.lastIndexOf('\n', position) + 1
    const lineEnd = text.indexOf('\n', position)
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/, '')
    if (encoder.encode(line).byteLength > MAX_MATCHED_LINE_BYTES) {
      throw new BrowserNativeFileToolError(`edit target line exceeds the ${String(MAX_MATCHED_LINE_BYTES)}-byte browser diff limit`, 'EDIT_PAYLOAD_TOO_LARGE')
    }
    position += Math.max(1, value.old_string.length)
    if (signal.aborted) return
  }
}

function sourceFile(descriptor: VfsOpenFile): ChunkBackedFile {
  const size = descriptor.stat().size
  return {
    get size(): number { return size },
    read: (position, length) => descriptor.read(position, length),
    write: () => { throw new Error('browser-native edit source is read-only') },
    truncate: () => { throw new Error('browser-native edit source is read-only') },
    flush: () => {},
    close: () => {},
  }
}

async function validateEditText(source: ChunkBackedFile, path: string, signal: AbortSignal): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let offset = 0; offset < source.size; offset += EDIT_CHUNK_BYTES) {
    if (signal.aborted) throw new BrowserNativeFileToolError(`edit aborted for ${relativeWorkspacePath(path)}`, 'FS_ABORTED')
    const bytes = source.read(offset, Math.min(EDIT_CHUNK_BYTES, source.size - offset))
    if (bytes.includes(0)) throw new BrowserNativeFileToolError(`cannot edit binary file ${relativeWorkspacePath(path)} as UTF-8 text`, 'FS_NOT_TEXT')
    try {
      decoder.decode(bytes, { stream: offset + bytes.byteLength < source.size })
    } catch (error) {
      throw new BrowserNativeFileToolError(`cannot edit ${relativeWorkspacePath(path)} as UTF-8 text: ${String(error)}`, 'FS_NOT_TEXT')
    }
    if (await yieldToWorker(signal, 0)) throw new BrowserNativeFileToolError(`edit aborted for ${relativeWorkspacePath(path)}`, 'FS_ABORTED')
  }
  try {
    decoder.decode()
  } catch (error) {
    throw new BrowserNativeFileToolError(`cannot edit ${relativeWorkspacePath(path)} as UTF-8 text: ${String(error)}`, 'FS_NOT_TEXT')
  }
}

function vfsFileVersion(stats: VfsBigIntStats): string {
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeNs)}:${String(stats.ctimeNs)}`
}

export async function cleanupAbandonedBrowserNativeEdits(workspaceId: string): Promise<void> {
  const storage = globalThis.navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== 'function') return
  const root = await storage.getDirectory()
  const prefix = `${EDIT_DIRECTORY_PREFIX}${workspaceId}-`
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory' || !name.startsWith(prefix) || activeEditDirectories.has(name)) continue
    await root.removeEntry(name, { recursive: true })
  }
}

async function createEditTarget(workspaceId: string): Promise<{ readonly file: ChunkBackedFile; readonly backing: VfsFileBacking; readonly dispose: () => Promise<void> }> {
  const storage = globalThis.navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw new BrowserNativeFileToolError('OPFS is required for bounded browser-native edit', 'EDIT_OPFS_UNAVAILABLE')
  }
  const root = await storage.getDirectory()
  const directoryName = `${EDIT_DIRECTORY_PREFIX}${workspaceId}-${crypto.randomUUID()}`
  const directory = await root.getDirectoryHandle(directoryName, { create: true })
  const targetHandle = await directory.getFileHandle('target', { create: true })
  const target = createSyncAccessChunkBackedFile(await targetHandle.createSyncAccessHandle())
  activeEditDirectories.add(directoryName)
  let closed = false
  const remove = async (): Promise<void> => {
    await root.removeEntry(directoryName, { recursive: true }).catch(() => {})
  }
  const close = (): void => {
    if (closed) return
    closed = true
    target.close()
    void remove().finally(() => { activeEditDirectories.delete(directoryName) })
  }
  return {
    file: target,
    backing: { get size(): number { return target.size }, read: (position, length) => target.read(position, length), close },
    dispose: async () => {
      close()
      await remove()
      activeEditDirectories.delete(directoryName)
    },
  }
}

function mapChunkEditError(error: unknown, path: string): BrowserNativeFileToolError {
  if (!(error instanceof Error)) return new BrowserNativeFileToolError(String(error), 'FS_IO_ERROR')
  if (error instanceof BrowserNativeFileToolError) return error
  if (error.name === 'ChunkEditError') {
    if (error.message.startsWith('TEXT_NOT_FOUND:')) {
      return new BrowserNativeFileToolError(`No replacement was performed in ${relativeWorkspacePath(path)}.`, 'FS_EDIT_NOT_FOUND')
    }
    if (error.message.startsWith('TEXT_NOT_UNIQUE:')) {
      return new BrowserNativeFileToolError(`No replacement was performed. The old string occurs more than once in ${relativeWorkspacePath(path)}.`, 'FS_AMBIGUOUS_EDIT')
    }
    if (error.message.startsWith('TOO_MANY_MATCHES:')) {
      return new BrowserNativeFileToolError(`edit has more than 10,000 matches in ${relativeWorkspacePath(path)}`, 'EDIT_MATCH_LIMIT')
    }
    if (error.message.startsWith('CANCELLED:')) return new BrowserNativeFileToolError(`edit aborted for ${relativeWorkspacePath(path)}`, 'FS_ABORTED')
  }
  return new BrowserNativeFileToolError(`cannot edit ${relativeWorkspacePath(path)}: ${error.message}`, 'FS_IO_ERROR')
}

/** Edit a Workspace file with bounded copy-on-write and publish a reference mutation.
 * @param vfs - Worker-local VFS containing the source file.
 * @param value - Untrusted model arguments parsed before editing.
 * @param signal - DSH tool cancellation signal.
 * @param workspaceId - Workspace that owns the temporary edit directory.
 * @param hooks - Optional PoC test delay and edit-stage observer.
 * @returns The bounded before/after content projection for the edited file.
 * @throws {BrowserNativeFileToolError} If validation, cancellation, I/O, or version checks reject the edit.
 */
export async function executeBrowserNativeEdit(
  vfs: MemoryVfs,
  value: unknown,
  signal: AbortSignal,
  workspaceId: string,
  hooks: { readonly yieldDelayMs?: number; readonly onStage?: (stage: ChunkEditStage) => void } = {},
): Promise<BrowserNativeEditResult> {
  const input = parseEditInput(value)
  const path = absoluteWorkspacePath(input.filePath)
  const stat = vfs.statSync(path, { bigint: true }) as VfsBigIntStats
  if (!stat.isFile()) throw new BrowserNativeFileToolError(`cannot edit ${relativeWorkspacePath(path)}: not a regular file`, 'FS_NOT_REGULAR_FILE')
  if (stat.size > BigInt(MAX_EDIT_FILE_BYTES)) {
    throw new BrowserNativeFileToolError(`edit input exceeds the ${String(MAX_EDIT_FILE_BYTES)}-byte browser preflight limit`, 'EDIT_PAYLOAD_TOO_LARGE')
  }
  const descriptor = vfs.openFileSync(path, 'r')
  const initialVersion = vfsFileVersion(descriptor.statBigInt())
  const source = sourceFile(descriptor)
  let target: Awaited<ReturnType<typeof createEditTarget>> | undefined
  let published = false
  try {
    await validateEditText(source, path, signal)
    const resultBefore = source.size <= MAX_EDIT_RESULT_BYTES
      ? new TextDecoder('utf-8', { fatal: true }).decode(source.read(0, source.size))
      : input.oldString
    const editTarget = await createEditTarget(workspaceId)
    target = editTarget
    if (signal.aborted) throw new BrowserNativeFileToolError(`edit aborted for ${relativeWorkspacePath(path)}`, 'FS_ABORTED')
    let metrics
    try {
      metrics = await replaceUtf8CopyOnWriteAsync(source, editTarget.file, input.oldString, input.newString, input.replaceAll, {
        chunkBytes: EDIT_CHUNK_BYTES,
        signal,
        onStage: hooks.onStage,
        yieldToCaller: async () => { await yieldToWorker(signal, hooks.yieldDelayMs ?? 0) },
      })
    } catch (error) {
      throw mapChunkEditError(error, path)
    }
    if (metrics.resultBytes > MAX_EDIT_FILE_BYTES) {
      throw new BrowserNativeFileToolError(`edited file exceeds the ${String(MAX_EDIT_FILE_BYTES)}-byte browser limit`, 'EDIT_PAYLOAD_TOO_LARGE')
    }
    const currentStat = vfs.statSync(path, { bigint: true }) as VfsBigIntStats
    if (!currentStat.isFile() || vfsFileVersion(currentStat) !== initialVersion) {
      throw new BrowserNativeFileToolError(`cannot edit ${relativeWorkspacePath(path)}: file changed while the edit was running`, 'FS_STALE_VERSION')
    }
    const reference = { hash: metrics.resultHash, bytes: metrics.resultBytes }
    vfs.replaceExternalSync(path, editTarget.backing, reference)
    published = true
    const resultAfter = source.size <= MAX_EDIT_RESULT_BYTES && metrics.resultBytes <= MAX_EDIT_RESULT_BYTES
      ? input.replaceAll ? resultBefore.split(input.oldString).join(input.newString) : resultBefore.replace(input.oldString, input.newString)
      : input.newString
    return { path, before: resultBefore, after: resultAfter }
  } finally {
    descriptor.close()
    if (!published) await target?.dispose()
  }
}

export function isBrowserWorkspacePath(value: string): boolean {
  try {
    absoluteWorkspacePath(value)
    return true
  } catch {
    return false
  }
}
