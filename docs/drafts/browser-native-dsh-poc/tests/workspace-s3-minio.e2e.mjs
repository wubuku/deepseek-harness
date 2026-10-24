import assert from 'node:assert/strict'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { S3WorkspaceBlobStore } from '../s3-blob-store.mjs'
import { openPreview, waitFor } from './runtime-test-support.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-s3-minio-')))
const minioDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-s3-minio-data-'))
let containerName = `dsh-browser-native-minio-${randomUUID()}`
const bucket = `dsh-poc-${randomUUID()}`
const imageName = 'minio/minio:RELEASE.2023-03-20T20-16-18Z'
const accessKeyId = 'dsh-poc-test-access'
const secretAccessKey = 'dsh-poc-test-secret-key-not-for-production'
const filePath = '/dsh/home/workspace/minio-roundtrip.bin'
const outageFilePath = '/dsh/home/workspace/minio-outage-retry.bin'
const missingObjectFilePath = '/dsh/home/workspace/minio-missing-object-retry.bin'
const fileBytes = 2 * 1024 * 1024 + 37
const byteValue = 0x5d
const dataHash = createHash('sha256').update(Buffer.alloc(fileBytes, byteValue)).digest('hex')
const missingObjectBytes = 131_071
const missingObjectValue = 0x26
const missingObjectHash = createHash('sha256').update(Buffer.alloc(missingObjectBytes, missingObjectValue)).digest('hex')
const pageErrors = []
const browserRequests = []
const workspaceResponses = []
const commitRequests = []
let removeNextUploadedObject = false
let removedUploadedObjectCount = 0
let minioPort
let image
let app
let blobStore
let browser
let page
let origin

async function docker(args) {
  return await execFileAsync('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
}

async function createMinioContainer() {
  await docker([
    'run', '--detach', '--name', containerName,
    '--publish', '127.0.0.1::9000',
    '--env', `MINIO_ROOT_USER=${accessKeyId}`,
    '--env', `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
    '--volume', `${minioDataDir}:/data`,
    imageName, 'server', '/data',
  ])
  const { stdout: mapping } = await docker(['port', containerName, '9000/tcp'])
  const mappedPort = mapping.match(/127\.0\.0\.1:(\d+)/)
  assert.ok(mappedPort, `Docker did not publish MinIO on loopback: ${mapping}`)
  minioPort = Number(mappedPort[1])
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${String(minioPort)}/minio/health/ready`).catch(() => undefined)
    return response?.ok === true ? true : undefined
  }, 'MinIO startup readiness', 30_000)
}

async function restartMinioAndBackend(distRoot) {
  const backendPort = Number(new URL(origin).port)
  await docker(['rm', '--force', containerName])
  containerName = `dsh-browser-native-minio-${randomUUID()}`
  await createMinioContainer()
  await app.close()
  app = undefined
  blobStore.close()
  blobStore = undefined
  await startBackend(distRoot, backendPort)
}

function makeBlobStore() {
  return new S3WorkspaceBlobStore({
    endpoint: `http://127.0.0.1:${String(minioPort)}`,
    region: 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
  })
}

async function startBackend(distRoot, port = 0) {
  blobStore = makeBlobStore()
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot,
    llmMode: 'scripted',
    workspaceBlobStore: blobStore,
  })
  origin = await app.listen(port)
  return origin
}

async function browserWorkspaceStatus() {
  return await page.evaluate(() => ({
    state: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state,
    revision: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision,
    dirtyCount: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount,
    workspaceId: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId,
  }))
}

async function readManifest(workspaceId) {
  return await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
}

try {
  const { stdout: imageId } = await docker(['image', 'inspect', '--format', '{{.Id}}', imageName])
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await createMinioContainer()

  origin = await startBackend(image.distRoot)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname.startsWith('/api/browser-native/')) {
      browserRequests.push({ url: request.url(), method: request.method(), bytes: request.postDataBuffer()?.byteLength ?? 0 })
      if (url.pathname.endsWith('/workspace/commit')) commitRequests.push(request.postDataJSON())
    } else if (url.origin !== origin) browserRequests.push({ url: request.url(), method: request.method() })
  })
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname
    if (pathname.startsWith('/api/browser-native/workspace/')) {
      workspaceResponses.push({ pathname, status: response.status() })
    }
  })
  await page.route('**/api/browser-native/workspace/commit', async route => {
    if (removeNextUploadedObject) {
      removeNextUploadedObject = false
      const body = route.request().postDataJSON()
      const change = body.changes.find(item => item.kind === 'file' && item.path === 'minio-missing-object-retry.bin')
      assert.ok(change, 'the injected object loss must target the pending Workspace file')
      await blobStore.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: blobStore.key(change.hash) }))
      removedUploadedObjectCount += 1
    }
    await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  const write = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(input), {
    action: 'write-pattern', path: filePath, byteLength: fileBytes, byteValue,
  })
  assert.deepEqual({ ok: write?.ok, bytes: write?.bytes, digest: write?.digest }, {
    ok: true,
    bytes: fileBytes,
    digest: dataHash,
  })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 60_000 })
  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  const firstManifest = await readManifest(identity.workspaceId)
  const firstEntry = firstManifest.entries.find(entry => entry.path === 'minio-roundtrip.bin')
  assert.deepEqual({ hash: firstEntry?.hash, bytes: firstEntry?.bytes, revision: firstManifest.revision }, {
    hash: dataHash, bytes: fileBytes, revision: 1,
  })
  const uploadedBytes = await blobStore.get(dataHash)
  assert.equal(createHash('sha256').update(uploadedBytes).digest('hex'), dataHash)
  assert.equal(uploadedBytes.byteLength, fileBytes)
  const localBlobFiles = await readdir(join(dataDir, 'workspace-v2', 'blobs')).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  assert.deepEqual(localBlobFiles, [], 'S3 mode must not place content blobs in the backend local blob directory')

  const chunkRead = await page.evaluate(async ({ workspaceId, hash }) => {
    const response = await fetch(`/api/browser-native/workspace/blob/${hash}/chunk/1?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`)
    return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())], totalBytes: response.headers.get('x-total-bytes') }
  }, { workspaceId: identity.workspaceId, hash: dataHash })
  assert.deepEqual({ status: chunkRead.status, bytes: chunkRead.bytes.length, totalBytes: chunkRead.totalBytes }, {
    status: 200, bytes: 1024 * 1024, totalBytes: String(fileBytes),
  })
  assert.ok(chunkRead.bytes.every(byte => byte === byteValue), 'S3 Range reads must return the requested content')

  await docker(['stop', '--time', '1', containerName])
  const outageWrite = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(input), {
    action: 'write-pattern', path: outageFilePath, byteLength: 131_071, byteValue: 0x34,
  })
  assert.equal(outageWrite?.ok, true, JSON.stringify(outageWrite))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 45_000 })
  const outageStatus = await browserWorkspaceStatus()
  assert.equal(outageStatus.revision, 1, 'a failed object upload must not advance the remote manifest')
  assert.ok(workspaceResponses.some(item => item.status === 503), 'S3 unavailability must produce a retryable 503')
  assert.equal(commitRequests.length, 1, 'the outage must not commit a manifest without its blob')

  await restartMinioAndBackend(image.distRoot)
  const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flush?.ok, true, JSON.stringify(flush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 2, undefined, { timeout: 60_000 })
  const recoveredManifest = await readManifest(identity.workspaceId)
  assert.equal(recoveredManifest.entries.some(entry => entry.path === 'minio-outage-retry.bin'), true)
  assert.equal(commitRequests.length, 2, 'the recovered retry must create one additional manifest commit')

  removeNextUploadedObject = true
  const missingObjectWrite = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(input), {
    action: 'write-pattern', path: missingObjectFilePath, byteLength: missingObjectBytes, byteValue: missingObjectValue,
  })
  assert.equal(missingObjectWrite?.ok, true, JSON.stringify(missingObjectWrite))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 45_000 })
  assert.equal(removedUploadedObjectCount, 1)
  assert.equal((await browserWorkspaceStatus()).revision, 2, 'the manifest must not commit a missing blob')
  assert.ok(workspaceResponses.some(item => item.pathname === '/api/browser-native/workspace/commit' && item.status === 409),
    'commit must reject a blob deleted after upload completion')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 3, undefined, { timeout: 60_000 })
  const afterMissingObjectRecovery = await readManifest(identity.workspaceId)
  const recoveredMissingObjectEntry = afterMissingObjectRecovery.entries.find(entry => entry.path === 'minio-missing-object-retry.bin')
  assert.deepEqual({ hash: recoveredMissingObjectEntry?.hash, bytes: recoveredMissingObjectEntry?.bytes }, {
    hash: missingObjectHash, bytes: missingObjectBytes,
  })
  assert.equal((await blobStore.get(missingObjectHash)).byteLength, missingObjectBytes,
    'refresh must re-upload the missing content-addressed object from the local retry')
  assert.equal(commitRequests.length, 4, 'missing-object retry must make one failed and one successful commit request')

  const backendPort = Number(new URL(origin).port)
  await app.close()
  app = undefined
  blobStore.close()
  blobStore = undefined
  await startBackend(image.distRoot, backendPort)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 3, undefined, { timeout: 60_000 })
  const persistedBlob = await blobStore.get(dataHash)
  assert.equal(createHash('sha256').update(persistedBlob).digest('hex'), dataHash)
  assert.deepEqual(pageErrors, [])
  assert.ok(browserRequests.every(request => request.url.startsWith(origin)), 'the browser must not connect directly to MinIO')
  assert.equal(JSON.stringify(browserRequests).includes(accessKeyId), false)
  assert.equal(JSON.stringify(browserRequests).includes(secretAccessKey), false)

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'browser-workspace-s3-compatible-content-blob-storage',
    backend: 'single-process-local-JSON-manifest-session-and-leases',
    minioImage: imageName,
    minioImageId: imageId.trim(),
    objectBucket: bucket,
    workspaceId: identity.workspaceId,
    objectSha256: dataHash,
    objectBytes: fileBytes,
    rangeReadBytes: chunkRead.bytes.length,
    manifestRevisionAfterOutageRecovery: recoveredManifest.revision,
    manifestRevisionAfterMissingObjectRecovery: afterMissingObjectRecovery.revision,
    commitRequestCount: commitRequests.length,
    missingObjectRecovery: 'refresh-reuploaded-previously-completed-but-missing-blob',
    outageResponseStatus: workspaceResponses.find(item => item.status === 503)?.status,
    backendRestartRead: 'passed',
    browserConnectedDirectlyToObjectStore: false,
    pageErrors,
  })}\n`)
} catch (error) {
  let status
  if (page !== undefined) {
    try { status = await browserWorkspaceStatus() } catch {}
  }
  process.stderr.write(`${JSON.stringify({
    diagnostic: 'workspace-s3-minio-e2e-failed',
    error: String(error),
    status,
    workspaceResponses,
    manifestCommitCount: commitRequests.length,
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  blobStore?.close()
  await image?.cleanup()
  try {
    await docker(['rm', '--force', containerName])
  } catch (error) {
    if (error?.code !== 1 && error?.code !== 'ENOENT') throw error
  }
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  await rm(minioDataDir, { recursive: true, force: true })
}
