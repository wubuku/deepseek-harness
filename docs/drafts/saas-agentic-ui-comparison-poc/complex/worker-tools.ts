/** Page-scoped DSH capabilities registered inside the real Cordis Worker Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-user-questions'
import { z } from 'zod'
import { requireActiveModuleLoader, type StaticModuleFactory } from '../../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import { requestCopilotKitFrontendTool } from '../../copilotkit-browser-native-dsh-poc/src/browser-native-control.ts'

const capabilitySchema = z.object({ type: z.literal('saas-capabilities'), page: z.enum(['tickets', 'quote', 'portfolio', 'billing']), role: z.enum(['editor', 'viewer']) })
let page: 'tickets' | 'quote' | 'portfolio' | 'billing' = 'tickets'
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
  { name: 'page_read', description: 'Read the current SaaS page, customer, selection, quote version, permissions and framework context. For a portfolio request call this at most once, then call portfolio_review; do not call page_read repeatedly.', parameters: {} },
  { name: 'bulk_assign', description: 'Assign exactly the selected support tickets. Only available on tickets page. Use customerId and ticketIds from page_read.', parameters: { customerId: { type: 'string', required: true }, ticketIds: { type: 'array', items: { type: 'string' }, required: true }, assignee: { type: 'string', required: true } } },
  { name: 'quote_patch', description: 'Patch only the requested quote fields. Preserve other manual edits. Use current expectedVersion from page_read. Errors are final, do not retry.', parameters: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true }, budget: { type: 'number' }, discount: { type: 'number' } } },
  { name: 'quote_send', description: 'Send the current quote ONLY after successful human approval via ask_user_question. Server rejects unapproved versions. Read current page/version first. Do not retry errors.', parameters: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true } } },
  { name: 'portfolio_apply', description: 'Apply the user-approved multi-customer renewal plan. Only available on the renewal portfolio page. Use the exact plan returned by portfolio_review and preserve each expectedVersion. Do not retry a VERSION_CONFLICT or APPROVAL_REQUIRED without one fresh page_read, one new portfolio_review, and a new approval.', parameters: { changes: { type: 'array', items: { type: 'object', properties: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true }, budget: { type: 'number' }, discount: { type: 'number' } }, additionalProperties: false }, required: true } } },
  { name: 'portfolio_review', description: 'After page_read, show the editable multi-customer renewal plan and wait for human approval or rejection. The result contains the exact approved changes and versions, including human edits. If approved and the user requested execution, call portfolio_apply with those returned changes in the same turn. If rejected, or the user requested preview only, stop without applying.', parameters: { changes: { type: 'array', items: { type: 'object', properties: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true }, budget: { type: 'number', required: true }, discount: { type: 'number', required: true } }, additionalProperties: false }, required: true } } },
  { name: 'billing_apply', description: 'Apply the approved billing credit plan. Only available on the billing page. Use the exact customerId, expectedVersion, creditAmount and reason returned by billing_review. Do not retry a VERSION_CONFLICT or APPROVAL_REQUIRED without one fresh page_read and one new billing_review.', parameters: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true }, creditAmount: { type: 'number', required: true }, reason: { type: 'string', required: true } } },
  { name: 'billing_review', description: 'After page_read, show an editable billing credit preview and wait for human approval or rejection. Preserve the current invoice version, keep creditAmount within the disputed amount, and call billing_apply only after approval.', parameters: { customerId: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true }, creditAmount: { type: 'number', required: true }, reason: { type: 'string', required: true } } },
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
          const desired = new Set(['page_read', ...(role === 'viewer' ? [] : page === 'tickets' ? ['bulk_assign'] : page === 'quote' ? ['quote_patch', 'quote_send'] : page === 'portfolio' ? ['portfolio_review', 'portfolio_apply'] : ['billing_review', 'billing_apply'])])
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
