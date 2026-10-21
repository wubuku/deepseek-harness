/** Temporary validation image over the built v2 preview; never mutates shared build outputs. */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = new URL('.', import.meta.url)

/**
 * Serve the real preview with a reproducible VFS fixture and optional browser-only preset.
 * @param {{distRoot?: string, roster?: 'browser' | 'original'}} options - Built preview and selected roster.
 * @returns {Promise<{distRoot: string, roster: string, cleanup: () => Promise<void>}>} Private image and cleanup owner.
 */
export async function createRuntimeValidationDist({ distRoot = 'apps/web/dist', roster = 'browser' } = {}) {
  if (!['browser', 'original'].includes(roster)) throw new Error('roster must be browser or original')
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
