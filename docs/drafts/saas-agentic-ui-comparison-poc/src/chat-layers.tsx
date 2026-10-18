/** Framework-specific presentation only; DSH owns execution, messages and tool results. */
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import ReactMarkdown from 'react-markdown'
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ToolCallMessagePartProps } from '@assistant-ui/react'
import { CopilotChat, CopilotKitProvider, useRenderTool } from '@copilotkit/react-core/v2'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { DshSessionAdapter } from '../../assistant-ui-browser-native-dsh-poc/src/dsh-session-adapter.ts'
import { DshAgUiAgent } from '../../copilotkit-browser-native-dsh-poc/src/dsh-agui-agent.ts'
import { Business, BusinessToolCard, useBusiness, type BusinessContext } from './business-ui.tsx'

const toolNames = ['saas_read_workspace', 'saas_create_task', 'saas_update_ticket', 'saas_approve_invoice', 'ask_user_question']

function AssistantTool(props: ToolCallMessagePartProps): React.ReactElement { return <BusinessToolCard callId={props.toolCallId} name={props.toolName} /> }
function MarkdownText({ text }: { text: string }): React.ReactElement { return <ReactMarkdown>{text}</ReactMarkdown> }
function AssistantMessage(): React.ReactElement { return <MessagePrimitive.Root className="assistant-message"><MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: AssistantTool } }} /></MessagePrimitive.Root> }
function UserMessage(): React.ReactElement { return <MessagePrimitive.Root className="user-message"><MessagePrimitive.Parts /></MessagePrimitive.Root> }

export function AssistantChat(): React.ReactElement {
  const { client } = useBusiness()
  const adapter = useMemo(() => new DshSessionAdapter({ binding: client.binding }), [client])
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot)
  useEffect(() => () => { adapter.dispose() }, [adapter])
  const runtime = useExternalStoreRuntime(adapter.runtimeOptions())
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="assistant-thread">
    <ThreadPrimitive.Viewport className="chat-scroll" autoScroll><ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} /></ThreadPrimitive.Viewport>
    {state.errorMessage ? <p role="alert">{state.errorMessage}</p> : null}
    <ComposerPrimitive.Root className="assistant-composer"><ComposerPrimitive.Input placeholder="描述业务目标，助手复用已有操作…" aria-label="消息" /><div><ComposerPrimitive.Send>发送</ComposerPrimitive.Send>{state.isRunning ? <button type="button" onClick={() => { void adapter.onCancel() }}>停止</button> : null}</div></ComposerPrimitive.Root>
  </ThreadPrimitive.Root></AssistantRuntimeProvider>
}

function CopilotRender({ name }: { name: string }): null {
  useRenderTool({ name, agentId: 'dsh-browser-native', parameters: z.object({}).passthrough(), render: ({ toolCallId }) => <BusinessToolCard callId={toolCallId} name={name} /> })
  return null
}
export function CopilotChatLayer(): React.ReactElement {
  const { client } = useBusiness()
  const agents = useMemo(() => ({ 'dsh-browser-native': new DshAgUiAgent({ binding: client.binding, threadId: String(client.binding.sessionId) }, { agentId: 'dsh-browser-native' }) }), [client])
  return <CopilotKitProvider agents__unsafe_dev_only={agents} showDevConsole={false} showInspector={false} showAgentIntelligenceIndicator={false}>
    {toolNames.map(name => <CopilotRender key={name} name={name} />)}
    <CopilotChat agentId="dsh-browser-native" threadId={String(client.binding.sessionId)} labels={{ title: '业务助手', initial: '描述业务目标，助手复用已有表单与操作。' }} />
  </CopilotKitProvider>
}

export function NativeChat(): React.ReactElement {
  const business = useBusiness()
  const businessRef = useRef(business)
  businessRef.current = business
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const ctx = business.client.context
    const disposers: (() => void)[] = []
    ctx.effect(() => {
      function Tool(props: ToolCallViewProps): React.ReactElement {
        return <Business.Provider value={businessRef.current}><BusinessToolCard callId={props.callId} name={props.toolName} /></Business.Provider>
      }
      for (const name of toolNames) disposers.push(ctx.slots.register({ name: 'tool.call.toolview', key: name, priority: -10 }, Tool))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    })
    const navigation = ctx.get('uiWorkspace')
    if (navigation === undefined) throw new Error('DSH native workspace navigation did not activate')
    navigation.openSession(business.client.binding.sessionId)
    console.info('SaaS native selected Session', JSON.stringify(business.client.sessions.retainInfo(business.client.binding.sessionId).getSnapshot()))
    if (host.current === null) throw new Error('native chat mount missing')
    const unmount = ctx.get('uiRenderer')?.mount(host.current)
    if (unmount === undefined) throw new Error('DSH native UI renderer did not activate')
    return unmount
  }, [business.client])
  return <div ref={host} className="native-host" data-testid="native-chat" />
}
