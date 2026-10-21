// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestEditor } from '../../src/renderer/src/components/RequestEditor'
import { ResponseViewer } from '../../src/renderer/src/components/ResponseViewer'
import { decodeBody } from '../../src/renderer/src/lib/body'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import { loadUi, useUi } from '../../src/renderer/src/state/ui'
import type { HttpResponse, ScriptReport, ScriptTest, SendResult } from '../../src/shared/types'
import { collectionTree, folderNode, installApi, REQUEST_PATH, requestNode } from './helpers'

// CodeMirror needs real layout; a textarea stands in for it here (tests/renderer/codeEditor.test.tsx covers the real one).
vi.mock('../../src/renderer/src/lib/body', async (importActual) => {
  const actual = await importActual<typeof import('../../src/renderer/src/lib/body')>()
  return { ...actual, decodeBody: vi.fn(actual.decodeBody) }
})

vi.mock('../../src/renderer/src/components/CodeEditor', () => ({
  CodeEditor: (p: { value: string; language: string; label?: string; readOnly?: boolean }) => (
    <textarea
      aria-label={p.label ?? 'code'}
      data-language={p.language}
      readOnly={p.readOnly}
      value={p.value}
      onChange={() => {}}
    />
  ),
}))

const OTHER_PATH = 'collections/shop/users/other.request.json'

function base64(text: string | Uint8Array): string {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function ok(body: string | Uint8Array = '', contentType = 'text/plain', extra: Partial<HttpResponse> = {}): SendResult {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return {
    ok: true,
    response: {
      status: 200,
      statusText: 'OK',
      headers: [['Content-Type', contentType]],
      bodyBase64: base64(bytes),
      bodyTruncated: false,
      sizeBytes: bytes.length,
      totalMs: 42,
      finalUrl: 'https://example.com/a',
      redirects: 0,
      cookies: [],
      ...extra,
    },
  }
}

function show(result: SendResult, path = REQUEST_PATH): void {
  useApp.setState({ responses: { ...useApp.getState().responses, [path]: { state: 'done', result } } })
}

const clipboardOriginal = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function stubClipboard(writeText: (t: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

beforeEach(() => {
  localStorage.clear()
  useApp.setState(initialState())
  useUi.setState(loadUi())
})

function pickFormat(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Body format' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name }))
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (clipboardOriginal) Object.defineProperty(navigator, 'clipboard', clipboardOriginal)
  else delete (navigator as unknown as Record<string, unknown>).clipboard
})

describe('response viewer states', () => {
  it('shows a hint before the first send', () => {
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText('Click Send to get a response')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('shows a sending status', () => {
    useApp.setState({ responses: { [REQUEST_PATH]: { state: 'sending' } } })
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByRole('status')).toHaveTextContent('Sending…')
  })

  it('does not render a result stored for another request', () => {
    show(ok('other body'), OTHER_PATH)
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText('Click Send to get a response')).toBeInTheDocument()
    expect(screen.queryByText('200 OK')).not.toBeInTheDocument()
  })

  it('shows the code, message and explanation of a failed send', () => {
    show({ ok: false, error: { code: 'dns_failed', message: 'getaddrinfo ENOTFOUND nope.test' } })
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('dns_failed')).toBeInTheDocument()
    expect(screen.getByText('getaddrinfo ENOTFOUND nope.test')).toBeInTheDocument()
    expect(screen.getByText(/host name could not be resolved/)).toBeInTheDocument()
  })

  it('shows an unknown error code without an explanation', () => {
    show({ ok: false, error: { code: 'weird', message: 'boom' } })
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText('weird')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
  })
})

describe('response summary', () => {
  it('renders status, time, size and a class for the colour', () => {
    show(ok('hello', 'text/plain', { status: 404, statusText: 'Not Found', totalMs: 1500 }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    const badge = screen.getByText('404 Not Found')
    expect(badge).toHaveClass('status-4xx')
    expect(screen.getByText('1.50 s')).toBeInTheDocument()
    expect(screen.getByText('5 B')).toBeInTheDocument()
  })

  it('explains the time and the sizes in tooltips', () => {
    show(ok('hello', 'text/plain', { totalMs: 14, sizeBytes: 5 }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    const time = screen.getByText('14 ms')
    fireEvent.mouseEnter(time)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Total time14 ms')
    fireEvent.mouseLeave(time)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(screen.getByText('5 B'))
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Headers.*Body5 B/)
  })

  it('shows the counts as plain numbers on the pill tabs', () => {
    show(ok('', 'text/plain', { cookies: [{ name: 'a', value: '1', attributes: {} }] }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Body',
      'Cookies 1',
      'Headers 1',
      'Test Results',
    ])
  })

  it.each([
    [200, 'status-2xx'],
    [302, 'status-3xx'],
    [503, 'status-5xx'],
  ])('colours %i with %s', (status, cls) => {
    show(ok('', 'text/plain', { status, statusText: 'X' }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText(`${status} X`)).toHaveClass(cls)
  })

  it('shows the final url only after redirects, regardless of the draft', () => {
    useApp.setState({
      drafts: { [REQUEST_PATH]: { ...requestNode(REQUEST_PATH, 'x').request, url: '{{baseUrl}}/x' } },
    })
    show(ok('', 'text/plain', { redirects: 0, finalUrl: 'https://example.com/x' }))
    const first = render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.queryByText('https://example.com/x')).not.toBeInTheDocument()
    expect(screen.queryByText(/redirect/)).not.toBeInTheDocument()
    first.unmount()

    show(ok('', 'text/plain', { redirects: 2, finalUrl: 'https://example.com/final' }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText('2 redirects')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/final')).toBeInTheDocument()
    act(() => {
      useApp.getState().editDraft(REQUEST_PATH, (r) => ({ ...r, url: 'https://elsewhere.test' }))
    })
    expect(screen.getByText('https://example.com/final')).toBeInTheDocument()
  })
})

describe('headers and cookies', () => {
  it('lists repeated header names as separate rows in order', () => {
    show(
      ok('', 'text/plain', {
        headers: [
          ['Set-Cookie', 'a=1'],
          ['X-Other', 'o'],
          ['Set-Cookie', 'b=2'],
        ],
      }),
    )
    render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }))
    const rows = within(screen.getByRole('tabpanel')).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual(['Set-Cookiea=1', 'X-Othero', 'Set-Cookieb=2'])
  })

  it('shows cookie attributes and HttpOnly/Secure flags', () => {
    show(
      ok('', 'text/plain', {
        cookies: [
          { name: 'sid', value: 'abc', attributes: { HttpOnly: true, Secure: true, Path: '/', 'Max-Age': '60' } },
        ],
      }),
    )
    render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.click(screen.getByRole('tab', { name: /Cookies/ }))
    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getByText('sid')).toBeInTheDocument()
    expect(within(panel).getByText('HttpOnly')).toBeInTheDocument()
    expect(within(panel).getByText('Secure')).toBeInTheDocument()
    expect(within(panel).getByText('Path=/; Max-Age=60')).toBeInTheDocument()
  })

  it('says so when there are no cookies', () => {
    show(ok())
    render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.click(screen.getByRole('tab', { name: /Cookies/ }))
    expect(screen.getByText('No cookies.')).toBeInTheDocument()
  })

  it('moves between tabs with the arrow keys', () => {
    show(ok())
    render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Body' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: /Test Results/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Test Results/ })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: /Test Results/ }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Body' })).toHaveFocus()
  })
})

describe('body', () => {
  it('pretty-prints JSON in the read-only editor and shows the raw text on request', () => {
    show(ok('{"a":1}', 'application/json'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    const editor = screen.getByRole('textbox', { name: 'Response body' })
    expect(editor).toHaveValue('{\n  "a": 1\n}')
    expect(editor).toHaveAttribute('data-language', 'json')
    expect(editor).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Body format' })).toHaveTextContent('JSON')
    pickFormat('Raw')
    expect(screen.getByRole('textbox', { name: 'Response body' })).toHaveValue('{"a":1}')
    expect(screen.getByRole('textbox', { name: 'Response body' })).toHaveAttribute('data-language', 'text')
  })

  it('highlights and pretty-prints in the format picked from the dropdown', () => {
    show(ok('<a><b>1</b></a>', 'text/plain'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByRole('button', { name: 'Body format' })).toHaveTextContent('Text')
    pickFormat('XML')
    const editor = screen.getByRole('textbox', { name: 'Response body' })
    expect(editor).toHaveAttribute('data-language', 'xml')
    expect(editor).toHaveValue('<a>\n  <b>1</b>\n</a>')
  })

  it('toggles line wrapping and remembers it', () => {
    show(ok('x'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })
    const before = wrap.getAttribute('aria-pressed')
    fireEvent.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true')
    expect(useUi.getState().responseWrap).toBe(before !== 'true')
    useUi.getState().setResponseWrap(true)
  })

  it('shows a notice with the real size for a truncated body', () => {
    show(ok('abcd', 'text/plain', { bodyTruncated: true, sizeBytes: 5 * 1024 * 1024 }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText('Response was cut at 4 B; actual size 5 MB.')).toBeInTheDocument()
  })

  it('shows a binary body as type and size without text, keeping the save button', () => {
    show(ok(new Uint8Array([0xff, 0xfe, 0x00, 1]), 'application/octet-stream'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText(/Binary response \(application\/octet-stream\), 4 B/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save body as file' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Copy body' })).toBeDisabled()
  })

  it('shows a large response raw and cut, without mounting the editor', () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    show(ok(big, 'application/json'))
    const { container } = render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText('Large response: showing first 256 KB of 3 MB')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Body format' })).not.toBeInTheDocument()
    expect(container.querySelector('pre')?.textContent).toHaveLength(256 * 1024)
  })

  it('previews HTML in a sandbox without permissions and says remote resources are blocked', () => {
    show(ok('<h1>Hi</h1><script>alert(1)</script>', 'text/html'))
    const { container } = render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Hi</h1>')
    expect(screen.getByText('Remote resources are blocked.')).toBeInTheDocument()
  })

  it('previews images through an img with a data URL', () => {
    show(ok(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    const img = screen.getByRole('img', { name: 'Response body' })
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('renders svg only through an img', () => {
    show(ok('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml'))
    const { container } = render(<ResponseViewer path={REQUEST_PATH} />)
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
    // The only inline svgs are the toolbar icons; the response's svg is never put in the DOM.
    expect(container.querySelector('.image-preview svg')).toBeNull()
    for (const svg of container.querySelectorAll('svg')) expect(svg).toHaveClass('lucide')
    expect(container.querySelector('script')).toBeNull()
  })
})

describe('copy body', () => {
  it('writes the decoded text to the clipboard and shows Copied for a moment', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    show(ok('héllo', 'text/plain'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy body' }))
    })
    expect(writeText).toHaveBeenCalledWith('héllo')
    expect(screen.getByText('Copied')).toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(1600))
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })

  it('shows an inline note when the clipboard rejects', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    show(ok('x'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy body' }))
    })
    expect(screen.getByText(/Copy failed/)).toBeInTheDocument()
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })

  it('shows the note when there is no clipboard at all', async () => {
    delete (navigator as unknown as Record<string, unknown>).clipboard
    show(ok('x'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy body' }))
    })
    expect(screen.getByText(/Copy failed/)).toBeInTheDocument()
  })
})

describe('save body as file', () => {
  it('downloads through an object URL named after Content-Disposition and revokes it', async () => {
    const created: Blob[] = []
    const createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:mock'))
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(`${this.download}|${this.href}`)
    })
    show(
      ok('a,b', 'text/csv', {
        headers: [
          ['Content-Type', 'text/csv'],
          ['Content-Disposition', 'attachment; filename="r.csv"'],
        ],
      }),
    )
    render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save body as file' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(await created[0]!.text()).toBe('a,b')
    expect(downloads).toEqual(['r.csv|blob:mock'])
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock'))
    expect(document.querySelector('a[download]')).toBeNull()
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })
})

describe('save body details', () => {
  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('does not decode the body again and takes the extension from the content type', () => {
    const created: Blob[] = []
    Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), 'blob:x'), revokeObjectURL: vi.fn() })
    let name = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download
    })
    show(ok('x'.repeat(3 * 1024 * 1024), 'application/json'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    vi.mocked(decodeBody).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Save body as file' }))
    expect(decodeBody).not.toHaveBeenCalled()
    expect(name).toBe('response.json')
    expect(created[0]!.type).toBe('application/json')
  })

  it('revokes the object URL even when the click throws', async () => {
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL: () => 'blob:y', revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click failed')
    })
    const swallow = (e: ErrorEvent): void => e.preventDefault()
    window.addEventListener('error', swallow)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    show(ok('x'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save body as file' }))
    window.removeEventListener('error', swallow)
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:y'))
    expect(document.querySelector('a[download]')).toBeNull()
  })
})

describe('html preview policy', () => {
  const POLICY =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'

  function previewDoc(html: string): string {
    show(ok(html, 'text/html'))
    const { container } = render(<ResponseViewer path={REQUEST_PATH} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    return container.querySelector('iframe')!.getAttribute('srcdoc')!
  }

  it('puts the policy first and keeps the response markup', () => {
    const doc = previewDoc('<h1>Hi</h1><img src="https://evil.test/x.png">')
    expect(doc.startsWith(POLICY)).toBe(true)
    expect(doc).toContain('<h1>Hi</h1>')
  })

  it('cannot be undone by a response that closes the head or brings its own meta', () => {
    const doc = previewDoc(
      '<html><head></head><meta http-equiv="Content-Security-Policy" content="default-src *"><body>x</body></html>',
    )
    expect(doc.startsWith(POLICY)).toBe(true)
    expect(doc.indexOf(POLICY)).toBe(0)
  })

  it('keeps a leading doctype in front so the document stays in standards mode', () => {
    const doc = previewDoc('<!DOCTYPE html><html><body>x</body></html>')
    expect(doc.startsWith('<!DOCTYPE html>' + POLICY)).toBe(true)
  })
})

describe('remembered view state', () => {
  it('keeps each request tab on its own response tab and mode', () => {
    show(ok('{"a":1}', 'application/json'), REQUEST_PATH)
    show(ok('plain', 'text/plain', { status: 201, statusText: 'Created' }), OTHER_PATH)
    const { rerender } = render(<ResponseViewer path={REQUEST_PATH} />)
    pickFormat('Raw')
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }))

    rerender(<ResponseViewer path={OTHER_PATH} />)
    expect(screen.getByText('201 Created')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Body' })).toHaveAttribute('aria-selected', 'true')

    rerender(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByText('200 OK')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Headers/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Body' }))
    expect(screen.getByRole('button', { name: 'Body format' })).toHaveTextContent('Raw')
  })

  it('falls back to the first mode when the remembered one does not apply', () => {
    useApp.getState().setResponseView(REQUEST_PATH, { mode: 'preview' })
    show(ok('{"a":1}', 'application/json'))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByRole('button', { name: 'Body format' })).toHaveTextContent('JSON')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  })
})

describe('view state in the store', () => {
  it('a new send resets to the Body tab and keeps the mode; rename follows the path', async () => {
    const NEW_PATH = 'collections/shop/users/renamed.request.json'
    const result = ok('x')
    const api = installApi({
      http: { send: vi.fn().mockResolvedValue(result) },
      collections: {
        list: vi.fn().mockResolvedValue({
          collections: [
            collectionTree('collections/shop', 'Shop', [
              folderNode('collections/shop/users', 'Users', [requestNode(REQUEST_PATH, 'Get users')]),
            ]),
          ],
          errors: [],
        }),
        rename: vi.fn().mockResolvedValue(NEW_PATH),
      },
    })
    await useApp.getState().openWorkspace('/tmp/demo')
    useApp.getState().openRequest(REQUEST_PATH)
    useApp.getState().setResponseView(REQUEST_PATH, { tab: 'cookies', mode: 'raw' })
    await useApp.getState().send(REQUEST_PATH)
    expect(useApp.getState().responseViews[REQUEST_PATH]).toEqual({ tab: 'body', mode: 'raw' })

    api.collections.list.mockResolvedValue({
      collections: [
        collectionTree('collections/shop', 'Shop', [
          folderNode('collections/shop/users', 'Users', [requestNode(NEW_PATH, 'Renamed')]),
        ]),
      ],
      errors: [],
    })
    await useApp.getState().rename(REQUEST_PATH, 'Renamed')
    expect(useApp.getState().responseViews[NEW_PATH]).toEqual({ tab: 'body', mode: 'raw' })
    expect(useApp.getState().responseViews[REQUEST_PATH]).toBeUndefined()
    useApp.getState().closeTab(NEW_PATH)
    expect(useApp.getState().responseViews[NEW_PATH]).toBeUndefined()
  })
})

describe('layout', () => {
  async function editor(layout: 'side' | 'stacked' = 'stacked') {
    installApi()
    useUi.setState({ layout, responseShare: { side: 0.5, stacked: 0.4 } })
    useApp.setState({
      drafts: { [REQUEST_PATH]: requestNode(REQUEST_PATH, 'Get users').request },
    })
    render(<RequestEditor path={REQUEST_PATH} />)
    return screen.getByRole('separator')
  }

  it('embeds the viewer under the editor', async () => {
    await editor()
    const region = screen.getByRole('region', { name: 'Response' })
    expect(within(region).getByText('Click Send to get a response')).toBeInTheDocument()
  })

  it('puts the response beside the request by default and follows the layout toggle', async () => {
    useUi.setState(loadUi())
    installApi()
    useApp.setState({ drafts: { [REQUEST_PATH]: requestNode(REQUEST_PATH, 'Get users').request } })
    const { container } = render(<RequestEditor path={REQUEST_PATH} />)
    expect(container.querySelector('.request-split')).toHaveClass('split-side')
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical')
    act(() => useUi.getState().setLayout('stacked'))
    expect(container.querySelector('.request-split')).toHaveClass('split-stacked')
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal')
    expect(loadUi().layout).toBe('stacked')
  })

  it('resizes side by side with the arrow keys and persists the ratio per layout', async () => {
    const sep = await editor('side')
    expect(sep).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(sep).toHaveAttribute('aria-valuenow', '55')
    expect(loadUi().responseShare).toEqual({ side: 0.55, stacked: 0.4 })
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(sep).toHaveAttribute('aria-valuenow', '45')
  })

  it('has a horizontal separator that resizes with the arrow keys within its limits', async () => {
    const sep = await editor()
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal')
    expect(sep).toHaveAttribute('aria-valuenow', '40')
    fireEvent.keyDown(sep, { key: 'ArrowUp' })
    expect(sep).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByRole('region', { name: 'Response' })).toHaveStyle({ flexBasis: '45%' })
    fireEvent.keyDown(sep, { key: 'ArrowDown' })
    fireEvent.keyDown(sep, { key: 'ArrowDown' })
    expect(sep).toHaveAttribute('aria-valuenow', '35')
    for (let i = 0; i < 30; i++) fireEvent.keyDown(sep, { key: 'ArrowUp' })
    expect(sep).toHaveAttribute('aria-valuenow', '80')
    fireEvent.keyDown(sep, { key: 'End' })
    expect(sep).toHaveAttribute('aria-valuenow', '20')
  })

  it('resizes by dragging', async () => {
    const sep = await editor()
    const root = sep.parentElement! // the split area
    root.getBoundingClientRect = () => ({
      top: 0,
      bottom: 1000,
      height: 1000,
      left: 0,
      right: 800,
      width: 800,
      x: 0,
      y: 0,
      toJSON() {},
    })
    sep.setPointerCapture = vi.fn()
    sep.releasePointerCapture = vi.fn()
    sep.hasPointerCapture = vi.fn(() => true)
    fireEvent.pointerDown(sep, { pointerId: 1 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 600 })
    expect(sep).toHaveAttribute('aria-valuenow', '40')
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 500 })
    expect(sep).toHaveAttribute('aria-valuenow', '50')
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 0 })
    expect(sep).toHaveAttribute('aria-valuenow', '80')
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(sep.releasePointerCapture).toHaveBeenCalled()
  })
})

function withScripts(result: SendResult, scripts: Partial<ScriptReport>): SendResult {
  return { ...result, scripts: { tests: [], logs: [], failures: [], changedEnvironmentIds: [], ...scripts } }
}

const TESTS: ScriptTest[] = [
  { name: 'status is 200', passed: true, skipped: false, source: 'Request "Get users"' },
  { name: 'has a token', passed: false, skipped: false, error: 'expected undefined to equal abc', source: 'Request "Get users"' },
  { name: 'later', passed: false, skipped: true, source: 'Folder "Users"' },
  { name: 'body is json', passed: true, skipped: false, source: 'Collection "Shop"' },
]

describe('test results', () => {
  const openTests = () => fireEvent.click(screen.getByRole('tab', { name: /Test Results/ }))
  const rows = () => within(screen.getByRole('list', { name: 'Test results' })).getAllByRole('listitem')

  it('counts passed tests out of all on the tab', () => {
    show(withScripts(ok(), { tests: TESTS }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByRole('tab', { name: /Test Results/ })).toHaveTextContent('Test Results (2/4)')
  })

  it('lists each test with its badge, name, error and source', () => {
    show(withScripts(ok(), { tests: TESTS }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    openTests()
    const [pass, fail, skip] = rows()
    expect(within(pass!).getByText('PASS')).toHaveClass('test-badge', 'test-pass')
    expect(pass).toHaveTextContent('status is 200')
    expect(within(pass!).getByText('Request "Get users"')).toHaveClass('test-source')
    expect(within(fail!).getByText('FAIL')).toHaveClass('test-fail')
    expect(within(fail!).getByText('expected undefined to equal abc')).toHaveClass('test-error')
    expect(within(skip!).getByText('SKIP')).toHaveClass('test-skip')
  })

  it.each([
    ['All', ['status is 200', 'has a token', 'later', 'body is json']],
    ['Passed', ['status is 200', 'body is json']],
    ['Skipped', ['later']],
    ['Failed', ['has a token']],
  ])('filters %s', (filter, names) => {
    show(withScripts(ok(), { tests: TESTS }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    openTests()
    const group = screen.getByRole('group', { name: 'Filter tests' })
    fireEvent.click(within(group).getByRole('button', { name: new RegExp(`^${filter}`) }))
    expect(within(group).getByRole('button', { name: new RegExp(`^${filter}`) })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(rows().map((r) => within(r).getByText(/./, { selector: '.test-name' }).textContent)).toEqual(names)
  })

  it('says when no test matches the filter', () => {
    show(withScripts(ok(), { tests: TESTS.slice(0, 1) }))
    render(<ResponseViewer path={REQUEST_PATH} />)
    openTests()
    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    expect(screen.getByText('No failed tests')).toBeInTheDocument()
  })

  it('shows an empty state without tests', () => {
    show(ok())
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByRole('tab', { name: 'Test Results' })).toHaveTextContent(/^Test Results$/)
    openTests()
    expect(screen.getByText('No tests for this request')).toBeInTheDocument()
    expect(screen.getByText('Write tests in the Scripts tab with pm.test()')).toHaveClass('response-state-hint')
    expect(screen.queryByRole('group', { name: 'Filter tests' })).toBeNull()
  })
})

describe('script failures', () => {
  it('shows a strip per failure above the response body', () => {
    show(
      withScripts(ok('hello'), {
        failures: [
          { phase: 'post-response', source: 'Request "Get user"', message: 'Unexpected token < in JSON' },
          { phase: 'post-response', source: 'Collection "Shop"', message: 'boom' },
        ],
      }),
    )
    render(<ResponseViewer path={REQUEST_PATH} />)
    const strips = screen.getAllByRole('alert')
    expect(strips.map((s) => s.textContent)).toEqual([
      'Error in post-response script of Request "Get user": Unexpected token < in JSON',
      'Error in post-response script of Collection "Shop": boom',
    ])
    expect(screen.getByText('200 OK')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Response body' })).toBeInTheDocument()
  })

  it('shows the strip in place of the response when a pre-request script failed', () => {
    show({
      ok: false,
      error: { code: 'script_error', message: 'Script timed out after 10 s' },
      scripts: {
        tests: [],
        logs: [],
        failures: [{ phase: 'pre-request', source: 'Folder "Users"', message: 'Script timed out after 10 s' }],
        changedEnvironmentIds: [],
      },
    })
    render(<ResponseViewer path={REQUEST_PATH} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Error in pre-request script of Folder "Users": Script timed out after 10 s',
    )
    expect(screen.queryByText('Could not get a response')).toBeNull()
    expect(screen.queryByText('script_error')).toBeNull()
  })
})
