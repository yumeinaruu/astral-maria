import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { toDispatch } from '../../src/main/http/dispatchOptions'
import { sendRequest } from '../../src/main/http/sendRequest'
import { startLoad, validateLoadOptions, type LoadDeps } from '../../src/main/load/engine'
import type { LoadEvent, LoadOptions, RequestItem } from '../../src/shared/types'
import { loadWorkers, waitFor } from './loadHelpers'

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

let server: Server | undefined
let held: ServerResponse[] = []
let workers: ReturnType<typeof loadWorkers> | undefined

afterEach(async () => {
  await workers?.terminateAll()
  workers = undefined
  for (const res of held) res.destroy()
  held = []
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  }
})

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handler(req, res, Buffer.concat(chunks)))
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const okHandler: Handler = (_req, res) => res.end('hello')

function req(url: string, over: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'r',
    name: 'r',
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...over,
  }
}

const options = (over: Partial<LoadOptions> = {}): LoadOptions => ({
  path: 'collections/c',
  environmentId: null,
  vus: 1,
  durationSec: 1,
  rampUpSec: 0,
  thinkTimeMs: 0,
  timeoutSec: 30,
  ...over,
})

function run(requests: RequestItem[], opts: LoadOptions, spawnWorker?: LoadDeps['spawnWorker']) {
  workers = loadWorkers()
  const events: LoadEvent[] = []
  const deps: LoadDeps = {
    spawnWorker: spawnWorker ?? workers.spawn,
    emit: (e) => events.push(e),
    now: () => performance.now(),
  }
  const handle = startLoad(deps, { requests, displayUrls: requests.map((r) => r.url) }, opts)
  const finished = async () => {
    await waitFor(() => events.some((e) => e.type === 'finished'), 6000)
    const last = events.at(-1)!
    if (last.type !== 'finished') throw new Error('finished is not the last event')
    return last
  }
  return { handle, events, finished }
}

describe('validateLoadOptions', () => {
  it('names the first field out of range', () => {
    const bad: [Partial<LoadOptions>, string][] = [
      [{ path: '' }, 'path'],
      [{ environmentId: 5 as unknown as string }, 'environmentId'],
      [{ vus: 0 }, 'vus'],
      [{ vus: 1001 }, 'vus'],
      [{ vus: 1.5 }, 'vus'],
      [{ durationSec: 0 }, 'durationSec'],
      [{ durationSec: 3601 }, 'durationSec'],
      [{ rampUpSec: -1 }, 'rampUpSec'],
      [{ rampUpSec: 2, durationSec: 1 }, 'rampUpSec'],
      [{ thinkTimeMs: 60_001 }, 'thinkTimeMs'],
      [{ thinkTimeMs: Number.NaN }, 'thinkTimeMs'],
      [{ timeoutSec: 0 }, 'timeoutSec'],
      [{ timeoutSec: 121 }, 'timeoutSec'],
    ]
    for (const [over, field] of bad) {
      expect(() => validateLoadOptions(options(over)), field).toThrow(`invalid_load_options: ${field}`)
    }
    expect(() => validateLoadOptions(null as unknown as LoadOptions)).toThrow('invalid_load_options: options')
    expect(() =>
      validateLoadOptions(options({ vus: 1000, durationSec: 3600, rampUpSec: 3600, thinkTimeMs: 60_000 })),
    ).not.toThrow()
  })

  it('startLoad throws before spawning anything', () => {
    let spawned = 0
    const deps: LoadDeps = {
      spawnWorker: () => {
        spawned++
        throw new Error('unexpected')
      },
      emit: () => {},
      now: () => 0,
    }
    expect(() => startLoad(deps, { requests: [], displayUrls: [] }, options())).toThrow('no_requests')
    expect(() => startLoad(deps, { requests: [req('http://x')], displayUrls: ['x'] }, options({ vus: 0 }))).toThrow(
      'invalid_load_options: vus',
    )
    expect(() => startLoad(deps, { requests: [req('ftp://x')], displayUrls: ['x'] }, options())).toThrow(
      /Unsupported URL scheme/,
    )
    expect(spawned).toBe(0)
  })
})

describe('startLoad', () => {
  it('runs a 2 s, 5-VU test and reports completed requests, rps and the status breakdown', async () => {
    const base = await serve(okHandler)
    const { handle, events, finished } = run(
      [req(`${base}/ok`, { name: 'Ok' })],
      options({ vus: 5, durationSec: 2, thinkTimeMs: 5 }),
    )
    expect(events[0]).toEqual({
      testId: handle.testId,
      type: 'started',
      startedAt: expect.any(String),
      requests: [{ name: 'Ok', method: 'GET', url: `${base}/ok` }],
      workers: Math.max(1, Math.min(4, availableParallelism() - 1, 5)),
    })
    const end = await finished()
    await handle.done
    expect(end.reason).toBe('completed')
    expect(end.message).toBeUndefined()
    const { totals } = end
    expect(totals.completed).toBeGreaterThan(50)
    expect(totals.status).toEqual({ '200': totals.completed })
    expect(totals.errors).toBe(0)
    expect(totals.errorRate).toBe(0)
    expect(totals.aborted).toBe(0)
    expect(totals.errorCodes).toEqual({})
    expect(totals.bytes).toBe(totals.completed * 5)
    expect(totals.rps).toBeCloseTo(totals.completed / (end.durationMs / 1000), 6)
    expect(end.durationMs).toBeGreaterThan(1900)
    expect(totals.p50).toBeGreaterThan(0)
    expect(totals.p50).toBeLessThanOrEqual(totals.p95)
    expect(totals.p95).toBeLessThanOrEqual(totals.p99)
    expect(totals.p99).toBeLessThanOrEqual(totals.max)
    // Every second of the run, in order, adding up to the totals.
    expect(end.ticks.map((t) => t.t)).toEqual(end.ticks.map((_, i) => i))
    expect(end.ticks.length).toBeGreaterThanOrEqual(2)
    expect(end.ticks.reduce((n, t) => n + t.rps, 0)).toBe(totals.completed)
    expect(end.ticks[0].activeVus).toBe(5)
    // Live ticks came in between, with growing totals and no full histograms.
    const ticks = events.filter((e) => e.type === 'tick')
    expect(ticks.length).toBeGreaterThanOrEqual(1)
    expect(Object.keys(ticks[0].ticks[0]).sort()).toEqual(['activeVus', 'errors', 'p50', 'p95', 'p99', 'rps', 't'])
    expect(ticks[0].ticks[0].t).toBe(0)
    expect(ticks[0].totals.completed).toBeGreaterThan(0)
    expect(events.every((e) => e.testId === handle.testId)).toBe(true)
    await workers!.allExited()
  })

  it('ramps virtual users up linearly', async () => {
    const base = await serve(okHandler)
    const { finished } = run([req(`${base}/`)], options({ vus: 8, durationSec: 2, rampUpSec: 2, thinkTimeMs: 20 }))
    const end = await finished()
    // VU k starts at 2 s * k / 8: four start in the first second, all eight by the end of the second.
    expect(end.ticks[0].activeVus).toBe(4)
    expect(end.ticks[1].activeVus).toBe(8)
  })

  it('pauses each virtual user for the think time after every request', async () => {
    const base = await serve(okHandler)
    const { finished } = run([req(`${base}/`)], options({ vus: 2, durationSec: 1, thinkTimeMs: 200 }))
    const end = await finished()
    // About 1000 / 200 = 5 requests per VU.
    expect(end.totals.completed).toBeGreaterThanOrEqual(8)
    expect(end.totals.completed).toBeLessThanOrEqual(12)
  })

  it('spreads a folder load across its requests, round-robin per VU', async () => {
    const counts: Record<string, number> = {}
    const base = await serve((r, res) => {
      counts[r.url!] = (counts[r.url!] ?? 0) + 1
      res.end()
    })
    const requests = [req(`${base}/a`), req(`${base}/b`)]
    const { events, finished } = run(requests, options({ vus: 3, durationSec: 1, thinkTimeMs: 10 }))
    await finished()
    expect(counts['/a']).toBeGreaterThan(10)
    expect(counts['/b']).toBeGreaterThan(10)
    expect(Math.abs(counts['/a'] - counts['/b'])).toBeLessThanOrEqual(3)
    expect(events[0].type === 'started' && events[0].requests.length).toBe(2)
  })

  it('counts 5xx responses as errors in the error rate', async () => {
    let n = 0
    const sent = { ok: 0, failed: 0 }
    const base = await serve((_r, res) => {
      const fail = ++n % 3 === 0
      sent[fail ? 'failed' : 'ok']++
      res.statusCode = fail ? 500 : 200
      res.end()
    })
    const { finished } = run([req(`${base}/`)], options({ vus: 2, durationSec: 1, thinkTimeMs: 5 }))
    const { totals } = await finished()
    expect(sent.failed).toBeGreaterThan(5)
    expect(totals.status).toEqual({ '200': sent.ok, '500': sent.failed })
    expect(totals.completed).toBe(sent.ok + sent.failed)
    expect(totals.errors).toBe(sent.failed)
    expect(totals.errorCodes).toEqual({ '5xx': sent.failed })
    expect(totals.errorRate).toBeCloseTo(sent.failed / (sent.ok + sent.failed), 9)
  })

  it('backs off after a refused connection instead of spinning, and counts ECONNREFUSED', async () => {
    const base = await serve(okHandler)
    server!.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
    const { finished } = run([req(`${base}/`)], options({ vus: 1, durationSec: 1, thinkTimeMs: 0 }))
    const { totals, reason } = await finished()
    expect(reason).toBe('completed')
    // At least 50 ms between attempts: about 20 in one second, not thousands.
    expect(totals.completed).toBeGreaterThanOrEqual(5)
    expect(totals.completed).toBeLessThanOrEqual(22)
    expect(totals.errorCodes).toEqual({ ECONNREFUSED: totals.completed })
    expect(totals.errorRate).toBe(1)
    expect(totals.status).toEqual({})
  })

  it('counts requests that run past the timeout as timeout', async () => {
    const base = await serve((_r, res) => {
      held.push(res)
    })
    const { finished } = run([req(`${base}/`)], options({ vus: 2, durationSec: 1, timeoutSec: 1 }))
    const { totals, reason } = await finished()
    expect(reason).toBe('completed')
    expect(totals.errorCodes).toEqual({ timeout: 2 })
    expect(totals.completed).toBe(2)
    expect(totals.aborted).toBe(0)
  })

  it('stop aborts every worker within 2 s, keeps the partial report and sends nothing after finished', async () => {
    let answered = 0
    const base = await serve((r, res) => {
      if (r.url === '/slow') held.push(res)
      else {
        answered++
        res.end()
      }
    })
    const requests = [req(`${base}/fast`), req(`${base}/slow`)]
    const { handle, events, finished } = run(requests, options({ vus: 4, durationSec: 30, thinkTimeMs: 20 }))
    // Each VU answers /fast once, then hangs on /slow.
    await waitFor(() => answered >= 2 && held.length >= 4)
    const stoppedAt = performance.now()
    handle.stop()
    const end = await finished()
    expect(performance.now() - stoppedAt).toBeLessThan(2000)
    await handle.done
    expect(end.reason).toBe('stopped')
    expect(end.totals.completed).toBeGreaterThan(0)
    expect(end.totals.aborted).toBe(4)
    expect(end.totals.status['200']).toBe(end.totals.completed)
    await workers!.allExited()
    const count = events.length
    handle.stop()
    await new Promise((r) => setTimeout(r, 300))
    expect(events.length).toBe(count)
  })

  it('ends with reason error, naming the failure, when a worker crashes', async () => {
    const base = await serve(okHandler)
    let spawned = 0
    const { finished } = run([req(`${base}/`)], options({ vus: 3, durationSec: 30 }), (init) => {
      spawned++
      if (spawned === 1) return new Worker('throw new Error("worker exploded")', { eval: true })
      return workers!.spawn(init)
    })
    const end = await finished()
    expect(end.reason).toBe('error')
    expect(end.message).toMatch(/worker exploded/)
    await workers!.allExited()
  })

  it('sends the same bytes and headers as Send for every body mode', async () => {
    const seen = new Map<string, { method: string; url: string; headers: IncomingMessage['headers']; body: string }>()
    const base = await serve((r, res, body) => {
      const key = `${r.url}`.split('?')[0]
      if (!seen.has(key)) {
        seen.set(key, { method: r.method!, url: r.url!, headers: r.headers, body: body.toString('utf8') })
      }
      res.end()
    })
    const kv = (key: string, value: string) => ({ key, value, enabled: true })
    const requests: RequestItem[] = [
      req(`${base}/raw`, {
        method: 'POST',
        headers: [kv('X-One', '1')],
        body: { mode: 'raw', language: 'json', content: '{"a":"é"}' },
        auth: { type: 'bearer', token: 'tok' },
      }),
      req(`${base}/urlencoded`, {
        method: 'PUT',
        params: [kv('q', 'a b')],
        body: { mode: 'urlencoded', fields: [kv('a', 'x y'), kv('b', '&=')] },
        auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' },
      }),
      req(`${base}/formdata`, {
        method: 'POST',
        body: { mode: 'formdata', fields: [kv('f', 'one'), kv('g', 'two')] },
        auth: { type: 'basic', username: 'u', password: 'p' },
      }),
      req(`${base}/get`, { headers: [kv('Accept-Encoding', 'identity'), kv('Cookie', 'a=1'), kv('cookie', 'b=2')] }),
    ]
    const { finished } = run(requests, options({ vus: 1, durationSec: 1, thinkTimeMs: 150 }))
    await finished()
    const fromLoad = new Map(seen)
    seen.clear()
    for (const r of requests) expect((await sendRequest(r)).ok).toBe(true)
    const normalize = (rec: { method: string; url: string; headers: IncomingMessage['headers']; body: string }) => {
      const boundary = /boundary=(\S+)/.exec(String(rec.headers['content-type']))?.[1]
      const strip = (s: string) => (boundary ? s.split(boundary).join('BOUNDARY') : s)
      return {
        ...rec,
        headers: Object.fromEntries(Object.entries(rec.headers).map(([k, v]) => [k, strip(String(v))])),
        body: strip(rec.body),
      }
    }
    expect(fromLoad.size).toBe(4)
    for (const [path, sent] of seen) expect(normalize(fromLoad.get(path)!), path).toEqual(normalize(sent))
    expect(toDispatch(requests[0]).headers.authorization).toBe('Bearer tok')
  })
})
