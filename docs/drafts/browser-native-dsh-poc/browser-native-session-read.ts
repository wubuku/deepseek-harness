/**
 * Read bounded backend pages as one DSH SessionHandle slice.
 * @param readPage - Fetch one backend page at the requested event offset.
 * @param offset - First event sequence to return.
 * @param length - Maximum number of events to return.
 * @param signal - Optional cancellation signal forwarded to each page request.
 * @returns The accumulated event slice and its backend ownership state.
 */
export async function readSessionPages<TEvent extends { readonly seq: number }>(
  readPage: (
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) => Promise<{
    readonly events: readonly TEvent[]
    readonly eventState: 'detached' | 'shared-frozen'
    readonly nextSeq: number
    readonly hasMore?: boolean
  }>,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<{
  readonly events: readonly TEvent[]
  readonly eventState: 'detached' | 'shared-frozen'
  readonly nextSeq: number
}> {
  const pageSize = 2_048
  const events: TEvent[] = []
  let pageOffset = offset
  let remaining = length
  let eventState: 'detached' | 'shared-frozen' | undefined
  let nextSeq = 0

  while (remaining > 0 || events.length === 0) {
    const pageLength = Math.min(remaining, pageSize)
    const page = await readPage(pageOffset, pageLength, signal)
    if (eventState !== undefined && eventState !== page.eventState) {
      throw new Error('browser-native Session read pages changed event ownership state')
    }
    eventState = page.eventState
    if (page.events.length > pageLength) {
      throw new Error('browser-native Session read page exceeded its requested length')
    }
    for (const event of page.events) {
      if (event.seq !== pageOffset) throw new Error('browser-native Session read pages contain a sequence gap')
      pageOffset += 1
    }
    events.push(...page.events)
    remaining -= page.events.length
    nextSeq = Math.max(nextSeq, page.nextSeq)

    if (page.events.length === 0) {
      if (page.hasMore === true) throw new Error('browser-native Session read page is empty but reports more events')
      break
    }
    if (remaining === 0 || page.hasMore === false) break
    if (page.events.length < pageLength && page.hasMore !== true) break
  }

  if (eventState === undefined) throw new Error('browser-native Session read returned no page')
  return { events, eventState, nextSeq }
}
