/** Bounded transcript window above the followed tail. */

/**
 * Settled Turns kept mounted while the reader follows the tail. At 150 Turns
 * the measured scroll burst stays inside budget and the 12,000-character append
 * produces no long task, so the window keeps the last acceptable Turn count and
 * hides only the region that crosses the virtualization trigger line.
 */
export const TRANSCRIPT_WINDOW_TURNS = 150

/** Rows hidden above the first rendered row. */
export interface ChatWindowPlan {
  /** Index of the first rendered root row. */
  readonly start: number
  /** Root rows hidden above `start`. */
  readonly hiddenRows: number
  /** Distinct Turns hidden above `start`. */
  readonly hiddenTurns: number
  /** Earliest hidden Turn, or null when nothing is hidden. */
  readonly firstHiddenTurn: number | null
  /** Latest hidden Turn, or null when nothing is hidden. */
  readonly lastHiddenTurn: number | null
}

const FULL: ChatWindowPlan = {
  start: 0,
  hiddenRows: 0,
  hiddenTurns: 0,
  firstHiddenTurn: null,
  lastHiddenTurn: null,
}

/**
 * Choose the first root row to render so earlier Turns stay out of the document.
 * A row without an owning Turn belongs to the Turn region before it.
 * @param turns - owning Turn per root row in render order, or null when it has none.
 * @param floorTurn - earliest Turn to keep mounted; null keeps every row.
 * @returns the window plan for this row list.
 */
export function planChatWindow(
  turns: readonly (number | null)[],
  floorTurn: number | null,
): ChatWindowPlan {
  if (floorTurn === null) return FULL
  const start = turns.findIndex(turn => turn !== null && turn >= floorTurn)
  if (start <= 0) return FULL
  const hidden = new Set<number>()
  for (let index = 0; index < start; index += 1) {
    const turn = turns[index]
    if (turn !== null && turn !== undefined && turn < floorTurn) hidden.add(turn)
  }
  if (hidden.size === 0) return FULL
  let firstHiddenTurn = Infinity
  let lastHiddenTurn = -Infinity
  for (const turn of hidden) {
    firstHiddenTurn = Math.min(firstHiddenTurn, turn)
    lastHiddenTurn = Math.max(lastHiddenTurn, turn)
  }
  return {
    start,
    hiddenRows: start,
    hiddenTurns: hidden.size,
    firstHiddenTurn,
    lastHiddenTurn,
  }
}
