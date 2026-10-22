// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { initialState, runnerTabId, useApp } from '../../src/renderer/src/state/store'
import type { CollectionTree, RunEvent, RunResult } from '../../src/shared/types'
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

function tree(): CollectionTree[] {
  return [
    collectionTree(SHOP, 'Shop', [
      folderNode(USERS, 'Users', [
        requestNode(GET_USERS, 'Get users'),
        requestNode(CREATE_USER, 'Create user', 'POST'),
      ]),
      requestNode(HEALTH, 'Health'),
    ]),
  ]
}

let events: MockEvents

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
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

async function mounted(overrides: Parameters<typeof installApi>[0] = {}): Promise<MockApi> {
  const api = installApi({
    ...overrides,
    collections: { list: vi.fn().mockResolvedValue({ collections: tree(), errors: [] }), ...overrides.collections },
  })
  await useApp.getState().openWorkspace('/tmp/demo')
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

function runFromMenu(name: string): void {
  fireEvent.contextMenu(row(name))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Run' }))
}

const runOrder = () => screen.getByRole('list', { name: 'Run order' })
const checkbox = (name: string) => within(runOrder()).getByRole('checkbox', { name })

function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    iteration: 0,
    path: GET_USERS,
    name: 'Get users',
    method: 'GET',
    url: 'http://api.test/users?key=••••',
    status: 200,
    statusText: 'OK',
    timeMs: 120,
    sizeBytes: 2048,
    tests: [],
    failures: [],
    ...patch,
  }
}

function emit(event: RunEvent): Promise<void> {
  return act(async () => events.emitRun(event))
}

/** Opens the Shop runner, clicks Run and lets the start resolve with `run-1`. */
async function started(api?: MockApi): Promise<MockApi> {
  const mock = api ?? (await mounted())
  runFromMenu('Shop')
  fireEvent.click(screen.getByRole('button', { name: 'Run Shop' }))
  await tick()
  await emit({ runId: 'run-1', type: 'started', total: 3, startedAt: '2026-10-22T09:05:07.000Z' })
  return mock
}

describe('opening the Runner tab', () => {
  it('opens from the collection menu as "Runner · <name>" with id runner:<path>', async () => {
    await mounted()
    runFromMenu('Shop')
    expect(useApp.getState().activePath).toBe(runnerTabId(SHOP))
    expect(runnerTabId(SHOP)).toBe(`runner:${SHOP}`)
    expect(tabNames()).toEqual(['Runner · Shop'])
    // Running again activates the same tab.
    runFromMenu('Shop')
    expect(useApp.getState().openTabs).toHaveLength(1)
  })

  it('opens from a folder menu with only that folder’s requests', async () => {
    await mounted()
    runFromMenu('Users')
    expect(tabNames()).toEqual(['Runner · Users'])
    expect(
      within(runOrder())
        .getAllByRole('checkbox')
        .map((c) => c.getAttribute('aria-label')),
    ).toEqual(['Get users', 'Create user'])
  })

  it('opens from the Run button of the collection settings tab', async () => {
    await mounted()
    fireEvent.contextMenu(row('Shop'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(useApp.getState().activePath).toBe(runnerTabId(SHOP))
    expect(tabNames()).toEqual(['Shop', 'Runner · Shop'])
  })
})

describe('configuration', () => {
  it('selects every request by default, in tree order, and shows the environment', async () => {
    await mounted()
    runFromMenu('Shop')
    const boxes = within(runOrder()).getAllByRole('checkbox')
    expect(boxes.map((c) => c.getAttribute('aria-label'))).toEqual(['Get users', 'Create user', 'Health'])
    for (const b of boxes) expect(b).toBeChecked()
    expect(screen.getByText('Environment: No environment')).toBeVisible()
  })

  it('sends only the selected requests, in tree order, with the options', async () => {
    const api = await mounted()
    runFromMenu('Shop')
    fireEvent.click(checkbox('Create user'))
    fireEvent.change(screen.getByLabelText('Iterations'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Delay (ms)'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep variable values' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stop run if a test fails or a request errors' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run Shop' }))
    await tick()
    expect(api.runner.start).toHaveBeenCalledWith({
      path: SHOP,
      requestPaths: [GET_USERS, HEALTH],
      environmentId: null,
      iterations: 3,
      delayMs: 250,
      data: null,
      keepVariables: false,
      stopOnError: true,
    })
  })

  it('Select all and Deselect all; Run is disabled with nothing selected', async () => {
    await mounted()
    runFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
    for (const b of within(runOrder()).getAllByRole('checkbox')) expect(b).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Run Shop' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    for (const b of within(runOrder()).getAllByRole('checkbox')) expect(b).toBeChecked()
    expect(screen.getByRole('button', { name: 'Run Shop' })).toBeEnabled()
  })

  it.each([
    ['Iterations', '0', false],
    ['Iterations', '10001', false],
    ['Iterations', '1.5', false],
    ['Iterations', '10000', true],
    ['Delay (ms)', '-1', false],
    ['Delay (ms)', '600001', false],
    ['Delay (ms)', '600000', true],
    ['Delay (ms)', '0', true],
  ])('%s = %s is valid: %s', async (label, value, valid) => {
    await mounted()
    runFromMenu('Shop')
    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value } })
    expect(input).toHaveAttribute('aria-invalid', String(!valid))
    expect(screen.getByRole('button', { name: 'Run Shop' })).toHaveProperty('disabled', !valid)
  })

  it('shows the chosen data file with its row count and a preview of the first 5 rows', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ user: `u${i}`, n: i }))
    const api = await mounted({ runner: { pickDataFile: vi.fn().mockResolvedValue({ name: 'users.csv', rows }) } })
    runFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Select file' }))
    await tick()
    expect(screen.getByText('users.csv')).toBeVisible()
    expect(screen.getByText('7 rows')).toBeVisible()
    const preview = screen.getByRole('table', { name: 'Data preview' })
    expect(within(preview).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['user', 'n'])
    expect(within(preview).getAllByRole('row')).toHaveLength(6)
    expect(within(preview).getByText('u4')).toBeVisible()
    expect(within(preview).queryByText('u5')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Run Shop' }))
    await tick()
    expect(api.runner.start).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'users.csv', rows } }))
  })

  it('removes the data file', async () => {
    await mounted({
      runner: { pickDataFile: vi.fn().mockResolvedValue({ name: 'users.csv', rows: [{ a: 1 }] }) },
    })
    runFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Select file' }))
    await tick()
    expect(screen.getByText('1 row')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Remove data file' }))
    expect(screen.queryByText('users.csv')).toBeNull()
    expect(screen.getByRole('button', { name: 'Select file' })).toBeVisible()
  })

  it('shows a data file parse error inline', async () => {
    await mounted({
      runner: { pickDataFile: vi.fn().mockRejectedValue(new Error('duplicate column "user" in the header')) },
    })
    runFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Select file' }))
    await tick()
    expect(screen.getByRole('alert')).toHaveTextContent('duplicate column "user" in the header')
    expect(screen.getByRole('alert')).toHaveClass('runner-error')
  })

  it('writes unsaved drafts before starting the run', async () => {
    const api = await mounted()
    fireEvent.click(row('Get users'))
    useApp.getState().editDraft(GET_USERS, (d) => ({ ...d, url: 'http://typed' }))
    runFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Run Shop' }))
    await tick()
    expect(api.collections.saveRequest).toHaveBeenCalled()
    expect(api.runner.start).toHaveBeenCalled()
    expect(api.collections.saveRequest.mock.invocationCallOrder[0]!).toBeLessThan(
      api.runner.start.mock.invocationCallOrder[0]!,
    )
  })

  it.each(['runner_busy', 'invalid_run_options: iterations', 'not_found: collections/shop', 'run_stopped'])(
    'shows a rejected start (%s) inline in the configuration',
    async (message) => {
      await mounted({ runner: { start: vi.fn().mockRejectedValue(new Error(message)) } })
      runFromMenu('Shop')
      fireEvent.click(screen.getByRole('button', { name: 'Run Shop' }))
      await tick()
      expect(screen.getByRole('alert')).toHaveTextContent(message)
      expect(screen.getByRole('button', { name: 'Run Shop' })).toBeEnabled()
    },
  )
})

describe('results', () => {
  it('accepts events that arrive before start resolves with the run id', async () => {
    let resolve!: (id: string) => void
    await mounted({ runner: { start: vi.fn().mockReturnValue(new Promise<string>((r) => (resolve = r))) } })
    runFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Run Shop' }))
    await tick()
    // A stray event of some other run, before ours started, is not adopted.
    await emit({ runId: 'other', type: 'result', result: result({ name: 'Stray' }) })
    await emit({ runId: 'run-7', type: 'started', total: 3, startedAt: '2026-10-22T09:05:07.000Z' })
    await emit({ runId: 'run-7', type: 'result', result: result() })
    expect(screen.getByText('1 / 3')).toBeVisible()
    expect(screen.getByRole('listitem', { name: 'GET Get users' })).toBeVisible()
    await act(async () => resolve('run-7'))
    await emit({ runId: 'run-7', type: 'result', result: result({ path: HEALTH, name: 'Health' }) })
    expect(screen.getByText('2 / 3')).toBeVisible()
    expect(screen.queryByText('Stray')).toBeNull()
  })

  it('applies results that arrive before start resolves even without a started event first', async () => {
    let resolve!: (id: string) => void
    await mounted({ runner: { start: vi.fn().mockReturnValue(new Promise<string>((r) => (resolve = r))) } })
    runFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Run Shop' }))
    await tick()
    await emit({ runId: 'run-9', type: 'result', result: result() })
    await act(async () => resolve('run-9'))
    await tick()
    expect(screen.getByRole('listitem', { name: 'GET Get users' })).toBeVisible()
  })

  it('groups streamed results by iteration and shows the summary', async () => {
    await started()
    expect(screen.getByText('0 / 3')).toBeVisible()
    await emit({
      runId: 'run-1',
      type: 'result',
      result: result({
        tests: [
          { name: 'status is 200', passed: true, skipped: false, source: 'Request' },
          { name: 'has users', passed: false, skipped: false, error: 'expected 0 to be above 0', source: 'Request' },
        ],
      }),
    })
    await emit({
      runId: 'run-1',
      type: 'result',
      result: result({ iteration: 1, path: HEALTH, name: 'Health', status: 503, statusText: 'Service Unavailable' }),
    })
    await emit({
      runId: 'run-1',
      type: 'result',
      result: result({
        iteration: 1,
        path: CREATE_USER,
        name: 'Create user',
        method: 'POST',
        status: undefined,
        statusText: undefined,
        timeMs: undefined,
        sizeBytes: undefined,
        error: 'connect ECONNREFUSED',
        failures: [{ phase: 'pre-request', source: 'Request "Create user"', message: 'boom' }],
      }),
    })
    expect(screen.getByText('3 / 3')).toBeVisible()

    const first = screen.getByRole('group', { name: 'Iteration 1' })
    const second = screen.getByRole('group', { name: 'Iteration 2' })
    const getUsers = within(first).getByRole('listitem', { name: 'GET Get users' })
    expect(getUsers).toHaveTextContent('http://api.test/users?key=••••')
    expect(within(getUsers).getByText('200 OK')).toHaveClass('status-2xx')
    expect(getUsers).toHaveTextContent('120 ms')
    expect(getUsers).toHaveTextContent('2 KB')
    expect(within(getUsers).getByText('PASS')).toBeVisible()
    expect(within(getUsers).getByText('FAIL')).toBeVisible()
    expect(getUsers).toHaveTextContent('expected 0 to be above 0')
    const health = within(second).getByRole('listitem', { name: 'GET Health' })
    expect(within(health).getByText('503 Service Unavailable')).toHaveClass('status-5xx')
    const create = within(second).getByRole('listitem', { name: 'POST Create user' })
    expect(create).toHaveTextContent('connect ECONNREFUSED')
    expect(create).toHaveTextContent('boom')

    const summary = screen.getByRole('region', { name: 'Run summary' })
    expect(summary).toHaveTextContent('Iterations 1')
    expect(summary).toHaveTextContent('Avg. response time 120 ms')
    expect(within(summary).getByText('1 passed')).toHaveClass('runner-passed')
    expect(within(summary).getByText('1 failed')).toHaveClass('runner-failed')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Export results' })).toBeNull()

    await emit({ runId: 'run-1', type: 'finished', reason: 'completed', durationMs: 1500 })
    expect(screen.queryByText('3 / 3')).toBeNull()
    expect(summary).toHaveTextContent('Duration 1.50 s')
    expect(screen.getByText('Completed')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Run again' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'New run' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Export results' })).toBeVisible()
  })

  it.each([
    ['stopped', 'Stopped'],
    ['next_request_not_found: "Login"', 'Next request "Login" not found'],
  ] as const)('shows the end reason %s as "%s"', async (reason, text) => {
    await started()
    await emit({ runId: 'run-1', type: 'finished', reason, durationMs: 10 })
    expect(screen.getByText(text)).toBeVisible()
  })

  it('filters by passed and failed requests', async () => {
    await started()
    await emit({ runId: 'run-1', type: 'result', result: result() })
    await emit({
      runId: 'run-1',
      type: 'result',
      result: result({
        path: HEALTH,
        name: 'Health',
        tests: [{ name: 'up', passed: false, skipped: false, source: 'Request' }],
      }),
    })
    const filter = screen.getByRole('group', { name: 'Filter results' })
    fireEvent.click(within(filter).getByRole('button', { name: 'Failed' }))
    expect(screen.queryByRole('listitem', { name: 'GET Get users' })).toBeNull()
    expect(screen.getByRole('listitem', { name: 'GET Health' })).toBeVisible()
    fireEvent.click(within(filter).getByRole('button', { name: 'Passed' }))
    expect(screen.getByRole('listitem', { name: 'GET Get users' })).toBeVisible()
    expect(screen.queryByRole('listitem', { name: 'GET Health' })).toBeNull()
    fireEvent.click(within(filter).getByRole('button', { name: 'All' }))
    expect(screen.getAllByRole('listitem', { name: /^GET / })).toHaveLength(2)
  })

  it('Stop calls runner.stop with the run id', async () => {
    const api = await started()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await tick()
    expect(api.runner.stop).toHaveBeenCalledWith('run-1')
  })

  it('closing a running tab stops the run and forgets its results', async () => {
    const api = await started()
    fireEvent.click(screen.getByRole('button', { name: 'Close Runner · Shop' }))
    await tick()
    expect(api.runner.stop).toHaveBeenCalledWith('run-1')
    expect(useApp.getState().openTabs).toEqual([])
    // The finished event of the stopped run arrives afterwards and is ignored.
    await emit({ runId: 'run-1', type: 'finished', reason: 'stopped', durationMs: 3 })
    runFromMenu('Shop')
    expect(screen.getByRole('button', { name: 'Run Shop' })).toBeVisible()
  })

  it('closing a finished tab does not call stop', async () => {
    const api = await started()
    await emit({ runId: 'run-1', type: 'finished', reason: 'completed', durationMs: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Close Runner · Shop' }))
    await tick()
    expect(api.runner.stop).not.toHaveBeenCalled()
  })

  it('keeps the results while switching tabs', async () => {
    await started()
    await emit({ runId: 'run-1', type: 'result', result: result() })
    fireEvent.click(row('Health'))
    expect(screen.queryByRole('region', { name: 'Run summary' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Runner · Shop' }))
    expect(screen.getByRole('listitem', { name: 'GET Get users' })).toBeVisible()
  })

  it('New run returns to the configuration; Run again starts with the same options', async () => {
    const api = await started()
    await emit({ runId: 'run-1', type: 'finished', reason: 'completed', durationMs: 3 })
    api.runner.start.mockResolvedValueOnce('run-2')
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    await tick()
    expect(api.runner.start).toHaveBeenCalledTimes(2)
    expect(api.runner.start.mock.calls[1]![0]).toEqual(api.runner.start.mock.calls[0]![0])
    await emit({ runId: 'run-2', type: 'finished', reason: 'completed', durationMs: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'New run' }))
    expect(screen.getByRole('button', { name: 'Run Shop' })).toBeVisible()
  })

  it('exports the report through saveReport with the report JSON and file name', async () => {
    const api = await started()
    await emit({ runId: 'run-1', type: 'result', result: result() })
    await emit({ runId: 'run-1', type: 'finished', reason: 'completed', durationMs: 900 })
    fireEvent.click(screen.getByRole('button', { name: 'Export results' }))
    await tick()
    expect(api.runner.saveReport).toHaveBeenCalledTimes(1)
    const [json, name] = api.runner.saveReport.mock.calls[0]! as [string, string]
    expect(name).toBe('Shop-run-2026-10-22-090507.json')
    const report = JSON.parse(json)
    expect(report).toMatchObject({
      collection: 'Shop',
      environment: null,
      startedAt: '2026-10-22T09:05:07.000Z',
      durationMs: 900,
      reason: 'completed',
      iterations: 1,
      delayMs: 0,
      dataFile: null,
      totals: { requests: 1, failedRequests: 0, tests: { passed: 0, failed: 0, skipped: 0 }, avgTimeMs: 120 },
    })
    expect(report.results).toHaveLength(1)
  })

  it('names the folder and the collection in the report of a folder run', async () => {
    const api = await mounted()
    runFromMenu('Users')
    fireEvent.click(screen.getByRole('button', { name: 'Run Users' }))
    await tick()
    await emit({ runId: 'run-1', type: 'started', total: 2, startedAt: '2026-10-22T09:05:07.000Z' })
    await tick()
    await emit({ runId: 'run-1', type: 'finished', reason: 'completed', durationMs: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Export results' }))
    await tick()
    const [json, name] = api.runner.saveReport.mock.calls[0]! as [string, string]
    expect(name).toBe('Users-run-2026-10-22-090507.json')
    expect(JSON.parse(json)).toMatchObject({ collection: 'Shop', folder: 'Users' })
  })

  it('deleting the collection closes its Runner tab and stops its run', async () => {
    const api = await started()
    api.collections.list.mockResolvedValue({ collections: [], errors: [] })
    await act(() => useApp.getState().remove(SHOP))
    expect(useApp.getState().openTabs).toEqual([])
    expect(useApp.getState().runners).toEqual({})
    expect(api.runner.stop).toHaveBeenCalledWith('run-1')
  })

  it('renaming the collection keeps its Runner tab, its results and its run', async () => {
    const RENAMED = 'collections/renamed'
    const api = await started()
    await emit({ runId: 'run-1', type: 'result', result: result() })
    api.collections.rename.mockResolvedValue(RENAMED)
    api.collections.list.mockResolvedValue({
      collections: [collectionTree(RENAMED, 'Renamed', [requestNode(`${RENAMED}/health.request.json`, 'Health')])],
      errors: [],
    })
    await act(() => useApp.getState().rename(SHOP, 'Renamed'))
    expect(useApp.getState().activePath).toBe(runnerTabId(RENAMED))
    expect(tabNames()).toEqual(['Runner · Renamed'])
    expect(screen.getByRole('listitem', { name: 'GET Get users' })).toBeVisible()
    await emit({ runId: 'run-1', type: 'finished', reason: 'completed', durationMs: 1 })
    expect(screen.getByText('Completed')).toBeVisible()
    expect(api.runner.stop).not.toHaveBeenCalled()
  })

  it('switching the workspace forgets the runs; late events are ignored', async () => {
    const api = await started()
    await act(async () => {
      await useApp.getState().leaveWorkspace()
    })
    expect(useApp.getState().runners).toEqual({})
    await emit({ runId: 'run-1', type: 'result', result: result() })
    expect(useApp.getState().runners).toEqual({})
    expect(api.workspace.close).toHaveBeenCalled()
  })

  it('ignores run events when no run of this tab is known', async () => {
    await mounted()
    runFromMenu('Shop')
    await emit({ runId: 'run-x', type: 'started', total: 3, startedAt: '2026-10-22T09:05:07.000Z' })
    expect(screen.getByRole('button', { name: 'Run Shop' })).toBeVisible()
  })

  it('unsubscribes from run events when the app unmounts', async () => {
    await mounted()
    expect(events.runListeners()).toBe(1)
    cleanup()
    expect(events.runListeners()).toBe(0)
  })
})
