/**
 * Dataset upgrade and rollback end-to-end.
 *
 * Builds a pre-marker v1 data directory, upgrades it through the versioned
 * backup flow, verifies the backend still serves it, rolls back to the backup,
 * and checks byte equality plus the documented refusal paths.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { exportDataDir } from '../hosted/data-backup.mjs'
import { CURRENT_DATASET_VERSION, readDataFormat } from '../hosted/data-format.mjs'
import { upgradeDataDir } from '../hosted/upgrade-data.mjs'
import { rollbackDataDir } from '../hosted/rollback-data.mjs'
import { inspectDataDirectory } from '../hosted/check-data.mjs'

const root = await mkdtemp(join(tmpdir(), 'dsh-upgrade-rollback-'))
const dataDir = join(root, 'data')
const backupRoot = join(root, 'backups')
const protocol = () => ({ protocolVersion: 1, requestId: randomUUID() })
let image
let app
let origin

/** Recursively fingerprint a directory as sorted path and content digests. */
async function fingerprint(directory) {
  const entries = []
  async function walk(prefix) {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (path === '.browser-native-backend.lock') continue
      entries.push({ path, sha256: createHash('sha256').update(await readFile(join(directory, path))).digest('hex') })
    }
  }
  await walk('')
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

/** Call the backend as one principal. */
async function call(principal, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `dsh-browser-native-principal=${principal}; dsh-browser-native-session-principal=${principal}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/** Create one anonymous principal and return its id. */
async function createIdentity() {
  const known = new Set(app.workspaces.identities.keys())
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const principal = [...app.workspaces.identities.keys()].find(key => !known.has(key))
  assert.equal(typeof principal, 'string')
  return principal
}

/** Start the backend on the shared data directory. */
async function start() {
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
}

/** Close the backend and clear the origin. */
async function stop() {
  await app?.close()
  app = undefined
  origin = undefined
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await start()
  const owner = await createIdentity()
  const viewer = await createIdentity()
  const sessionId = `sess-upgrade-${randomUUID()}`
  const created = await call(owner, '/api/browser-native/session/create', {
    ...protocol(), sessionId, header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const appended = await call(owner, '/api/browser-native/session/append', {
    ...protocol(),
    sessionId,
    ownerToken: created.body.owner.ownerToken,
    ownerEpoch: created.body.owner.ownerEpoch,
    expectedNextSeq: 0,
    events: [
      { seq: 0, type: 'user', data: { text: 'pre-upgrade transcript' } },
      { seq: 1, type: 'assistant', data: { text: 'survives upgrade and rollback' } },
    ],
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const flushed = await call(owner, '/api/browser-native/session/flush', {
    ...protocol(),
    sessionId,
    ownerToken: created.body.owner.ownerToken,
    ownerEpoch: created.body.owner.ownerEpoch,
    expectedNextSeq: 2,
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))
  await stop()

  // Simulate a directory written before share links and dataset markers existed.
  await writeFile(join(dataDir, 'session-shares.json'), `${JSON.stringify({
    version: 1,
    shares: [{ sessionId, ownerPrincipalId: owner, viewerPrincipalId: viewer, grantedAt: 1 }],
  })}\n`, 'utf8')
  assert.equal((await readDataFormat(dataDir)).version, 1)
  await start()
  const v1Read = await call(viewer, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(v1Read.status, 200, 'a v1 grant must still load, including a missing role')
  await stop()

  const preUpgrade = await fingerprint(dataDir)
  const preFormat = await readDataFormat(dataDir)
  assert.equal(preFormat.version, 1)
  assert.equal(preFormat.inferred, true)

  const unversionedDir = join(root, 'backup-unversioned')
  await exportDataDir({ dataDir, outputDir: unversionedDir })
  const unversionedManifestPath = join(unversionedDir, 'manifest.json')
  const unversionedManifest = JSON.parse(await readFile(unversionedManifestPath, 'utf8'))
  assert.equal(unversionedManifest.dataset.version, 1, 'exports must record the dataset generation')
  await rm(unversionedManifestPath)
  const { dataset: _dropped, ...withoutDataset } = unversionedManifest
  await writeFile(unversionedManifestPath, `${JSON.stringify(withoutDataset, null, 2)}\n`, 'utf8')
  await assert.rejects(rollbackDataDir({ dataDir, bundleDir: unversionedDir }),
    error => error.code === 'BACKUP_UNVERSIONED')
  assert.deepEqual(await fingerprint(dataDir), preUpgrade, 'a refused rollback must not touch the data directory')

  const tooNewDir = join(root, 'backup-too-new')
  await exportDataDir({ dataDir, outputDir: tooNewDir })
  const tooNewManifestPath = join(tooNewDir, 'manifest.json')
  const tooNewManifest = JSON.parse(await readFile(tooNewManifestPath, 'utf8'))
  tooNewManifest.dataset.version = CURRENT_DATASET_VERSION + 1
  await writeFile(tooNewManifestPath, `${JSON.stringify(tooNewManifest, null, 2)}\n`, 'utf8')
  await assert.rejects(rollbackDataDir({ dataDir, bundleDir: tooNewDir }),
    error => error.code === 'BACKUP_TOO_NEW')
  assert.deepEqual(await fingerprint(dataDir), preUpgrade)

  const upgraded = await upgradeDataDir({ dataDir, backupRoot })
  assert.equal(upgraded.status, 'upgraded')
  assert.equal(upgraded.from, 1)
  assert.equal(upgraded.to, CURRENT_DATASET_VERSION)
  assert.equal(upgraded.steps.length, 1)
  assert.equal(upgraded.steps[0].id, 'session-shares-v2')
  assert.equal(upgraded.steps[0].changed, true)
  assert.deepEqual(upgraded.steps[0], { id: 'session-shares-v2', from: 1, to: 2, changed: true, shareFileVersion: 2 })
  const backupManifest = JSON.parse(await readFile(join(upgraded.backupDir, 'manifest.json'), 'utf8'))
  assert.equal(backupManifest.dataset.version, 1)
  const backedUpShares = JSON.parse(await readFile(join(upgraded.backupDir, 'files', 'session-shares.json'), 'utf8'))
  assert.equal(backedUpShares.version, 1, 'the versioned backup preserves the pre-upgrade file')

  const upgradedFormat = await readDataFormat(dataDir)
  assert.equal(upgradedFormat.version, 2)
  assert.equal(upgradedFormat.upgradedFrom, 1)
  assert.equal(upgradedFormat.shareFileVersion, 2)
  const upgradedShares = JSON.parse(await readFile(join(dataDir, 'session-shares.json'), 'utf8'))
  assert.equal(upgradedShares.version, 2)
  assert.deepEqual(upgradedShares.links, [])
  assert.deepEqual(upgradedShares.shares.map(share => share.role), ['viewer'],
    'the missing role must materialize as viewer')
  assert.deepEqual((await inspectDataDirectory(dataDir)).dataset, { present: true, version: 2, inferred: false, supported: true, needsUpgrade: false })

  await start()
  const v2Read = await call(viewer, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(v2Read.status, 200, 'the upgraded directory must still serve the v1 grants')
  await assert.rejects(upgradeDataDir({ dataDir, backupRoot }),
    error => error.code === 'BACKEND_RUNNING')
  await assert.rejects(rollbackDataDir({ dataDir, bundleDir: upgraded.backupDir }),
    error => error.code === 'BACKEND_RUNNING')
  await stop()

  const again = await upgradeDataDir({ dataDir, backupRoot })
  assert.equal(again.status, 'up-to-date', 'an upgraded directory must not create a second backup')

  const savedMarker = await readFile(join(dataDir, 'data-format.json'), 'utf8')
  await writeFile(join(dataDir, 'data-format.json'), `${JSON.stringify({ ...JSON.parse(savedMarker), version: 99 }, null, 2)}\n`, 'utf8')
  await assert.rejects(start(), error => error.code === 'DATA_FORMAT_TOO_NEW')
  app = undefined
  assert.equal((await inspectDataDirectory(dataDir)).compatible, false, 'a newer dataset is incompatible')
  await assert.rejects(upgradeDataDir({ dataDir, backupRoot }), error => error.code === 'DATA_FORMAT_TOO_NEW')
  await writeFile(join(dataDir, 'data-format.json'), savedMarker, 'utf8')

  const faultDir = join(root, 'fault-data')
  await cp(dataDir, faultDir, { recursive: true })
  await rm(join(faultDir, 'data-format.json'))
  const faultFingerprint = await fingerprint(faultDir)
  let failure
  try {
    await upgradeDataDir({
      dataDir: faultDir,
      backupRoot,
      migrations: [{
        id: 'injected-fault',
        from: 1,
        to: 2,
        apply: async ({ dataDir: target }) => {
          await writeFile(join(target, 'partial-migration.txt'), 'half written\n')
          throw new Error('injected migration fault')
        },
      }],
    })
  } catch (error) {
    failure = error
  }
  assert.equal(failure?.code, 'UPGRADE_FAILED_ROLLED_BACK', String(failure))
  assert.equal(failure.details.failedStep, 'injected-fault')
  assert.ok(failure.details.preservedDir.includes('.upgrade-failed-'))
  assert.deepEqual(await fingerprint(faultDir), faultFingerprint, 'a failed migration restores the original bytes')
  const partial = await readFile(join(failure.details.preservedDir, 'partial-migration.txt'), 'utf8')
  assert.equal(partial, 'half written\n', 'the partial directory is preserved for diagnosis')

  const rolledBack = await rollbackDataDir({ dataDir, bundleDir: upgraded.backupDir })
  assert.equal(rolledBack.status, 'rolled-back')
  assert.equal(rolledBack.datasetVersion, 1)
  assert.deepEqual(await fingerprint(dataDir), preUpgrade, 'rollback restores the pre-upgrade bytes')
  assert.equal((await readDataFormat(dataDir)).inferred, true, 'rollback also removes the dataset marker')
  assert.equal(JSON.parse(await readFile(join(dataDir, 'session-shares.json'), 'utf8')).version, 1)
  assert.equal((await readdir(dataDir)).includes('data-format.json'), false)
  assert.ok(rolledBack.preservedDir.includes('.pre-rollback-'))

  await start()
  const afterRollback = await call(viewer, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(afterRollback.status, 200, 'the rolled-back v1 directory must serve again')
  const events = await call(viewer, '/api/browser-native/session/read', { ...protocol(), sessionId })
  assert.deepEqual(events.body.events.map(event => event.seq), [0, 1])
  await stop()

  const summary = {
    result: 'passed',
    scope: 'dataset-upgrade-rollback',
    dataDir,
    preUpgradeFiles: preUpgrade.length,
    upgrade: { from: upgraded.from, to: upgraded.to, steps: upgraded.steps, backupDataset: backupManifest.dataset.version, backupFiles: upgraded.backupFiles },
    upToDate: again.status,
    rollback: { datasetVersion: rolledBack.datasetVersion, files: rolledBack.files, byteIdentical: true },
    refusals: ['BACKUP_UNVERSIONED', 'BACKUP_TOO_NEW', 'BACKEND_RUNNING', 'DATA_FORMAT_TOO_NEW', 'UPGRADE_FAILED_ROLLED_BACK'],
    v1Read: v1Read.status,
    v2Read: v2Read.status,
    afterRollback: afterRollback.status,
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  await stop().catch(() => undefined)
  await image?.cleanup()
  await rm(root, { recursive: true, force: true })
}
