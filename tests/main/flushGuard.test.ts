import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlushCoordinator, interceptOnce, OperationTracker } from '../../src/main/flushGuard'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const deferred = <T = void>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('OperationTracker', () => {
  it('is idle at once when nothing runs', async () => {
    const ops = new OperationTracker()
    let done = false
    void ops.idle().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('waits for every tracked operation, also failed ones and ones started while waiting', async () => {
    const ops = new OperationTracker()
    const a = deferred<number>()
    const b = deferred<number>()
    const c = deferred<number>()
    expect(ops.track(a.promise)).toBe(a.promise)
    void ops.track(b.promise).catch(() => undefined)
    let done = false
    void ops.idle().then(() => (done = true))
    a.resolve(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    void ops.track(c.promise)
    b.reject(new Error('x'))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    c.resolve(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })
})

describe('FlushCoordinator', () => {
  function setup(asked = 1) {
    const ops = new OperationTracker()
    const requestFlush = vi.fn(() => asked)
    const coordinator = new FlushCoordinator({ requestFlush, idle: () => ops.idle(), timeoutMs: 3000 })
    return { ops, requestFlush, coordinator }
  }

  it('asks the renderer and resolves once it acknowledges and the store is idle', async () => {
    const { ops, requestFlush, coordinator } = setup()
    const save = deferred()
    let result: string | undefined
    void coordinator.flush().then((r) => (result = r))
    expect(requestFlush).toHaveBeenCalledTimes(1)
    void ops.track(save.promise)
    coordinator.acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBeUndefined()
    save.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe('acknowledged')
  })

  it('gives up waiting for the acknowledgement after the timeout, then still waits for the store', async () => {
    const { ops, coordinator } = setup()
    const save = deferred()
    void ops.track(save.promise)
    let result: string | undefined
    void coordinator.flush().then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(2999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeUndefined()
    save.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe('timeout')
  })

  it('does not wait when there is no renderer to ask', async () => {
    const { coordinator } = setup(0)
    let result: string | undefined
    void coordinator.flush().then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe('no_renderer')
  })

  it('waits for an acknowledgement from every renderer asked', async () => {
    const { coordinator } = setup(2)
    let result: string | undefined
    void coordinator.flush().then((r) => (result = r))
    coordinator.acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBeUndefined()
    coordinator.acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe('acknowledged')
  })

  it('ignores an acknowledgement nobody waits for', async () => {
    const { coordinator } = setup()
    coordinator.acknowledge()
    let result: string | undefined
    void coordinator.flush().then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toBeUndefined()
    coordinator.acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe('acknowledged')
  })
})

describe('interceptOnce', () => {
  const event = () => ({ preventDefault: vi.fn() })

  it('prevents the first event, runs the flush, then proceeds once', async () => {
    const flush = deferred()
    const proceed = vi.fn()
    const handler = interceptOnce(() => flush.promise, proceed)
    const first = event()
    handler(first)
    expect(first.preventDefault).toHaveBeenCalled()
    // A second quit or close while flushing is held back too, and does not flush again.
    const second = event()
    handler(second)
    expect(second.preventDefault).toHaveBeenCalled()
    expect(proceed).not.toHaveBeenCalled()
    flush.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(proceed).toHaveBeenCalledTimes(1)
    // The event raised by proceeding passes.
    const third = event()
    handler(third)
    expect(third.preventDefault).not.toHaveBeenCalled()
  })

  it('still proceeds when the flush fails', async () => {
    const proceed = vi.fn()
    const handler = interceptOnce(() => Promise.reject(new Error('boom')), proceed)
    handler(event())
    await vi.advanceTimersByTimeAsync(0)
    expect(proceed).toHaveBeenCalledTimes(1)
  })

  it('lets events through without flushing when told to skip', async () => {
    const run = vi.fn(async () => undefined)
    const handler = interceptOnce(run, vi.fn(), () => true)
    const e = event()
    handler(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
