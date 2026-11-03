/** Transcript window planning keeps settled Turns out of the document above a floor. */
import { expect, it } from 'vitest'
import { planChatWindow } from '../src/client/chat/chat-window.ts'

const FULL = {
  start: 0, hiddenRows: 0, hiddenTurns: 0, firstHiddenTurn: null, lastHiddenTurn: null,
}

it('renders every row without a floor', () => {
  expect(planChatWindow([1, 1, 2], null)).toEqual(FULL)
})

it('keeps every row when the floor is at or below the first Turn', () => {
  expect(planChatWindow([1, 1, 2, 2], 1)).toEqual(FULL)
})

it('starts at the first row of the floor Turn and counts distinct hidden Turns', () => {
  // Turns 1 and 2 each own several rows; only their Turn numbers count.
  expect(planChatWindow([1, 1, 1, 2, 2, 2, 3, 3], 3)).toEqual({
    start: 6, hiddenRows: 6, hiddenTurns: 2, firstHiddenTurn: 1, lastHiddenTurn: 2,
  })
})

it('keeps rows without an owning Turn attached to the preceding region', () => {
  // A session-level row after Turn 1 is hidden with Turn 1; once Turn 2 starts it is kept.
  expect(planChatWindow([1, 1, null, 2, 2], 2)).toMatchObject({ start: 3, hiddenTurns: 1 })
})

it('hides leading rows without an owning Turn together with the first hidden Turn', () => {
  expect(planChatWindow([null, 1, 1, 2], 2)).toMatchObject({
    start: 3, hiddenRows: 3, hiddenTurns: 1, firstHiddenTurn: 1,
  })
})

it('keeps every row when no row reaches the floor', () => {
  expect(planChatWindow([1, 1], 5)).toEqual(FULL)
})

it('reports the hidden Turn range from the rows above the start', () => {
  expect(planChatWindow([2, 3, 5, 6], 6)).toMatchObject({
    hiddenTurns: 3, firstHiddenTurn: 2, lastHiddenTurn: 5,
  })
})
