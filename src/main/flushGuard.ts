/**
 * Quit and window-close coordination: before the app quits (or a window closes) the renderer is asked to write all
 * unsaved drafts, and the main process waits for its acknowledgement and for store operations still in flight.
 * Electron is injected, so this is plain logic that unit tests drive with fakes.
 */

/** Tracks in-flight store operations so a quit can wait for them. */
export class OperationTracker {
  private readonly running = new Set<Promise<unknown>>()

  /** Returns `operation` unchanged; it counts as in flight until it settles. */
  track<T>(operation: Promise<T>): Promise<T> {
    this.running.add(operation)
    const forget = (): void => {
      this.running.delete(operation)
    }
    operation.then(forget, forget)
    return operation
  }

  /** Resolves once nothing is in flight, including operations started while waiting. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running])
  }
}

export interface FlushDeps {
  /** Asks every live renderer to flush its drafts; returns how many were asked. */
  requestFlush(): number
  /** Resolves when no store operation is in flight. */
  idle(): Promise<void>
  /** How long to wait for the renderers' acknowledgements. */
  timeoutMs: number
}

export type FlushOutcome = 'acknowledged' | 'timeout' | 'no_renderer'

export class FlushCoordinator {
  private waiting: { left: number; done(): void } | null = null

  constructor(private readonly deps: FlushDeps) {}

  /** A renderer finished flushing (the `app.flushed` API call). */
  acknowledge(): void {
    const w = this.waiting
    if (!w) return
    w.left--
    if (w.left <= 0) {
      this.waiting = null
      w.done()
    }
  }

  async flush(): Promise<FlushOutcome> {
    const asked = this.deps.requestFlush()
    let outcome: FlushOutcome = 'no_renderer'
    if (asked > 0) {
      outcome = await new Promise<FlushOutcome>((resolve) => {
        const timer = setTimeout(() => {
          this.waiting = null
          resolve('timeout')
        }, this.deps.timeoutMs)
        this.waiting = {
          left: asked,
          done: () => {
            clearTimeout(timer)
            resolve('acknowledged')
          },
        }
      })
    }
    await this.deps.idle()
    return outcome
  }
}

/**
 * An event handler (for `before-quit` or a window's `close`) that prevents the first event, runs `flush`, then calls
 * `proceed` (which raises the event again); that one, and any later one, passes. Events raised while flushing are
 * prevented too. `skip` lets events pass untouched, e.g. a window closing because the app already flushed and quits.
 */
export function interceptOnce(
  flush: () => Promise<unknown>,
  proceed: () => void,
  skip: () => boolean = () => false,
): (event: { preventDefault(): void }) => void {
  let state: 'idle' | 'flushing' | 'done' = 'idle'
  return (event) => {
    if (state === 'done' || skip()) return
    event.preventDefault()
    if (state === 'flushing') return
    state = 'flushing'
    void flush()
      .catch(() => undefined)
      .then(() => {
        state = 'done'
        proceed()
      })
  }
}
