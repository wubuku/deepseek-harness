/** DSH tools execute in the shared Worker, never in an independent framework agent loop. */
import type { Context } from '@deepseek-ai/cordis'
import { requireActiveModuleLoader, type StaticModuleFactory } from '../../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { requestCopilotKitFrontendTool } from '../../copilotkit-browser-native-dsh-poc/src/browser-native-control.ts'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-user-questions'

const definitions = [
  { name: 'saas_read_workspace', description: 'Read the existing SaaS tasks, support tickets, invoices, role and operation receipts. Read before business operations to obtain ids and current versions. The result is logged in DSH Session.', parameters: {} },
  { name: 'saas_create_task', description: 'Open the existing SaaS task form inside the assistant. User edits and confirms or cancels. Fields returned by the tool are authoritative, including user edits. Never claim success before ok=true. On cancellation or API errors report the outcome, do not automatically retry.', parameters: {
    title: { type: 'string', required: true }, assignee: { type: 'string', required: true, description: '林悦, 陈晨 or 周宁' }, priority: { type: 'string', required: true, description: 'high, medium or low' },
  } },
  { name: 'saas_update_ticket', description: 'Open the existing SaaS support-ticket form for user review. Use the version from saas_read_workspace. Return user-confirmed changes to the same DSH tool call. Report errors or cancellation without retrying.', parameters: {
    id: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true }, assignee: { type: 'string', required: true }, priority: { type: 'string', required: true }, status: { type: 'string', required: true, description: 'open, in_progress or resolved' },
  } },
  { name: 'saas_approve_invoice', description: 'Show an existing SaaS invoice approval form requiring explicit human confirmation. No business write occurs before confirmation. Read workspace first for the current version. A cancellation or forbidden/conflict error is final for this request; do not automatically retry.', parameters: {
    id: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true },
  } },
] as const

/** Resolve DSH plugin classes from the Worker VFS to preserve Cordis service identity. */
export function createCopilotKitStaticModules(): Readonly<Record<string, StaticModuleFactory>> {
  return {
    '@deepseek-ai/dsh-copilotkit-frontend-tools': () => ({ default(ctx: Context): void {
      const { defineTool } = requireActiveModuleLoader().requireFrom('/dsh')('@deepseek-ai/dsh-tools') as typeof import('@deepseek-ai/dsh-tools')
      const tools = definitions.map(definition => defineTool({
        ...definition,
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, result: unknown) => [{ type: 'text' as const, text: JSON.stringify(result) }] },
        execute(args: unknown, exec: ToolExecution): Promise<unknown> {
          if (exec.agent === undefined) throw new Error('SaaS tool requires an owning DSH agent')
          return requestCopilotKitFrontendTool({ sessionId: String(exec.agent.id), callId: String(exec.callId), name: definition.name, arguments: args, signal: exec.signal })
        },
      }) as ToolDefinition)
      ctx.effect(() => { const disposers = tools.map(tool => ctx.tools.register(tool)); return () => { for (const dispose of disposers) dispose() } })
    } }),
    '@deepseek-ai/dsh-copilotkit-user-questions': () => ({ default(ctx: Context): void {
      ctx.on('user-questions/request', async (request: AskUserQuestionRequestEvent, next) => {
        if (request.agent === undefined || request.wait === undefined) return next()
        return await requestCopilotKitFrontendTool({ sessionId: String(request.agent.id), callId: String(request.wait.callId), name: 'ask_user_question', arguments: { questions: request.questions }, signal: request.signal }) as AskUserQuestionAnswer
      }, { global: true })
    } }),
  }
}
