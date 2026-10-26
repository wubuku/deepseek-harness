/** Runtime publication state shared by the Worker Host and its DSH providers. */
import {
  BROWSER_NATIVE_CAPABILITIES,
  BROWSER_NATIVE_PROFILE_MANIFEST,
  publishBrowserNativeTools,
  type BrowserNativeCapabilityDescriptor,
  type BrowserNativeCapabilityId,
} from './browser-native-capabilities.ts'

const WORKSPACE_CAPABILITIES: readonly BrowserNativeCapabilityId[] = [
  'worker-vfs',
  'restricted-shell',
  'structured-file-tools',
  'working-directory',
]

const WORKSPACE_CAPABILITY_FAILURE = 'LOCAL_WORKSPACE_PERSISTENCE_UNCONFIRMED'

/** Own the live/degraded tool roster for one Dedicated Worker lifetime. */
export class BrowserNativeCapabilityPublication {
  private active = false
  private readonly degraded = new Set<BrowserNativeCapabilityId>()
  private readonly listeners = new Set<() => void>()

  /** Publish the profile after the required startup probes pass. */
  activate(): void {
    if (this.active) return
    this.active = true
    this.notify()
  }

  /** Hide every tool backed by the local Workspace after an unconfirmed save. */
  degradeWorkspace(): void {
    let changed = false
    for (const capability of WORKSPACE_CAPABILITIES) {
      if (!this.degraded.has(capability)) {
        this.degraded.add(capability)
        changed = true
      }
    }
    if (changed) this.notify()
  }

  /** Return the tools that are currently eligible for a DSH model request. */
  publishedToolNames(): ReadonlySet<string> {
    return new Set(publishBrowserNativeTools(BROWSER_NATIVE_PROFILE_MANIFEST, this.capabilities()).map(tool => tool.name))
  }

  /** Test whether one tool may be published and dispatched now. */
  isToolPublished(name: string): boolean {
    return this.publishedToolNames().has(name)
  }

  /** Return the workspace-backed tools that must be hidden at this state. */
  unavailableWorkspaceToolNames(): readonly string[] {
    const published = this.publishedToolNames()
    return BROWSER_NATIVE_PROFILE_MANIFEST.tools
      .filter(tool => WORKSPACE_CAPABILITIES.includes(tool.capability) && !published.has(tool.name))
      .map(tool => tool.name)
  }

  /** Subscribe to synchronous roster transitions. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private capabilities(): Partial<Readonly<Record<BrowserNativeCapabilityId, BrowserNativeCapabilityDescriptor>>> {
    const overrides: Partial<Record<BrowserNativeCapabilityId, BrowserNativeCapabilityDescriptor>> = {}
    for (const capability of new Set(BROWSER_NATIVE_PROFILE_MANIFEST.tools.map(tool => tool.capability))) {
      const descriptor = BROWSER_NATIVE_CAPABILITIES[capability]
      if (!this.active) {
        overrides[capability] = { ...descriptor, lifecycle: 'staged' }
      } else if (this.degraded.has(capability)) {
        overrides[capability] = {
          ...descriptor,
          lifecycle: 'degraded',
          detail: WORKSPACE_CAPABILITY_FAILURE,
        }
      }
    }
    return overrides
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Reject an adapter request when its schema does not match live publication. */
export function assertBrowserNativeToolSchemas(
  tools: readonly { readonly name: string }[],
  publication: BrowserNativeCapabilityPublication,
): void {
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`browser-native capability publication: duplicate tool schema "${tool.name}"`)
    seen.add(tool.name)
    if (!publication.isToolPublished(tool.name)) {
      throw new Error(`browser-native capability publication: tool schema "${tool.name}" is not currently published`)
    }
  }
}
