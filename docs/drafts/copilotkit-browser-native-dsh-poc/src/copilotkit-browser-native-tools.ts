import type { Context } from '@deepseek-ai/cordis'
import type { StaticModuleFactory } from '../../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import { requireActiveModuleLoader } from '../../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { requestCopilotKitFrontendTool } from './browser-native-control.ts'
import type { AskUserQuestionRequestEvent, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-user-questions'

interface RuntimeToolsModule {
  readonly defineTool: typeof import('@deepseek-ai/dsh-tools').defineTool
}

function loaderRequire(): (specifier: string) => unknown {
  return requireActiveModuleLoader().requireFrom('/dsh')
}

function runtimeTools(): RuntimeToolsModule {
  return loaderRequire()('@deepseek-ai/dsh-tools') as RuntimeToolsModule
}

function toolModule(): StaticModuleFactory {
  let module: unknown
  return () => {
    module ??= {
      default: (ctx: Context): void => {
        const { defineTool } = runtimeTools()
        const probeTool = defineTool({
          name: 'browser_native_ui_probe',
          description: 'Ask the Browser-Native SaaS UI to display a capability probe and return its result.',
          parameters: {
            label: { type: 'string', required: true, description: 'Short label to show in the UI probe.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                accepted: { type: 'boolean', required: true },
                label: { type: 'string', required: true },
                completedAt: { type: 'string', required: true },
              },
            },
            render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
          },
          async execute(args: { readonly label: string }, exec: ToolExecution): Promise<unknown> {
            if (exec.agent === undefined) throw new Error('browser_native_ui_probe requires an owning Agent')
            return requestCopilotKitFrontendTool({
              sessionId: String(exec.agent.id),
              callId: String(exec.callId),
              name: 'browser_native_ui_probe',
              arguments: args,
              signal: exec.signal,
            })
          },
        }) as ToolDefinition
        const workspaceTool = defineTool({
          name: 'saas_get_workspace',
          description: 'Read the current projects and open work items from the existing SaaS workspace UI. Use this before proposing a business operation when the user refers to current workspace state.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              additionalProperties: true,
              properties: {
                projects: { type: 'array', required: true },
                workItems: { type: 'array', required: true },
              },
            },
            render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
          },
          async execute(_args: Record<string, never>, exec: ToolExecution): Promise<unknown> {
            if (exec.agent === undefined) throw new Error('saas_get_workspace requires an owning Agent')
            return requestCopilotKitFrontendTool({
              sessionId: String(exec.agent.id),
              callId: String(exec.callId),
              name: 'saas_get_workspace',
              arguments: {},
              signal: exec.signal,
            })
          },
        }) as ToolDefinition
        const createWorkItemTool = defineTool({
          name: 'saas_create_work_item',
          description: 'Propose a planned work item in the existing SaaS workspace. This opens an interactive Agentic UI card in the conversation; the user can edit fields and confirm or cancel. The result contains the final user-confirmed values and userEditedFields. Treat those as the applied operation; do not describe edited values as a mismatch or ask the user to confirm again. Never claim creation until the tool returns ok=true.',
          parameters: {
            projectId: { type: 'string', required: true, description: 'Existing project id, such as growth, platform, or customer.' },
            title: { type: 'string', required: true, description: 'Short work-item title.' },
            priority: { type: 'string', required: true, description: 'Priority: High, Medium, or Low.' },
            assignee: { type: 'string', required: true, description: 'Person who owns the work item.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                operationId: { type: 'string', required: true },
                itemId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                project: { type: 'string', required: true },
                projectId: { type: 'string', required: true },
                priority: { type: 'string', required: true },
                assignee: { type: 'string', required: true },
                status: { type: 'string', required: true },
                userConfirmed: { type: 'boolean', required: true },
                userEditedFields: { type: 'array', required: true },
              },
            },
            render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
          },
          async execute(args: { readonly projectId: string; readonly title: string; readonly priority: string; readonly assignee: string }, exec: ToolExecution): Promise<unknown> {
            if (exec.agent === undefined) throw new Error('saas_create_work_item requires an owning Agent')
            return requestCopilotKitFrontendTool({
              sessionId: String(exec.agent.id),
              callId: String(exec.callId),
              name: 'saas_create_work_item',
              arguments: args,
              signal: exec.signal,
            })
          },
        }) as ToolDefinition
        ctx.effect(() => {
          const disposers = [
            ctx.tools.register(probeTool),
            ctx.tools.register(workspaceTool),
            ctx.tools.register(createWorkItemTool),
          ]
          return () => { for (const dispose of disposers) dispose() }
        })
      },
    }
    return module
  }
}

function userQuestionsModule(): StaticModuleFactory {
  let module: unknown
  return () => {
    module ??= {
      default: (ctx: Context): void => {
        ctx.on('user-questions/request', async (request: AskUserQuestionRequestEvent, next) => {
          const sessionId = request.agent?.id
          const callId = request.wait?.callId ?? globalThis.crypto.randomUUID()
          if (sessionId === undefined) return next()
          const result = await requestCopilotKitFrontendTool({
            sessionId: String(sessionId),
            callId: String(callId),
            name: 'ask_user_question',
            arguments: { questions: request.questions },
            signal: request.signal,
          })
          return result as AskUserQuestionAnswer
        }, { global: true })
      },
    }
    return module
  }
}

/** Worker-only static modules that bridge DSH tool execution to CopilotKit UI. */
export function createCopilotKitStaticModules(): Readonly<Record<string, StaticModuleFactory>> {
  return {
    '@deepseek-ai/dsh-copilotkit-frontend-tools': toolModule(),
    '@deepseek-ai/dsh-copilotkit-user-questions': userQuestionsModule(),
  }
}
