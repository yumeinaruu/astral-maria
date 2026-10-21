// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { CONSOLE_LIMIT, initialState, useApp } from '../../src/renderer/src/state/store'
import { CONSOLE_DEFAULT, CONSOLE_MIN, loadUi, useUi } from '../../src/renderer/src/state/ui'
import type { HttpResponse, ScriptReport, SendResult } from '../../src/shared/types'
import { installApi, REQUEST_PATH } from './helpers'

vi.mock('../../src/renderer/src/components/CodeEditor', () => ({
  CodeEditor: (p: { value: string; label?: string }) => (
    <textarea aria-label={p.label ?? 'code'} value={p.value} onChange={() => {}} />
  ),
}))

const RESPONSE: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: [['Authorization', 'Bearer header-secret']],
  bodyBase64: '',
  bodyTruncated: false,
  sizeBytes: 0,
  totalMs: 42,
  finalUrl: 'https://api.example.com/users?page=1',
  redirects: 0,
  cookies: [],
}

function report(patch: Partial<ScriptReport> = {}): ScriptReport {
  return { tests: [], logs: [], failures: [], changedEnvironmentIds: [], ...patch }
}

const LOGS = report({
  logs: [
    { level: 'log', text: 'starting', phase: 'pre-request', source: 'Collection "Shop"' },
    { level: 'warn', text: 'slow answer', phase: 'post-response', source: 'Request "Get users"' },
    { level: 'error', text: 'bad field', phase: 'post-response', source: 'Request "Get users"' },
  ],
  failures: [{ phase: 'post-response', source: 'Folder "Users"', message: 'boom' }],
})

beforeEach(() => {
  localStorage.clear()
  useApp.setState(initialState())
  useUi.setState({ ...loadUi(), consoleOpen: false })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function mount(result: SendResult) {
  const send = vi.fn().mockResolvedValue(result)
  installApi({ http: { send } })
  await useApp.getState().openWorkspace('/tmp/demo')
  useApp.getState().openRequest(REQUEST_PATH)
  render(<App />)
  return { send, user: userEvent.setup() }
}

const consoleToggle = () => screen.getByRole('button', { name: 'Console' })
const panel = () => screen.getByRole('region', { name: 'Console' })
const lines = () => within(panel()).queryAllByRole('listitem')

describe('console panel', () => {
  it('toggles from the status bar', async () => {
    const { user } = await mount({ ok: true, response: RESPONSE })
    expect(screen.queryByRole('region', { name: 'Console' })).toBeNull()
    expect(consoleToggle()).toHaveAttribute('aria-pressed', 'false')
    await user.click(consoleToggle())
    expect(panel()).toBeInTheDocument()
    expect(consoleToggle()).toHaveAttribute('aria-pressed', 'true')
    expect(within(panel()).getByText(/No output yet/)).toBeInTheDocument()
    await user.click(consoleToggle())
    expect(screen.queryByRole('region', { name: 'Console' })).toBeNull()
  })

  it('closes from its own close button', async () => {
    const { user } = await mount({ ok: true, response: RESPONSE })
    await user.click(consoleToggle())
    await user.click(within(panel()).getByRole('button', { name: 'Close console' }))
    expect(screen.queryByRole('region', { name: 'Console' })).toBeNull()
  })

  it('lists the request line, the logs and the failures of each send, newest last', async () => {
    const { user } = await mount({ ok: true, response: RESPONSE, scripts: LOGS })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(consoleToggle())
    const texts = lines().map((l) => l.textContent)
    expect(texts).toHaveLength(10)
    expect(texts[0]).toBe('GET https://api.example.com/users?page=1 200 42 ms')
    expect(texts[1]).toBe('logstartingpre-request · Collection "Shop"')
    expect(lines()[2]).toHaveClass('console-warn')
    expect(lines()[3]).toHaveClass('console-error')
    expect(texts[4]).toBe('errorScript error: boompost-response · Folder "Users"')
    expect(lines()[4]).toHaveClass('console-error', 'console-failure')
    expect(texts[5]).toBe(texts[0])
    expect(within(lines()[1]!).getByText('pre-request · Collection "Shop"')).toHaveClass('console-meta')
  })

  it('never shows headers, and shows the unresolved url when nothing was received', async () => {
    const { user } = await mount({ ok: false, error: { code: 'dns_failed', message: 'getaddrinfo ENOTFOUND' } })
    act(() => useApp.getState().editDraft(REQUEST_PATH, (r) => ({ ...r, url: '{{baseUrl}}/users' })))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(consoleToggle())
    expect(lines().map((l) => l.textContent)).toEqual(['GET {{baseUrl}}/users dns_failed'])
    expect(panel()).not.toHaveTextContent('header-secret')
  })

  it('keeps the failure of a pre-request script that stopped the send', async () => {
    const { user } = await mount({
      ok: false,
      error: { code: 'script_error', message: 'nope' },
      scripts: report({ failures: [{ phase: 'pre-request', source: 'Request "Get users"', message: 'nope' }] }),
    })
    act(() => useApp.getState().editDraft(REQUEST_PATH, (r) => ({ ...r, url: '{{baseUrl}}/users' })))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(consoleToggle())
    expect(lines().map((l) => l.textContent)).toEqual([
      'GET {{baseUrl}}/users script_error',
      'errorScript error: nopepre-request · Request "Get users"',
    ])
  })

  it('filters by level and clears', async () => {
    const { user } = await mount({ ok: true, response: RESPONSE, scripts: LOGS })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(consoleToggle())
    await user.click(within(panel()).getByRole('button', { name: 'Console level' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Warnings' }))
    expect(lines().map((l) => l.textContent)).toEqual([
      'GET https://api.example.com/users?page=1 200 42 ms',
      'warnslow answerpost-response · Request "Get users"',
    ])
    await user.click(within(panel()).getByRole('button', { name: 'Console level' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Errors' }))
    expect(lines()).toHaveLength(3)
    await user.click(within(panel()).getByRole('button', { name: 'Clear' }))
    expect(lines()).toHaveLength(0)
    expect(useApp.getState().consoleLines).toEqual([])
  })

  it(`keeps at most ${CONSOLE_LIMIT} entries, dropping the oldest`, async () => {
    const logs = Array.from({ length: 300 }, (_, i) => ({
      level: 'log' as const,
      text: `line ${i}`,
      phase: 'post-response' as const,
      source: 'Request "Get users"',
    }))
    await mount({ ok: true, response: RESPONSE, scripts: report({ logs }) })
    await act(() => useApp.getState().send(REQUEST_PATH))
    await act(() => useApp.getState().send(REQUEST_PATH))
    const kept = useApp.getState().consoleLines
    expect(kept).toHaveLength(CONSOLE_LIMIT)
    expect(kept.at(-1)).toMatchObject({ kind: 'log', text: 'line 299' })
    expect(kept[0]).toMatchObject({ kind: 'log', text: 'line 101' })
  })

  it('is resizable, at least 120px, and remembers its height', async () => {
    const { user } = await mount({ ok: true, response: RESPONSE })
    await user.click(consoleToggle())
    const handle = within(panel()).getByRole('separator', { name: 'Resize console' })
    expect(panel()).toHaveStyle({ height: `${CONSOLE_DEFAULT}px` })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(useUi.getState().consoleHeight).toBeGreaterThan(CONSOLE_DEFAULT)
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(useUi.getState().consoleHeight).toBe(CONSOLE_MIN)
    expect(panel()).toHaveStyle({ height: `${CONSOLE_MIN}px` })
    expect(loadUi().consoleHeight).toBe(CONSOLE_MIN)
  })

  it('ignores a stored height below the minimum', () => {
    localStorage.setItem('astral.consoleHeight', '40')
    expect(loadUi().consoleHeight).toBe(CONSOLE_MIN)
  })
})
