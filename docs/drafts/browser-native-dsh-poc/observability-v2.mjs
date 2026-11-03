/**
 * In-process metrics registry for the Browser-Native PoC backend.
 *
 * It records transport-level request outcomes, failure codes classified at the
 * error channel, and model request duration/queue wait. Gauges that live in
 * other controllers (admission queue, Session leases, durable turns, process
 * memory) are passed to `snapshot()` at capture time instead of being polled.
 *
 * Cardinality is capped per label map: overflowing labels collapse to `other`,
 * so an attacker cannot grow memory by generating route or error-code names.
 */

const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000]
const MAX_LABEL_KEYS = 48
const MAX_ROUTE_LENGTH = 120
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HEX_LIKE = /[0-9a-f]{32,}/gi
const NUMBER_LIKE = /[0-9]+/g

/**
 * Collapse dynamic identifiers so a route label stays bounded and stable.
 * @param {string} pathname - Request pathname.
 * @returns {string} Route label with identifiers replaced by `:id`.
 */
export function metricRoute(pathname) {
  const normalized = pathname
    .replace(UUID_LIKE, ':id')
    .replace(HEX_LIKE, ':id')
    .replace(NUMBER_LIKE, ':id')
  return normalized.length > MAX_ROUTE_LENGTH ? `${normalized.slice(0, MAX_ROUTE_LENGTH)}...` : normalized
}

function createHistogram() {
  return { count: 0, sumMs: 0, buckets: new Map() }
}

function observeHistogram(histogram, value) {
  const ms = Number.isFinite(value) && value >= 0 ? value : 0
  histogram.count += 1
  histogram.sumMs += ms
  for (const le of HISTOGRAM_BUCKETS_MS) {
    if (ms <= le) histogram.buckets.set(le, (histogram.buckets.get(le) ?? 0) + 1)
  }
  histogram.buckets.set('+Inf', (histogram.buckets.get('+Inf') ?? 0) + 1)
}

function histogramSnapshot(histogram) {
  const buckets = HISTOGRAM_BUCKETS_MS.map(le => ({ le, count: histogram.buckets.get(le) ?? 0 }))
  buckets.push({ le: '+Inf', count: histogram.buckets.get('+Inf') ?? 0 })
  return { count: histogram.count, sumMs: Math.round(histogram.sumMs), buckets }
}

function bumpCapped(map, key) {
  if (!map.has(key) && map.size >= MAX_LABEL_KEYS) key = 'other'
  map.set(key, (map.get(key) ?? 0) + 1)
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * Create the metrics registry.
 * @returns {object} Recorders, a snapshot assembler, and a Prometheus renderer.
 */
export function createMetricsRegistry() {
  const requestsByRouteStatus = new Map()
  const failuresByCode = new Map()
  const routeDurations = new Map()
  const allRequestDurations = createHistogram()
  const modelDurations = createHistogram()
  const modelQueueWaits = createHistogram()
  const modelFailuresByCode = new Map()
  let totalRequests = 0
  let abortedRequests = 0
  let modelRequests = 0
  let modelFailures = 0

  /**
   * Record one completed HTTP request.
   * @param {{route: string, method: string, status: number, durationMs: number, aborted?: boolean}} record - Transport outcome.
   */
  const recordRequest = ({ route, method, status, durationMs, aborted = false }) => {
    const label = `${method.toUpperCase()} ${route} ${aborted ? 'aborted' : String(status)}`
    bumpCapped(requestsByRouteStatus, label)
    totalRequests += 1
    if (aborted) abortedRequests += 1
    observeHistogram(allRequestDurations, durationMs)
    if (!routeDurations.has(route)) {
      if (routeDurations.size >= MAX_LABEL_KEYS) return
      routeDurations.set(route, createHistogram())
    }
    observeHistogram(routeDurations.get(route), durationMs)
  }

  /**
   * Record one classified failure.
   * @param {{code: string}} record - Stable error code from the error channel.
   */
  const recordFailure = ({ code }) => {
    bumpCapped(failuresByCode, code)
  }

  /**
   * Record one model request and its admission wait.
   * @param {{outcome: string, durationMs: number, queueWaitMs?: number}} record - Outcome code (`completed` or an error code) and timings.
   */
  const recordModelRequest = ({ outcome, durationMs, queueWaitMs }) => {
    modelRequests += 1
    observeHistogram(modelDurations, durationMs)
    if (Number.isFinite(queueWaitMs) && queueWaitMs >= 0) observeHistogram(modelQueueWaits, queueWaitMs)
    if (outcome !== 'completed') {
      modelFailures += 1
      bumpCapped(modelFailuresByCode, outcome)
    }
  }

  /**
   * Assemble a point-in-time snapshot.
   * @param {{startedAt: number, activeRequests: number, admission?: object, leases?: object, durable?: object, now?: number}} gauges - Live values owned by other controllers.
   * @returns {object} Versioned JSON snapshot with counters, histograms, and gauges.
   */
  const snapshot = ({ startedAt, activeRequests, admission, leases, durable, now = Date.now() }) => {
    let memory = {}
    try {
      const usage = process.memoryUsage()
      memory = { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, heapTotalBytes: usage.heapTotal }
    } catch {} // Memory reporting is optional evidence; counters still export without it.
    return {
      metricsVersion: 1,
      capturedAt: now,
      uptimeMs: Math.max(0, now - startedAt),
      process: memory,
      requests: {
        total: totalRequests,
        active: activeRequests,
        aborted: abortedRequests,
        byRouteStatus: mapToObject(requestsByRouteStatus),
        failuresByCode: mapToObject(failuresByCode),
        durationMs: histogramSnapshot(allRequestDurations),
        routes: Object.fromEntries([...routeDurations.entries()].map(([route, histogram]) => [route, histogramSnapshot(histogram)])),
      },
      model: {
        requests: modelRequests,
        failures: modelFailures,
        failuresByCode: mapToObject(modelFailuresByCode),
        durationMs: histogramSnapshot(modelDurations),
        queueWaitMs: histogramSnapshot(modelQueueWaits),
      },
      queue: admission === undefined ? null : {
        activeTurns: admission.activeTurns,
        queuedTurns: admission.queuedTurns,
        limits: admission.limits,
        mountedSessions: admission.mounts.active,
        counters: admission.counters,
      },
      leases: leases ?? null,
      durableTurns: durable ?? null,
    }
  }

  /**
   * Render a snapshot in Prometheus text exposition format.
   * @param {object} view - Snapshot produced by `snapshot()`.
   * @returns {string} Text suitable for a scrape endpoint.
   */
  const prometheus = view => {
    const lines = []
    const labelSet = pairs => (pairs.length === 0 ? '' : `{${pairs.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`)
    const counter = (name, help, labels, value) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name}${labelSet(labels)} ${value}`)
    }
    const gauge = (name, help, labels, value) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labelSet(labels)} ${value}`)
    }
    counter('dsh_browser_native_http_requests_total', 'Completed HTTP requests by route, method, and status.', [], view.requests.total)
    for (const [label, count] of Object.entries(view.requests.byRouteStatus)) {
      const [method, route, status] = label.split(' ')
      counter('dsh_browser_native_http_requests_by_route_total', 'Completed HTTP requests by route and outcome.', [['method', method], ['route', route], ['status', status]], count)
    }
    for (const [code, count] of Object.entries(view.requests.failuresByCode)) {
      counter('dsh_browser_native_failures_total', 'Classified backend failures by stable error code.', [['code', code]], count)
    }
    gauge('dsh_browser_native_active_requests', 'Requests currently held by the backend.', [], view.requests.active)
    for (const bucket of view.requests.durationMs.buckets) {
      counter('dsh_browser_native_http_request_duration_ms_bucket', 'HTTP request duration histogram.', [['le', bucket.le]], bucket.count)
    }
    counter('dsh_browser_native_http_request_duration_ms_sum', 'Sum of HTTP request durations in milliseconds.', [], view.requests.durationMs.sumMs)
    counter('dsh_browser_native_http_request_duration_ms_count', 'Observed HTTP request durations.', [], view.requests.durationMs.count)
    counter('dsh_browser_native_model_requests_total', 'Model requests issued through the backend.', [], view.model.requests)
    counter('dsh_browser_native_model_failures_total', 'Model requests that ended in an error.', [], view.model.failures)
    for (const [code, count] of Object.entries(view.model.failuresByCode)) {
      counter('dsh_browser_native_model_failures_by_code_total', 'Failed model requests by stable error code.', [['code', code]], count)
    }
    for (const bucket of view.model.durationMs.buckets) {
      counter('dsh_browser_native_model_request_duration_ms_bucket', 'Model request duration histogram.', [['le', bucket.le]], bucket.count)
    }
    for (const bucket of view.model.queueWaitMs.buckets) {
      counter('dsh_browser_native_model_queue_wait_ms_bucket', 'Admission queue wait histogram.', [['le', bucket.le]], bucket.count)
    }
    if (view.queue !== null) {
      gauge('dsh_browser_native_admission_active_turns', 'Model turns holding an admission slot.', [], view.queue.activeTurns)
      gauge('dsh_browser_native_admission_queued_turns', 'Model turns waiting for an admission slot.', [], view.queue.queuedTurns)
      gauge('dsh_browser_native_admission_mounted_sessions', 'Sessions holding a mount lease.', [], view.queue.mountedSessions)
      gauge('dsh_browser_native_admission_max_queue_wait_ms', 'Longest admission wait observed.', [], view.queue.counters.maxQueueWaitMs)
    }
    if (view.leases !== null) {
      gauge('dsh_browser_native_sessions_total', 'Loaded Sessions.', [], view.leases.sessions)
      gauge('dsh_browser_native_session_leases_held', 'Sessions whose owner lease has not expired.', [], view.leases.held)
      gauge('dsh_browser_native_session_leases_expired', 'Sessions whose owner lease expired without release.', [], view.leases.expired)
      gauge('dsh_browser_native_sessions_write_blocked', 'Sessions blocked pending backend recovery.', [], view.leases.writeBlocked)
    }
    if (view.durableTurns !== null) {
      gauge('dsh_browser_native_durable_turns_running', 'Durable turns currently executing.', [], view.durableTurns.running)
      gauge('dsh_browser_native_durable_turns_completed', 'Durable turns settled completed.', [], view.durableTurns.completed)
      gauge('dsh_browser_native_durable_turns_failed', 'Durable turns settled failed.', [], view.durableTurns.failed)
      gauge('dsh_browser_native_durable_turns_cancelled', 'Durable turns settled cancelled.', [], view.durableTurns.cancelled)
    }
    if (view.process.rssBytes !== undefined) {
      gauge('dsh_browser_native_process_rss_bytes', 'Resident set size of the backend process.', [], view.process.rssBytes)
      gauge('dsh_browser_native_process_heap_used_bytes', 'Used JS heap of the backend process.', [], view.process.heapUsedBytes)
    }
    gauge('dsh_browser_native_uptime_ms', 'Backend uptime in milliseconds.', [], view.uptimeMs)
    return `${lines.join('\n')}\n`
  }

  return { recordRequest, recordFailure, recordModelRequest, snapshot, prometheus }
}
