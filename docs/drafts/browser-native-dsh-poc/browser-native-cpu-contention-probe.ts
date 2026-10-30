import type { Context } from '@deepseek-ai/cordis'
import type { StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { runBrowserNativeCpuContentionWorkload } from './browser-native-cpu-contention.ts'
import type {
  BrowserNativeCpuContentionEvent,
  BrowserNativeCpuContentionInput,
  BrowserNativeCpuContentionResult,
} from './browser-native-cpu-contention.ts'

const MAX_SLICE_MS = 50

/** Create a Worker-only static module that registers the two bounded probe tools. */
export function createBrowserNativeCpuContentionProbe(
  emit: (event: BrowserNativeCpuContentionEvent) => void,
): { readonly factory: StaticModuleFactory } {
  const output: ToolDefinition['output'] = {
    schema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        mode: { type: 'string' as const },
        elapsedMs: { type: 'integer' as const },
        iterations: { type: 'integer' as const },
        checksum: { type: 'integer' as const },
      },
      required: ['mode', 'elapsedMs', 'iterations', 'checksum'],
    },
    render: (_args: unknown, value: BrowserNativeCpuContentionResult) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
  const parseArguments = (value: unknown, mode: BrowserNativeCpuContentionInput['mode']): {
    readonly durationMs: number
    readonly sliceMs?: number
  } => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('CPU probe arguments must be an object')
    const record = value as Record<string, unknown>
    const allowedKeys = mode === 'blocking' ? ['durationMs'] : ['durationMs', 'sliceMs']
    if (Object.keys(record).some(key => !allowedKeys.includes(key))) throw new TypeError('CPU probe arguments contain an unknown field')
    if (!Number.isSafeInteger(record.durationMs) || Number(record.durationMs) < 20 || Number(record.durationMs) > 2_000) {
      throw new RangeError('durationMs must be an integer between 20 and 2000')
    }
    if (mode === 'cooperative' && record.sliceMs !== undefined
      && (!Number.isSafeInteger(record.sliceMs) || Number(record.sliceMs) < 1 || Number(record.sliceMs) > MAX_SLICE_MS)) {
      throw new RangeError(`sliceMs must be an integer between 1 and ${MAX_SLICE_MS}`)
    }
    return {
      durationMs: Number(record.durationMs),
      ...(record.sliceMs === undefined ? {} : { sliceMs: Number(record.sliceMs) }),
    }
  }
  const createTool = (mode: BrowserNativeCpuContentionInput['mode']): ToolDefinition => ({
    name: mode === 'blocking' ? 'browser_cpu_blocking_probe' : 'browser_cpu_cooperative_probe',
    description: mode === 'blocking'
      ? 'Validation-only bounded synchronous CPU work in the Browser-Native Worker.'
      : 'Validation-only sliced CPU work that yields to the Worker task queue and observes cancellation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        durationMs: { type: 'integer', description: 'Work duration in milliseconds, from 20 to 2000.' },
        ...(mode === 'cooperative' ? {
          sliceMs: { type: 'integer', description: `Maximum CPU slice in milliseconds, from 1 to ${MAX_SLICE_MS}; defaults to 10.` },
        } : {}),
      },
      required: ['durationMs'],
    },
    output,
    async execute(value, execution) {
      const args = parseArguments(value, mode)
      return await runBrowserNativeCpuContentionWorkload({
        mode,
        durationMs: args.durationMs,
        ...(args.sliceMs === undefined ? {} : { sliceMs: args.sliceMs }),
        sessionId: execution.agent?.id ?? 'unowned',
        callId: execution.callId,
        signal: execution.signal,
      }, emit)
    },
  })

  const blockingTool = createTool('blocking')
  const cooperativeTool = createTool('cooperative')

  const plugin = Object.assign((ctx: Context): void => {
    ctx.effect(() => {
      const disposeBlocking = ctx.tools.register(blockingTool)
      const disposeCooperative = ctx.tools.register(cooperativeTool)
      return () => {
        disposeCooperative()
        disposeBlocking()
      }
    }, 'browser-native CPU contention probe')
  }, { inject: ['tools'] as const })
  return { factory: () => plugin }
}
