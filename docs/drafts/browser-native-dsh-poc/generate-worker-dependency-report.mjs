#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODULE_PROXIES,
  MODULE_PROXY_PREFIXES,
  REPLACED_EXTERNAL_PACKAGES,
} from '../../../packages/experimental/webworker-runtime/lib/index.js'
import { packRepositoryImage } from '../../../packages/experimental/webworker-packer/lib/index.js'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../../..')
const outputPath = resolve(process.argv[2] ?? resolve(scriptDirectory, 'worker-dependency-closure-report.json'))
const packed = packRepositoryImage(repoRoot, 'web')

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function proxyPathFor(specifier) {
  const exact = MODULE_PROXIES[specifier] ?? MODULE_PROXIES[`node:${specifier}`]
  if (exact !== undefined) return exact
  const prefix = Object.keys(MODULE_PROXY_PREFIXES)
    .filter(candidate => specifier.startsWith(candidate))
    .sort((left, right) => right.length - left.length)[0]
  return prefix === undefined ? undefined : MODULE_PROXY_PREFIXES[prefix]
}

function classify(request) {
  if (request.resolution === 'image') return 'image-module'
  if (request.resolution === 'unresolved-external') {
    if (isBuiltin(request.specifier)) return 'unresolved-node-builtin'
    return request.requestKind === 'meta-resolve' ? 'unresolved-meta-resolve' : 'unresolved-external'
  }
  const proxyPath = proxyPathFor(request.specifier)
  if (proxyPath === undefined) return 'unclassified-worker-static'
  if (proxyPath.includes('/builtin_modules/implemented/')) return 'implemented-builtin-module'
  if (proxyPath.includes('/builtin_modules/mock/')) return 'structural-builtin-stub'
  if (proxyPath.includes('/external_packages/')) return 'external-replacement'
  return 'unclassified-worker-static'
}

const requests = packed.moduleRequests.map(request => ({ ...request, classification: classify(request) }))
const unclassified = requests.filter(request => request.classification === 'unclassified-worker-static')
if (packed.missing.length > 0 || unclassified.length > 0) {
  throw new Error(`Worker dependency report refused: missing=${packed.missing.length}, unclassified=${unclassified.length}`)
}

const counts = Object.fromEntries([...new Set(requests.map(request => request.classification))]
  .sort()
  .map(classification => [classification,
    requests.filter(request => request.classification === classification).length]))
const staticProxies = [...new Map(requests
  .filter(request => request.resolution === 'worker-static')
  .map(request => [request.specifier, {
    specifier: request.specifier,
    proxyPath: proxyPathFor(request.specifier),
    classification: request.classification,
      importers: [...new Set(requests.filter(candidate => candidate.specifier === request.specifier)
        .map(candidate => candidate.importer))].sort(compareStrings),
  }])).values()].sort((left, right) => compareStrings(left.specifier, right.specifier))

const replacedExternalPackages = [...REPLACED_EXTERNAL_PACKAGES].sort(compareStrings)

const report = {
  reportVersion: 1,
  profile: 'web',
  wrapperContract: packed.contract,
  scope: {
    roots: 'Worker assembly seeds plus every non-wildcard runtime export of each workspace package materialized by the web profile roster and declared config-tree roster inputs.',
    meaning: 'A conservative pack-time module-request closure, not the configured Cordis activation graph, eager module-evaluation trace, or proof that a conditional branch executes.',
    requestKinds: 'module records import, re-export, supported literal dynamic import/require, and recognized createRequire requests; meta-resolve records import.meta.resolve URL mapping requests.',
  },
  image: {
    javascriptEntries: packed.javascriptEntries,
    workspacePackages: packed.workspacePackages,
    missingPackages: packed.missing,
    droppedJavascriptEntries: packed.droppedJavascriptEntries,
  },
  summary: {
    requestCount: requests.length,
    classifications: counts,
    unresolvedExternalRequests: packed.unresolvedExternalRequests.length,
    replacedExternalPackages,
  },
  staticProxies,
  requests,
  interpretation: [
    'image-module means the request resolves to a module included in the packed Worker image; it does not establish that every exported API is supported.',
    'implemented-builtin-module means the proxy path is under the runtime implemented directory; member-level Node compatibility still requires behavioral tests.',
    'structural-builtin-stub and external-replacement identify runtime substitutes, not equivalent host behavior.',
    'unresolved external and meta-resolve requests remain explicit; they can fail if an execution path reaches them.',
    'the graph roots include every materialized workspace package runtime export, including exports not activated by the composed web profile; it is a conservative packaging closure, not a profile boot trace.',
    'the graph covers packer-recognized requests, not computed runtime specifiers, all conditional branches, or dynamic execution reachability.',
  ],
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({
  result: 'passed',
  profile: report.profile,
  wrapperContract: report.wrapperContract,
  imageModules: report.image.javascriptEntries,
  requestCount: report.summary.requestCount,
  classifications: report.summary.classifications,
  unresolvedExternalRequests: report.summary.unresolvedExternalRequests,
  reportPath: outputPath,
})}\n`)
