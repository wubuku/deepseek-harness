/**
 * One-source budget configuration.
 *
 * Checks that the backend reader rejects partial or invalid environments and
 * that the profile mapping produces exactly the values the backend publishes,
 * so one edited environment record reaches both sides unchanged.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BUDGET_ENV, readBudgetLimitsFromEnv } from '../budget-config.mjs'

const ONE_PLACE = {
  [BUDGET_ENV.sessionTokens]: '12000',
  [BUDGET_ENV.tenantTokens]: '24000',
  [BUDGET_ENV.tenantId]: 'poc-tenant',
}

test('an unset token budget leaves both sides disabled', () => {
  assert.equal(readBudgetLimitsFromEnv({}), undefined)
})

test('a partial token budget fails instead of half-configuring the plugin', () => {
  assert.throws(() => readBudgetLimitsFromEnv({ [BUDGET_ENV.sessionTokens]: '12000' }),
    /DSH_POC_SESSION_TOKEN_BUDGET and DSH_POC_TENANT_TOKEN_BUDGET must be set together/)
  assert.throws(() => readBudgetLimitsFromEnv({ [BUDGET_ENV.tenantTokens]: '24000' }),
    /DSH_POC_SESSION_TOKEN_BUDGET and DSH_POC_TENANT_TOKEN_BUDGET must be set together/)
})

test('invalid or non-positive limits fail at the environment name', () => {
  assert.throws(() => readBudgetLimitsFromEnv({ ...ONE_PLACE, [BUDGET_ENV.sessionTokens]: '0' }),
    /DSH_POC_SESSION_TOKEN_BUDGET must be a positive safe integer/)
  assert.throws(() => readBudgetLimitsFromEnv({ ...ONE_PLACE, [BUDGET_ENV.tenantTokens]: '1.5' }),
    /DSH_POC_TENANT_TOKEN_BUDGET must be a positive safe integer/)
  assert.throws(() => readBudgetLimitsFromEnv({ ...ONE_PLACE, [BUDGET_ENV.warnRatio]: '1.5' }),
    /warnRatio/)
})

test('the one environment record reaches the backend unchanged', () => {
  assert.deepEqual(readBudgetLimitsFromEnv(ONE_PLACE), {
    sessionTokens: 12_000,
    tenantTokens: 24_000,
    tenantId: 'poc-tenant',
    warnRatio: 0.8,
  })
})
