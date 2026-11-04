#!/usr/bin/env node
/**
 * Erase one Session or one principal from a stopped browser-native data
 * directory and report what each store lost.
 *
 * Exit codes: 0 erased, 1 erasure failed, 2 usage error, 3 backend running,
 * 4 target not found.
 */
import { erasePrincipal, eraseSession, findResidue, ErasureError } from './data-erasure.mjs'

function usage() {
  process.stderr.write(`usage: erase-data.mjs --data-dir <dir> --session <sessionId>\n       erase-data.mjs --data-dir <dir> --principal <principalId>\n`)
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--data-dir') options.dataDir = argv[++index]
    else if (argument === '--session') options.session = argv[++index]
    else if (argument === '--principal') options.principal = argv[++index]
    else return undefined
  }
  if (typeof options.dataDir !== 'string' || options.dataDir.length === 0) return undefined
  if ((options.session === undefined) === (options.principal === undefined)) return undefined
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options === undefined) {
    usage()
    return 2
  }
  try {
    const result = options.session !== undefined
      ? await eraseSession({ dataDir: options.dataDir, sessionId: options.session })
      : await erasePrincipal({ dataDir: options.dataDir, principalId: options.principal })
    const needles = options.session !== undefined
      ? [options.session]
      : [options.principal, result.workspaceId].filter(value => typeof value === 'string')
    result.residue = await findResidue({ dataDir: options.dataDir, needles })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.residue.length === 0 ? 0 : 1
  } catch (error) {
    const code = error instanceof ErasureError ? error.code : 'ERASURE_FAILED'
    process.stderr.write(`erase-data: ${code}: ${error instanceof Error ? error.message : String(error)}\n`)
    if (code === 'BACKEND_RUNNING') return 3
    if (code === 'SESSION_NOT_FOUND' || code === 'PRINCIPAL_NOT_FOUND') return 4
    return 1
  }
}

main().then(code => {
  process.exitCode = code
})
