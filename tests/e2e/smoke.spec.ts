import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const MAIN = resolve(__dirname, '../../out/main/index.js')
// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const SECRET = 's3cr3t-e2e-PLAIN-TEXT-9f1c'
const BODY = { greeting: 'hello from the astral test server' }
/** Set ASTRAL_E2E_SHOTS to a directory to also save screenshots there. */
const SHOTS = process.env.ASTRAL_E2E_SHOTS

let server: Server
let baseUrl: string
let hits: string[] = []
let root: string
let userData: string
let workspace: string
let downloadDir: string
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/page') {
      res.setHeader('content-type', 'text/html')
      // The tracker image must never be fetched by the preview.
      res.end(`<h1>Preview heading</h1><img src="${baseUrl}/tracker">`)
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

async function launch(): Promise<{ app: ElectronApplication; page: Page; problems: string[]; requests: string[] }> {
  app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test', ASTRAL_E2E_WORKSPACE: workspace },
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
  })

  await test.step('create a workspace', async () => {
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await page.getByLabel('Workspace name').fill('Smoke')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.workspace-name')).toHaveText('Smoke')
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
    await page.getByRole('button', { name: 'Manage environments' }).click()
    const dialog = page.getByRole('dialog', { name: 'Environments' })
    await dialog.getByRole('button', { name: 'New environment' }).click()
    await dialog.getByLabel('Environment name').fill('Local')
    await dialog.getByRole('button', { name: 'Add variable' }).click()
    await dialog.getByLabel('Variable name 1').fill('baseUrl')
    await dialog.getByLabel('Shared value 1').fill(baseUrl)
    await dialog.getByRole('button', { name: 'Add variable' }).click()
    await dialog.getByLabel('Variable name 2').fill('token')
    await dialog.getByLabel('Secret 2').check()
    await dialog.getByLabel('Current value 2').fill(SECRET)
    await shot(page, '1-environment-editor')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Environment' }).selectOption({ label: 'Local' })
  })

  await test.step('send the request and see the response', async () => {
    await page.getByRole('textbox', { name: 'URL', exact: true }).fill('{{baseUrl}}/hello?key={{token}}')
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.status-badge')).toHaveText('200 OK')
    await expect(page.locator('.response-viewer .cm-content')).toContainText(BODY.greeting)
    expect(hits).toEqual([`/hello?key=${SECRET}`])
    await shot(page, '2-response')
  })

  await test.step('the request editor accepts typing in CodeMirror', async () => {
    await page.getByRole('tab', { name: 'Body' }).first().click()
    const raw = page.getByRole('radio', { name: /raw/i })
    if (await raw.count()) await raw.first().check()
    const editor = page.locator('.request-pane .cm-content').first()
    await editor.click()
    await page.keyboard.type('{"a":1}')
    await expect(editor).toContainText('{"a":1}')
    await shot(page, '3-body-editor')
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

  await test.step('HTML preview (srcdoc iframe) and image preview (data: URL) work under the CSP', async () => {
    await page.getByRole('textbox', { name: 'URL', exact: true }).fill('{{baseUrl}}/page')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('radio', { name: 'Preview' }).check()
    await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole('heading')).toHaveText('Preview heading')
    await shot(page, '4-html-preview')
    await page.getByRole('textbox', { name: 'URL', exact: true }).fill('{{baseUrl}}/image')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const img = page.getByRole('img', { name: 'Response body' })
    await expect(img).toBeVisible()
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
    await shot(page, '5-image-preview')
  })

  await test.step('files on disk: layout and no plain-text secret outside .local', async () => {
    const files = (await allFiles(workspace)).map((f) => relative(workspace, f))
    const requestFile = files.find((f) => /^collections\/[^/]+\/[^/]+\.request\.json$/.test(f))
    expect(requestFile, files.join('\n')).toBeTruthy()
    expect(existsSync(join(workspace, requestFile!))).toBe(true)
    for (const f of files.filter((f) => !f.startsWith('.local/'))) {
      expect(await readFile(join(workspace, f), 'utf8'), f).not.toContain(SECRET)
    }
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
    await p
      .getByRole('button', { name: 'Actions for Demo' })
      .click()
      .catch(() => undefined)
    await p.getByRole('treeitem', { name: 'Hello' }).click()
    await expect(p.getByRole('textbox', { name: 'URL', exact: true })).toHaveValue('{{baseUrl}}/image')
    await p.getByRole('button', { name: 'Manage environments' }).click()
    const dialog = p.getByRole('dialog', { name: 'Environments' })
    await dialog.getByRole('button', { name: 'Local' }).click()
    await expect(dialog.getByLabel('Variable name 1')).toHaveValue('baseUrl')
    await expect(dialog.getByLabel('Shared value 1')).toHaveValue(baseUrl)
    await expect(dialog.getByLabel('Variable name 2')).toHaveValue('token')
    await expect(dialog.getByLabel('Current value 2')).toHaveValue(SECRET)
    expect(second.problems).toEqual([])
  })
})
