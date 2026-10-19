/** Page-scoped DSH capabilities registered inside the real Cordis Worker Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-user-questions'
import { z } from 'zod'
import { requireActiveModuleLoader, type StaticModuleFactory } from '../../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import { requestCopilotKitFrontendTool } from '../../copilotkit-browser-native-dsh-poc/src/browser-native-control.ts'

const capabilitySchema = z.object({ type: z.literal('saas-capabilities'), page: z.enum(['tickets', 'quote']), role: z.enum(['editor', 'viewer']) })
let page: 'tickets' | 'quote' = 'tickets'
let role = 'editor'
let update: (() => void) | undefined

/** Validate page messages and retract tools before the next DSH model request.
 * @param value - Data-only page capability message from the main thread.
 */
export function updateCapabilities(value: unknown): void {
  const parsed = capabilitySchema.parse(value)
  page = parsed.page
  role = parsed.role
  update?.()
}

const definitions = [
  { name: 'page_read', description: 'Read the current SaaS page, customer, selection, quote version, permissions and framework context. Always read before each business action.', parameters: {} },
  { name: 'bulk_assign', description: 'Assign exactly the selected support tickets. Only available on tickets page. Use customerId and ticketIds from page_read.', parameters: { customerId: { type: 'string', required: true }, ticketIds: { type: 'array', items: { type: 'string' }, required: true }, assignee: { type: 'string', required: true } } },
  { name: 'quote_patch', description: 'Patch only the requested quote fields. Preserve other manual edits. Use current expectedVersion from page_read. Errors are final, do not retry.', parameters: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true }, budget: { type: 'number' }, discount: { type: 'number' } } },
  { name: 'quote_send', description: 'Send the current quote ONLY after successful human approval via ask_user_question. Server rejects unapproved versions. Read current page/version first. Do not retry errors.', parameters: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true } } },
] as const

/** Resolve plugin services through VFS so Cordis uses one service identity.
 * @returns Worker plugin factories for tools and the DSH question service.
 */
export function createCopilotKitStaticModules(): Readonly<Record<string, StaticModuleFactory>> {
  return {
    '@deepseek-ai/dsh-copilotkit-frontend-tools': () => ({ default(ctx: Context): void {
      const { defineTool } = requireActiveModuleLoader().requireFrom('/dsh')('@deepseek-ai/dsh-tools') as typeof import('@deepseek-ai/dsh-tools')
      ctx.effect(() => {
        const active = new Map<string, () => void>()
        const sync = (): void => {
          const desired = new Set(['page_read', ...(role === 'viewer' ? [] : page === 'tickets' ? ['bulk_assign'] : ['quote_patch', 'quote_send'])])
          for (const [name, dispose] of active) if (!desired.has(name)) { dispose(); active.delete(name) }
          for (const definition of definitions) if (desired.has(definition.name) && !active.has(definition.name)) {
            const tool = defineTool({ ...definition,
              output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, result: unknown) => [{ type: 'text' as const, text: JSON.stringify(result) }] },
              execute(args: unknown, exec: ToolExecution): Promise<unknown> {
                if (!exec.agent) throw new Error('工具缺少 DSH Session')
                return requestCopilotKitFrontendTool({ sessionId: String(exec.agent.id), callId: String(exec.callId), name: definition.name, arguments: args, signal: exec.signal })
              },
            }) as ToolDefinition
            active.set(definition.name, ctx.tools.register(tool))
          }
        }
        update = sync
        sync()
        return () => { update = undefined; for (const dispose of active.values()) dispose() }
      })
    } }),
    '@deepseek-ai/dsh-copilotkit-user-questions': () => ({ default(ctx: Context): void {
      ctx.on('user-questions/request', async (request: AskUserQuestionRequestEvent, next) => {
        if (!request.agent || !request.wait) return next()
        return await requestCopilotKitFrontendTool({ sessionId: String(request.agent.id), callId: String(request.wait.callId), name: 'ask_user_question', arguments: { questions: request.questions }, signal: request.signal }) as AskUserQuestionAnswer
      }, { global: true })
    } }),
  }
}
