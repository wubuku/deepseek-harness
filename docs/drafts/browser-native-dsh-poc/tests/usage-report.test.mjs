/**
 * Tenant cost report contract.
 *
 * Checks token aggregation by principal and Session, price arithmetic, the
 * unpriced mode, unattributed entries, and CSV rendering without starting a
 * server.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUsageReport, normalizeUsagePricing, usageReportCsv } from '../usage-report.mjs'

const PRICING = normalizeUsagePricing({ inputUsdPer1M: 1.25, outputUsdPer1M: 2.5 })

/** Compare floating costs without depending on binary representation details. */
function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${String(actual)} must be within 1e-9 of ${String(expected)}`)
}

test('pricing validation rejects missing and negative rates', () => {
  assert.equal(normalizeUsagePricing(undefined), undefined)
  assert.deepEqual(normalizeUsagePricing({ inputUsdPer1M: 0, outputUsdPer1M: 0 }), { inputUsdPer1M: 0, outputUsdPer1M: 0 })
  assert.throws(() => normalizeUsagePricing({ inputUsdPer1M: -1, outputUsdPer1M: 0 }), /inputUsdPer1M/)
  assert.throws(() => normalizeUsagePricing({ inputUsdPer1M: Number.NaN, outputUsdPer1M: 0 }), /inputUsdPer1M/)
  assert.throws(() => normalizeUsagePricing({ inputUsdPer1M: 0 }), /outputUsdPer1M/)
})

test('aggregates provider usage by principal and Session with priced cost', () => {
  const report = buildUsageReport([
    { principalId: 'p1', sessionId: 's1', inputTokens: 1_000, outputTokens: 200 },
    { principalId: 'p1', sessionId: 's1', inputTokens: 400, outputTokens: 100 },
    { principalId: 'p1', sessionId: 's2', inputTokens: 1_000, outputTokens: 0 },
    { principalId: 'p2', sessionId: 's3', inputTokens: 0, outputTokens: 800 },
  ], { pricing: PRICING, model: 'priced-model', now: Date.UTC(2026, 10, 4, 6, 0, 0) })
  assert.equal(report.generatedAt, '2026-11-04T06:00:00.000Z')
  assert.equal(report.model, 'priced-model')
  assert.equal(report.totals.requests, 4)
  assert.equal(report.totals.inputTokens, 2_400)
  assert.equal(report.totals.outputTokens, 1_100)
  assert.equal(report.totals.totalTokens, 3_500)
  // 2400 input * 1.25/M + 1100 output * 2.5/M
  closeTo(report.totals.costUsd, 0.00575)
  const p1 = report.principals.find(principal => principal.principalId === 'p1')
  assert.ok(p1)
  assert.equal(p1.requests, 3)
  assert.equal(p1.totalTokens, 2_700)
  closeTo(p1.costUsd, (2_400 / 1_000_000) * 1.25 + (300 / 1_000_000) * 2.5)
  assert.deepEqual(p1.sessions.map(session => session.sessionId), ['s1', 's2'])
  assert.equal(p1.sessions[0].requests, 2)
  assert.equal(p1.sessions[0].totalTokens, 1_700)
})

test('keeps tokens but reports no cost when pricing is disabled', () => {
  const report = buildUsageReport([
    { principalId: 'p1', sessionId: 's1', inputTokens: 100, outputTokens: 50 },
  ], { now: 0 })
  assert.equal(report.pricing, null)
  assert.equal(report.totals.totalTokens, 150)
  assert.equal(report.totals.costUsd, null)
  assert.equal(report.principals[0].sessions[0].costUsd, null)
})

test('groups entries without a principal or Session instead of dropping them', () => {
  const report = buildUsageReport([
    { inputTokens: 10, outputTokens: 20 },
  ], { pricing: PRICING, now: 0 })
  assert.equal(report.totals.requests, 1)
  assert.equal(report.principals.length, 1)
  assert.equal(report.principals[0].principalId, null)
  assert.equal(report.principals[0].sessions[0].sessionId, null)
})

test('renders one CSV row per principal and Session pair', () => {
  const report = buildUsageReport([
    { principalId: 'p1', sessionId: 's1', inputTokens: 1_000, outputTokens: 200 },
    { principalId: 'p1', sessionId: 's2', inputTokens: 1_000, outputTokens: 0 },
    { principalId: 'p2', sessionId: 's3', inputTokens: 0, outputTokens: 800 },
    { inputTokens: 5, outputTokens: 5 },
  ], { pricing: PRICING, now: 0 })
  const csv = usageReportCsv(report)
  const rows = csv.trimEnd().split('\n')
  assert.equal(rows[0], 'principal_id,session_id,requests,input_tokens,output_tokens,total_tokens,cost_usd')
  assert.equal(rows.length, 5)
  assert.ok(rows.includes('p1,s1,1,1000,200,1200,0.001750'))
  assert.ok(rows.includes('p2,s3,1,0,800,800,0.002000'))
  assert.ok(rows.includes(',,1,5,5,10,0.000019'))
})
