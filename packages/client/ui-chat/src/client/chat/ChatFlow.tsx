/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
import { memo, useMemo } from 'react'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'
import { planChatWindow } from './chat-window.ts'
import { RunningStatus } from './RunningStatus.tsx'
import css from './ChatView.module.css'

/**
 * Assign each root row the Turn it renders. Group rows carry no node store
 * entry, so they inherit the preceding row's Turn; session-level rows before
 * the first Turn stay null and never open the window.
 */
function entryTurns(
  entries: readonly RenderEntry[],
  nodes: ChatSnapshot['nodes'],
): readonly (number | null)[] {
  let turn: number | null = null
  return entries.map((entry) => {
    if (entry.kind === 'node') {
      const location = nodes.get(entry.key)?.location
      if (location?.kind === 'turn' || location?.kind === 'step') turn = location.turn.turn
    }
    return turn
  })
}

/** Render the flow without adding a DOM parent or changing keyed row positions. */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, lastInputTurn, deferCollapse, windowFloorTurn, onShowEarlier,
  useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation,
  useStore, actions, renderSlot, renderFactorySlot, t, useGroupAction, useGroupHeaderAction,
  cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
}: ChatFlowSlotProps) {
  const nodeStore = useChat(snapshot => snapshot.nodes)
  const running = useSession(snapshot => snapshot.running)
  const latestTurnAnchor = useChat(snapshot => snapshot.navigation.items().at(-1)?.anchorKey)
  const runningStartTime = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.status === 'open' ? location.turn.start?.time : undefined
      : undefined
  })
  const window = useMemo(
    () => planChatWindow(entryTurns(entries, nodeStore), windowFloorTurn),
    [entries, nodeStore, windowFloorTurn],
  )
  const seatProps = {
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
  }
  const rows = entries.slice(window.start).map((entry) => {
    switch (entry.kind) {
      case 'node':
        return <ChatNodeSeat {...seatProps} key={chatRenderKey(entry)} nodeKey={entry.key}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...seatProps} key={chatRenderKey(entry)} groupKey={entry.key}
          useChatGroup={useChatGroup} useGroupHeaderAction={useGroupHeaderAction} />
      default:
        return assertNever(entry)
    }
  })
  const pendingRows = pendingInputs.map(item => 'requestId' in item ? (
    <PendingSubmissionBubble key={item.requestId} submission={item}
      loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
  ) : (
    <PendingSteeringBubble key={item.id} content={item.content}
      loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
  ))
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    const index = pendingInputs.findIndex(item => 'requestId' in item && item.placement === 'transcript')
    if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1))
  }
  return [
    ...window.hiddenTurns === 0 ? [] : [
      <div key="window-boundary" className={css.windowBoundary}
        data-chat-window-boundary="" data-chat-window-hidden={window.hiddenTurns}>
        <button type="button" onClick={onShowEarlier}>
          {t('chat.showEarlier', { count: window.hiddenTurns })}
        </button>
      </div>,
    ],
    ...rows,
    ...pendingRows,
    ...running ? [<RunningStatus key="running" startTime={runningStartTime} t={t} />] : [],
  ]
})
