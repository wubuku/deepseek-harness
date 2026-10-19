import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const directory = resolve(import.meta.dirname, 'profile-overlay')
await mkdir(resolve(directory, 'home'), { recursive: true })
const base = resolve(import.meta.dirname, '../profile-overlay')
for (const name of ['browser-native-session-persistence.js', 'browser-native-llm.js', 'copilotkit-frontend-tools.js', 'copilotkit-user-questions.js']) {
  await writeFile(resolve(directory, 'home', name), await readFile(resolve(base, name)))
}
await writeFile(resolve(directory, 'home/cordis.patch.yml'), await readFile(resolve(directory, 'cordis.patch.yml')))
execFileSync('tar', ['-czf', resolve(directory, 'complex-profile-overlay.tar.gz'), '-C', directory, 'home'])
