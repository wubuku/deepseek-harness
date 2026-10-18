import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const directory = dirname(fileURLToPath(import.meta.url))
const temporaryDirectory = resolve(directory, '.build')
const output = resolve(directory, 'comparison-profile-overlay.tar.gz')

await rm(temporaryDirectory, { recursive: true, force: true })
await mkdir(resolve(temporaryDirectory, 'home'), { recursive: true })
for (const name of [
  'cordis.patch.yml',
  'browser-native-session-persistence.js',
  'browser-native-llm.js',
  'copilotkit-frontend-tools.js',
  'copilotkit-user-questions.js',
]) {
  await writeFile(
    resolve(temporaryDirectory, 'home', name),
    await readFile(resolve(directory, name), 'utf8'),
  )
}
await execFileAsync('tar', ['-czf', output, '-C', temporaryDirectory, 'home'])
await rm(temporaryDirectory, { recursive: true, force: true })
process.stdout.write(`${output}\n`)
