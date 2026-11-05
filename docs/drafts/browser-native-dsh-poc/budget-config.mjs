/**
 * One budget configuration for the backend snapshot and the Worker profile plugin.
 *
 * The backend reads the limits once, from the hosted environment or an explicit
 * `budgetLimits` option, and publishes them through
 * `GET /api/browser-native/config`. A mounted Worker budget plugin adopts that
 * payload, so the page and the request guard cannot run on different limits. An
 * image whose profile mounts the plugin declares that requirement, and the
 * runtime probe refuses startup when the published payload is missing.
 */
import { normalizeBudgetLimits } from './usage-report.mjs'

/** Environment names read by hosted deployments and validation runners. */
export const BUDGET_ENV = Object.freeze({
  sessionTokens: 'DSH_POC_SESSION_TOKEN_BUDGET',
  tenantTokens: 'DSH_POC_TENANT_TOKEN_BUDGET',
  tenantId: 'DSH_POC_TENANT_ID',
  warnRatio: 'DSH_POC_BUDGET_WARN_RATIO',
})

/**
 * Parse one positive integer environment value.
 * @param {string} name - Environment name named in the failure.
 * @param {string} raw - Raw value.
 * @returns {number} The parsed integer.
 */
function positiveIntegerEnv(name, raw) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

/**
 * Read the shared limits from one environment record.
 * @param {Record<string, string | undefined>} [environment] - Hosted environment or a test stand-in.
 * @returns {object | undefined} Normalized limits, or undefined when the budget is disabled.
 */
export function readBudgetLimitsFromEnv(environment = process.env) {
  const session = environment[BUDGET_ENV.sessionTokens] || undefined
  const tenant = environment[BUDGET_ENV.tenantTokens] || undefined
  if (session === undefined && tenant === undefined) return undefined
  if (session === undefined || tenant === undefined) {
    throw new Error(`${BUDGET_ENV.sessionTokens} and ${BUDGET_ENV.tenantTokens} must be set together`)
  }
  const tenantId = environment[BUDGET_ENV.tenantId] || undefined
  const warnRatio = environment[BUDGET_ENV.warnRatio] || undefined
  return normalizeBudgetLimits({
    sessionTokens: positiveIntegerEnv(BUDGET_ENV.sessionTokens, session),
    tenantTokens: positiveIntegerEnv(BUDGET_ENV.tenantTokens, tenant),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(warnRatio === undefined ? {} : { warnRatio: Number(warnRatio) }),
  })
}
