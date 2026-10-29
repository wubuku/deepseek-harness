function normalizeImporter(importer) {
  return importer === '/dsh' ? '' : importer.startsWith('/dsh/') ? importer.slice('/dsh/'.length) : importer
}

function edgeKey(importer, specifier) {
  return `${normalizeImporter(importer)}\u0000${specifier}`
}

function sortedCounts(values) {
  return Object.fromEntries([...values].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

function compareEdges(left, right) {
  const leftKey = edgeKey(left.importer, left.specifier)
  const rightKey = edgeKey(right.importer, right.specifier)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

function unmatchedCategory(importer) {
  if (importer === '' || importer === '/') return 'worker-bootstrap'
  if (importer.startsWith('home/')) return 'home-overlay'
  if (importer.startsWith('node_modules/')) return 'image-runtime-only'
  return 'other-vfs-path'
}

/**
 * Compare a bounded Worker trace with the packer's conservative request graph.
 * @param {{ trace: object, staticReport: object, browser: string, scenario: string }} input - Trace and static report.
 * @returns {object} Content-free counts and bounded module-edge examples.
 */
export function summarizeWorkerModuleTrace({ trace, staticReport, browser, scenario }) {
  if (!Array.isArray(trace?.events) || !Array.isArray(staticReport?.requests)) {
    throw new TypeError('module trace report needs Worker events and packer requests')
  }

  const staticByEdge = new Map(staticReport.requests.map(request => [edgeKey(request.importer, request.specifier), request]))
  const staticEdges = new Set(staticByEdge.keys())
  const staticUnresolved = staticReport.requests.filter(request => request.resolution === 'unresolved-external')
  const runtimeRequests = trace.events.filter(event => event.type === 'request')
  const runtimeLoads = trace.events.filter(event => event.type === 'load')
  const runtimeEdges = new Map()
  const runtimeResolutionsByEdge = new Map()
  const runtimeUnresolvedEdges = new Map()
  const runtimeResolutionCounts = new Map()
  const runtimeLoadCounts = new Map()

  for (const event of runtimeRequests) {
    if (typeof event.importer !== 'string' || typeof event.specifier !== 'string'
      || !['static', 'file', 'unresolved'].includes(event.resolution)) {
      throw new TypeError('module trace report contains an invalid request event')
    }
    const key = edgeKey(event.importer, event.specifier)
    runtimeEdges.set(key, { importer: normalizeImporter(event.importer), specifier: event.specifier })
    const resolutions = runtimeResolutionsByEdge.get(key) ?? new Set()
    resolutions.add(event.resolution)
    runtimeResolutionsByEdge.set(key, resolutions)
    if (event.resolution === 'unresolved') runtimeUnresolvedEdges.set(key, runtimeEdges.get(key))
    runtimeResolutionCounts.set(event.resolution, (runtimeResolutionCounts.get(event.resolution) ?? 0) + 1)
  }

  for (const event of runtimeLoads) {
    if (typeof event.target !== 'string' || typeof event.outcome !== 'string') {
      throw new TypeError('module trace report contains an invalid load event')
    }
    const key = `${event.moduleKind}:${event.outcome}`
    runtimeLoadCounts.set(key, (runtimeLoadCounts.get(key) ?? 0) + 1)
  }

  const unmatchedRuntimeEdges = [...runtimeEdges.entries()]
    .filter(([key]) => !staticEdges.has(key))
    .map(([, edge]) => edge)
    .sort(compareEdges)
  const unmatchedByCategory = new Map()
  for (const edge of unmatchedRuntimeEdges) {
    const category = unmatchedCategory(edge.importer)
    const edges = unmatchedByCategory.get(category) ?? []
    edges.push(edge)
    unmatchedByCategory.set(category, edges)
  }
  const resolutionDifferences = []
  for (const [key, resolutions] of runtimeResolutionsByEdge) {
    const staticRequest = staticByEdge.get(key)
    if (staticRequest === undefined) continue
    const expected = {
      image: 'file',
      'worker-static': 'static',
      'unresolved-external': 'unresolved',
    }[staticRequest.resolution]
    if (expected === undefined || [...resolutions].some(resolution => resolution !== expected)) {
      resolutionDifferences.push({
        importer: staticRequest.importer,
        specifier: staticRequest.specifier,
        staticResolution: staticRequest.resolution,
        runtimeResolutions: [...resolutions].sort(),
      })
    }
  }
  resolutionDifferences.sort(compareEdges)
  const runtimeEdgeKeys = new Set(runtimeEdges.keys())
  const observedStaticUnresolved = staticUnresolved
    .filter(request => runtimeEdgeKeys.has(edgeKey(request.importer, request.specifier)))
    .map(request => ({
      importer: request.importer,
      specifier: request.specifier,
      runtimeResolutions: [...(runtimeResolutionsByEdge.get(edgeKey(request.importer, request.specifier)) ?? [])].sort(),
    }))
    .sort(compareEdges)
  const runtimeUnresolvedExamples = [...runtimeUnresolvedEdges.values()].sort(compareEdges)

  return {
    reportVersion: 1,
    browser,
    scenario,
    trace: {
      eventCount: trace.events.length,
      droppedEvents: trace.droppedEvents,
      requestEventCount: runtimeRequests.length,
      uniqueRequestEdgeCount: runtimeEdges.size,
      resolutionCounts: sortedCounts(runtimeResolutionCounts),
      unresolvedUniqueEdgeCount: runtimeUnresolvedEdges.size,
      unresolvedExamples: runtimeUnresolvedExamples.slice(0, 20),
      loadEventCount: runtimeLoads.length,
      loadCounts: sortedCounts(runtimeLoadCounts),
    },
    staticGraph: {
      requestCount: staticReport.requests.length,
      uniqueEdgeCount: staticEdges.size,
      matchedRuntimeEdgeCount: runtimeEdges.size - unmatchedRuntimeEdges.length,
      unmatchedRuntimeEdgeCount: unmatchedRuntimeEdges.length,
      unmatchedRuntimeCategories: sortedCounts(new Map([...unmatchedByCategory].map(([key, edges]) => [key, edges.length]))),
      unmatchedRuntimeExamples: Object.fromEntries([...unmatchedByCategory]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([category, edges]) => [category, edges.slice(0, 10)])),
      resolutionDifferenceCount: resolutionDifferences.length,
      resolutionDifferenceExamples: resolutionDifferences.slice(0, 20),
      unresolvedStaticGraphRequestCount: staticUnresolved.length,
      observedUnresolvedStaticGraphEdgeCount: observedStaticUnresolved.length,
      observedUnresolvedStaticGraphExamples: observedStaticUnresolved.slice(0, 20),
    },
    interpretation: 'Module identifiers only; not module-content, Node-conformance, profile-activation, or full dynamic-reachability evidence.',
  }
}
