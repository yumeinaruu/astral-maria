// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { initialState, loadTabId, useApp } from '../../src/renderer/src/state/store'
import type {
  CollectionTree,
  Environment,
  LoadEvent,
  LoadOptions,
  LoadTick,
  LoadTotals,
  RequestNode,
} from '../../src/shared/types'
import {
  collectionTree,
  folderNode,
  installApi,
  installEvents,
  requestNode,
  uninstallEvents,
  type MockApi,
  type MockEvents,
} from './helpers'

vi.mock('../../src/renderer/src/components/CodeEditor', () => ({
  CodeEditor: (p: { value: string; label?: string; onChange(v: string): void }) => (
    <textarea aria-label={p.label ?? 'code'} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}))

const SHOP = 'collections/shop'
const USERS = 'collections/shop/users'
const GET_USERS = 'collections/shop/users/get-users.request.json'
const CREATE_USER = 'collections/shop/users/create-user.request.json'
const HEALTH = 'collections/shop/health.request.json'
const LAN = 'collections/shop/lan.request.json'

function withUrl(node: RequestNode, url: string): RequestNode {
  return { ...node, request: { ...node.request, url } }
}

function tree(): CollectionTree[] {
  return [
    {
      ...collectionTree(SHOP, 'Shop', [
        folderNode(USERS, 'Users', [
          withUrl(requestNode(GET_USERS, 'Get users'), '{{baseUrl}}/users?key={{apiKey}}'),
          withUrl(requestNode(CREATE_USER, 'Create user', 'POST'), '{{baseUrl}}/users'),
        ]),
        withUrl(requestNode(HEALTH, 'Health'), 'http://127.0.0.1:3000/health'),
        withUrl(requestNode(LAN, 'Lan'), 'http://192.168.1.5/ping'),
      ]),
      variables: [{ key: 'baseUrl', value: 'http://localhost:9', enabled: true }],
    },
  ]
}

const DEV: Environment = {
  id: 'env-dev',
  name: 'Dev',
  variables: [
    { key: 'baseUrl', value: 'https://api.example.com', secret: false, enabled: true },
    { key: 'apiKey', value: 'k-123456', secret: true, enabled: true },
  ],
}

let events: MockEvents

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
  localStorage.clear()
  useApp.setState(initialState())
  events = installEvents()
})
afterEach(() => {
  cleanup()
  uninstallEvents()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function mounted(overrides: Parameters<typeof installApi>[0] = {}, env = false): Promise<MockApi> {
  const api = installApi({
    ...overrides,
    collections: { list: vi.fn().mockResolvedValue({ collections: tree(), errors: [] }), ...overrides.collections },
    environments: {
      list: vi.fn().mockResolvedValue({ environments: env ? [DEV] : [], errors: [] }),
      ...overrides.environments,
    },
  })
  await useApp.getState().openWorkspace('/tmp/demo')
  if (env) useApp.getState().setActiveEnvironment(DEV.id)
  useApp.getState().setExpanded(USERS, true)
  render(<App />)
  return api
}

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms))
const row = (name: string) => screen.getByRole('treeitem', { name })
const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'Open tabs' }))
    .queryAllByRole('tab')
    .map((t) => t.textContent)

function loadFromMenu(name: string): void {
  fireEvent.contextMenu(row(name))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Load test' }))
}

const startButton = () => screen.getByRole('button', { name: 'Start load test' })
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement

function totals(patch: Partial<LoadTotals> = {}): LoadTotals {
  return {
    completed: 120,
    errors: 0,
    aborted: 0,
    bytes: 1200,
    rps: 40,
    p50: 3.2,
    p95: 8.4,
    p99: 12.1,
    mean: 4,
    max: 20,
    errorRate: 0,
    status: { '200': 120 },
    errorCodes: {},
    ...patch,
  }
}

function second(t: number, patch: Partial<LoadTick> = {}): LoadTick {
  return { t, rps: 40, errors: 0, activeVus: 5, p50: 3, p95: 8, p99: 12, ...patch }
}

const STARTED: LoadEvent = {
  testId: 'load-1',
  type: 'started',
  startedAt: '2026-10-23T08:04:05.000Z',
  requests: [{ name: 'Health', method: 'GET', url: 'http://127.0.0.1:3000/health' }],
  workers: 1,
}

function emit(event: LoadEvent): Promise<void> {
  return act(async () => events.emitLoad(event))
}

/** Opens the Health load test, starts it and lets the start resolve with `load-1` after its started event. */
async function started(api?: MockApi): Promise<MockApi> {
  const mock = api ?? (await mounted())
  loadFromMenu('Health')
  fireEvent.click(startButton())
  await tick()
  await emit(STARTED)
  return mock
}

describe('opening the Load test tab', () => {
  it('opens from the request menu as "Load · <name>" with id load:<path>', async () => {
    await mounted()
    loadFromMenu('Health')
    expect(loadTabId(HEALTH)).toBe(`load:${HEALTH}`)
    expect(useApp.getState().activePath).toBe(loadTabId(HEALTH))
    expect(tabNames()).toEqual(['Load · Health'])
    loadFromMenu('Health')
    expect(useApp.getState().openTabs).toHaveLength(1)
  })

  it('opens from the folder and collection menus with their requests', async () => {
    await mounted()
    loadFromMenu('Users')
    expect(tabNames()).toEqual(['Load · Users'])
    const list = screen.getByRole('list', { name: 'Target requests' })
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      'GET Get users',
      'POST Create user',
    ])
    loadFromMenu('Shop')
    expect(tabNames()).toEqual(['Load · Users', 'Load · Shop'])
    expect(within(screen.getByRole('list', { name: 'Target requests' })).getAllByRole('listitem')).toHaveLength(4)
  })

  it('opens from the More menu of the request header', async () => {
    await mounted()
    fireEvent.click(row('Health'))
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Load test' }))
    expect(useApp.getState().activePath).toBe(loadTabId(HEALTH))
  })

  it('opens from the Load test button of the collection settings tab', async () => {
    await mounted()
    fireEvent.contextMenu(row('Shop'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load test' }))
    expect(useApp.getState().activePath).toBe(loadTabId(SHOP))
  })

  it('shows a Gauge icon on the tab', async () => {
    await mounted()
    loadFromMenu('Health')
    expect(screen.getByRole('tab', { name: 'Load · Health' }).querySelector('svg.lucide-gauge')).not.toBeNull()
  })
})

describe('configuration', () => {
  it('has the defaults, the environment, the masked targets and the notes', async () => {
    await mounted({}, true)
    loadFromMenu('Users')
    expect(field('Virtual users').value).toBe('10')
    expect(field('Duration (s)').value).toBe('30')
    expect(field('Ramp-up (s)').value).toBe('0')
    expect(field('Think time (ms)').value).toBe('0')
    expect(field('Timeout (s)').value).toBe('30')
    expect(screen.getByText('Environment: Dev')).toBeVisible()
    expect(screen.getByText('https://api.example.com/users?key=••••')).toBeVisible()
    expect(screen.queryByText(/k-123456/)).toBeNull()
    expect(
      screen.getByText('Scripts are not run during a load test; variables are resolved once at start.'),
    ).toBeVisible()
    expect(screen.getByText('Redirects are not followed during a load test.')).toBeVisible()
  })

  it.each([
    ['Virtual users', '0'],
    ['Virtual users', '1001'],
    ['Duration (s)', '0'],
    ['Duration (s)', '3601'],
    ['Think time (ms)', '60001'],
    ['Timeout (s)', '0'],
    ['Timeout (s)', '121'],
    ['Virtual users', '2.5'],
  ])('flags %s = %s and disables Start', async (label, value) => {
    await mounted()
    loadFromMenu('Health')
    fireEvent.change(field(label), { target: { value } })
    expect(field(label)).toHaveAttribute('aria-invalid', 'true')
    expect(startButton()).toBeDisabled()
  })

  it('bounds the ramp-up by the duration', async () => {
    await mounted()
    loadFromMenu('Health')
    fireEvent.change(field('Duration (s)'), { target: { value: '10' } })
    fireEvent.change(field('Ramp-up (s)'), { target: { value: '11' } })
    expect(field('Ramp-up (s)')).toHaveAttribute('aria-invalid', 'true')
    expect(startButton()).toBeDisabled()
    fireEvent.change(field('Ramp-up (s)'), { target: { value: '10' } })
    expect(field('Ramp-up (s)')).toHaveAttribute('aria-invalid', 'false')
    expect(startButton()).toBeEnabled()
  })

  it('starts with the options and the active environment', async () => {
    const api = await mounted({}, true)
    loadFromMenu('Health')
    fireEvent.change(field('Virtual users'), { target: { value: '5' } })
    fireEvent.change(field('Duration (s)'), { target: { value: '3' } })
    fireEvent.change(field('Ramp-up (s)'), { target: { value: '1' } })
    fireEvent.change(field('Think time (ms)'), { target: { value: '100' } })
    fireEvent.change(field('Timeout (s)'), { target: { value: '5' } })
    fireEvent.click(startButton())
    await tick()
    expect(api.load.start).toHaveBeenCalledWith({
      path: HEALTH,
      environmentId: DEV.id,
      vus: 5,
      durationSec: 3,
      rampUpSec: 1,
      thinkTimeMs: 100,
      timeoutSec: 5,
    } satisfies LoadOptions)
  })

  it('writes unsaved drafts before load.start', async () => {
    const api = await mounted()
    fireEvent.click(row('Health'))
    useApp.getState().editDraft(HEALTH, (d) => ({ ...d, url: 'http://127.0.0.1:3000/typed' }))
    loadFromMenu('Health')
    fireEvent.click(startButton())
    await tick()
    expect(api.collections.saveRequest).toHaveBeenCalled()
    expect(api.load.start).toHaveBeenCalled()
    expect(api.collections.saveRequest.mock.invocationCallOrder[0]!).toBeLessThan(
      api.load.start.mock.invocationCallOrder[0]!,
    )
  })

  it.each(['load_busy', 'invalid_load_options: vus', 'no_requests'])(
    'shows a rejected start (%s) inline',
    async (message) => {
      await mounted({ load: { start: vi.fn().mockRejectedValue(new Error(message)) } })
      loadFromMenu('Health')
      fireEvent.click(startButton())
      await tick()
      expect(screen.getByRole('alert')).toHaveTextContent(message)
      expect(startButton()).toBeEnabled()
    },
  )
})

describe('the target host check', () => {
  it('asks once for a public host, and remembers the answer', async () => {
    const api = await mounted({}, true)
    loadFromMenu('Users')
    fireEvent.click(startButton())
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Only load-test systems you own or have permission to test.')
    expect(dialog).toHaveTextContent('api.example.com')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await tick()
    expect(api.load.start).not.toHaveBeenCalled()

    fireEvent.click(startButton())
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start' }))
    await tick()
    expect(api.load.start).toHaveBeenCalledTimes(1)
    await emit({ ...STARTED, testId: 'load-1' })
    await emit({ testId: 'load-1', type: 'finished', reason: 'completed', durationMs: 10, totals: totals(), ticks: [] })

    // Confirmed hosts are kept in prefs: no question the next time.
    api.load.start.mockResolvedValueOnce('load-2')
    fireEvent.click(screen.getByRole('button', { name: 'New test' }))
    fireEvent.click(startButton())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await tick()
    expect(api.load.start).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem('astral.loadConfirmedHosts')!)).toEqual(['api.example.com'])
  })

  it.each([
    ['Health', '127.0.0.1'],
    ['Lan', '192.168.1.5'],
  ])('does not ask for %s (%s)', async (name) => {
    const api = await mounted()
    loadFromMenu(name)
    fireEvent.click(startButton())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await tick()
    expect(api.load.start).toHaveBeenCalledTimes(1)
  })
})

describe('results', () => {
  it('renders streamed ticks as tiles and chart paths', async () => {
    const container = document.body
    await started()
    expect(screen.getByRole('progressbar', { name: 'Elapsed' })).toHaveAttribute('aria-valuenow', '0')
    await emit({
      testId: 'load-1',
      type: 'tick',
      ticks: [second(0, { rps: 38 }), second(1, { rps: 42 })],
      totals: totals({ completed: 80, rps: 40 }),
    })
    const tile = (label: string) => screen.getByRole('group', { name: label })
    expect(tile('Requests')).toHaveTextContent('80')
    expect(tile('Req/s')).toHaveTextContent('40.0')
    expect(tile('p50')).toHaveTextContent('3.2')
    expect(tile('p95')).toHaveTextContent('8.4')
    expect(tile('p99')).toHaveTextContent('12')
    expect(tile('Error rate')).toHaveTextContent('0%')
    expect(tile('Active VUs')).toHaveTextContent('5')
    expect(screen.getByRole('progressbar', { name: 'Elapsed' })).toHaveAttribute('aria-valuenow', '2')
    expect(container.querySelector('path[data-series="rps"]')?.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+ L/)

    // A later tick carries only the new second; it is appended.
    await emit({ testId: 'load-1', type: 'tick', ticks: [second(2)], totals: totals({ completed: 120 }) })
    expect(container.querySelector('path[data-series="rps"]')?.getAttribute('d')?.split('L')).toHaveLength(3)
    for (const key of ['p50', 'p95', 'p99']) {
      expect(container.querySelector(`path[data-series="${key}"]`)).not.toBeNull()
    }
    expect(tile('Requests')).toHaveTextContent('120')
  })

  it('marks a non-zero error rate and lists the status codes and errors', async () => {
    await started()
    await emit({
      testId: 'load-1',
      type: 'tick',
      ticks: [second(0)],
      totals: totals({
        completed: 100,
        errors: 25,
        errorRate: 0.25,
        status: { '200': 75, '503': 20 },
        errorCodes: { '5xx': 20, ECONNRESET: 5 },
      }),
    })
    const rate = screen.getByRole('group', { name: 'Error rate' })
    expect(rate).toHaveTextContent('25%')
    expect(rate).toHaveClass('load-tile-error')
    expect(rate.querySelector('svg')).not.toBeNull()
    const rows = (name: string) =>
      within(screen.getByRole('table', { name }))
        .getAllByRole('row')
        .map((r) => [...r.children].map((c) => c.textContent))
    expect(rows('Status codes')).toEqual([
      ['Code', 'Count', '%'],
      ['200', '75', '78.9%'],
      ['503', '20', '21.1%'],
    ])
    expect(rows('Errors')).toEqual([
      ['Code', 'Count', '%'],
      ['5xx', '20', '80%'],
      ['ECONNRESET', '5', '20%'],
    ])
  })

  it('takes the full series from the finished event and shows the end reason', async () => {
    await started()
    await emit({ testId: 'load-1', type: 'tick', ticks: [second(0)], totals: totals() })
    await emit({
      testId: 'load-1',
      type: 'finished',
      reason: 'completed',
      durationMs: 3010,
      totals: totals({ completed: 200 }),
      ticks: [second(0), second(1), second(2)],
    })
    expect(screen.getByText('Completed')).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Active VUs' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Requests' })).toHaveTextContent('200')
    expect(document.querySelector('path[data-series="rps"]')?.getAttribute('d')?.split('L')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Run again' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'New test' })).toBeVisible()
  })

  it('shows the message of a test that failed', async () => {
    await started()
    await emit({
      testId: 'load-1',
      type: 'finished',
      reason: 'error',
      message: 'worker exited',
      durationMs: 10,
      totals: totals(),
      ticks: [],
    })
    expect(screen.getByText('Failed: worker exited')).toBeVisible()
  })

  it('adopts events that arrive before start resolves, and ignores other tests', async () => {
    let resolve!: (id: string) => void
    await mounted({ load: { start: vi.fn().mockReturnValue(new Promise<string>((r) => (resolve = r))) } })
    loadFromMenu('Health')
    fireEvent.click(startButton())
    await tick()
    await emit({ testId: 'other', type: 'tick', ticks: [second(0)], totals: totals({ completed: 999 }) })
    await emit({ ...STARTED, testId: 'load-7' })
    await emit({ testId: 'load-7', type: 'tick', ticks: [second(0)], totals: totals({ completed: 11 }) })
    expect(screen.getByRole('group', { name: 'Requests' })).toHaveTextContent('11')
    await act(async () => resolve('load-7'))
    await emit({ testId: 'load-7', type: 'tick', ticks: [second(1)], totals: totals({ completed: 22 }) })
    expect(screen.getByRole('group', { name: 'Requests' })).toHaveTextContent('22')
  })

  it('Stop calls load.stop with the test id', async () => {
    const api = await started()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await tick()
    expect(api.load.stop).toHaveBeenCalledWith('load-1')
  })

  it('closing a running tab stops the test; its late finished event is ignored', async () => {
    const api = await started()
    fireEvent.click(screen.getByRole('button', { name: 'Close Load · Health' }))
    await tick()
    expect(api.load.stop).toHaveBeenCalledWith('load-1')
    expect(useApp.getState().openTabs).toEqual([])
    await emit({ testId: 'load-1', type: 'finished', reason: 'stopped', durationMs: 3, totals: totals(), ticks: [] })
    loadFromMenu('Health')
    expect(startButton()).toBeVisible()
  })

  it('closing a finished tab does not call stop', async () => {
    const api = await started()
    await emit({ testId: 'load-1', type: 'finished', reason: 'completed', durationMs: 3, totals: totals(), ticks: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Close Load · Health' }))
    await tick()
    expect(api.load.stop).not.toHaveBeenCalled()
  })

  it('switching the workspace forgets the tests; late events are ignored', async () => {
    await started()
    await act(async () => {
      await useApp.getState().leaveWorkspace()
    })
    expect(useApp.getState().loads).toEqual({})
    await emit({ testId: 'load-1', type: 'finished', reason: 'stopped', durationMs: 3, totals: totals(), ticks: [] })
    expect(useApp.getState().loads).toEqual({})
  })

  it('deleting the request closes its Load test tab and stops the test', async () => {
    const api = await started()
    api.collections.list.mockResolvedValue({ collections: [], errors: [] })
    await act(() => useApp.getState().remove(HEALTH))
    expect(useApp.getState().openTabs).toEqual([])
    expect(api.load.stop).toHaveBeenCalledWith('load-1')
  })

  it('Run again starts with the same options', async () => {
    const api = await started()
    await emit({ testId: 'load-1', type: 'finished', reason: 'completed', durationMs: 3, totals: totals(), ticks: [] })
    api.load.start.mockResolvedValueOnce('load-2')
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    await tick()
    expect(api.load.start).toHaveBeenCalledTimes(2)
    expect(api.load.start.mock.calls[1]![0]).toEqual(api.load.start.mock.calls[0]![0])
  })

  it('exports the report through load.saveReport', async () => {
    const api = await started()
    await emit({
      testId: 'load-1',
      type: 'finished',
      reason: 'completed',
      durationMs: 3010,
      totals: totals(),
      ticks: [second(0)],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export results' }))
    await tick()
    expect(api.load.saveReport).toHaveBeenCalledTimes(1)
    const [json, name] = api.load.saveReport.mock.calls[0]! as [string, string]
    expect(name).toBe('Health-load-2026-10-23-080405.json')
    expect(JSON.parse(json)).toEqual({
      target: { name: 'Health', path: HEALTH, requests: STARTED.type === 'started' ? STARTED.requests : [] },
      environment: null,
      options: api.load.start.mock.calls[0]![0],
      startedAt: '2026-10-23T08:04:05.000Z',
      durationMs: 3010,
      reason: 'completed',
      totals: totals(),
      ticks: [second(0)],
    })
    expect(screen.getByText('Saved to /tmp/load-report.json')).toBeVisible()
  })

  it('unsubscribes from load events when the app unmounts', async () => {
    await mounted()
    expect(events.loadListeners()).toBe(1)
    cleanup()
    expect(events.loadListeners()).toBe(0)
  })
})
