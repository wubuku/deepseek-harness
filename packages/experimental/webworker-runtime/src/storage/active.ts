/**
 * Process-wide slot holding the mounted filesystem and its optional diagnostic observer. Kept apart from any
 * backend implementation: the `node:fs` proxy depends on the slot, not on which backend the worker entry mounted.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/active
 */
import type { Vfs } from './types.ts'

/** Callback for instrumented Node filesystem shim calls in the active Worker. */
export type NodeBuiltinMemberObserver = (specifier: 'node:fs' | 'node:fs/promises', member: string) => void

let active: { readonly vfs: Vfs; readonly observer?: NodeBuiltinMemberObserver } | undefined

/**
 * Publish the filesystem the `node:fs` proxy reads.
 * @param vfs - Filesystem mounted by the worker entry.
 * @param observer - Optional observer for Worker Node filesystem shim calls.
 */
export function setActiveVfs(vfs: Vfs, observer?: NodeBuiltinMemberObserver): void {
  active = { vfs, ...observer === undefined ? {} : { observer } }
}

/**
 * Read the mounted filesystem.
 * @returns The active filesystem.
 */
export function requireActiveVfs(): Vfs {
  if (active === undefined) {
    throw new Error('webworker vfs: no filesystem is mounted; the worker entry must call setActiveVfs before any node:fs access')
  }
  return active.vfs
}

/** Notify the active Worker Host that one public Node filesystem method was entered.
 * @param specifier - Node filesystem builtin containing the method.
 * @param member - public method name.
 */
export function recordActiveNodeBuiltinMember(specifier: 'node:fs' | 'node:fs/promises', member: string): void {
  active?.observer?.(specifier, member)
}
