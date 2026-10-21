import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'

const MAIN = resolve(__dirname, '../../out/main/index.js')
const POSTMAN_FIXTURES = resolve(__dirname, '../fixtures/postman')
// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const SECRET = 's3cr3t-e2e-PLAIN-TEXT-9f1c'
const BODY = { greeting: 'hello from the astral test server' }
const PACKAGED = process.env.ASTRAL_E2E_EXECUTABLE
/** Set ASTRAL_E2E_SHOTS to a directory to also save screenshots there. */
const SHOTS = process.env.ASTRAL_E2E_SHOTS

let server: Server
let baseUrl: string
let hits: string[] = []
/** The `x-trace` header of each request the server received, in order. */
let traces: (string | undefined)[] = []
let root: string
let userData: string
let workspace: string
let downloadDir: string
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    const trace = req.headers['x-trace']
    traces.push(Array.isArray(trace) ? trace.join(', ') : trace)
    if (req.url === '/page') {
      res.setHeader('content-type', 'text/html')
      // The tracker image must never be fetched by the preview.
      res.end(`<h1>Preview heading</h1><img src="${baseUrl}/tracker">`)
    } else if (req.url?.startsWith('/missing')) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 404, code: 'not_found', message: 'No such user', path: '/missing' }))
    } else if (req.url === '/image') {
      res.setHeader('content-type', 'image/png')
      res.end(PNG)
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(BODY))
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Everything the app touches lives under this temp root; the real home directory and Keychain are never used.
  root = await mkdtemp(join(tmpdir(), 'astral-e2e-'))
  userData = join(root, 'user-data')
  workspace = join(root, 'workspace')
  downloadDir = join(root, 'downloads')
  await Promise.all([mkdir(userData), mkdir(workspace), mkdir(downloadDir)])
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await new Promise<void>((done) => server.close(() => done()))
  await rm(root, { recursive: true, force: true })
})

async function launch(
  workspaceDir = workspace,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; problems: string[]; requests: string[] }> {
  app = await electron.launch({
    // ASTRAL_E2E_EXECUTABLE runs the same steps against a packaged build instead of out/main.
    ...(PACKAGED ? { executablePath: PACKAGED } : {}),
    args: [...(PACKAGED ? [] : [MAIN]), `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test', ASTRAL_E2E_WORKSPACE: workspaceDir, ...extraEnv },
  })
  const page = await app.firstWindow()
  const problems: string[] = []
  const requests: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('request', (r) => requests.push(r.url()))
  return { app, page, problems, requests }
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

/** Takes the shot once in the dark and once in the light palette (the OS setting is emulated). */
async function shotBoth(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme })
    await shot(page, `${name}-${colorScheme}`)
  }
  await page.emulateMedia({ colorScheme: null })
}

/** Opens a request sub-section, through the pill tabs or (narrow pane) the section dropdown. */
async function openSection(page: Page, name: string): Promise<void> {
  const pane = page.locator('.request-pane')
  const dropdown = pane.getByRole('button', { name: 'Request section' })
  if (await dropdown.count()) {
    await dropdown.click()
    await page.getByRole('menuitemradio', { name }).click()
  } else {
    await pane.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
  }
}

async function pick(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('menuitemradio', { name: item, exact: true }).click()
}

/** The sidebar row of an environment (its name button opens the editor tab). */
function envRow(page: Page, name: string) {
  return page.getByRole('list', { name: 'Environments' }).getByRole('button', { name, exact: true })
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await allFiles(full)))
    else out.push(full)
  }
  return out
}

test('create, send, persist, and keep secrets local', async () => {
  const first = await launch()
  const page = first.page

  await test.step('the preload bridge exists', async () => {
    await expect(page.getByRole('heading', { name: 'Astral Maria' })).toBeVisible()
    expect(await page.evaluate(() => typeof (window as unknown as { astral?: unknown }).astral)).toBe('object')
    await shotBoth(page, '0-gate')
  })

  await test.step('create a workspace', async () => {
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await page.getByLabel('Workspace name').fill('Smoke')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.workspace-name')).toHaveText('Smoke')
    await shotBoth(page, '0-empty-workspace')
  })

  await test.step('create a collection and a request', async () => {
    await page.getByRole('button', { name: 'New collection' }).click()
    await page.getByLabel('Name', { exact: true }).fill('Demo')
    await page.getByLabel('Name', { exact: true }).press('Enter')
    const collection = page.getByRole('treeitem', { name: 'Demo' })
    await expect(collection).toBeVisible()
    await collection.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New request' }).click()
    await page.getByLabel('Name', { exact: true }).fill('Hello')
    await page.getByLabel('Name', { exact: true }).press('Enter')
    await page.getByRole('treeitem', { name: 'Hello' }).click()
    await expect(page.getByRole('tab', { name: /Hello/ })).toBeVisible()
  })

  await test.step('define an environment with a variable and a secret', async () => {
    await page.getByRole('button', { name: 'New environment' }).click()
    // Created on disk at once; its sidebar row is in inline rename with the name selected.
    const rename = page.getByRole('list', { name: 'Environments' }).getByRole('textbox', { name: 'Name' })
    await expect(rename).toBeFocused()
    await expect(rename).toHaveValue('New environment')
    await shotBoth(page, 'd4-new-environment-rename')
    await rename.fill('Local')
    await rename.press('Enter')
    await expect(envRow(page, 'Local')).toBeVisible()
    const editor = page.getByRole('tabpanel')
    await expect(editor.getByLabel('Environment name')).toHaveValue('Local')
    // Typing into the trailing empty row creates the variable.
    await editor.getByLabel('Variable name 1').fill('baseUrl')
    await editor.getByLabel('Value 1', { exact: true }).fill(baseUrl)
    await editor.getByLabel('Variable name 2').fill('token')
    await pick(page, 'Type 2', 'Secret')
    await editor.getByLabel('Value 2', { exact: true }).fill(SECRET)
    // A local-only value and a disabled variable, for the screenshots.
    await editor.getByLabel('Variable name 3').fill('userId')
    await editor.getByLabel('Value 3', { exact: true }).fill('56')
    await page.getByRole('button', { name: 'Storage of value 3', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Local:/ }).click()
    await editor.getByLabel('Variable name 4').fill('legacyHost')
    await editor.getByLabel('Value 4', { exact: true }).fill('http://old.example.test')
    await page.getByRole('button', { name: 'Actions for variable 4', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Disable' }).click()
    await expect(editor.getByLabel('Variable name 4').locator('xpath=ancestor::tr')).toHaveClass(/grid-disabled/)
    await shotBoth(page, '1-environment-tab-unsaved')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor.getByRole('alert')).toHaveCount(0)
    await expect(envRow(page, 'Local')).toBeVisible()
    await editor.getByLabel('Variable name 3').hover()
    await shotBoth(page, 'c1-environment-variables')
    await page.getByRole('button', { name: 'Storage of value 3', exact: true }).click()
    await expect(page.getByRole('menu', { name: 'Where the value is kept' })).toBeVisible()
    await shotBoth(page, 'c2-environment-sync-menu')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Variable options', exact: true }).click()
    await shotBoth(page, 'c3-environment-options-menu')
    await page.keyboard.press('Escape')
    // Activated from the sidebar check, as the selector would.
    await page.getByRole('button', { name: 'Activate Local' }).click()
    await expect(page.getByRole('button', { name: 'Environment', exact: true })).toHaveText('Local')
    await shotBoth(page, '2-environment-tab')
    await page.getByRole('tab', { name: /Hello/ }).click()
  })

  await test.step('send the request and see the response', async () => {
    await page.getByRole('textbox', { name: 'URL', exact: true }).fill('{{baseUrl}}/hello?key={{token}}')
    await expect(page.locator('.save-status')).toHaveText('Saved')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.status-badge')).toHaveText('200 OK')
    await expect(page.locator('.response-viewer .cm-content')).toContainText(BODY.greeting)
    expect(hits).toEqual([`/hello?key=${SECRET}`])
    await shotBoth(page, '3-response')
  })

  await test.step('the request editor accepts typing in CodeMirror', async () => {
    await openSection(page, 'Body')
    await pick(page, 'Body type', 'raw')
    const editor = page.locator('.request-pane .cm-content').first()
    await editor.click()
    await page.keyboard.type('{"a":1}')
    await expect(editor).toContainText('{"a":1}')
    await shot(page, '4-body-editor')
  })

  await test.step('Save body as file downloads through the blob URL', async () => {
    await app!.evaluate(({ session }, dir) => {
      session.defaultSession.on('will-download', (_e, item) => item.setSavePath(`${dir}/${item.getFilename()}`))
    }, downloadDir)
    await page.getByRole('button', { name: 'Save body as file' }).click()
    await expect.poll(async () => (await readdir(downloadDir)).length).toBe(1)
    const [saved] = await readdir(downloadDir)
    await expect.poll(async () => JSON.parse(await readFile(join(downloadDir, saved), 'utf8'))).toEqual(BODY)
  })

  await test.step('network and permission lockdown is in effect, and copying still works', async () => {
    const state = await app!.evaluate(({ app: electronApp, session }) => ({
      spellchecker: session.defaultSession.isSpellCheckerEnabled(),
      switches: ['disable-background-networking', 'disable-component-update', 'disable-sync'].filter((s) =>
        electronApp.commandLine.hasSwitch(s),
      ),
    }))
    expect(state).toEqual({
      spellchecker: false,
      switches: ['disable-background-networking', 'disable-component-update', 'disable-sync'],
    })
    expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)).toBe(
      'denied',
    )
    // Writing to the clipboard is the one permission granted; the user's clipboard text is restored afterwards.
    const saved = await app!.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await page.getByRole('button', { name: 'Copy body' }).click()
      await expect(page.getByText('Copied', { exact: true })).toBeVisible()
      expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(JSON.stringify(BODY))
    } finally {
      await app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
    }
  })

  await test.step('HTML preview (srcdoc iframe) and image preview (data: URL) work under the CSP', async () => {
    await page.getByRole('textbox', { name: 'URL', exact: true }).fill('{{baseUrl}}/page')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole('heading')).toHaveText('Preview heading')
    await shot(page, '5-html-preview')
    await page.getByRole('textbox', { name: 'URL', exact: true }).fill('{{baseUrl}}/image')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const img = page.getByRole('img', { name: 'Response body' })
    await expect(img).toBeVisible()
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
    await shot(page, '6-image-preview')
  })

  await test.step('files on disk: layout and no plain-text secret outside .local', async () => {
    const files = (await allFiles(workspace)).map((f) => relative(workspace, f))
    const requestFile = files.find((f) => /^collections\/[^/]+\/[^/]+\.request\.json$/.test(f))
    expect(requestFile, files.join('\n')).toBeTruthy()
    expect(existsSync(join(workspace, requestFile!))).toBe(true)
    for (const f of files.filter((f) => !f.startsWith('.local/'))) {
      expect(await readFile(join(workspace, f), 'utf8'), f).not.toContain(SECRET)
    }
    // A local value is not shared; a disabled variable is still saved.
    const envFile = files.find((f) => /^environments\/[^/]+\.json$/.test(f) && !f.endsWith('globals.json'))
    const committed = JSON.parse(await readFile(join(workspace, envFile!), 'utf8')) as {
      variables: { key: string; value: string; enabled: boolean }[]
    }
    expect(committed.variables.find((v) => v.key === 'userId')).toMatchObject({ value: '' })
    expect(committed.variables.find((v) => v.key === 'legacyHost')).toMatchObject({ enabled: false })
    // The secret is stored somewhere under .local, and only encrypted.
    for (const f of files.filter((f) => f.startsWith('.local/'))) {
      expect(await readFile(join(workspace, f), 'utf8'), f).not.toContain(SECRET)
    }
    expect(files.some((f) => f.startsWith('.local/'))).toBe(true)
  })

  await test.step('no console problems, no network except the local server', async () => {
    // The only console errors allowed are the CSP blocks of the deliberate tracker image.
    const unexpected = first.problems.filter((p) => !(p.includes('/tracker') && p.includes('Content Security Policy')))
    expect(unexpected).toEqual([])
    expect(first.problems.some((p) => p.includes('/tracker'))).toBe(true)
    for (const url of first.requests) expect(url, url).toMatch(/^(file|data|blob):/)
    // Only the three requests the test sent; the preview's tracker image was never fetched.
    expect(hits).toEqual([`/hello?key=${SECRET}`, '/page', '/image'])
  })

  await app!.close()
  app = undefined

  await test.step('restart on the same workspace: everything is still there', async () => {
    const second = await launch()
    const p = second.page
    await p.getByRole('button', { name: 'Open workspace' }).click()
    await expect(p.locator('.workspace-name')).toHaveText('Smoke')
    await p.getByRole('treeitem', { name: 'Hello' }).click()
    await expect(p.getByRole('textbox', { name: 'URL', exact: true })).toHaveValue('{{baseUrl}}/image')
    await envRow(p, 'Local').click()
    const editor = p.getByRole('tabpanel')
    await expect(editor.getByLabel('Variable name 1')).toHaveValue('baseUrl')
    await expect(editor.getByLabel('Value 1', { exact: true })).toHaveValue(baseUrl)
    await expect(editor.getByLabel('Variable name 2')).toHaveValue('token')
    await expect(editor.getByLabel('Value 2', { exact: true })).toHaveValue(SECRET)
    await expect(editor.getByLabel('Value 3', { exact: true })).toHaveValue('56')
    await expect(p.getByRole('button', { name: 'Storage of value 3', exact: true })).toHaveAttribute('title', /^Local/)
    await expect(editor.getByLabel('Variable name 4').locator('xpath=ancestor::tr')).toHaveClass(/grid-disabled/)
    expect(second.problems).toEqual([])
  })

  await test.step('quick open finds the request; the sidebar collapses', async () => {
    const p = app!.windows()[0]
    await p.keyboard.press('ControlOrMeta+k')
    await p.keyboard.type('hel')
    await expect(p.getByRole('option', { name: /Hello/ })).toBeVisible()
    await shotBoth(p, '7-quick-open')
    await p.keyboard.press('Enter')
    await expect(p.getByRole('tab', { name: /Hello/ })).toHaveAttribute('aria-selected', 'true')
    await p.getByRole('button', { name: 'Settings' }).click()
    await p.getByRole('menuitemradio', { name: 'Light' }).click()
    await expect(p.locator('html')).toHaveAttribute('data-theme', 'light')
    await shot(p, '8-light-theme-setting')
    await p.getByRole('button', { name: 'Settings' }).click()
    await p.getByRole('menuitemradio', { name: 'System' }).click()
  })

  await test.step('the redesigned request and response panes', async () => {
    const p = app!.windows()[0]
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1512, 982))
    // The active environment is chosen per session.
    await p.getByRole('button', { name: 'Activate Local' }).click()
    await p.getByRole('treeitem', { name: 'Hello' }).click()
    await expect(p.getByText('Click Send to get a response')).toBeVisible()
    await shotBoth(p, 'b1-empty-response')

    const url = p.getByRole('textbox', { name: 'URL', exact: true })
    await url.fill('{{baseUrl}}/missing?page=1&limit={{limit}}')
    await openSection(p, 'Params')
    await expect(p.getByText('Query Params')).toBeVisible()
    await expect(p.locator('.url-box .var-missing')).toHaveText('{{limit}}')
    await expect(p.locator('.url-box .var-resolved')).toHaveText('{{baseUrl}}')
    // The token is painted by a mirror that ignores the pointer; the input under it shows the tooltip.
    const box = (await p.locator('.url-box .var-resolved').boundingBox())!
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(p.getByRole('tooltip')).toContainText(baseUrl)
    await p.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(p.locator('.status-badge')).toHaveText('404 Not Found')
    await p.mouse.move(0, 0)
    await shotBoth(p, 'b2-params-404-side-by-side')

    await url.fill('{{baseUrl}}/hello')
    await openSection(p, 'Body')
    await pick(p, 'Body type', 'raw')
    await pick(p, 'Language', 'JSON')
    const body = p.locator('.request-pane .cm-content').first()
    await body.click()
    await p.keyboard.press('ControlOrMeta+a')
    await p.keyboard.type('{"user": "{{user}}", "token": "{{token}}", "count": 3, "ok": true}')
    await p.getByRole('button', { name: 'Beautify' }).click()
    await expect(body).toContainText('"count": 3')
    await p.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(p.locator('.status-badge')).toHaveText('200 OK')
    await shotBoth(p, 'b3-json-body-200-side-by-side')

    await openSection(p, 'Headers')
    await p.getByRole('textbox', { name: 'Header key 1' }).fill('Accept')
    await p.getByRole('textbox', { name: 'Header value 1' }).fill('application/json')
    await p.getByRole('textbox', { name: 'Header key 2' }).fill('X-Token')
    await p.getByRole('textbox', { name: 'Header value 2' }).fill('{{token}}')
    await p.getByRole('textbox', { name: 'Header description 2' }).fill('From the environment')
    await p.mouse.move(0, 0)
    await shotBoth(p, 'b4-headers-grid')

    await openSection(p, 'Authorization')
    await pick(p, 'Auth type', 'Bearer token')
    await p.getByRole('textbox', { name: 'Token' }).fill('{{token}}')
    await shotBoth(p, 'b5-auth-bearer')
    await pick(p, 'Auth type', 'Inherit from parent')
    await shotBoth(p, 'b6-auth-inherit')

    await p.getByRole('button', { name: 'Show the response below the request' }).click()
    await expect(p.getByRole('separator', { name: 'Resize response' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    )
    await openSection(p, 'Params')
    await shotBoth(p, 'b7-stacked')
    await p.getByRole('button', { name: 'Show the response beside the request' }).click()

    // Cmd/Ctrl+W closes the tab, not the window.
    await p.getByRole('textbox', { name: 'URL', exact: true }).click()
    await p.keyboard.press('ControlOrMeta+w')
    await expect(p.getByRole('tab', { name: /Hello/ })).toHaveCount(0)
    expect(app!.windows()).toHaveLength(1)
    await p.getByRole('treeitem', { name: 'Hello' }).click()
  })

  await test.step('{{ completion, the caret after a variable, and the focus states', async () => {
    const p = app!.windows()[0]
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
    const url = p.getByRole('textbox', { name: 'URL', exact: true })
    await url.fill('{{baseUrl}}/users/')
    await url.press('End')
    await p.keyboard.type('{{ba')
    const menu = p.getByRole('listbox', { name: 'Variables' })
    await expect(menu.getByRole('option').first()).toContainText('baseUrl')
    if (SHOTS) await p.screenshot({ path: join(SHOTS, 'd2-url-completion.png') })
    await p.keyboard.press('Enter')
    await expect(url).toHaveValue('{{baseUrl}}/users/{{baseUrl}}')
    await expect(menu).toHaveCount(0)
    // The caret sits right after the last chip; checked by eye in this shot.
    if (SHOTS) {
      const box = (await p.locator('.url-box').boundingBox())!
      await p.screenshot({
        path: join(SHOTS, 'd1-caret-after-variable.png'),
        clip: { x: box.x, y: box.y - 4, width: box.width, height: box.height + 8 },
        caret: 'initial',
      })
    }
    await openSection(p, 'Body')
    const body = p.locator('.request-pane .cm-content').first()
    await body.click()
    await p.keyboard.press('ControlOrMeta+End')
    await p.keyboard.type('{{to')
    await expect(p.locator('.cm-tooltip-autocomplete')).toContainText('token')
    await expect(p.locator('.cm-tooltip-autocomplete')).toContainText('••••')
    if (SHOTS) await p.screenshot({ path: join(SHOTS, 'd2-body-completion.png') })
    await p.keyboard.press('Escape')

    // Focus: one border colour change on composed boxes, nothing spilling out of grid cells.
    const focusShot = async (name: string, target: { x: number; y: number; width: number; height: number }) => {
      if (SHOTS) {
        await p.screenshot({
          path: join(SHOTS, `${name}.png`),
          clip: {
            x: Math.max(0, target.x - 12),
            y: Math.max(0, target.y - 12),
            width: target.width + 24,
            height: target.height + 24,
          },
          caret: 'initial',
        })
      }
    }
    await p.getByRole('combobox', { name: 'Search requests' }).focus()
    await focusShot('d5-focus-search', (await p.locator('.quick-open-box').boundingBox())!)
    await p.getByRole('searchbox', { name: 'Filter requests' }).focus()
    await focusShot('d5-focus-filter', (await p.locator('.filter-box').boundingBox())!)
    await url.focus()
    await focusShot('d5-focus-url', (await p.locator('.url-box').boundingBox())!)
    await openSection(p, 'Params')
    const key = p.getByRole('textbox', { name: 'Param key 1' })
    await key.focus()
    await focusShot('d5-focus-grid-cell', (await p.locator('.kv-table').boundingBox())!)
    // Keyboard focus on a tab: an inside ring.
    await p.getByRole('tab', { name: /Hello/ }).focus()
    await p.keyboard.press('ArrowLeft')
    await p.keyboard.press('ArrowRight')
    await focusShot('d5-focus-tab', (await p.locator('.tabstrip').boundingBox())!)
    await envRow(p, 'Local').click()
    const valueCell = p.getByRole('tabpanel').getByLabel('Value 1', { exact: true })
    await valueCell.focus()
    await focusShot('d5-focus-environment-cell', (await p.locator('.env-table').boundingBox())!)
  })

  await test.step('Cmd/Ctrl+S writes an environment and a request right away', async () => {
    const p = app!.windows()[0]
    const editor = p.getByRole('tabpanel')
    const value = editor.getByLabel('Value 4', { exact: true })
    await value.fill('http://saved-by-shortcut.example.test')
    // The environment editor only writes on Save, Cmd/Ctrl+S or close.
    await p.keyboard.press('ControlOrMeta+s')
    const envFiles = (await allFiles(workspace)).filter((f) => /\/environments\/[^/]+\.json$/.test(f))
    await expect
      .poll(async () => {
        const texts = await Promise.all(envFiles.map((f) => readFile(f, 'utf8')))
        return texts.some((t) => t.includes('http://saved-by-shortcut.example.test'))
      })
      .toBe(true)
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

    await p.getByRole('tab', { name: /Hello/ }).click()
    const url = p.getByRole('textbox', { name: 'URL', exact: true })
    await url.fill('{{baseUrl}}/saved-by-shortcut')
    await p.keyboard.press('ControlOrMeta+s')
    // Well within the 500 ms autosave delay: only the shortcut can have written it this soon.
    const requestFile = (await allFiles(workspace)).find((f) => f.endsWith('.request.json'))!
    await expect
      .poll(async () => JSON.parse(await readFile(requestFile, 'utf8')).url, { timeout: 400, intervals: [25] })
      .toBe('{{baseUrl}}/saved-by-shortcut')
  })

  await test.step('scripts set a variable, tests check it, and the console shows the send', async () => {
    const p = app!.windows()[0]
    await p.getByRole('tab', { name: /Hello/ }).click()
    await openSection(p, 'Scripts')
    const scripts = p.getByRole('tablist', { name: 'Scripts' })
    const editor = p.locator('.scripts-editor .cm-content')
    await scripts.getByRole('tab', { name: /^Pre-request/ }).click()
    await editor.click()
    await p.keyboard.type("pm.environment.set('token', 'abc')")
    await scripts.getByRole('tab', { name: /^Post-response/ }).click()
    await editor.click()
    await p.keyboard.type(
      "pm.test('status is 200', () => pm.response.to.have.status(200)); " +
        "pm.test('token was set', () => pm.expect(pm.environment.get('token')).to.equal('abc'))",
    )
    await expect(scripts.getByRole('tab', { name: /^Pre-request/ }).locator('.config-dot')).toHaveCount(1)
    await shotBoth(p, 'f1-scripts-editor')

    await p.getByRole('button', { name: 'Send', exact: true }).click()
    const results = p.getByRole('tab', { name: /^Test Results/ })
    await expect(results).toHaveText('Test Results (2/2)')
    await results.click()
    await expect(p.getByRole('list', { name: 'Test results' }).getByRole('listitem')).toHaveCount(2)
    await shotBoth(p, 'f2-test-results')

    await p.getByRole('button', { name: 'Console', exact: true }).click()
    const consolePanel = p.getByRole('region', { name: 'Console' })
    // Earlier sends of this session are listed too; the newest request line is the last one.
    const latest = consolePanel.locator('.console-request').last()
    await expect(latest).toContainText('GET')
    await expect(latest).toContainText('200')
    await shotBoth(p, 'f3-console')
  })

  await test.step('a collection variable and a collection script reach the request', async () => {
    const p = app!.windows()[0]
    await p.getByRole('treeitem', { name: 'Demo' }).click({ button: 'right' })
    await p.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    await expect(p.getByRole('tab', { name: /Demo/ })).toHaveAttribute('aria-selected', 'true')
    const editor = p.getByRole('tabpanel')
    const sections = editor.getByRole('tablist', { name: 'Collection sections' })
    await sections.getByRole('tab', { name: /^Variables/ }).click()
    await editor.getByRole('textbox', { name: 'Variable key 1' }).fill('traceId')
    await editor.getByRole('textbox', { name: 'Variable value 1' }).fill('trace-from-collection')
    await sections.getByRole('tab', { name: /^Scripts/ }).click()
    await editor.locator('.scripts-editor .cm-content').click()
    await p.keyboard.type("pm.request.headers.upsert({ key: 'X-Trace', value: pm.collectionVariables.get('traceId') })")
    await p.keyboard.press('ControlOrMeta+s')
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const collectionFile = (await allFiles(workspace)).find((f) => f.endsWith('/collection.json'))!
    await expect
      .poll(async () => JSON.parse(await readFile(collectionFile, 'utf8')).variables)
      .toEqual([{ key: 'traceId', value: 'trace-from-collection', enabled: true }])
    await shotBoth(p, 'f4-collection-settings')

    await p.getByRole('tab', { name: /Hello/ }).click()
    traces = []
    await p.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(p.getByRole('tab', { name: /^Test Results/ })).toHaveText('Test Results (2/2)')
    await expect.poll(() => traces).toEqual(['trace-from-collection'])
  })

  await test.step('an edit typed just before quitting is on disk after the quit', async () => {
    const p = app!.windows()[0]
    await p.getByRole('textbox', { name: 'URL', exact: true }).fill('{{baseUrl}}/typed-before-quit')
    // Well within the 500 ms autosave delay: only the quit flush can have written it.
    await app!.close()
    app = undefined
    const files = (await allFiles(workspace)).filter((f) => f.endsWith('.request.json'))
    expect(files).toHaveLength(1)
    expect(JSON.parse(await readFile(files[0], 'utf8')).url).toBe('{{baseUrl}}/typed-before-quit')
  })
})

test('a secret is refused, not stored, when OS encryption is unavailable', async () => {
  const dir = join(root, 'workspace-no-crypto')
  await mkdir(dir)
  const { page } = await launch(dir)
  await app!.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => false
  })
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await page.getByLabel('Workspace name').fill('NoCrypto')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.workspace-name')).toHaveText('NoCrypto')
  await page.getByRole('button', { name: 'New environment' }).click()
  const editor = page.getByRole('tabpanel')
  await editor.getByLabel('Environment name').fill('Locked')
  await editor.getByLabel('Variable name 1').fill('token')
  await pick(page, 'Type 1', 'Secret')
  await editor.getByLabel('Value 1', { exact: true }).fill(SECRET)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('alert')).toBeVisible()
  for (const f of await allFiles(dir)) expect(await readFile(f, 'utf8'), f).not.toContain(SECRET)
})

test('import Postman files and export a collection as v2.1', async () => {
  const dir = join(root, 'workspace-transfer')
  const exportDir = join(root, 'exports')
  await Promise.all([mkdir(dir), mkdir(exportDir)])
  const { page, problems } = await launch(dir, {
    ASTRAL_E2E_IMPORT_FILES: [
      join(POSTMAN_FIXTURES, 'full.v21.postman_collection.json'),
      join(POSTMAN_FIXTURES, 'dev.postman_environment.json'),
    ].join(delimiter),
    ASTRAL_E2E_EXPORT_DIR: exportDir,
  })
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await page.getByLabel('Workspace name').fill('Transfer')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.workspace-name')).toHaveText('Transfer')

  await test.step('import through Choose files', async () => {
    await page.locator('.sidebar').getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await expect(dialog).toBeVisible()
    await shotBoth(page, 'e1-import-empty')
    await dialog.getByRole('button', { name: 'Choose files' }).click()
    await expect(dialog.getByText('Collection "Acme Orders API" imported')).toBeVisible()
    await expect(dialog.getByText('Environment "Dev" imported')).toBeVisible()
    await shotBoth(page, 'e2-import-results')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('treeitem', { name: 'Acme Orders API' })).toBeVisible()
    await expect(envRow(page, 'Dev')).toBeVisible()
  })

  await test.step('export the collection', async () => {
    // The imported collection is expanded, so click its own row rather than the middle of the item and its children.
    await page.getByRole('treeitem', { name: 'Acme Orders API' }).locator('.tree-row').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Export' }).click()
    const target = join(exportDir, 'Acme Orders API.postman_collection.json')
    await expect.poll(() => existsSync(target)).toBe(true)
    const doc = JSON.parse(await readFile(target, 'utf8'))
    expect(doc.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
    expect(doc.info.name).toBe('Acme Orders API')
  })

  expect(problems).toEqual([])
})
