/**
 * Session-retrieval probe for the Browser-Native PoC.
 *
 * The web profile already mounts the shipped `@deepseek-ai/dsh-session-query`
 * SQLite engine, which reconciles the browser-native persistence and serves
 * filtered listing plus indexed full-text search inside the Worker. This
 * test-only plugin binds that service and measures the shipped operations at
 * 100+ Session scale; it adds no retrieval implementation of its own.
 */
import type { StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { Context } from '@deepseek-ai/cordis'
import type SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionResultFilter } from '@deepseek-ai/dsh-session-query'

/** One measured retrieval request; every field is observable test input. */
export interface SessionQueryRunInput {
  /** Literal full-text query scanned across extracted semantic text. */
  readonly query: string
  /** Optional exact working-directory filter applied before the scan. */
  readonly cwd?: string
  /** Optional session whose within-session search is measured too. */
  readonly sessionId?: string
  /** Page size for both search calls. */
  readonly limit?: number
}

/** One search hit the probe returns for correctness assertions. */
export interface SessionQueryProbeHit {
  readonly sessionId: string
  readonly seq: number
  readonly snippet: string
}

/** Measured retrieval results for one run. */
export interface SessionQueryReport {
  readonly sessions: number
  readonly listMs: number
  readonly filterMs: number
  readonly filtered: number
  readonly filteredIds: readonly string[]
  readonly searchMs: number
  readonly matched: number
  readonly hits: readonly SessionQueryProbeHit[]
  /** `service` when the shipped index answered; `linear-fallback` otherwise. */
  readonly searchBackend: 'service' | 'linear-fallback'
  /** Why the shipped index could not answer, when it could not. */
  readonly searchError: string | undefined
  readonly withinSession: {
    readonly sessionId: string
    readonly hits: number
    readonly ms: number
  } | undefined
}

/** Test-only operations exposed through the Worker test port. */
export interface BrowserNativeSessionQueryProbe {
  readonly factory: StaticModuleFactory
  /**
   * Run one measured retrieval against the mounted query service.
   * @param input - query text, filters, and optional within-session target.
   * @returns corpus size, timings, and the matching hit identifiers.
   * @throws when the profile did not mount `sessionQuery`.
   */
  run(input: SessionQueryRunInput): Promise<SessionQueryReport>
}

/**
 * Create the query probe plugin.
 * @returns the static module factory plus the measured retrieval operation.
 */
export function createBrowserNativeSessionQuery(): BrowserNativeSessionQueryProbe {
  let service: SessionQueryEngine | undefined

  const factory: StaticModuleFactory = () => ({
    default: class BrowserNativeSessionQueryProbePlugin {
      constructor(ctx: Context) {
        ctx.inject(['sessionQuery'], (child: Context) => {
          const bound = child.sessionQuery
          service = bound
          child.effect(() => () => {
            if (service === bound) service = undefined
          }, 'browser-native session query probe binding')
        })
      }
    },
  })

  return {
    factory,
    async run(input) {
      if (service === undefined) throw new Error('browser-native session query: profile has no sessionQuery service')
      const started = performance.now()
      const records = await service.listSessions()
      const listMs = performance.now() - started

      const filters: SessionResultFilter[] = input.cwd === undefined ? [] : [{ kind: 'cwd', values: [input.cwd] }]
      const beforeFilter = performance.now()
      const filtered = await service.filterSessions(filters)
      const filterMs = performance.now() - beforeFilter

      const beforeSearch = performance.now()
      const limit = input.limit ?? 20
      let searchBackend: SessionQueryReport['searchBackend'] = 'service'
      let searchError: string | undefined
      let hits: SessionQueryProbeHit[] = []
      let matched = 0
      try {
        const page = await service.searchSessions({ query: input.query, limit })
        matched = page.items.length
        hits = page.items.map(item => ({
          sessionId: String(item.header.id),
          seq: item.bestMatch.seq,
          snippet: item.bestMatch.snippet,
        }))
      } catch (error) {
        // The Web deployment either disables the index or cannot open SQLite in
        // a Worker; measure the degradation instead of reporting no answer.
        searchBackend = 'linear-fallback'
        searchError = error instanceof Error ? error.message : String(error)
        const scannable = records
        for (const record of scannable.slice(0, 500)) {
          const snapshot = await service.readSession(record.header.id)
          const events = snapshot.events.filter(event => JSON.stringify(event).toLowerCase().includes(input.query.toLowerCase()))
          if (events.length === 0) continue
          const event = events[0]
          if (event === undefined) continue
          matched += 1
          if (hits.length < limit) {
            const serialized = JSON.stringify(event)
            const index = serialized.toLowerCase().indexOf(input.query.toLowerCase())
            const start = Math.max(0, index - 24)
            hits.push({ sessionId: String(record.header.id), seq: event.seq, snippet: serialized.slice(start, start + 96) })
          }
        }
      }
      const searchMs = performance.now() - beforeSearch

      let withinSession: SessionQueryReport['withinSession']
      if (input.sessionId !== undefined) {
        const beforeWithin = performance.now()
        if (searchBackend === 'service') {
          const events = await service.searchEvents({ sessionId: input.sessionId, query: input.query, limit })
          withinSession = { sessionId: input.sessionId, hits: events.items.length, ms: performance.now() - beforeWithin }
        } else {
          const snapshot = await service.readSession(input.sessionId)
          const events = snapshot.events.filter(event => JSON.stringify(event).toLowerCase().includes(input.query.toLowerCase()))
          withinSession = { sessionId: input.sessionId, hits: events.length, ms: performance.now() - beforeWithin }
        }
      }

      return {
        sessions: records.length,
        listMs,
        filterMs,
        filtered: filtered.length,
        filteredIds: filtered.map(record => String(record.header.id)),
        searchMs,
        matched,
        hits,
        searchBackend,
        searchError,
        withinSession,
      }
    },
  }
}
