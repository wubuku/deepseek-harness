import type { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'

const WORKSPACE_ROOT = '/dsh/home/workspace'
const MAX_SEARCH_FILES = 10_000
const MAX_SEARCH_BYTES = 32 * 1024 * 1024
const MAX_SEARCH_MATCHES = 5_000
const MAX_GLOB_RESULTS = 5_000
const MAX_SEARCH_PATTERN_BYTES = 4 * 1024
const MAX_INCLUDE_PATTERN_BYTES = 4 * 1024
const MAX_GLOB_ALTERNATIVES = 128
const SEARCH_CHUNK_BYTES = 64 * 1024
const MAX_MATCHED_LINE_BYTES = 64 * 1024
const MAX_EDIT_ARGUMENT_BYTES = 256 * 1024
const MAX_EDIT_FILE_BYTES = 64 * 1024 * 1024
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

function isQuantifierAt(pattern: string, index: number): number {
  const char = pattern[index]
  if (char === '*' || char === '+' || char === '?') return 1
  if (char !== '{') return 0
  const end = pattern.indexOf('}', index + 1)
  if (end < 0 || !/^\{\d+(?:,\d*)?\}$/.test(pattern.slice(index, end + 1))) return 0
  return end - index + 1
}

function hasPotentiallyUnsafeRegex(pattern: string): boolean {
  if (/\\(?:\d+|k<[^>]+>)/u.test(pattern)) return true
  const groups: boolean[] = []
  let inClass = false
  let escaped = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '[') {
      inClass = true
      continue
    }
    if (char === ']' && inClass) {
      inClass = false
      continue
    }
    if (inClass) continue
    if (char === '(') {
      groups.push(false)
      continue
    }
    if (char === ')') {
      const containsQuantifier = groups.pop() ?? false
      const quantifierLength = isQuantifierAt(pattern, index + 1)
      if (quantifierLength > 0 && containsQuantifier) return true
      if (quantifierLength > 0 && groups.length > 0) groups[groups.length - 1] = true
      continue
    }
    if (isQuantifierAt(pattern, index) > 0 && char !== '?' && pattern[index - 1] !== '(') {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) groups[groupIndex] = true
    }
  }
  return false
}

function parseRegex(pattern: string): RegExp {
  if (hasPotentiallyUnsafeRegex(pattern)) {
    throw new BrowserNativeFileToolError('pattern contains a backreference or nested quantifier', 'SEARCH_PATTERN_TOO_COMPLEX')
  }
  try {
    return new RegExp(pattern, 'u')
  } catch (error) {
    throw new BrowserNativeFileToolError(`pattern is not supported by the Worker regex engine: ${String(error)}`, 'SEARCH_INVALID_PATTERN')
  }
}

async function searchFile(
  vfs: MemoryVfs,
  path: string,
  regex: RegExp,
  matches: BrowserNativeGrepMatch[],
  scannedBytes: number,
  signal: AbortSignal,
  yieldDelayMs: number,
): Promise<{ readonly scannedBytes: number; readonly aborted: boolean }> {
  const file = vfs.openFileSync(path, 'r')
  const size = file.stat().size
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let position = 0
  let lineNumber = 1
  let pending = ''
  let totalBytes = scannedBytes

  const consumeLine = (line: string): void => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!regex.test(normalized)) return
    if (encoder.encode(normalized).byteLength > MAX_MATCHED_LINE_BYTES) {
      throw new BrowserNativeFileToolError(`matched line in ${relativeWorkspacePath(path)} exceeds the ${String(MAX_MATCHED_LINE_BYTES)}-byte result limit`, 'SEARCH_LINE_TOO_LONG')
    }
    matches.push({ path: relativeWorkspacePath(path), lineNumber, line: normalized })
    if (matches.length > MAX_SEARCH_MATCHES) {
      throw new BrowserNativeFileToolError(`search returned more than ${String(MAX_SEARCH_MATCHES)} matches`, 'SEARCH_RESULT_OVERFLOW')
    }
  }

  try {
    while (position < size) {
      if (signal.aborted) return { scannedBytes: totalBytes, aborted: true }
      const bytes = file.read(position, Math.min(SEARCH_CHUNK_BYTES, size - position))
      if (bytes.byteLength === 0) break
      position += bytes.byteLength
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_SEARCH_BYTES) {
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
        consumeLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        lineNumber += 1
        if (lineNumber % 128 === 0 && await yieldToWorker(signal, yieldDelayMs)) return { scannedBytes: totalBytes, aborted: true }
        newline = pending.indexOf('\n')
      }
      if (await yieldToWorker(signal, yieldDelayMs)) return { scannedBytes: totalBytes, aborted: true }
    }
    try {
      pending += decoder.decode()
    } catch (error) {
      throw new BrowserNativeFileToolError(`cannot decode ${relativeWorkspacePath(path)} as UTF-8 text: ${String(error)}`, 'SEARCH_BINARY_FILE')
    }
    if (pending.length > 0) consumeLine(pending)
    return { scannedBytes: totalBytes, aborted: false }
  } catch (error) {
    if (error instanceof BrowserNativeFileToolError) throw error
    throw new BrowserNativeFileToolError(`cannot search ${relativeWorkspacePath(path)}: ${String(error)}`, 'SEARCH_FAILED')
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
  const include = input.include === undefined ? undefined : globRegex(input.include)
  const matches: BrowserNativeGrepMatch[] = []
  let scannedBytes = 0
  for await (const file of walkFiles(vfs, root, signal, yieldDelayMs)) {
    if (signal.aborted) return { matches: [] }
    if (include !== undefined && !include.test(relativeWorkspacePath(file))) continue
    const result = await searchFile(vfs, file, regex, matches, scannedBytes, signal, yieldDelayMs)
    scannedBytes = result.scannedBytes
    if (result.aborted) return { matches: [] }
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
  const paths: Array<{ readonly path: string; readonly mtimeMs: number }> = []
  for await (const path of walkFiles(vfs, rootPath, signal, yieldDelayMs)) {
    if (signal.aborted) return { root: input.path ?? '.', paths: [] }
    if (pattern.test(relativeWorkspacePath(path))) {
      if (paths.length >= MAX_GLOB_RESULTS) {
        throw new BrowserNativeFileToolError(`glob returned more than ${String(MAX_GLOB_RESULTS)} paths`, 'SEARCH_RESULT_OVERFLOW')
      }
      const stat = vfs.statSync(path)
      paths.push({ path: relativeWorkspacePath(path), mtimeMs: Number(stat.mtimeMs) })
    }
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

export function isBrowserWorkspacePath(value: string): boolean {
  try {
    absoluteWorkspacePath(value)
    return true
  } catch {
    return false
  }
}
