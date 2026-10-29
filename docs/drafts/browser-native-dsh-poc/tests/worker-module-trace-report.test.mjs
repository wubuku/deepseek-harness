import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeWorkerModuleTrace } from './worker-module-trace-report.mjs'

test('reconciles VFS importer paths with packer image paths and reports runtime-only edges', () => {
  const report = summarizeWorkerModuleTrace({
    browser: 'chrome',
    scenario: 'scripted-worker-tool',
    trace: {
      droppedEvents: 0,
      events: [
        { type: 'request', importer: '/dsh/node_modules/pkg/index.js', specifier: './dep.js', resolution: 'file' },
        { type: 'request', importer: '/dsh/node_modules/pkg/index.js', specifier: 'dynamic-name', resolution: 'file' },
        { type: 'load', importer: '/dsh/node_modules/pkg/index.js', target: '/dsh/node_modules/pkg/dep.js', moduleKind: 'commonjs', outcome: 'evaluated' },
      ],
    },
    staticReport: {
      requests: [
        { importer: 'node_modules/pkg/index.js', specifier: './dep.js', resolution: 'image' },
        { importer: 'node_modules/pkg/index.js', specifier: 'not-loaded', resolution: 'unresolved-external' },
      ],
    },
  })

  assert.equal(report.trace.uniqueRequestEdgeCount, 2)
  assert.equal(report.staticGraph.matchedRuntimeEdgeCount, 1)
  assert.deepEqual(report.staticGraph.unmatchedRuntimeCategories, { 'image-runtime-only': 1 })
  assert.deepEqual(report.staticGraph.unmatchedRuntimeExamples['image-runtime-only'], [
    { importer: 'node_modules/pkg/index.js', specifier: 'dynamic-name' },
  ])
  assert.equal(report.staticGraph.observedUnresolvedStaticGraphEdgeCount, 0)
})

test('rejects malformed trace input instead of silently omitting records', () => {
  assert.throws(() => summarizeWorkerModuleTrace({
    browser: 'chrome',
    scenario: 'invalid',
    trace: { events: [{ type: 'request', importer: '/dsh/pkg.js' }] },
    staticReport: { requests: [] },
  }), /invalid request event/)
})
