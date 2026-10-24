import type { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'

const WORKSPACE_ROOT = '/dsh/home/workspace'
const MAX_SEARCH_FILES = 10_000
const MAX_SEARCH_BYTES = 32 * 1024 * 1024
const MAX_SEARCH_MATCHES = 5_000
const MAX_MATCHED_LINE_BYTES = 64 * 1024
const MAX_EDIT_ARGUMENT_BYTES = 256 * 1024
const MAX_EDIT_FILE_BYTES = 64 * 1024 * 1024
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])

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

export class BrowserNativeFileToolError extends Error {
  constructor(message: string, readonly code: string) {
    super(`${code}: ${message}`)
    this.name = 'BrowserNativeFileToolError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  if (value.path !== undefined && typeof value.path !== 'string') {
    throw new BrowserNativeFileToolError('path must be a string when given', 'SEARCH_INVALID_ARGUMENT')
  }
  if (value.include !== undefined && typeof value.include !== 'string') {
    throw new BrowserNativeFileToolError('include must be a string when given', 'SEARCH_INVALID_ARGUMENT')
  }
  if (typeof value.include === 'string' && (value.include.trim().length === 0 || value.include.startsWith('!'))) {
    throw new BrowserNativeFileToolError('include must be one non-empty positive glob', 'SEARCH_INVALID_ARGUMENT')
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
  return { pattern: value.pattern, ...(value.path === undefined ? {} : { path: value.path }) }
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
        return alternatives.flatMap(alternative => expandBraces(`${pattern.slice(0, start)}${alternative}${pattern.slice(index + 1)}`))
      }
    }
  }
  return [pattern]
}

function globRegex(pattern: string): RegExp {
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
  return new RegExp(`^(?:${source})$`)
}

function fileMatchesInclude(path: string, include: string | undefined): boolean {
  return include === undefined || globRegex(include).test(path)
}

function fileBytes(vfs: MemoryVfs, path: string): Uint8Array {
  const value = vfs.readFileSync(path)
  return typeof value === 'string' ? encoder.encode(value) : value
}

function childPaths(vfs: MemoryVfs, root: string): string[] {
  const files: string[] = []
  const visit = (path: string): void => {
    const stat = vfs.statSync(path)
    if (stat.isFile()) {
      files.push(path)
      return
    }
    for (const name of vfs.readdirSync(path)) {
      if (IGNORED_DIRECTORY_NAMES.has(name) && vfs.statSync(`${path}/${name}`).isDirectory()) continue
      visit(`${path}/${name}`)
    }
  }
  visit(root)
  return files
}

function searchFiles(vfs: MemoryVfs, root: string): string[] {
  const stat = vfs.statSync(root)
  return stat.isFile() ? [root] : childPaths(vfs, root)
}

function parseRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'u')
  } catch (error) {
    throw new BrowserNativeFileToolError(`pattern is not supported by the Worker regex engine: ${String(error)}`, 'SEARCH_INVALID_PATTERN')
  }
}

/** Execute a bounded grep over the Worker VFS without spawning a host process. */
export async function executeBrowserNativeGrep(
  vfs: MemoryVfs,
  value: unknown,
  signal: AbortSignal,
  yieldDelayMs = 0,
): Promise<{ readonly matches: readonly BrowserNativeGrepMatch[] }> {
  const input = parseGrepInput(value)
  const regex = parseRegex(input.pattern)
  const root = absoluteWorkspacePath(input.path)
  const files = searchFiles(vfs, root)
  if (files.length > MAX_SEARCH_FILES) {
    throw new BrowserNativeFileToolError(`search would inspect ${String(files.length)} files; limit is ${String(MAX_SEARCH_FILES)}`, 'SEARCH_RESULT_OVERFLOW')
  }
  const matches: BrowserNativeGrepMatch[] = []
  let scannedBytes = 0
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    if (signal.aborted) return { matches: [] }
    const file = files[fileIndex]
    if (file === undefined || !fileMatchesInclude(relativeWorkspacePath(file), input.include)) continue
    const bytes = fileBytes(vfs, file)
    scannedBytes += bytes.byteLength
    if (scannedBytes > MAX_SEARCH_BYTES) {
      throw new BrowserNativeFileToolError(`search exceeded the ${String(MAX_SEARCH_BYTES)}-byte scan limit`, 'SEARCH_RESULT_OVERFLOW')
    }
    const text = decoder.decode(bytes)
    let start = 0
    let lineNumber = 1
    while (start <= text.length) {
      const newline = text.indexOf('\n', start)
      const end = newline < 0 ? text.length : newline
      const line = text.slice(start, end).endsWith('\r') ? text.slice(start, end - 1) : text.slice(start, end)
      if (regex.test(line)) {
        const lineBytes = encoder.encode(line).byteLength
        if (lineBytes > MAX_MATCHED_LINE_BYTES) {
          throw new BrowserNativeFileToolError(`matched line in ${relativeWorkspacePath(file)} exceeds the ${String(MAX_MATCHED_LINE_BYTES)}-byte result limit`, 'SEARCH_LINE_TOO_LONG')
        }
        matches.push({ path: relativeWorkspacePath(file), lineNumber, line })
        if (matches.length > MAX_SEARCH_MATCHES) {
          throw new BrowserNativeFileToolError(`search returned more than ${String(MAX_SEARCH_MATCHES)} matches`, 'SEARCH_RESULT_OVERFLOW')
        }
      }
      if (newline < 0) break
      start = newline + 1
      lineNumber += 1
      if (lineNumber % 128 === 0 && await yieldToWorker(signal, yieldDelayMs)) return { matches: [] }
    }
    if (fileIndex % 16 === 0 && await yieldToWorker(signal, yieldDelayMs)) return { matches: [] }
  }
  return { matches }
}

/** Execute the browser-native replacement for the process-backed glob tool. */
export async function executeBrowserNativeGlob(
  vfs: MemoryVfs,
  value: unknown,
  signal: AbortSignal,
  yieldDelayMs = 0,
): Promise<{ readonly root: string; readonly paths: readonly string[] }> {
  const input = parseGlobInput(value)
  const rootPath = absoluteWorkspacePath(input.path)
  const pattern = globRegex(input.pattern)
  const files = searchFiles(vfs, rootPath)
  const paths: Array<{ readonly path: string; readonly mtimeMs: number }> = []
  for (let index = 0; index < files.length; index += 1) {
    if (signal.aborted) return { root: input.path ?? '.', paths: [] }
    const path = files[index]
    if (path !== undefined && pattern.test(relativeWorkspacePath(path))) {
      const stat = vfs.statSync(path)
      paths.push({ path: relativeWorkspacePath(path), mtimeMs: stat.mtimeMs })
    }
    if (index % 32 === 0 && await yieldToWorker(signal, yieldDelayMs)) return { root: input.path ?? '.', paths: [] }
  }
  paths.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
  return { root: input.path ?? '.', paths: paths.map(item => item.path) }
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
  const text = decoder.decode(bytes)
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

export function isBrowserWorkspacePath(value: string): boolean {
  try {
    absoluteWorkspacePath(value)
    return true
  } catch {
    return false
  }
}
