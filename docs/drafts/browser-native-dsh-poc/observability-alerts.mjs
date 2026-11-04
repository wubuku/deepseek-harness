/**
 * Threshold alerts for the Browser-Native PoC backend.
 *
 * The evaluator watches three signals the backend already owns: the failure
 * share of recent HTTP requests, the admission queue depth, and the cumulative
 * provider cost. Each threshold is independently optional. An alert emits once
 * on entry and once on recovery, to stderr as a JSON line and optionally to a
 * webhook; evaluation never blocks or fails a request.
 */

import { buildUsageReport } from './usage-report.mjs'

const DEFAULT_INTERVAL_MS = 15_000
const DEFAULT_WINDOW_SIZE = 200
const WEBHOOK_TIMEOUT_MS = 2_000
const HISTORY_LIMIT = 32

/** Validate one threshold object and return its normalized fields. */
function normalizeFailureRate(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new TypeError('alerts.failureRate must be an object')
  const ratio = value.ratio
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new TypeError('alerts.failureRate.ratio must be a number from 0 through 1')
  }
  const minSamples = value.minSamples ?? 20
  if (!Number.isSafeInteger(minSamples) || minSamples < 1) {
    throw new TypeError('alerts.failureRate.minSamples must be a positive integer')
  }
  const windowSize = value.windowSize ?? Math.max(DEFAULT_WINDOW_SIZE, minSamples)
  if (!Number.isSafeInteger(windowSize) || windowSize < minSamples) {
    throw new TypeError('alerts.failureRate.windowSize must be an integer at least minSamples')
  }
  return { ratio, minSamples, windowSize }
}

/** Validate the queue depth threshold and return its normalized fields. */
function normalizeQueueBacklog(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new TypeError('alerts.queueBacklog must be an object')
  const queuedTurns = value.queuedTurns
  if (!Number.isSafeInteger(queuedTurns) || queuedTurns < 1) {
    throw new TypeError('alerts.queueBacklog.queuedTurns must be a positive integer')
  }
  return { queuedTurns }
}

/** Validate the webhook URL without resolving it. */
function normalizeWebhookUrl(value) {
  if (value === undefined) return undefined
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('alerts.webhookUrl must be an absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('alerts.webhookUrl must use http or https')
  }
  return url.href
}

/**
 * Validate the alert configuration supplied by a deployment.
 * @param config - Candidate `{ failureRate?, queueBacklog?, budgetUsd?, webhookUrl?, intervalMs? }`.
 * @returns Normalized configuration, or undefined when alerting is disabled.
 */
export function normalizeAlertConfig(config) {
  if (config === undefined) return undefined
  if (typeof config !== 'object' || config === null) throw new TypeError('alerts must be an object')
  const failureRate = normalizeFailureRate(config.failureRate)
  const queueBacklog = normalizeQueueBacklog(config.queueBacklog)
  let budgetUsd
  if (config.budgetUsd !== undefined) {
    if (typeof config.budgetUsd !== 'number' || !Number.isFinite(config.budgetUsd) || config.budgetUsd <= 0) {
      throw new TypeError('alerts.budgetUsd must be a positive number')
    }
    budgetUsd = config.budgetUsd
  }
  const webhookUrl = normalizeWebhookUrl(config.webhookUrl)
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError('alerts.intervalMs must be a positive integer')
  }
  if (failureRate === undefined && queueBacklog === undefined && budgetUsd === undefined) return undefined
  return { failureRate, queueBacklog, budgetUsd, webhookUrl, intervalMs }
}

/** Emit one event to stderr as a machine-readable line. */
function emitToStderr(event) {
  console.warn(`browser-native alert ${JSON.stringify(event)}`)
}

/** POST one event to the configured webhook; failures are reported, never thrown. */
async function postToWebhook(url, event) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    await response.body?.cancel()
    if (!response.ok) return `HTTP ${String(response.status)}`
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Create the alert evaluator.
 *
 * @param {object} options - Dependencies and configuration.
 * @param {object} [options.config] - Raw alert configuration.
 * @param {object} [options.pricing] - Normalized usage pricing; required by `budgetUsd`.
 * @param {() => object[]} [options.usage] - Current usage entries for the budget total.
 * @param {() => object|undefined} [options.queue] - Current admission snapshot.
 * @param {() => number} [options.now] - Clock used for event timestamps.
 * @param {(event: object) => void} [options.emit] - Sink for transition events.
 * @param {(url: string, event: object) => Promise<string|undefined>} [options.deliver] - Webhook delivery override.
 * @returns {object} Recorders, evaluation, lifecycle, and a snapshot.
 */
export function createAlertEvaluator(options = {}) {
  const config = normalizeAlertConfig(options.config)
  if (config?.budgetUsd !== undefined && options.pricing === undefined) {
    throw new TypeError('alerts.budgetUsd requires usagePricing')
  }
  const now = () => (options.now ?? Date.now)()
  const emit = options.emit ?? emitToStderr
  const deliver = options.deliver
    ?? (config?.webhookUrl === undefined ? undefined : (url, event) => postToWebhook(url, event))
  const usage = options.usage ?? (() => [])
  const queue = options.queue ?? (() => undefined)
  const windowSize = config?.failureRate?.windowSize ?? DEFAULT_WINDOW_SIZE
  const outcomes = []
  const active = new Map()
  const history = []
  let webhookFailures = 0
  let lastEvaluatedAt
  let timer

  const recordRequest = ({ status, aborted }) => {
    if (config?.failureRate === undefined) return
    outcomes.push(aborted === true || status >= 500)
    if (outcomes.length > windowSize) outcomes.splice(0, outcomes.length - windowSize)
  }

  const event = (type, alert, value, threshold, message) => ({
    type,
    alert,
    value,
    threshold,
    message,
    source: 'browser-native',
    at: new Date(now()).toISOString(),
  })

  const apply = events => (id, condition, value, threshold, message) => {
    const current = active.get(id)
    if (condition && current === undefined) {
      active.set(id, { since: new Date(now()).toISOString(), value, threshold })
      events.push(event('alert', id, value, threshold, message))
    } else if (condition) {
      current.value = value
    } else if (current !== undefined) {
      active.delete(id)
      events.push(event('recovery', id, value, threshold, message))
    }
  }

  /**
   * Evaluate all configured thresholds against the current backend state.
   * @returns {Promise<object[]>} Transitions produced by this evaluation.
   */
  const run = async () => {
    if (config === undefined) return []
    const events = []
    const transition = apply(events)
    if (config.failureRate !== undefined) {
      const failures = outcomes.reduce((count, failed) => count + (failed ? 1 : 0), 0)
      if (outcomes.length >= config.failureRate.minSamples) {
        const ratio = failures / outcomes.length
        transition(
          'failure-rate', ratio >= config.failureRate.ratio, ratio, config.failureRate.ratio,
          `${String(failures)} of ${String(outcomes.length)} recent requests failed`,
        )
      }
    }
    if (config.queueBacklog !== undefined) {
      const queuedTurns = queue()?.queuedTurns
      if (Number.isInteger(queuedTurns)) {
        transition(
          'queue-backlog', queuedTurns >= config.queueBacklog.queuedTurns, queuedTurns, config.queueBacklog.queuedTurns,
          `${String(queuedTurns)} model turns are waiting for an admission slot`,
        )
      }
    }
    if (config.budgetUsd !== undefined) {
      const costUsd = buildUsageReport(usage(), { pricing: options.pricing }).totals.costUsd
      transition(
        'budget', costUsd >= config.budgetUsd, costUsd, config.budgetUsd,
        `$${costUsd.toFixed(6)} provider cost reached the $${String(config.budgetUsd)} budget`,
      )
    }
    lastEvaluatedAt = new Date(now()).toISOString()
    for (const transitionEvent of events) {
      history.push(transitionEvent)
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
      emit(transitionEvent)
      if (deliver !== undefined) {
        const failure = await deliver(config.webhookUrl, transitionEvent)
        if (failure !== undefined) {
          webhookFailures += 1
          console.error(`browser-native alert webhook failed: ${failure}`)
        }
      }
    }
    return events
  }

  /** Start periodic evaluation; the timer does not keep the process alive. */
  const start = () => {
    if (config === undefined || timer !== undefined) return
    timer = setInterval(() => { void run() }, config.intervalMs)
    timer.unref()
  }

  /** Stop periodic evaluation. */
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  /**
   * Report configured thresholds, the failure window, active alerts, and recent transitions.
   * @returns {object} Current alert state.
   */
  const snapshot = () => ({
    alertsVersion: 1,
    enabled: config !== undefined,
    evaluatedAt: lastEvaluatedAt ?? null,
    thresholds: config === undefined ? null : {
      failureRate: config.failureRate ?? null,
      queueBacklog: config.queueBacklog ?? null,
      budgetUsd: config.budgetUsd ?? null,
      webhookConfigured: config.webhookUrl !== undefined,
      intervalMs: config.intervalMs,
    },
    window: {
      samples: outcomes.length,
      failures: outcomes.reduce((count, failed) => count + (failed ? 1 : 0), 0),
    },
    active: [...active.entries()].map(([alert, state]) => ({ alert, ...state })),
    history: [...history],
    webhookFailures,
  })

  return { recordRequest, run, start, stop, snapshot }
}
