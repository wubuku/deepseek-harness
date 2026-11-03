import { afterEach, describe, expect, it } from 'vitest'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { Config, SqliteStorageBackend } from '../src/index.ts'
import { SqliteKvUnit } from '../src/unit.ts'

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'specimen',
  version: 1,
  tables: ['records'],
  hasGlobal: true,
}

function backendAt(path: string): SqliteStorageBackend {
  return new SqliteStorageBackend(new Config({ path }))
}

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-fault-'))
  dirs.push(dir)
  return dir
}

async function freshDbPath(): Promise<string> {
  return join(await freshDir(), 'storage.db')
}

function unitOn(path: string): { db: DatabaseSync; unit: SqliteKvUnit } {
  const db = new DatabaseSync(path)
  return { db, unit: new SqliteKvUnit(db, DESCRIPTOR, () => {}) }
}

function pageCount(db: DatabaseSync): number {
  return (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
}

async function recordsOf(unit: KvUnit): Promise<Record<string, unknown>> {
  return (await unit.loadAll()).tables['records'] ?? {}
}

describe('sqlite storage fault injection', () => {
  it('rejects a write that exceeds the page budget and commits nothing', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'before', { n: 1 })
    await backend.close()

    const { db, unit: live } = unitOn(path)
    try {
      db.exec(`PRAGMA max_page_count = ${pageCount(db) + 2}`)
      const payload = { blob: 'x'.repeat(200_000) }
      const failure = await live.putRecord('records', 'too-large', payload).catch(error => error)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure.message)).toMatch(/database or disk is full/i)
      expect(await recordsOf(live)).toEqual({ before: { n: 1 } })

      db.exec('PRAGMA max_page_count = 1000')
      await live.putRecord('records', 'too-large', payload)
      expect(Object.keys(await recordsOf(live)).sort()).toEqual(['before', 'too-large'])
    } finally {
      db.close()
    }

    const reopened = backendAt(path)
    const reread = await reopened.kv.open(DESCRIPTOR)
    expect(Object.keys(await recordsOf(reread)).sort()).toEqual(['before', 'too-large'])
    await reopened.close()
  }, 90_000)

  it('recovers committed rows from the WAL journal in an unclean snapshot', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'checkpointed', { n: 1 })
    await backend.close()
    await expect(readFile(`${path}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })

    // Keep the connection open: this row is committed in the WAL but not yet
    // checkpointed, so the file set is a live-process snapshot.
    const { db, unit: live } = unitOn(path)
    await live.putRecord('records', 'wal-only', { n: 2 })

    const snapshotDir = await freshDir()
    const withWal = join(snapshotDir, 'with-wal')
    await mkdir(withWal)
    await copyFile(path, join(withWal, 'storage.db'))
    for (const suffix of ['-wal', '-shm']) {
      await copyFile(`${path}${suffix}`, join(withWal, `storage.db${suffix}`)).catch(() => {})
    }
    const mainOnly = join(snapshotDir, 'main-only')
    await mkdir(mainOnly)
    await copyFile(path, join(mainOnly, 'storage.db'))

    const recovered = backendAt(join(withWal, 'storage.db'))
    const recoveredUnit = await recovered.kv.open(DESCRIPTOR)
    expect(Object.keys(await recordsOf(recoveredUnit)).sort()).toEqual(['checkpointed', 'wal-only'])
    await recovered.close()

    const mainOnlyBackend = backendAt(join(mainOnly, 'storage.db'))
    const mainOnlyUnit = await mainOnlyBackend.kv.open(DESCRIPTOR)
    expect(Object.keys(await recordsOf(mainOnlyUnit)).sort()).toEqual(['checkpointed'])
    await mainOnlyBackend.close()

    db.close()
  }, 90_000)

  it('rejects a corrupt database without overwriting it', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'kept', { n: 1 })
    await backend.close()

    await writeFile(path, 'this is not a sqlite database\n')
    const before = await readFile(path)

    const broken = backendAt(path)
    try {
      await expect(broken.kv.open(DESCRIPTOR)).rejects.toThrow(/not a database|malformed/i)
    } finally {
      await broken.close()
    }
    expect(await readFile(path)).toEqual(before)
  }, 90_000)

  it('fails loudly on the first write to a read-only database and recovers after permissions return', async () => {
    if (process.platform === 'win32') return
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'kept', { n: 1 })
    await backend.close()

    await chmod(path, 0o444)
    const readOnly = backendAt(path)
    const readOnlyUnit = await readOnly.kv.open(DESCRIPTOR)
    const failure = await readOnlyUnit.putRecord('records', 'blocked', { n: 2 }).catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure.message)).toMatch(/readonly|read-only|attempt to write/i)
    expect(await recordsOf(readOnlyUnit)).toEqual({ kept: { n: 1 } })
    await readOnly.close()

    await chmod(path, 0o644)
    // The read-only connection left a read-only `-shm` beside the database;
    // SQLite keeps rejecting writes until that side file is writable too.
    for (const suffix of ['-shm', '-wal', '-journal']) await chmod(`${path}${suffix}`, 0o644).catch(() => {})
    const recovered = backendAt(path)
    const recoveredUnit = await recovered.kv.open(DESCRIPTOR)
    await recoveredUnit.putRecord('records', 'blocked', { n: 2 })
    expect(await recordsOf(recoveredUnit)).toEqual({ kept: { n: 1 }, blocked: { n: 2 } })
    await recovered.close()
  }, 90_000)
})
