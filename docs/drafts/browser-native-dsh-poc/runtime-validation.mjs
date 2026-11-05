/** Temporary validation image over the built v2 preview; never mutates shared build outputs. */
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dump, load } from 'js-yaml'

const execFileAsync = promisify(execFile)
const here = new URL('.', import.meta.url)

/** Find one patch entry by id, walking nested plugin lists and group configs. */
function findPluginEntry(value, id) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPluginEntry(item, id)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  if (value.id === id) return value
  for (const child of Object.values(value)) {
    const found = findPluginEntry(child, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Serve the real preview with reproducible VFS files and an optional browser-only preset.
 * @param {{distRoot?: string, roster?: 'browser' | 'original' | 'browser-skill' | 'browser-multi-agent' | 'browser-cpu-contention' | 'browser-session-orchestration' | 'browser-session-continuity' | 'browser-subagent' | 'browser-tool-policy' | 'browser-budget' | 'browser-session-query' | 'browser-profile-preset', largeFileChars?: number, timedQuestionTimeout?: number, contextWindow?: number, compactHeadroomTokens?: number, compactMaxTokens?: number, memoryIsolation?: boolean, toolResultPrunerThresholdChars?: number}} options - Built preview and validation fixtures; contextWindow, compactHeadroomTokens, and compactMaxTokens override the profile's model window, compaction headroom, and summary cap; toolResultPrunerThresholdChars overrides the tool-result pruner threshold so a run can compare trimmed and untrimmed requests; memoryIsolation adds the Session memory tool that only the memory validation publishes.
 * @returns {Promise<{distRoot: string, roster: string, cleanup: () => Promise<void>}>} Private image and cleanup owner.
 */
export async function createRuntimeValidationDist({
  distRoot = 'apps/web/dist', roster = 'browser', largeFileChars = 0, timedQuestionTimeout, contextWindow, compactHeadroomTokens, compactMaxTokens, memoryIsolation = false, toolResultPrunerThresholdChars,
} = {}) {
  if (!['browser', 'original', 'browser-skill', 'browser-multi-agent', 'browser-cpu-contention', 'browser-session-orchestration', 'browser-session-continuity', 'browser-subagent', 'browser-tool-policy', 'browser-budget', 'browser-session-query', 'browser-profile-preset'].includes(roster)) {
    throw new Error('roster must be browser, original, browser-skill, browser-multi-agent, browser-cpu-contention, browser-session-orchestration, browser-session-continuity, browser-subagent, browser-tool-policy, browser-budget, browser-session-query, or browser-profile-preset')
  }
  if (!Number.isSafeInteger(largeFileChars) || largeFileChars < 0 || largeFileChars > 1_000_000) {
    throw new Error('largeFileChars must be an integer between 0 and 1000000')
  }
  if (timedQuestionTimeout !== undefined
    && (!Number.isSafeInteger(timedQuestionTimeout) || timedQuestionTimeout < 1 || timedQuestionTimeout > 2_147_483)) {
    throw new Error('timedQuestionTimeout must be an integer between 1 and 2147483 seconds')
  }
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error('contextWindow must be a positive safe integer')
  }
  if (compactHeadroomTokens !== undefined && (!Number.isSafeInteger(compactHeadroomTokens) || compactHeadroomTokens <= 0)) {
    throw new Error('compactHeadroomTokens must be a positive safe integer')
  }
  if (compactMaxTokens !== undefined && (!Number.isSafeInteger(compactMaxTokens) || compactMaxTokens <= 0)) {
    throw new Error('compactMaxTokens must be a positive safe integer')
  }
  const sourceRoot = resolve(distRoot)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-browser-runtime-image-'))
  try {
    const imageRoot = join(temporary, 'image')
    const outputRoot = join(temporary, 'dist')
    const home = join(imageRoot, 'home')
    await mkdir(join(home, 'browser-validation'), { recursive: true })
    const patch = roster === 'browser' || roster === 'browser-multi-agent' || roster === 'browser-cpu-contention' || roster === 'browser-session-orchestration' || roster === 'browser-session-continuity' || roster === 'browser-subagent' || roster === 'browser-tool-policy' || roster === 'browser-budget' || roster === 'browser-session-query' || roster === 'browser-profile-preset'
      ? 'runtime-validation.cordis.patch.yml'
      : roster === 'browser-skill' ? 'worker-skill-filesystem-validation.cordis.patch.yml' : 'browser-native-profile.cordis.patch.yml'
    let profilePatch = await readFile(new URL(patch, here), 'utf8')
    if (memoryIsolation || timedQuestionTimeout !== undefined || contextWindow !== undefined || compactHeadroomTokens !== undefined || compactMaxTokens !== undefined || toolResultPrunerThresholdChars !== undefined || roster === 'browser-multi-agent' || roster === 'browser-cpu-contention' || roster === 'browser-session-orchestration' || roster === 'browser-session-continuity' || roster === 'browser-subagent' || roster === 'browser-tool-policy' || roster === 'browser-budget' || roster === 'browser-session-query' || roster === 'browser-profile-preset') {
      const entries = load(profilePatch)
      if (!Array.isArray(entries)) throw new Error('validation profile must be a Cordis patch list')
      if (memoryIsolation) {
        const preset = entries.find(entry => entry?.id === 'preset-standard')
        if (!Array.isArray(preset?.config?.plugins)) throw new Error('validation profile has no preset-standard plugin list')
        preset.config.plugins.push({ id: 'tool-memory', name: './browser-native-memory.js' })
      }
      if (contextWindow !== undefined) {
        const llm = findPluginEntry(entries, 'llm-browser-native')
        if (llm === undefined) throw new Error('validation profile has no llm-browser-native entry')
        llm.config = { ...llm.config, contextWindow }
      }
      if (compactHeadroomTokens !== undefined || compactMaxTokens !== undefined) {
        const compaction = findPluginEntry(entries, 'compaction-basic')
        if (compaction === undefined) throw new Error('validation profile has no compaction-basic entry')
        compaction.config = {
          ...compaction.config,
          ...(compactHeadroomTokens === undefined ? {} : { headroomTokens: compactHeadroomTokens }),
          ...(compactMaxTokens === undefined ? {} : { maxTokens: compactMaxTokens }),
        }
      }
      if (toolResultPrunerThresholdChars !== undefined) {
        if (!Number.isSafeInteger(toolResultPrunerThresholdChars) || toolResultPrunerThresholdChars <= 0) {
          throw new Error('toolResultPrunerThresholdChars must be a positive safe integer')
        }
        const pruner = findPluginEntry(entries, 'tool-result-pruner')
        if (pruner === undefined) throw new Error('validation profile has no tool-result-pruner entry')
        pruner.config = { ...pruner.config, thresholdChars: toolResultPrunerThresholdChars }
      }
      if (timedQuestionTimeout !== undefined) {
        const preset = entries.find(entry => entry?.id === 'preset-standard')
        if (!Array.isArray(preset?.config?.plugins)) throw new Error('validation profile has no preset-standard plugin list')
        const askUser = preset.config.plugins.filter(plugin => plugin?.id === 'tool-ask-user')
        if (askUser.length !== 1) throw new Error('validation profile must contain exactly one tool-ask-user plugin')
        askUser[0].config = {
          ...askUser[0].config,
          mode: 'timed',
          timeout: timedQuestionTimeout,
        }
      }
      if (roster === 'browser-multi-agent' || roster === 'browser-cpu-contention' || roster === 'browser-session-orchestration' || roster === 'browser-session-continuity' || roster === 'browser-profile-preset') {
        const insertion = entries.find(entry => Array.isArray(entry?.insert))
        if (insertion === undefined) throw new Error('validation profile has no root plugin insertion')
        insertion.insert.push({
          id: 'browser-native-multi-agent-probe',
          name: './browser-native-multi-agent-probe.js',
        })
        if (roster === 'browser-session-orchestration' || roster === 'browser-profile-preset') {
          insertion.insert.push({
            id: 'browser-native-session-orchestration-probe',
            name: './browser-native-session-orchestration-probe.js',
          })
        }
        if (roster === 'browser-session-continuity') {
          insertion.insert.push({
            id: 'browser-native-session-continuity-probe',
            name: './browser-native-session-continuity-probe.js',
          })
        }
        if (roster === 'browser-cpu-contention') {
          insertion.insert.push({
            id: 'browser-native-cpu-contention-probe',
            name: './browser-native-cpu-contention-probe.js',
          })
        }
      }
      if (roster === 'browser-budget') {
        const insertion = entries.find(entry => Array.isArray(entry?.insert))
        if (insertion === undefined) throw new Error('validation profile has no root plugin insertion')
        // The plugin carries no limits: it adopts the backend-published budget,
        // so the profile cannot drift from the page's budget source.
        insertion.insert.push({
          id: 'browser-native-token-budget',
          name: './browser-native-token-budget.js',
        })
      }
      if (roster === 'browser-session-query') {
        const insertion = entries.find(entry => Array.isArray(entry?.insert))
        if (insertion === undefined) throw new Error('validation profile has no root plugin insertion')
        insertion.insert.push({
          id: 'browser-native-session-query',
          name: './browser-native-session-query.js',
        })
        // The Web deployment disables full-text search; this validation image
        // opens the in-memory index on the first search to measure it.
        entries.push({
          id: 'session-query-sqlite',
          config: { path: ':memory:', openAt: 'first-search' },
        })
      }
      if (roster === 'browser-tool-policy' || roster === 'browser-profile-preset' || roster === 'browser-subagent') {
        const insertion = entries.find(entry => Array.isArray(entry?.insert))
        if (insertion === undefined) throw new Error('validation profile has no root plugin insertion')
        insertion.insert.push({
          id: 'browser-native-tool-policy',
          name: './browser-native-tool-policy.js',
          config: roster === 'browser-tool-policy'
            ? { tools: { write: 'ask', edit: 'deny', read: 'allow' }, default: 'allow' }
            : { default: 'allow' },
        })
      }
      if (roster === 'browser-subagent') {
        const preset = entries.find(entry => entry?.id === 'preset-standard')
        if (preset === undefined) throw new Error('validation profile has no preset-standard entry')
        preset.config.plugins.push({
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'spawn', agentPreset: 'standard', maxDepth: 1 },
        })
        // The stop scenario drives the public Agent cancellation path.
        const insertion = entries.find(entry => Array.isArray(entry?.insert))
        if (insertion === undefined) throw new Error('validation profile has no root plugin insertion')
        insertion.insert.push({
          id: 'browser-native-permission-probe',
          name: './browser-native-permission-probe.js',
        })
      }
      profilePatch = dump(entries, { lineWidth: -1, noRefs: true })
    }
    await writeFile(join(home, 'cordis.patch.yml'), profilePatch)
    for (const file of ['browser-native-session-persistence.js', 'browser-native-attachments.js', 'browser-native-permission-probe.js', 'browser-native-tool-policy.js', 'browser-native-token-budget.js', 'browser-native-session-query.js', 'browser-native-llm.js', 'browser-native-multi-agent-probe.js', 'browser-native-cpu-contention-probe.js', 'browser-native-session-orchestration-probe.js', 'browser-native-session-continuity-probe.js']) {
      await writeFile(join(home, file), await readFile(new URL(file, here)))
    }
    // Preset plugins resolve relative entry names against the profile directory.
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'browser-native-memory.js'), await readFile(new URL('browser-native-memory.js', here)))
    await writeFile(join(home, 'browser-validation', 'input.txt'), 'runtime=DedicatedWorker\nfixture=VFS_INPUT_READY\n')
    await writeFile(
      join(home, 'browser-validation', 'scale-input.txt'),
      Array.from({ length: 24 }, (_, index) => `scale-fixture-line-${String(index).padStart(4, '0')} ${'y'.repeat(60)}\n`).join(''),
    )
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
    await execFileAsync('tar', ['--format=ustar', '--no-xattrs', '-czf', archive, '-C', imageRoot, 'home'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const dataUrl = `data:application/gzip;base64,${(await readFile(archive)).toString('base64')}`
    await mkdir(join(outputRoot, 'preview'), { recursive: true })
    // The preview server refuses static reads that realpath outside its root, so
    // every entry is copied rather than symlinked into the image.
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      await cp(join(sourceRoot, entry.name), join(outputRoot, entry.name), { recursive: true, dereference: true })
    }
    let replaced = 0
    for (const entry of await readdir(join(outputRoot, 'preview'), { withFileTypes: true })) {
      if (!(entry.name.startsWith('bootstrap-') && entry.name.endsWith('.js'))) continue
      const target = join(outputRoot, 'preview', entry.name)
      const text = await readFile(target, 'utf8')
      const matches = text.match(/data:application\/gzip;base64,[A-Za-z0-9+/=]+/g) ?? []
      if (matches.length !== 1) throw new Error('preview bootstrap must contain exactly one inline profile overlay; rebuild preview or update the validation image builder')
      await writeFile(target, text.replace(matches[0], dataUrl))
      replaced += 1
    }
    if (replaced !== 1) throw new Error('expected one preview bootstrap; run build:preview first')
    if (roster === 'browser-budget') {
      // The preview reads this marker before the runtime probe and refuses to
      // boot when the backend does not publish the limits the plugin adopts.
      await writeFile(join(outputRoot, 'browser-native-budget-profile.json'), '{"budget":"required"}\n')
    }
    return { distRoot: outputRoot, roster, cleanup: () => rm(temporary, { recursive: true, force: true }) }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}
