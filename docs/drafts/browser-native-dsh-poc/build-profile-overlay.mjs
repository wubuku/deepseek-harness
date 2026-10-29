import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const directory = new URL('.', import.meta.url)
const output = new URL('browser-native-profile-overlay.tar.gz', directory)
const temporary = await mkdtemp(join(dirname(output.pathname), '.profile-overlay-'))

try {
  const home = join(temporary, 'home')
  await mkdir(home, { recursive: true })
  await cp(new URL('browser-native-profile.cordis.patch.yml', directory), join(home, 'cordis.patch.yml'))
  await cp(new URL('browser-native-session-persistence.js', directory), join(home, 'browser-native-session-persistence.js'))
  await cp(new URL('browser-native-attachments.js', directory), join(home, 'browser-native-attachments.js'))
  await cp(new URL('browser-native-permission-probe.js', directory), join(home, 'browser-native-permission-probe.js'))
  await cp(new URL('browser-native-llm.js', directory), join(home, 'browser-native-llm.js'))
  await execFileAsync('tar', [
    '--format=ustar', '--no-xattrs', '-czf', output.pathname, '-C', temporary, 'home',
  ], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
