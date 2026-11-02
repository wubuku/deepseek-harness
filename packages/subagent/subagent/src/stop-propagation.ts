/**
 * Stop propagation across a delegated work tree.
 *
 * A turn ending `aborted` with the `user` cause is the durable record of a
 * stop the user asked for. Stopping a top-level Session covers the work that
 * Session delegated: the descendant Activations keep their Sessions and
 * settlement notices, but none of them may keep running. A targeted interrupt
 * of one subagent stays targeted at that subagent, and ancestor (`parent`) and
 * disposal causes are reconciled by the Activation lifecycle instead, so
 * neither is re-entered here.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'

/**
 * Stop the live subagent descendants of a top-level Session whose turn the
 * user aborted. The listener lives as long as `ctx`'s fiber.
 * @param ctx - context carrying the Agent registry and Session events.
 * @param stopDescendants - cancels the descendant Activations of one Session id.
 */
export function installSubagentStopPropagation(
  ctx: Context,
  stopDescendants: (rootId: SessionId) => void,
): void {
  // The stop is recorded on an Agent Session this runtime does not own, so the
  // listener sits at the root and disposes with the runtime's fiber.
  ctx.effect(() => ctx.root.on('session/event', (session, event) => {
    if (session.header.parentSession !== undefined) return
    if (event.type !== 'turn/end') return
    const { reason } = event.data
    if (reason.kind !== 'aborted' || reason.reason.kind !== 'user') return
    stopDescendants(session.id)
  }), 'subagents.stopPropagation()')
}
