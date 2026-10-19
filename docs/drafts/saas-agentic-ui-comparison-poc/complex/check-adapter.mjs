import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
const files = ['domain.ts', 'bridge.ts', 'dsh-segmented-agent.ts'].map(name => resolve(import.meta.dirname, name))
const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'], paths: {
  '@deepseek-ai/dsh-api-session-controller/client': [resolve(root, 'packages/api/session-controller/lib/types/client/index.d.ts')],
  '@deepseek-ai/dsh-llm': [resolve(root, 'packages/llm/llm/lib/types/index.d.ts')],
} }
for (const path of Object.values(options.paths).flat()) readFileSync(path)
const program = ts.createProgram(files, options)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }))
  process.exitCode = 1
} else console.log('复杂实验 domain / bridge / 分段适配器 strict 类型检查通过（依赖已构建的 DSH 声明）')
