/**
 * Validation-only per-Session tool presets for Browser-Native DSH.
 *
 * A preset narrows the tool surface a Session exposes to the model. The
 * restriction is applied through `agent.ctx.tools.restrict()`, so it changes
 * the schemas sent on the next request, and through `ctx.tools.guard()`, so a
 * direct call cannot bypass the preset. Presets are scoped per Session: changing
 * one Session never rewrites another Agent's restriction or in-flight request.
 */
/** Tool surface presets available to the browser test port. */
export type BrowserNativeToolPreset = 'full' | 'read-only'

/** Immutable snapshot of the global default and per-Session overrides. */
export interface BrowserNativeProfilePresetSnapshot {
  readonly global: BrowserNativeToolPreset
  readonly sessions: Readonly<Record<string, BrowserNativeToolPreset>>
}

/** Operations exposed only through the Worker validation MessagePort. */
export interface BrowserNativeProfilePresetProbe {
  /**
   * Read the live default and overrides without changing them.
   * @returns the current preset state.
   */
  state(): BrowserNativeProfilePresetSnapshot
  /**
   * Resolve the effective preset for one Session.
   * @param sessionId - owning Session, or undefined for the global default.
   * @returns the Session override when present, otherwise the default.
   */
  presetFor(sessionId: string | undefined): BrowserNativeToolPreset
  /**
   * Replace the default or one Session preset.
   * @param sessionId - owning Session, or undefined to change the default.
   * @param preset - validated preset name.
   * @returns the state after the change.
   */
  setPreset(sessionId: string | undefined, preset: BrowserNativeToolPreset): BrowserNativeProfilePresetSnapshot
  /**
   * Names a preset withholds from the model for one Session.
   * @param sessionId - owning Session, or undefined for the global default.
   * @returns tool names that are hidden and guarded.
   */
  deniedTools(sessionId: string | undefined): readonly string[]
  /**
   * Whether one tool may be exposed and executed for a Session.
   * @param sessionId - owning Session, or undefined for the global default.
   * @param toolName - registered tool name.
   * @returns false only when the active preset withholds the name.
   */
  allows(sessionId: string | undefined, toolName: string): boolean
  /**
   * Subscribe to preset changes so scoped restrictions refresh.
   * @param listener - called synchronously after every accepted change.
   * @returns the disposer that removes the listener.
   */
  subscribe(listener: () => void): () => void
}

const PRESETS: readonly BrowserNativeToolPreset[] = ['full', 'read-only']

const PRESET_DENIED_TOOLS: Readonly<Record<BrowserNativeToolPreset, readonly string[]>> = {
  full: [],
  // A read-only preset keeps navigation and inspection tools while withholding
  // every workspace mutation path, including the shell.
  'read-only': ['bash', 'edit', 'write'],
}

function isPreset(value: unknown): value is BrowserNativeToolPreset {
  return typeof value === 'string' && (PRESETS as readonly string[]).includes(value)
}

function parsePreset(value: unknown): BrowserNativeToolPreset {
  if (!isPreset(value)) throw new Error(`profile preset must be one of ${PRESETS.join(', ')}, got ${JSON.stringify(value)}`)
  return value
}

/**
 * Create the in-memory preset probe consumed by the Browser-Native LLM module.
 * @returns the live preset state plus its test-port operations.
 */
export function createBrowserNativeProfilePresetProbe(): BrowserNativeProfilePresetProbe {
  let fallback: BrowserNativeToolPreset = 'full'
  const overrides = new Map<string, BrowserNativeToolPreset>()
  const listeners = new Set<() => void>()

  const state = (): BrowserNativeProfilePresetSnapshot => ({
    global: fallback,
    sessions: Object.fromEntries(overrides),
  })

  const presetFor = (sessionId: string | undefined): BrowserNativeToolPreset => {
    if (sessionId === undefined) return fallback
    return overrides.get(sessionId) ?? fallback
  }

  return {
    state,
    presetFor,
    setPreset: (sessionId, preset) => {
      const parsed = parsePreset(preset)
      if (sessionId === undefined) fallback = parsed
      else overrides.set(sessionId, parsed)
      for (const listener of listeners) listener()
      return state()
    },
    deniedTools: sessionId => PRESET_DENIED_TOOLS[presetFor(sessionId)],
    allows: (sessionId, toolName) => !PRESET_DENIED_TOOLS[presetFor(sessionId)].includes(toolName),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
