/** Framework-native registrations share business commands, not a replacement agent loop. */
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ToolCallMessagePartProps } from '@assistant-ui/react'
import { CopilotChat, CopilotKitProvider, useAgent, useAgentContext, useCopilotKit, useFrontendTool, useHumanInTheLoop } from '@copilotkit/react-core/v2'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import ReactMarkdown from 'react-markdown'
import { DshSessionAdapter } from '../../assistant-ui-browser-native-dsh-poc/src/dsh-session-adapter.ts'
import { DshSegmentedAgent } from './dsh-segmented-agent.ts'
import { BillingReviewCard, billingReviewSchema, Business, executeCommand, PortfolioReviewCard, questionSchema, ReviewCard, ToolCard, useBusiness } from './business.tsx'

function FrontendTool({ name }: { name: string }): null {
  const business = useBusiness()
  const current = useRef(business)
  current.current = business
  useFrontendTool({ name, agentId: 'dsh-browser-native', parameters: z.object({}).passthrough(),
    handler: async (args, context) => current.current.client.frontendTools.executeNative(context.toolCall.id, name, call => executeCommand(current.current, name, args, call)),
    render: ({ toolCallId }) => <ToolCard callId={toolCallId} name={name} />,
  }, [name])
  return null
}

function CopilotRegistrations(): React.ReactElement {
  const business = useBusiness()
  const { copilotkit } = useCopilotKit()
  const { agent } = useAgent({ agentId: 'dsh-browser-native' })
  const pending = useSyncExternalStore(business.client.frontendTools.subscribe, business.client.frontendTools.getSnapshot)
  const account = business.data.accounts[business.customerId]
  useAgentContext({ description: '当前 SaaS 页面；经 page_read 记录后供 DSH 模型使用', value: { page: business.page, customerId: business.customerId, selected: business.selected, role: business.role, quote: { budget: account.quote.budget, discount: account.quote.discount, version: account.quote.version }, billing: { invoiceId: account.billing.invoiceId, disputed: account.billing.disputed, version: account.billing.version, status: account.billing.status } } })
  useHumanInTheLoop({ name: 'ask_user_question', agentId: 'dsh-browser-native', parameters: questionSchema,
    render: ({ toolCallId, respond }) => <ReviewCard callId={toolCallId} respond={respond} />,
  }, [])
  useHumanInTheLoop({ name: 'portfolio_review', agentId: 'dsh-browser-native', parameters: z.object({ changes: z.array(z.object({ customerId: z.enum(['acme', 'birch']), expectedVersion: z.number(), budget: z.number(), discount: z.number() }).strict()) }),
    render: ({ toolCallId, respond }) => <PortfolioReviewCard callId={toolCallId} respond={respond} />,
  }, [])
  useHumanInTheLoop({ name: 'billing_review', agentId: 'dsh-browser-native', parameters: billingReviewSchema,
    render: ({ toolCallId, respond }) => <BillingReviewCard callId={toolCallId} respond={respond} />,
  }, [])
  const names = ['page_read', ...(business.role === 'viewer' ? [] : business.page === 'tickets' ? ['bulk_assign'] : business.page === 'quote' ? ['quote_patch', 'quote_send'] : business.page === 'portfolio' ? ['portfolio_apply'] : ['billing_apply'])]
  return <>{names.map(name => <FrontendTool key={name} name={name} />)}{pending.length ? <button className="stop-operation" type="button" onClick={() => { copilotkit.stopAgent({ agent }) }}>停止当前操作</button> : null}</>
}

/** Render only CopilotKit chat; DSH remains the executor and history authority.
 * @returns The official chat component with native SaaS tool and HITL registrations.
 */
export function CopilotLayer(): React.ReactElement {
  const { client } = useBusiness()
  const agent = useMemo(() => new DshSegmentedAgent(client.binding, client.frontendTools), [client])
  const error = useSyncExternalStore(agent.subscribeError, agent.getError)
  const pending = useSyncExternalStore(client.frontendTools.subscribe, client.frontendTools.getSnapshot)
  const agents = useMemo(() => ({ 'dsh-browser-native': agent }), [agent])
  useEffect(() => {
    Object.defineProperty(window, '__complexSegments', { configurable: true, get: () => agent.segments })
    return () => { delete (window as Window & { __complexSegments?: unknown }).__complexSegments }
  }, [agent])
  return <CopilotKitProvider agents__unsafe_dev_only={agents} showDevConsole={false} showIntelligenceIndicator={false}><CopilotRegistrations />{error ? <p role="alert">本轮未完成：{error}。可以发送下一条消息继续。</p> : null}<CopilotChat agentId="dsh-browser-native" threadId={String(client.binding.sessionId)} autoScroll="pin-to-bottom" inspectorTools={false} input={{ textArea: { disabled: pending.length > 0 }, sendButton: { disabled: pending.length > 0 } }} labels={{ modalHeaderTitle: '续约协作助手', welcomeMessageText: '我可以读取当前业务页面、调整报价，并在您审核后发送。', chatInputPlaceholder: '描述业务目标…', chatDisclaimerText: '操作结果以业务凭据为准，请核对重要信息。' }} /></CopilotKitProvider>
}

function AssistantTool(props: ToolCallMessagePartProps): React.ReactElement { return <ToolCard callId={props.toolCallId} name={props.toolName} /> }
function Markdown({ text }: { text: string }): React.ReactElement { return <ReactMarkdown>{text}</ReactMarkdown> }
function AssistantMessage(): React.ReactElement { return <MessagePrimitive.Root className="assistant-message"><MessagePrimitive.Parts components={{ Text: Markdown, tools: { Fallback: AssistantTool } }} /></MessagePrimitive.Root> }
function UserMessage(): React.ReactElement { return <MessagePrimitive.Root className="user-message"><MessagePrimitive.Parts /></MessagePrimitive.Root> }

/** Project the same DSH Session through assistant-ui without a second Agent Loop.
 * @returns Chat primitives and shared business tool cards.
 */
export function AssistantLayer(): React.ReactElement {
  const { client } = useBusiness()
  const adapter = useMemo(() => new DshSessionAdapter({ binding: client.binding }), [client])
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot)
  const runtime = useExternalStoreRuntime(adapter.runtimeOptions())
  useEffect(() => () => { adapter.dispose() }, [adapter])
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="assistant-thread"><ThreadPrimitive.Viewport className="chat-scroll"><ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} /></ThreadPrimitive.Viewport>{state.errorMessage ? <p role="alert">{state.errorMessage}</p> : null}<ComposerPrimitive.Root className="assistant-composer"><ComposerPrimitive.Input aria-label="消息" placeholder="描述业务目标…" /><div><ComposerPrimitive.Send>发送</ComposerPrimitive.Send>{state.isRunning ? <button type="button" onClick={() => { void adapter.onCancel() }}>停止</button> : null}</div></ComposerPrimitive.Root></ThreadPrimitive.Root></AssistantRuntimeProvider>
}

/** Mount the native renderer and synchronize SaaS context across its separate React root.
 * @returns The native comparison host, without mounting either third-party chat layer.
 */
export function NativeLayer(): React.ReactElement {
  const business = useBusiness()
  const current = useRef(business)
  current.current = business
  const listeners = useMemo(() => new Set<() => void>(), [])
  useEffect(() => { for (const listener of listeners) listener() }, [business, listeners])
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const ctx = business.client.context
    const cleanup = ctx.effect(() => {
      function Card(props: ToolCallViewProps): React.ReactElement {
        const value = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current.current)
        return <Business.Provider value={value}><ToolCard callId={props.callId} name={props.toolName} /></Business.Provider>
      }
      const disposers = ['page_read', 'bulk_assign', 'quote_patch', 'quote_send', 'portfolio_review', 'portfolio_apply', 'ask_user_question'].map(name => ctx.slots.register({ name: 'tool.call.toolview', key: name, priority: -10 }, Card))
      return () => { for (const dispose of disposers) dispose() }
    })
    const navigation = ctx.get('uiWorkspace')
    if (!navigation || !host.current) throw new Error('原生聊天工作区不可用')
    navigation.openSession(business.client.binding.sessionId)
    const unmount = ctx.get('uiRenderer')?.mount(host.current)
    return () => { unmount?.(); cleanup() }
  }, [business.client])
  return <div className="native-host" ref={host} />
}
