/**
 * Per-principal data export for hosted Browser-native deployments.
 *
 * The bundle carries every store that keyed the principal: Sessions with their
 * full event logs, Workspace identity and metadata, published attachment
 * bytes, the usage ledger entries, the derived cost report, and observability
 * access denials. `verifyPrincipalExport` re-derives every hash, count, and
 * ownership fact so a caller can reject a truncated or foreign bundle instead
 * of trusting the counts the exporter reported.
 *
 * @module principal-export
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildUsageReport } from './usage-report.mjs'

const EXPORT_VERSION = 1
const HASH_PATTERN = /^[a-f0-9]{64}$/

function digestOf(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Principal digest used for observability access-denial records. */
function principalDigest(principalId) {
  return digestOf(principalId).slice(0, 16)
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/** Every regular file below `directory`, as paths relative to it. */
async function walkFiles(directory, current = directory, files = []) {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) await walkFiles(directory, path, files)
    else if (entry.isFile()) files.push(path.slice(directory.length + 1))
  }
  return files
}

async function collectAttachments(dataDir, workspaceId) {
  const root = join(dataDir, 'attachments-v1', workspaceId)
  const attachments = []
  for (const relative of await walkFiles(root)) {
    const hash = relative.slice(relative.lastIndexOf('/') + 1)
    if (!HASH_PATTERN.test(hash)) throw new Error(`attachment export: unexpected file ${relative}`)
    const bytes = await readFile(join(root, relative))
    const sha256 = digestOf(bytes)
    if (sha256 !== hash) throw new Error(`attachment export: ${relative} does not match its hash`)
    attachments.push({
      hash,
      workspaceId,
      byteLength: bytes.byteLength,
      bytesBase64: bytes.toString('base64'),
    })
  }
  attachments.sort((left, right) => left.hash.localeCompare(right.hash))
  return attachments
}

async function collectWorkspaceBlobs(dataDir, workspace) {
  if (workspace === null || !Array.isArray(workspace.entries)) return []
  const hashes = new Set()
  for (const entry of workspace.entries) {
    if (entry?.kind === 'file' && HASH_PATTERN.test(entry.hash)) hashes.add(entry.hash)
  }
  const blobs = []
  for (const hash of [...hashes].sort()) {
    const bytes = await readFile(join(dataDir, 'workspace-v2', 'blobs', hash.slice(0, 2), hash))
    if (digestOf(bytes) !== hash) throw new Error(`workspace export: blob ${hash} does not match its hash`)
    blobs.push({ hash, byteLength: bytes.byteLength, bytesBase64: bytes.toString('base64') })
  }
  return blobs
}

/**
 * Build the export bundle for one principal.
 * @param options - Export inputs.
 * @param options.dataDir - Backend data directory.
 * @param options.principalId - Principal whose data is exported.
 * @param options.workspaceId - Workspace bound to that principal.
 * @param options.sessions - Durable Session records already filtered to the principal.
 * @param options.usage - Usage ledger entries already filtered to the principal and its retention window.
 * @param options.accessDenials - Observability records; only this principal's digest is kept.
 * @param options.pricing - Optional per-million-token prices for the cost report.
 * @param options.model - Model name recorded in the cost report.
 * @param options.now - Clock for `exportedAt` and the cost report.
 * @returns Export bundle whose `digest` covers every other field.
 */
export async function buildPrincipalExport({
  dataDir,
  principalId,
  workspaceId,
  sessions,
  usage,
  accessDenials = [],
  pricing,
  model,
  now = Date.now,
}) {
  if (typeof principalId !== 'string' || principalId.length === 0) throw new TypeError('principal export requires a principalId')
  const identity = { principalId, workspaceId }
  const workspace = workspaceId === undefined
    ? null
    : await readJson(join(dataDir, 'workspace-v2', 'workspaces', `${workspaceId}.json`), null)
  const attachments = workspaceId === undefined ? [] : await collectAttachments(dataDir, workspaceId)
  const workspaceBlobs = await collectWorkspaceBlobs(dataDir, workspace)
  const digest = principalDigest(principalId)
  const denied = accessDenials.filter(record => record?.principalDigest === digest)
  const counts = {
    sessions: sessions.length,
    sessionEvents: sessions.reduce((total, session) => total + (Array.isArray(session.events) ? session.events.length : 0), 0),
    attachments: attachments.length,
    attachmentBytes: attachments.reduce((total, attachment) => total + attachment.byteLength, 0),
    workspaceBlobs: workspaceBlobs.length,
    workspaceBytes: workspaceBlobs.reduce((total, blob) => total + blob.byteLength, 0),
    usageEntries: usage.length,
    accessDenials: denied.length,
  }
  const bundle = {
    version: EXPORT_VERSION,
    exportedAt: new Date(now()).toISOString(),
    principalId,
    workspaceId,
    identity,
    workspace,
    workspaceBlobs,
    sessions,
    attachments,
    usage,
    cost: buildUsageReport(usage, { pricing, model, now: now() }),
    accessDenials: denied,
    counts,
  }
  bundle.digest = digestOf(JSON.stringify(bundle))
  return bundle
}

/**
 * Re-derive the bundle's ownership, hashes, and counts.
 * @param bundle - Bundle produced by {@link buildPrincipalExport}.
 * @returns Nothing; throws when the bundle is incomplete or admits foreign data.
 */
export function verifyPrincipalExport(bundle) {
  const fail = reason => {
    throw new Error(`principal export verification failed: ${reason}`)
  }
  if (bundle?.version !== EXPORT_VERSION) fail('unknown bundle version')
  // The HTTP envelope adds `protocolVersion`; the digest covers bundle fields only.
  const { digest, protocolVersion: envelopeVersion, ...rest } = bundle
  if (digestOf(JSON.stringify(rest)) !== digest) fail('bundle digest does not match its contents')
  const principalId = bundle.principalId
  if (bundle.identity?.principalId !== principalId) fail('identity principal does not match the bundle')
  for (const session of bundle.sessions) {
    if (session?.principalId !== principalId) fail(`session ${session?.id} belongs to another principal`)
    if (session.id !== session.header?.id) fail(`session ${session.id} id does not match its header`)
  }
  for (const attachment of bundle.attachments) {
    const bytes = Buffer.from(attachment.bytesBase64, 'base64')
    if (bytes.byteLength !== attachment.byteLength) fail(`attachment ${attachment.hash} byte length mismatch`)
    if (digestOf(bytes) !== attachment.hash) fail(`attachment ${attachment.hash} content hash mismatch`)
  }
  for (const blob of bundle.workspaceBlobs ?? []) {
    const bytes = Buffer.from(blob.bytesBase64, 'base64')
    if (bytes.byteLength !== blob.byteLength) fail(`workspace blob ${blob.hash} byte length mismatch`)
    if (digestOf(bytes) !== blob.hash) fail(`workspace blob ${blob.hash} content hash mismatch`)
  }
  for (const entry of bundle.usage) {
    if (entry?.principalId !== principalId) fail('usage entry belongs to another principal')
  }
  const expected = {
    sessions: bundle.sessions.length,
    sessionEvents: bundle.sessions.reduce((total, session) => total + session.events.length, 0),
    attachments: bundle.attachments.length,
    attachmentBytes: bundle.attachments.reduce((total, attachment) => total + attachment.byteLength, 0),
    workspaceBlobs: (bundle.workspaceBlobs ?? []).length,
    workspaceBytes: (bundle.workspaceBlobs ?? []).reduce((total, blob) => total + blob.byteLength, 0),
    usageEntries: bundle.usage.length,
    accessDenials: bundle.accessDenials.length,
  }
  const declared = bundle.counts ?? {}
  for (const [key, value] of Object.entries(expected)) {
    if (declared[key] !== value) fail(`count ${key} is ${declared[key]} but the bundle holds ${value}`)
  }
  const totals = bundle.cost?.totals
  if (totals?.requests !== bundle.usage.length) fail('cost report request count does not match the usage ledger')
}
