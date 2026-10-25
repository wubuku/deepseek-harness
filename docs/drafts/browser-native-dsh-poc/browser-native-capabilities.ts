/** Capability identifiers used by the Browser-Native PoC preflight. */
export type BrowserNativeCapabilityId =
  | 'worker-vfs'
  | 'structured-file-tools'
  | 'restricted-shell'
  | 'remote-session-persistence'
  | 'remote-llm-proxy'
  | 'human-interaction'
  | 'todo-persistence'
  | 'working-directory'
  | 'host-network-egress'
  | 'host-subprocess'
  | 'filesystem-watch'
  | 'dynamic-module-loading'
  | 'native-addon'
  | 'wasi-runtime'
  | 'background-process'

/** Capability status at the Browser-Native PoC deployment point. */
export type BrowserNativeCapabilityStatus = 'provided' | 'adapted' | 'unsupported' | 'unverified'

/** Evidence class used before a capability can become model-visible. */
export type BrowserNativeCapabilityEvidenceKind = 'declared' | 'service' | 'method' | 'version' | 'contract' | 'probe'

/** Publication state kept separate from the coarse PoC status. */
export type BrowserNativeCapabilityLifecycleState = 'declared' | 'staged' | 'live' | 'unsupported' | 'degraded'

/** Permission state is independent from whether a browser API exists. */
export type BrowserNativeCapabilityPermission = 'not-required' | 'unknown' | 'granted' | 'denied'

export interface BrowserNativeCapabilityEvidence {
  readonly kind: BrowserNativeCapabilityEvidenceKind
  readonly id: string
  readonly detail?: string
}

/** One capability exposed to the Browser-Native profile preflight. */
export interface BrowserNativeCapabilityDescriptor {
  readonly id: BrowserNativeCapabilityId
  readonly status: BrowserNativeCapabilityStatus
  readonly provider: string
  readonly detail: string
  readonly lifecycle?: BrowserNativeCapabilityLifecycleState
  readonly evidence?: readonly BrowserNativeCapabilityEvidence[]
  readonly permission?: BrowserNativeCapabilityPermission
}

/** A plugin requirement checked before the Worker Host starts. */
export interface BrowserNativePluginRequirement {
  readonly id: string
  readonly packageName: string
  readonly required: readonly BrowserNativeCapabilityId[]
}

/** A model-visible tool and the capability that owns its execution. */
export interface BrowserNativeToolRequirement {
  readonly name: string
  readonly capability: BrowserNativeCapabilityId
}

/** The profile inputs checked by the Browser-Native boot preflight. */
export interface BrowserNativeProfileManifest {
  readonly id: string
  readonly plugins: readonly BrowserNativePluginRequirement[]
  readonly tools: readonly BrowserNativeToolRequirement[]
}

/** A single reason why a Browser-Native profile cannot be started safely. */
export interface BrowserNativePreflightIssue {
  readonly kind: 'duplicate-plugin' | 'unknown-capability' | 'missing-capability' | 'unknown-tool-capability' | 'unpublished-tool' | 'permission-denied'
  readonly pluginId?: string
  readonly toolName?: string
  readonly capability: string
  readonly message: string
}

/** The result of checking a profile against the browser capability table. */
export interface BrowserNativePreflightResult {
  readonly ok: boolean
  readonly issues: readonly BrowserNativePreflightIssue[]
  readonly providedCapabilities: readonly BrowserNativeCapabilityId[]
}

/** One model-visible tool after capability lifecycle and permission checks. */
export interface BrowserNativePublishedTool extends BrowserNativeToolRequirement {
  readonly capabilityState: 'live'
  readonly evidence: readonly BrowserNativeCapabilityEvidence[]
}

/** Browser capability facts used by the current PoC profile. */
export const BROWSER_NATIVE_CAPABILITIES: Readonly<Record<BrowserNativeCapabilityId, BrowserNativeCapabilityDescriptor>> = {
  'worker-vfs': { id: 'worker-vfs', status: 'provided', provider: 'MemoryVfs', detail: 'Worker-local virtual files under /dsh/home/workspace', lifecycle: 'live', evidence: [{ kind: 'probe', id: 'worker-vfs.prepare-and-read' }], permission: 'not-required' },
  'structured-file-tools': { id: 'structured-file-tools', status: 'adapted', provider: 'browser-native-providers.ts', detail: 'Bounded read, write, edit, grep and glob execution against the Worker VFS', lifecycle: 'live', evidence: [{ kind: 'probe', id: 'file-tools.chrome-worker' }], permission: 'not-required' },
  'restricted-shell': { id: 'restricted-shell', status: 'adapted', provider: 'webworker-runtime shell command table', detail: 'Worker shell with a fixed command table and no host process access', lifecycle: 'live', evidence: [{ kind: 'probe', id: 'restricted-shell.command-table' }], permission: 'not-required' },
  'remote-session-persistence': { id: 'remote-session-persistence', status: 'adapted', provider: 'same-origin Session backend', detail: 'Session events and leases are persisted through the PoC backend' },
  'remote-llm-proxy': { id: 'remote-llm-proxy', status: 'adapted', provider: 'same-origin LLM proxy', detail: 'The backend reads model credentials; the Worker receives only the stream' },
  'human-interaction': { id: 'human-interaction', status: 'provided', provider: 'tool-ask-user', detail: 'DSH interaction service renders and records browser questions', lifecycle: 'live', evidence: [{ kind: 'probe', id: 'ask-user.session-event' }], permission: 'not-required' },
  'todo-persistence': { id: 'todo-persistence', status: 'provided', provider: 'tool-todo', detail: 'Todo events are part of the DSH Session history', lifecycle: 'live', evidence: [{ kind: 'probe', id: 'todo.session-event' }], permission: 'not-required' },
  'working-directory': { id: 'working-directory', status: 'provided', provider: 'tool-working-directory', detail: 'Working directory stays within the Worker VFS namespace', lifecycle: 'live', evidence: [{ kind: 'probe', id: 'working-directory.worker-vfs' }], permission: 'not-required' },
  'host-network-egress': { id: 'host-network-egress', status: 'adapted', provider: 'same-origin backend routes', detail: 'The profile has no web search or web fetch tool; only declared same-origin routes are used' },
  'host-subprocess': { id: 'host-subprocess', status: 'unsupported', provider: 'none', detail: 'The browser Worker cannot start host processes or native binaries' },
  'filesystem-watch': { id: 'filesystem-watch', status: 'unsupported', provider: 'none', detail: 'The profile does not expose host or persistent filesystem watch events' },
  'dynamic-module-loading': { id: 'dynamic-module-loading', status: 'unverified', provider: 'WorkerModuleLoader', detail: 'Only modules present in the mounted image or explicit static table are in scope' },
  'native-addon': { id: 'native-addon', status: 'unsupported', provider: 'none', detail: 'Browser Workers cannot load Node native addons' },
  'wasi-runtime': { id: 'wasi-runtime', status: 'unverified', provider: 'none', detail: 'No WASI adapter is part of the default Browser-Native profile' },
  'background-process': { id: 'background-process', status: 'unsupported', provider: 'none', detail: 'The Worker is owned by the page and is not a background Agent process' },
}

/** Plugins selected by browser-native-profile.cordis.patch.yml. */
export const BROWSER_NATIVE_PROFILE_PLUGINS: readonly BrowserNativePluginRequirement[] = [
  { id: 'persona', packageName: '@deepseek-ai/dsh-persona', required: [] },
  { id: 'time-context', packageName: '@deepseek-ai/dsh-time-context', required: [] },
  { id: 'tool-bash', packageName: '@deepseek-ai/dsh-tool-bash', required: ['restricted-shell'] },
  { id: 'tool-fs', packageName: '@deepseek-ai/dsh-tool-fs', required: ['worker-vfs'] },
  { id: 'tool-fs-search', packageName: '@deepseek-ai/dsh-tool-fs-search', required: ['worker-vfs', 'structured-file-tools'] },
  { id: 'tool-working-directory', packageName: '@deepseek-ai/dsh-tool-working-directory', required: ['working-directory', 'worker-vfs'] },
  { id: 'tool-ask-user', packageName: '@deepseek-ai/dsh-tool-ask-user', required: ['human-interaction'] },
  { id: 'tool-todo', packageName: '@deepseek-ai/dsh-tool-todo', required: ['todo-persistence'] },
  { id: 'compaction-basic', packageName: '@deepseek-ai/dsh-compaction-basic', required: ['remote-llm-proxy', 'remote-session-persistence'] },
  { id: 'command-compact', packageName: '@deepseek-ai/dsh-command-compact', required: ['remote-llm-proxy', 'remote-session-persistence'] },
  { id: 'tool-result-pruner', packageName: '@deepseek-ai/dsh-compaction-tool-result-pruner', required: ['remote-session-persistence'] },
  { id: 'session-persistence-browser-native', packageName: 'PoC static module', required: ['remote-session-persistence'] },
  { id: 'llm-browser-native', packageName: 'PoC static module', required: ['remote-llm-proxy'] },
]

/** Tools exposed by the current Browser-Native profile. */
export const BROWSER_NATIVE_TOOL_REQUIREMENTS: readonly BrowserNativeToolRequirement[] = [
  { name: 'bash', capability: 'restricted-shell' },
  { name: 'read', capability: 'structured-file-tools' },
  { name: 'write', capability: 'structured-file-tools' },
  { name: 'edit', capability: 'structured-file-tools' },
  { name: 'grep', capability: 'structured-file-tools' },
  { name: 'glob', capability: 'structured-file-tools' },
  { name: 'todo_write', capability: 'todo-persistence' },
  { name: 'ask_user_question', capability: 'human-interaction' },
  { name: 'working_directory', capability: 'working-directory' },
]

/** Complete static input for the current Browser-Native profile. */
export const BROWSER_NATIVE_PROFILE_MANIFEST: BrowserNativeProfileManifest = {
  id: 'browser-native-standard',
  plugins: BROWSER_NATIVE_PROFILE_PLUGINS,
  tools: BROWSER_NATIVE_TOOL_REQUIREMENTS,
}

/** File tool names that the PoC browser provider can inspect or route. */
export const BROWSER_NATIVE_FILE_TOOL_NAMES = ['read', 'read_image', 'write', 'edit', 'grep', 'glob'] as const

/** A file tool name recognized by the PoC browser provider. */
export type BrowserNativeFileToolName = typeof BROWSER_NATIVE_FILE_TOOL_NAMES[number]

const browserNativeFileToolNames: ReadonlySet<string> = new Set(BROWSER_NATIVE_FILE_TOOL_NAMES)

function capabilityLifecycle(descriptor: BrowserNativeCapabilityDescriptor): BrowserNativeCapabilityLifecycleState {
  if (descriptor.lifecycle !== undefined) return descriptor.lifecycle
  if (descriptor.status === 'unsupported') return 'unsupported'
  if (descriptor.status === 'unverified') return 'degraded'
  return 'staged'
}

function hasProbeEvidence(descriptor: BrowserNativeCapabilityDescriptor): boolean {
  return (descriptor.evidence ?? []).some(evidence => evidence.kind === 'probe')
}

/**
 * Return the Browser-Native tools that may enter a model request.
 *
 * A supported module without a probe is staged only. Degraded capabilities
 * never publish their full tool group, and an explicit permission denial wins
 * over every positive capability observation.
 * @param manifest - Profile tools to evaluate.
 * @param capabilities - Capability observations for this boot.
 */
export function publishBrowserNativeTools(
  manifest: BrowserNativeProfileManifest,
  capabilities: Partial<Readonly<Record<BrowserNativeCapabilityId, BrowserNativeCapabilityDescriptor>>> = BROWSER_NATIVE_CAPABILITIES,
): readonly BrowserNativePublishedTool[] {
  return manifest.tools.flatMap(tool => {
    const descriptor = capabilities[tool.capability] ?? BROWSER_NATIVE_CAPABILITIES[tool.capability]
    if (descriptor === undefined || capabilityLifecycle(descriptor) !== 'live'
      || !hasProbeEvidence(descriptor) || descriptor.permission === 'denied' || descriptor.permission === 'unknown') return []
    return [{
      ...tool,
      capabilityState: 'live' as const,
      evidence: Object.freeze([...(descriptor.evidence ?? [])]),
    }]
  })
}

/** Model-facing tool names admitted by the checked-in Browser-Native profile. */
export const BROWSER_NATIVE_PUBLISHED_TOOL_NAMES: ReadonlySet<string> = new Set(
  publishBrowserNativeTools(BROWSER_NATIVE_PROFILE_MANIFEST).map(tool => tool.name),
)

/** Test whether a runtime tool name belongs to the browser file provider. */
export function isBrowserNativeFileToolName(name: string): name is BrowserNativeFileToolName {
  return browserNativeFileToolNames.has(name)
}

function isSupported(status: BrowserNativeCapabilityStatus): boolean {
  return status === 'provided' || status === 'adapted'
}

/** Check a profile without touching the Worker Host or any persistent state. */
export function evaluateBrowserNativeProfile(
  manifest: BrowserNativeProfileManifest = BROWSER_NATIVE_PROFILE_MANIFEST,
  capabilities: Partial<Readonly<Record<BrowserNativeCapabilityId, BrowserNativeCapabilityDescriptor>>> = BROWSER_NATIVE_CAPABILITIES,
): BrowserNativePreflightResult {
  const issues: BrowserNativePreflightIssue[] = []
  const seenPlugins = new Set<string>()
  const providedCapabilities: BrowserNativeCapabilityId[] = []
  for (const [id, descriptor] of Object.entries(BROWSER_NATIVE_CAPABILITIES) as [BrowserNativeCapabilityId, BrowserNativeCapabilityDescriptor][]) {
    if (isSupported(descriptor.status)) providedCapabilities.push(id)
  }
  for (const plugin of manifest.plugins) {
    if (seenPlugins.has(plugin.id)) {
      issues.push({ kind: 'duplicate-plugin', pluginId: plugin.id, capability: plugin.id, message: `Browser-Native profile declares plugin ${plugin.id} more than once` })
    }
    seenPlugins.add(plugin.id)
    for (const capability of plugin.required) {
      const descriptor = capabilities[capability] ?? BROWSER_NATIVE_CAPABILITIES[capability]
      if (descriptor === undefined) {
        issues.push({ kind: 'unknown-capability', pluginId: plugin.id, capability, message: `Plugin ${plugin.id} requires unknown Browser-Native capability ${capability}` })
      } else if (!isSupported(descriptor.status)) {
        issues.push({ kind: 'missing-capability', pluginId: plugin.id, capability, message: `Plugin ${plugin.id} requires ${capability}, but Browser-Native status is ${descriptor.status}: ${descriptor.detail}` })
      }
    }
  }
  for (const tool of manifest.tools) {
    const descriptor = capabilities[tool.capability] ?? BROWSER_NATIVE_CAPABILITIES[tool.capability]
    if (descriptor === undefined) {
      issues.push({ kind: 'unknown-tool-capability', toolName: tool.name, capability: tool.capability, message: `Tool ${tool.name} refers to unknown Browser-Native capability ${tool.capability}` })
    } else if (!isSupported(descriptor.status)) {
      issues.push({ kind: 'missing-capability', toolName: tool.name, capability: tool.capability, message: `Tool ${tool.name} cannot be exposed because ${tool.capability} is ${descriptor.status}: ${descriptor.detail}` })
    } else if (capabilityLifecycle(descriptor) !== 'live' || !hasProbeEvidence(descriptor)) {
      issues.push({ kind: 'unpublished-tool', toolName: tool.name, capability: tool.capability, message: `Tool ${tool.name} cannot be exposed before ${tool.capability} reaches live with probe evidence` })
    } else if (descriptor.permission === 'denied' || descriptor.permission === 'unknown') {
      issues.push({ kind: 'permission-denied', toolName: tool.name, capability: tool.capability, message: `Tool ${tool.name} cannot be exposed because permission is ${descriptor.permission}` })
    }
  }
  return { ok: issues.length === 0, issues, providedCapabilities }
}

/** Format a failed preflight for a Worker boot diagnostic. */
export function formatBrowserNativePreflightFailure(result: BrowserNativePreflightResult): string {
  if (result.ok) return 'Browser-Native profile capability preflight passed'
  return `Browser-Native profile capability preflight failed: ${result.issues.map(issue => issue.message).join('; ')}`
}
