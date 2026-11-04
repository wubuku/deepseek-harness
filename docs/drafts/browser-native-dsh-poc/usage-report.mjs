/**
 * Tenant cost aggregation for provider-reported usage.
 *
 * The report only sums usage entries the backend already recorded from provider
 * responses; it never estimates tokens. Cost is derived from configured per-
 * million rates at report time, and CSV export carries one row per principal and
 * Session pair.
 */

/**
 * Validate the configured price pair.
 * @param pricing - Candidate `{ inputUsdPer1M, outputUsdPer1M }` or undefined.
 * @returns Normalized rates, or undefined when cost reporting is disabled.
 */
export function normalizeUsagePricing(pricing) {
  if (pricing === undefined) return undefined
  const rates = ['inputUsdPer1M', 'outputUsdPer1M']
  for (const name of rates) {
    const value = pricing[name]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a finite non-negative number`)
    }
  }
  return { inputUsdPer1M: pricing.inputUsdPer1M, outputUsdPer1M: pricing.outputUsdPer1M }
}

/**
 * Price one usage entry using provider-reported token counts.
 * @param entry - Usage entry carrying input and output token counts.
 * @param pricing - Normalized price pair, or undefined when costing is disabled.
 * @returns Cost in USD, or undefined without pricing.
 */
function costOf(entry, pricing) {
  if (pricing === undefined) return undefined
  return (entry.inputTokens / 1_000_000) * pricing.inputUsdPer1M
    + (entry.outputTokens / 1_000_000) * pricing.outputUsdPer1M
}

/** Create a zeroed accumulator. */
function emptyTotals() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
}

/** Add one entry to an accumulator. */
function addTo(accumulator, entry, pricing) {
  accumulator.requests += 1
  accumulator.inputTokens += entry.inputTokens
  accumulator.outputTokens += entry.outputTokens
  accumulator.totalTokens += entry.inputTokens + entry.outputTokens
  const cost = costOf(entry, pricing)
  if (cost !== undefined) accumulator.costUsd += cost
}

/**
 * Aggregate provider-reported usage by principal and Session.
 * @param entries - Recorded usage entries with `inputTokens`, `outputTokens`, `sessionId`, and optional `principalId`.
 * @param options - `pricing` (normalized rates or undefined), `model`, and `now` for deterministic output.
 * @returns Report with totals, per-principal totals, and per-Session rows.
 */
export function buildUsageReport(entries, options = {}) {
  const pricing = options.pricing
  const generatedAt = new Date(options.now ?? Date.now()).toISOString()
  const principals = new Map()
  const totals = emptyTotals()
  for (const entry of entries) {
    const principalId = typeof entry.principalId === 'string' && entry.principalId.length > 0
      ? entry.principalId : null
    let principal = principals.get(principalId)
    if (principal === undefined) {
      principal = { ...emptyTotals(), principalId, sessions: new Map() }
      principals.set(principalId, principal)
    }
    const sessionKey = typeof entry.sessionId === 'string' && entry.sessionId.length > 0
      ? entry.sessionId : null
    let session = principal.sessions.get(sessionKey)
    if (session === undefined) {
      session = { ...emptyTotals(), sessionId: sessionKey }
      principal.sessions.set(sessionKey, session)
    }
    addTo(totals, entry, pricing)
    addTo(principal, entry, pricing)
    addTo(session, entry, pricing)
  }
  const serialize = accumulator => ({
    requests: accumulator.requests,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    totalTokens: accumulator.totalTokens,
    costUsd: pricing === undefined ? null : accumulator.costUsd,
  })
  const principalRows = [...principals.values()].map(principal => ({
    principalId: principal.principalId,
    ...serialize(principal),
    sessions: [...principal.sessions.values()].map(session => ({
      sessionId: session.sessionId,
      ...serialize(session),
    })),
  })).sort((left, right) => String(left.principalId).localeCompare(String(right.principalId)))
  return {
    generatedAt,
    model: options.model ?? null,
    pricing: pricing ?? null,
    totals: serialize(totals),
    principals: principalRows,
  }
}

/** Quote one CSV field when it contains a delimiter, quote, or line break. */
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Render the report as CSV with one row per principal and Session.
 * @param report - Report returned by {@link buildUsageReport}.
 * @returns CSV text with a trailing newline.
 */
export function usageReportCsv(report) {
  const lines = ['principal_id,session_id,requests,input_tokens,output_tokens,total_tokens,cost_usd']
  for (const principal of report.principals) {
    for (const session of principal.sessions) {
      lines.push([
        csvField(principal.principalId),
        csvField(session.sessionId),
        String(session.requests),
        String(session.inputTokens),
        String(session.outputTokens),
        String(session.totalTokens),
        session.costUsd === null ? '' : session.costUsd.toFixed(6),
      ].join(','))
    }
  }
  return `${lines.join('\n')}\n`
}
