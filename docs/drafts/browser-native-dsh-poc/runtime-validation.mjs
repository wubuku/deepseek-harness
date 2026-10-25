/** Temporary validation image over the built v2 preview; never mutates shared build outputs. */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = new URL('.', import.meta.url)

/**
 * Serve the real preview with reproducible VFS files and an optional browser-only preset.
 * @param {{distRoot?: string, roster?: 'browser' | 'original', largeFileChars?: number}} options - Built preview and validation fixtures.
 * @returns {Promise<{distRoot: string, roster: string, cleanup: () => Promise<void>}>} Private image and cleanup owner.
 */
export async function createRuntimeValidationDist({ distRoot = 'apps/web/dist', roster = 'browser', largeFileChars = 0 } = {}) {
  if (!['browser', 'original'].includes(roster)) throw new Error('roster must be browser or original')
  if (!Number.isSafeInteger(largeFileChars) || largeFileChars < 0 || largeFileChars > 1_000_000) {
    throw new Error('largeFileChars must be an integer between 0 and 1000000')
  }
  const sourceRoot = resolve(distRoot)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-browser-runtime-image-'))
  try {
    const imageRoot = join(temporary, 'image')
    const outputRoot = join(temporary, 'dist')
    const home = join(imageRoot, 'home')
    await mkdir(join(home, 'browser-validation'), { recursive: true })
    const patch = roster === 'browser' ? 'runtime-validation.cordis.patch.yml' : 'browser-native-profile.cordis.patch.yml'
    await writeFile(join(home, 'cordis.patch.yml'), await readFile(new URL(patch, here)))
    for (const file of ['browser-native-session-persistence.js', 'browser-native-llm.js']) {
      await writeFile(join(home, file), await readFile(new URL(file, here)))
    }
    await writeFile(join(home, 'browser-validation', 'input.txt'), 'runtime=DedicatedWorker\nfixture=VFS_INPUT_READY\n')
    if (largeFileChars > 0) {
      const filler = Array.from(
        { length: Math.ceil(largeFileChars / 96) },
        (_, index) => `fixture-line-${String(index).padStart(5, '0')} ${'x'.repeat(78)}\n`,
      ).join('').slice(0, largeFileChars)
      const midpoint = Math.floor(filler.length / 2)
      const largeFile = `${filler.slice(0, midpoint)}\nBROWSER_NATIVE_LARGE_TOOL_RESULT_MIDDLE_SENTINEL\n${filler.slice(midpoint)}`
      await writeFile(join(home, 'browser-validation', 'large.txt'), largeFile)
    }
    const archive = join(temporary, 'overlay.tar.gz')
    await execFileAsync('tar', ['-czf', archive, '-C', imageRoot, 'home'])
    const dataUrl = `data:application/gzip;base64,${(await readFile(archive)).toString('base64')}`
    await mkdir(join(outputRoot, 'preview'), { recursive: true })
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (entry.name !== 'preview') await symlink(join(sourceRoot, entry.name), join(outputRoot, entry.name))
    }
    let replaced = 0
    for (const entry of await readdir(join(sourceRoot, 'preview'), { withFileTypes: true })) {
      const source = join(sourceRoot, 'preview', entry.name)
      const target = join(outputRoot, 'preview', entry.name)
      if (entry.name.startsWith('bootstrap-') && entry.name.endsWith('.js')) {
        const text = await readFile(source, 'utf8')
        const matches = text.match(/data:application\/gzip;base64,[A-Za-z0-9+/=]+/g) ?? []
        if (matches.length !== 1) throw new Error('preview bootstrap must contain exactly one inline profile overlay; rebuild preview or update the validation image builder')
        await writeFile(target, text.replace(matches[0], dataUrl))
        replaced += 1
      } else {
        await symlink(source, target)
      }
    }
    if (replaced !== 1) throw new Error('expected one preview bootstrap; run build:preview first')
    return { distRoot: outputRoot, roster, cleanup: () => rm(temporary, { recursive: true, force: true }) }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}
