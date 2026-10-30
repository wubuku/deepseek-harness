import { describe, expect, it } from 'vitest'
import { runBrowserNativeCpuContentionWorkload } from '../browser-native-cpu-contention.ts'

const identity = {
  sessionId: 'cpu-probe-session',
  callId: 'cpu-probe-call',
}

describe('Browser-Native CPU contention workload', () => {
  it('rejects durations outside the bounded probe budget', async () => {
    await expect(runBrowserNativeCpuContentionWorkload({
      ...identity,
      mode: 'blocking',
      durationMs: 2_001,
      signal: new AbortController().signal,
    }, () => {})).rejects.toThrow('durationMs must be an integer between 20 and 2000')
  })

  it('records completion for a bounded synchronous workload', async () => {
    const events: string[] = []
    const result = await runBrowserNativeCpuContentionWorkload({
      ...identity,
      mode: 'blocking',
      durationMs: 20,
      signal: new AbortController().signal,
    }, event => events.push(event.stage))

    expect(events).toEqual(['started', 'completed'])
    expect(result).toMatchObject({ mode: 'blocking', elapsedMs: expect.any(Number) })
    expect(result.iterations).toBeGreaterThan(0)
  })

  it('yields between slices and observes AbortSignal before completing', async () => {
    const controller = new AbortController()
    const events: string[] = []
    let timerRan = false
    const abortTimer = setTimeout(() => {
      timerRan = true
      controller.abort(new Error('cooperative test cancellation'))
    }, 20)

    try {
      await expect(runBrowserNativeCpuContentionWorkload({
        ...identity,
        mode: 'cooperative',
        durationMs: 1_000,
        sliceMs: 2,
        signal: controller.signal,
      }, event => events.push(event.stage))).rejects.toThrow('cooperative test cancellation')
    } finally {
      clearTimeout(abortTimer)
    }

    expect(timerRan).toBe(true)
    expect(events).toEqual(['started', 'cancelled'])
  })
})
