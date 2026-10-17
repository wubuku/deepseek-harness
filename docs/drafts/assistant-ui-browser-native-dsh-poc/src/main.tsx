import './symbol-dispose'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import * as React from 'react'
import { useSyncExternalStore, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactElement } from 'react'
import { bootBrowserNativeDshClient, type BrowserNativeDshClient } from './dsh-client'
import './styles.css'

function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result) ?? String(result)
  } catch {
    return String(result)
  }
}

function DshToolCallPart(props: ToolCallMessagePartProps): ReactElement {
  const state = props.isError === true
    ? 'failed'
    : props.result !== undefined
      ? 'completed'
      : props.status.type === 'running'
        ? 'running'
        : 'requested'
  return (
    <div className={`tool-call-card tool-call-${state}`} data-testid="assistant-ui-tool-call" data-tool-name={props.toolName}>
      <div className="tool-call-heading">
        <strong>DSH tool</strong>
        <span>{props.toolName}</span>
        <span className="tool-call-status" data-testid="assistant-ui-tool-status">{state}</span>
      </div>
      <pre className="tool-call-arguments">{props.argsText}</pre>
      {props.result !== undefined && (
        <div className="tool-call-result" data-testid="assistant-ui-tool-result">
          <span>Result</span>
          <pre>{toolResultText(props.result)}</pre>
        </div>
      )}
    </div>
  )
}

function AssistantUiThread({ client }: { readonly client: BrowserNativeDshClient }): ReactElement {
  const adapter = client.adapter
  const snapshot = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot)
  const runtime = useExternalStoreRuntime(adapter.runtimeOptions())
  useEffect(() => {
    const key = `dsh-assistant-ui-draft:${String(client.reference.binding.sessionId)}`
    const draft = window.sessionStorage.getItem(key)
    if (draft !== null) runtime.thread.composer.setText(draft)
    return runtime.thread.composer.subscribe(() => {
      window.sessionStorage.setItem(key, runtime.thread.composer.getState().text)
    })
  }, [client, runtime])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="poc-shell" data-testid="assistant-ui-ready">
        <header className="poc-header">
          <div>
            <p className="eyebrow">Browser-Native DSH PoC</p>
            <h1>assistant-ui chat layer</h1>
          </div>
          <div className="fact-badge">
            <span className={snapshot.isRunning ? 'status-dot running' : 'status-dot'} />
            {snapshot.connectionError !== undefined ? 'Session write access unavailable' : snapshot.isRunning ? 'DSH Agent Loop running' : 'DSH Session connected'}
          </div>
          <button className="load-earlier" type="button" data-testid="assistant-ui-new-session" disabled={snapshot.isRunning} onClick={() => { client.startNewSession() }}>
            New Session
          </button>
        </header>
        <section className="poc-thread" aria-label="assistant-ui thread">
          {snapshot.errorMessage !== undefined && (
            <div className="session-error" data-testid="assistant-ui-error" role="alert">
              <strong>{snapshot.connectionError !== undefined ? 'This Session cannot accept messages.' : 'The previous DSH Agent turn failed.'}</strong>
              <span>{snapshot.errorMessage}</span>
              <span>{snapshot.connectionError !== undefined
                ? 'If another tab has this Session open, close it first. Otherwise wait up to 30 seconds for its write lease to expire, then reconnect. Your draft is kept in this tab.'
                : 'This Session is still open. Send another message to continue. A rejected message is returned to the input.'}</span>
              {snapshot.connectionError !== undefined && (
                <button className="load-earlier" data-testid="assistant-ui-reconnect" type="button" onClick={() => { window.location.reload() }}>
                  Reconnect this Session
                </button>
              )}
            </div>
          )}
          <ThreadPrimitive.Root className="thread-root">
            <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
              <ThreadPrimitive.LoadEarlier className="load-earlier">
                Load earlier Session events
              </ThreadPrimitive.LoadEarlier>
              <ThreadPrimitive.Messages>
                {({ message }) => (
                  <MessagePrimitive.Root
                    className={`message-row message-${message.role}`}
                    data-message-id={message.id}
                    data-role={message.role}
                    data-dsh-live={message.id.startsWith('dsh-live-') ? 'true' : undefined}
                  >
                    <div className="message-label">{message.role === 'user' ? 'You' : 'DSH Agent'}</div>
                    <div className="message-body">
                      <MessagePrimitive.Parts components={{ tools: { Fallback: DshToolCallPart } }} />
                    </div>
                  </MessagePrimitive.Root>
                )}
              </ThreadPrimitive.Messages>
            </ThreadPrimitive.Viewport>
            <ComposerPrimitive.Root className="composer-root">
              <ComposerPrimitive.Input
                className="composer-input"
                data-testid="assistant-ui-input"
                placeholder="Ask the DSH Agent…"
              />
              <div className="composer-actions">
                <span className="composer-note">Text-only incremental adapter</span>
                <ComposerPrimitive.Send className="send-button" data-testid="assistant-ui-send">
                  Send
                </ComposerPrimitive.Send>
                <button
                  className="stop-button"
                  data-testid="assistant-ui-stop"
                  disabled={!snapshot.isRunning}
                  onClick={() => { void adapter.onCancel() }}
                  type="button"
                >
                  Stop
                </button>
              </div>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.Root>
        </section>
        <footer className="poc-footer">
          <span>UI: assistant-ui</span>
          <span>Execution: DSH ctx.agentLoop</span>
          <span>Facts: DSH Session</span>
        </footer>
      </main>
    </AssistantRuntimeProvider>
  )
}

function App(): ReactElement {
  const [client, setClient] = useState<BrowserNativeDshClient>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    let current: BrowserNativeDshClient | undefined
    const disposeCurrent = () => {
      const disposing = current
      current = undefined
      void disposing?.dispose().catch(reason => {
        console.error('assistant-ui PoC: DSH client disposal failed', reason)
      })
    }
    void bootBrowserNativeDshClient().then(value => {
      if (!active) {
        void value.dispose()
        return
      }
      current = value
      setClient(value)
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      active = false
      disposeCurrent()
    }
  }, [])

  if (error !== undefined) {
    return <main className="poc-error" data-testid="assistant-ui-error">{error}</main>
  }
  if (client === undefined) {
    return <main className="poc-loading" data-testid="assistant-ui-loading">Starting DSH Worker and Session Controller…</main>
  }
  return <AssistantUiThread client={client} />
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
