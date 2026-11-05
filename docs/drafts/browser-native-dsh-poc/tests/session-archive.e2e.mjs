/**
 * Archived Session end-to-end: inactive Sessions move to compressed cold
 * storage, startup stops parsing their events, list still finds them, opening
 * and export decompress on demand together with their attachment bytes, the
 * audit and cost ledgers stay unchanged, and an accidentally deleted active
 * file can be restored from the archive.
 *
 *   node --expose-gc docs/drafts/browser-native-dsh-poc/tests/session-archive.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, test } from 'node:test'
import { createBrowserNativeV2Server, FormalSessionStore } from '../backend-v2.mjs'
import { archiveFilePath } from '../session-archive.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'

const TOTAL = 300
const ARCHIVED = 250
const ACTIVE = TOTAL - ARCHIVED
const EVENTS = 50
const LEGACY_AT = 1_700_000_000_000
const MiB = 1024 * 1024

const directories = []
const remember = async path => {
  const directory = await mkdtemp(join(tmpdir(), path))
  directories.push(directory)
  return directory
}

after(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

const protocol = () => ({ protocolVersion: 1, requestId: randomUUID() })

async function collectGarbage() {
  globalThis.gc?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  globalThis.gc?.()
}

async function call(origin, cookie, path, body, method) {
  const response = await fetch(`${origin}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

async function start(dataDir) {
  const app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted', durableTurnTimeoutMs: 120_000 })
  const origin = await app.listen()
  return { app, origin }
}

async function newIdentity(origin, app) {
  const known = new Set(app.workspaces.identities.keys())
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const principalId = [...app.workspaces.identities.keys()].find(key => !known.has(key))
  assert.equal(typeof principalId, 'string')
  const cookie = `dsh-browser-native-principal=${principalId}; dsh-browser-native-session-principal=${principalId}`
  return { principalId, cookie, workspaceId: (await response.json()).workspaceId }
}

function sessionRecord(index, principalId, attachmentHash) {
  const id = `archive-${String(index).padStart(4, '0')}`
  const events = Array.from({ length: EVENTS }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: seq === 0
      ? { content: [{ type: 'file', attachment: { attachmentId: `sha256:${attachmentHash}`, name: 'evidence.txt' } }] }
      : { content: `session ${id} event ${String(seq)} ${'x'.repeat(120)}` },
    at: '2026-11-05T00:00:00.000Z',
  }))
  return {
    id,
    principalId,
    header: { id, version: 4, createdAt: LEGACY_AT, cwd: '/workspace' },
    inheritedEventCount: 0,
    events,
    durableThroughSeq: events.length - 1,
    ownerEpoch: 0,
    handoffs: {},
  }
}

async function writeSessions(dataDir, principalId, attachmentHash) {
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  const legacy = new Date(LEGACY_AT)
  for (let start = 0; start < TOTAL; start += 50) {
    const batch = []
    for (let index = start; index < Math.min(start + 50, TOTAL); index += 1) {
      const path = join(dataDir, 'sessions', `archive-${String(index).padStart(4, '0')}.json`)
      batch.push(writeFile(path, `${JSON.stringify(sessionRecord(index, principalId, attachmentHash))}\n`)
        .then(() => utimes(path, legacy, legacy)))
    }
    await Promise.all(batch)
  }
}

async function listAll(origin, cookie) {
  const snapshots = []
  const items = []
  let cursor
  for (;;) {
    const page = await call(origin, cookie, '/api/browser-native/session/list', {
      ...protocol(), limit: 100, ...(cursor === undefined ? {} : { cursor }),
    })
    assert.equal(page.status, 200)
    snapshots.push(...page.body.snapshots)
    items.push(...page.body.items)
    if (page.body.hasMore !== true) return { snapshots, items }
    cursor = page.body.nextCursor
  }
}

async function measureStoreLoad(dataDir) {
  await collectGarbage()
  const before = process.memoryUsage().heapUsed
  const store = new FormalSessionStore(dataDir)
  const started = performance.now()
  await store.load()
  const loadMs = performance.now() - started
  await collectGarbage()
  const heapDelta = process.memoryUsage().heapUsed - before
  const result = { loadMs, heapDelta, loaded: store.sessions.size, archived: store.archived.size }
  store.sessions.clear()
  store.archived.clear()
  return result
}

async function journalDigest(dataDir) {
  const digest = createHash('sha256')
  for (const name of ['access-denials.jsonl', 'usage.jsonl']) {
    digest.update(await readFile(join(dataDir, 'observability', name), 'utf8'))
  }
  return digest.digest('hex')
}

test('archive reduces startup and keeps archived Sessions usable', { timeout: 300_000 }, async () => {
  const dataDir = await remember('dsh-session-archive-')
  const first = await start(dataDir)
  const owner = await newIdentity(first.origin, first.app)
  const bytes = Buffer.from('archived attachment evidence '.repeat(64))
  const attachmentHash = createHash('sha256').update(bytes).digest('hex')
  const upload = await fetch(`${first.origin}/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${owner.workspaceId}&name=evidence.txt`, {
    method: 'PUT',
    headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  assert.equal(upload.status, 200)
  await first.app.close()

  const journal = createObservabilityJournal({ dataDir })
  await journal.appendUsage({
    at: LEGACY_AT, sessionId: 'archive-0000', provider: 'scripted', purpose: 'turn',
    inputTokens: 120, outputTokens: 40, fallbackUsed: false,
  })
  for (let index = 0; index < 100; index += 1) {
    await journal.appendAccessDenial({
      at: LEGACY_AT + index, route: '/api/browser-native/session/read',
      reason: 'principal-mismatch', sessionId: 'archive-0000',
    })
  }
  await writeSessions(dataDir, owner.principalId, attachmentHash)

  const before = await measureStoreLoad(dataDir)
  assert.equal(before.loaded, TOTAL)
  assert.equal(before.archived, 0)

  const second = await start(dataDir)
  const listBefore = await listAll(second.origin, owner.cookie)
  assert.equal(listBefore.snapshots.length, TOTAL)

  const digestBefore = await journalDigest(dataDir)
  const archived = await call(second.origin, owner.cookie, '/api/browser-native/admin/session/archive', { inactiveMs: 60_000, limit: ARCHIVED })
  assert.equal(archived.status, 200)
  assert.equal(archived.body.archived.length, ARCHIVED)
  const archivedIds = new Set(archived.body.archived.map(entry => entry.sessionId))
  assert.equal(archivedIds.size, ARCHIVED)

  const listAfter = await listAll(second.origin, owner.cookie)
  assert.equal(listAfter.snapshots.length, TOTAL)
  assert.equal(listAfter.snapshots.filter(snapshot => snapshot.archived === true).length, ARCHIVED)
  assert.equal(listAfter.items.filter(item => item.archived === true).length, ARCHIVED)
  for (const id of archivedIds) {
    assert.ok(listAfter.snapshots.some(snapshot => snapshot.header.id === id))
    assert.ok(await stat(archiveFilePath(dataDir, id)).then(() => true, () => false))
  }
  assert.equal(await journalDigest(dataDir), digestBefore)
  const restoredJournal = await createObservabilityJournal({ dataDir }).restore()
  assert.equal(restoredJournal.integrity.verified, true)
  assert.equal(restoredJournal.usage.length, 1)
  assert.equal(restoredJournal.accessDenials.length, 100)
  await second.app.close()

  const later = await measureStoreLoad(dataDir)
  assert.equal(later.loaded, ACTIVE)
  assert.equal(later.archived, ARCHIVED)
  assert.ok(later.loadMs < before.loadMs * 0.75, `load time grew: ${before.loadMs.toFixed(1)} -> ${later.loadMs.toFixed(1)} ms`)
  assert.ok(later.heapDelta < before.heapDelta * 0.75, `heap grew: ${before.heapDelta} -> ${later.heapDelta} bytes`)
  process.stderr.write(`session archive: load ${before.loadMs.toFixed(1)} -> ${later.loadMs.toFixed(1)} ms, heap ${(before.heapDelta / MiB).toFixed(1)} -> ${(later.heapDelta / MiB).toFixed(1)} MiB\n`)

  const third = await start(dataDir)
  const archivedId = archived.body.archived[0].sessionId
  const activeId = listAfter.snapshots.find(snapshot => snapshot.archived !== true).header.id

  // Prove the archive carries attachment bytes: remove the live object before opening.
  await rm(join(dataDir, 'attachments-v1', owner.workspaceId, attachmentHash.slice(0, 2), attachmentHash), { force: true })
  const open = await call(third.origin, owner.cookie, '/api/browser-native/session/open', { ...protocol(), sessionId: archivedId, access: 'read' })
  assert.equal(open.status, 200)
  const read = await call(third.origin, owner.cookie, '/api/browser-native/session/read', { ...protocol(), sessionId: archivedId, offset: 0, length: 1_000 })
  assert.equal(read.status, 200)
  assert.equal(read.body.events.length, EVENTS)
  assert.ok(read.body.events[0].data.content.at(0).attachment.attachmentId.startsWith('sha256:'))
  assert.ok(await stat(join(dataDir, 'attachments-v1', owner.workspaceId, attachmentHash.slice(0, 2), attachmentHash)).then(() => true, () => false), 'attachment bytes were not restored')

  const exported = await call(third.origin, owner.cookie, '/api/browser-native/session/export', {
    ...protocol(), sessionId: archivedId, workspaceId: owner.workspaceId,
  })
  assert.equal(exported.status, 200)
  assert.equal(exported.body.session.events.length, EVENTS)
  assert.equal(exported.body.attachments.length, 1)
  assert.equal(exported.body.attachments[0].data, bytes.toString('base64'))
  const activeExport = await call(third.origin, owner.cookie, '/api/browser-native/session/export', {
    ...protocol(), sessionId: activeId, workspaceId: owner.workspaceId,
  })
  assert.equal(activeExport.status, 200)

  const restore = await call(third.origin, owner.cookie, '/api/browser-native/admin/session/restore', { sessionId: archivedId })
  assert.equal(restore.status, 200)
  assert.equal(restore.body.snapshot.eventCount, EVENTS)
  assert.ok(await stat(join(dataDir, 'sessions', `${archivedId}.json`)).then(() => true, () => false), 'restore did not write the active Session file')
  await third.app.close()

  // Accidental deletion of the restored active file must not lose the Session.
  await rm(join(dataDir, 'sessions', `${archivedId}.json`))
  const fourth = await start(dataDir)
  const listAfterDelete = await listAll(fourth.origin, owner.cookie)
  assert.ok(listAfterDelete.snapshots.some(snapshot => snapshot.header.id === archivedId && snapshot.archived === true))
  const restoreAgain = await call(fourth.origin, owner.cookie, '/api/browser-native/admin/session/restore', { sessionId: archivedId })
  assert.equal(restoreAgain.status, 200)
  const readAgain = await call(fourth.origin, owner.cookie, '/api/browser-native/session/read', { ...protocol(), sessionId: archivedId, offset: 0, length: 1_000 })
  assert.equal(readAgain.status, 200)
  assert.equal(readAgain.body.events.length, EVENTS)
  assert.equal(await journalDigest(dataDir), digestBefore)
  await fourth.app.close()
})
