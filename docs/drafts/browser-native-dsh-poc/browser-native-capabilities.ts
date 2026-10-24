/** File tool names that the PoC browser provider can inspect or route. */
export const BROWSER_NATIVE_FILE_TOOL_NAMES = ['read', 'read_image', 'write', 'edit', 'grep', 'glob'] as const

/** A file tool name recognized by the PoC browser provider. */
export type BrowserNativeFileToolName = typeof BROWSER_NATIVE_FILE_TOOL_NAMES[number]

const browserNativeFileToolNames: ReadonlySet<string> = new Set(BROWSER_NATIVE_FILE_TOOL_NAMES)

/** Test whether a runtime tool name belongs to the browser file provider. */
export function isBrowserNativeFileToolName(name: string): name is BrowserNativeFileToolName {
  return browserNativeFileToolNames.has(name)
}
