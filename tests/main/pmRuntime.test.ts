import { describe, expect, it } from 'vitest'
import { runScript, type EngineHooks, type RunOptions, type RunOutput } from '../../src/main/scripts/engine'
import { PRELUDE, chaiAsExpression } from '../../src/main/scripts/prelude'
import type { ScriptInput, ScriptResponse, ScriptResult } from '../../src/main/scripts/types'
import type { RequestItem } from '../../src/shared/types'

const OPTS: RunOptions = { cpuMs: 5000, wallMs: 10_000, memoryBytes: 64 * 1024 * 1024 }
const noHooks: EngineHooks = { sendRequest: () => Promise.reject(new Error('unexpected sendRequest')) }

const request = (): RequestItem => ({
  id: 'r1',
  name: 'Get user',
  method: 'GET',
  url: 'https://api.test/users',
  params: [{ key: 'page', value: '1', enabled: true }],
  headers: [
    { key: 'Accept', value: 'application/json', enabled: true },
    { key: 'X-Off', value: 'off', enabled: false },
  ],
  body: { mode: 'none' },
  auth: { type: 'none' },
})

const jsonResponse = (over: Partial<ScriptResponse> = {}): ScriptResponse => ({
  code: 200,
  status: 'OK',
  headers: [
    ['Content-Type', 'application/json; charset=utf-8'],
    ['X-Request-Id', 'abc'],
  ],
  body: '{"id":7,"user":{"name":"Ann","tags":["a",{"c":3}]}}',
  responseTime: 42,
  responseSize: 51,
  cookies: [{ name: 'session', value: 's1', attributes: { Path: '/' } }],
  ...over,
})

type Over = Partial<Omit<ScriptInput, 'variables'>> & { variables?: Partial<ScriptInput['variables']> }

function makeInput(over: Over = {}): ScriptInput {
  const phase = over.phase ?? (over.response ? 'post-response' : 'pre-request')
  return {
    phase,
    info: {
      eventName: phase === 'pre-request' ? 'prerequest' : 'test',
      requestName: 'Get user',
      requestId: 'r1',
      iteration: 0,
      iterationCount: 1,
    },
    request: request(),
    iterationData: {},
    environmentName: 'Dev',
    ...over,
    variables: { local: {}, environment: {}, collection: {}, globals: {}, ...over.variables },
  }
}

const post = (over: Over = {}) => makeInput({ response: jsonResponse(), ...over })

async function run(source: string, input: ScriptInput = makeInput(), hooks: EngineHooks = noHooks) {
  const out = await runScript(PRELUDE, source, input, hooks, OPTS)
  return out as RunOutput & { result: ScriptResult }
}

/** Runs and expects no failure; returns the result and the log texts. */
async function ok(source: string, input?: ScriptInput, hooks?: EngineHooks) {
  const out = await run(source, input, hooks)
  expect(out.error).toBeUndefined()
  return { ...out.result, logs: out.logs.map((l) => l.text), levels: out.logs }
}

/** Runs and returns the failure message. */
async function failure(source: string, input?: ScriptInput) {
  const out = await run(source, input)
  expect(out.error?.kind).toBe('error')
  return out.error!.message
}

describe('the prelude', () => {
  it('returns a result with the unchanged request, variables and no tests', async () => {
    const r = await ok('')
    expect(r.request).toEqual(makeInput().request)
    expect(r.variables).toEqual({ local: {}, environment: {}, collection: {}, globals: {} })
    expect(r.tests).toEqual([])
    expect('nextRequest' in r).toBe(false)
  })

  it('exposes no chai or helper globals besides pm and the legacy ones', async () => {
    const r = await ok(
      `console.log(typeof chai, typeof expect, typeof pm, typeof postman, typeof tests, typeof __finish)`,
    )
    expect(r.logs).toEqual(['undefined undefined object object object function'])
    const helpers = await ok(`console.log(typeof g, typeof define, typeof hasOwn, typeof utf8Encode, typeof MODULES)`)
    expect(helpers.logs).toEqual(['undefined undefined undefined undefined undefined'])
  })
})

describe('chaiAsExpression', () => {
  it('turns the trailing export list into a returned object', () => {
    const code = chaiAsExpression('var a = 1;\nvar b_x = 2;\nexport {\n  a,\n  b_x as b\n};\n')
    expect(new Function(`return ${code}`)()).toEqual({ a: 1, b: 2 })
  })

  it('refuses a bundle without an export list or with imports', () => {
    expect(() => chaiAsExpression('var a = 1')).toThrow('chai: the bundle has no trailing export list')
    expect(() => chaiAsExpression('import x from "y"\nexport { x };')).toThrow(
      'chai: the bundle is expected to have no imports',
    )
  })
})

describe('variable scopes', () => {
  it('converts set values to strings', async () => {
    const r = await ok(`
      pm.environment.set('n', 5)
      pm.environment.set('o', {a: 1})
      pm.environment.set('arr', [1, 'x'])
      pm.environment.set('u', undefined)
      pm.environment.set('nl', null)
      pm.environment.set('b', true)
      pm.environment.set('s', 'text')
    `)
    expect(r.variables.environment).toEqual({
      n: '5',
      o: '{"a":1}',
      arr: '[1,"x"]',
      u: '',
      nl: '',
      b: 'true',
      s: 'text',
    })
  })

  it('gets, sets, unsets, checks, lists and clears each scope', async () => {
    const input = makeInput({
      variables: { environment: { e: 'E', drop: 'x' }, collection: { c: 'C' }, globals: { g: 'G', g2: 'G2' } },
    })
    const r = await ok(
      `
      console.log(pm.environment.get('e'), pm.environment.get('nope'), pm.environment.has('e'), pm.environment.has('c'))
      pm.environment.unset('drop')
      pm.collectionVariables.set('c2', 2)
      console.log(JSON.stringify(pm.collectionVariables.toObject()))
      pm.globals.clear()
      pm.globals.set('g3', 'G3')
      pm.variables.set('l', 'L')
      console.log(pm.variables.get('l'), typeof pm.variables.clear)
    `,
      input,
    )
    expect(r.logs).toEqual(['E undefined true false', '{"c":"C","c2":"2"}', 'L undefined'])
    expect(r.variables).toEqual({
      local: { l: 'L' },
      environment: { e: 'E' },
      collection: { c: 'C', c2: '2' },
      globals: { g3: 'G3' },
    })
  })

  it('resolves pm.variables by precedence: local, environment, collection, globals', async () => {
    const input = makeInput({
      variables: {
        local: { k: 'local' },
        environment: { k: 'env', e: 'env' },
        collection: { k: 'coll', e: 'coll', c: 'coll' },
        globals: { k: 'glob', e: 'glob', c: 'glob', g: 'glob' },
      },
    })
    const r = await ok(
      `console.log(pm.variables.get('k'), pm.variables.get('e'), pm.variables.get('c'), pm.variables.get('g'))
       console.log(pm.variables.has('g'), pm.variables.has('none'))
       console.log(JSON.stringify(pm.variables.toObject()))`,
      input,
    )
    expect(r.logs).toEqual(['local env coll glob', 'true false', '{"k":"local","e":"env","c":"coll","g":"glob"}'])
  })

  it('replaces {{variables}} and keeps unknown ones', async () => {
    const input = makeInput({ variables: { local: { a: 'A' }, environment: { b: 'B' } } })
    const r = await ok(
      `console.log(pm.variables.replaceIn('{{a}}-{{missing}}'))
       console.log(pm.variables.replaceIn('{{ b }}/{{a}}'))
       console.log(pm.environment.replaceIn('{{a}}{{b}}'))`,
      input,
    )
    expect(r.logs).toEqual(['A-{{missing}}', 'B/A', '{{a}}B'])
  })

  it('names the environment', async () => {
    const r = await ok(`console.log(pm.environment.name)`)
    expect(r.logs).toEqual(['Dev'])
  })

  it('does not let a script change the values it got through toObject', async () => {
    const input = makeInput({ variables: { globals: { g: '1' } } })
    const r = await ok(`const o = pm.globals.toObject(); o.g = '2'; o.x = '3'`, input)
    expect(r.variables.globals).toEqual({ g: '1' })
  })
})

describe('without an active environment', () => {
  const noEnv = () => makeInput({ environmentName: undefined, variables: { environment: null } })

  it('pm.environment.get returns undefined and the scope is empty', async () => {
    const r = await ok(
      `console.log(typeof pm.environment.get('a'), pm.environment.has('a'), JSON.stringify(pm.environment.toObject()))`,
      noEnv(),
    )
    expect(r.logs).toEqual(['undefined false {}'])
    expect(r.variables.environment).toBeNull()
  })

  it('pm.environment.set throws', async () => {
    expect(await failure(`pm.environment.set('a', 1)`, noEnv())).toBe('pm.environment.set: no environment is selected')
  })

  it('skips environment values in pm.variables resolution', async () => {
    const input = makeInput({ variables: { environment: null, globals: { a: 'G' } } })
    const r = await ok(`console.log(pm.variables.get('a'))`, input)
    expect(r.logs).toEqual(['G'])
  })
})

describe('pm.request', () => {
  it('reads and assigns the method', async () => {
    const r = await ok(`console.log(pm.request.method); pm.request.method = 'post'`)
    expect(r.logs).toEqual(['GET'])
    expect(r.request.method).toBe('POST')
  })

  it('rejects an unknown method', async () => {
    expect(await failure(`pm.request.method = 'BREW'`)).toBe('pm.request.method: unsupported method BREW')
  })

  it('prints the URL with its enabled, encoded query', async () => {
    const input = makeInput()
    input.request.params.push({ key: 'q', value: 'a b&c', enabled: true }, { key: 'off', value: '1', enabled: false })
    const r = await ok(`console.log(pm.request.url.toString()); console.log(String(pm.request.url))`, input)
    expect(r.logs).toEqual(['https://api.test/users?page=1&q=a%20b%26c', 'https://api.test/users?page=1&q=a%20b%26c'])
  })

  it('edits the query', async () => {
    const r = await ok(`
      const q = pm.request.url.query
      q.add({key: 'a', value: '1'})
      q.upsert({key: 'page', value: '2'})
      q.upsert({key: 'b', value: 'B'})
      console.log(q.get('page'), q.has('a'), q.has('zzz'), JSON.stringify(q.toObject()))
      q.remove('a')
    `)
    expect(r.logs).toEqual(['2 true false {"page":"2","a":"1","b":"B"}'])
    expect(r.request.params).toEqual([
      { key: 'page', value: '2', enabled: true },
      { key: 'b', value: 'B', enabled: true },
    ])
  })

  it('replaces the URL and its params when assigned a string', async () => {
    const r = await ok(`pm.request.url = 'http://h/p?x=1&y=a%20b&flag#frag'`)
    expect(r.request.url).toBe('http://h/p#frag')
    expect(r.request.params).toEqual([
      { key: 'x', value: '1', enabled: true },
      { key: 'y', value: 'a b', enabled: true },
      { key: 'flag', value: '', enabled: true },
    ])
  })

  it('edits headers, matching names without regard to case', async () => {
    const r = await ok(`
      const h = pm.request.headers
      console.log(h.get('accept'), h.has('ACCEPT'), h.has('x-off'), h.get('X-Off'))
      h.add({key: 'X-One', value: '1'})
      h.upsert({key: 'accept', value: 'text/plain'})
      h.upsert({key: 'X-Two', value: '2'})
      h.remove('x-one')
      const seen = []
      h.each((header) => seen.push(header.key + '=' + header.value))
      console.log(seen.join(','), JSON.stringify(h.toObject()))
    `)
    expect(r.logs).toEqual([
      'application/json true false undefined',
      'Accept=text/plain,X-Two=2 {"Accept":"text/plain","X-Two":"2"}',
    ])
    expect(r.request.headers).toEqual([
      { key: 'Accept', value: 'text/plain', enabled: true },
      { key: 'X-Off', value: 'off', enabled: false },
      { key: 'X-Two', value: '2', enabled: true },
    ])
  })

  it('reads and replaces the body', async () => {
    const input = makeInput()
    input.request.body = { mode: 'raw', language: 'json', content: '{"a":1}' }
    const r = await ok(
      `console.log(pm.request.body.mode, pm.request.body.raw)
       pm.request.body.update('{"a":2}')
       console.log(pm.request.body.raw)`,
      input,
    )
    expect(r.logs).toEqual(['raw {"a":1}', '{"a":2}'])
    expect(r.request.body).toEqual({ mode: 'raw', language: 'json', content: '{"a":2}' })
  })

  it('turns an empty body into a raw one on update({mode, raw})', async () => {
    const r = await ok(
      `console.log(pm.request.body.mode, typeof pm.request.body.raw); pm.request.body.update({mode: 'raw', raw: 'hi'})`,
    )
    expect(r.logs).toEqual(['none undefined'])
    expect(r.request.body).toEqual({ mode: 'raw', language: 'text', content: 'hi' })
  })

  it('rejects body modes other than raw', async () => {
    expect(await failure(`pm.request.body.update({mode: 'urlencoded', urlencoded: []})`)).toBe(
      'pm.request.body.update: only raw bodies are supported',
    )
  })

  it('ignores request changes in a post-response script, with a warning', async () => {
    const input = post()
    const r = await ok(
      `pm.request.headers.add({key: 'X-New', value: '1'})
       pm.request.method = 'DELETE'
       pm.request.url = 'http://other'`,
      input,
    )
    expect(r.request).toEqual(input.request)
    expect(r.levels).toEqual([{ level: 'warn', text: 'pm.request changes in a post-response script have no effect' }])
  })
})

describe('pm.response', () => {
  it('exposes the status, timings and size', async () => {
    const r = await ok(
      `console.log(pm.response.code, pm.response.status, pm.response.responseTime, pm.response.responseSize)`,
      post(),
    )
    expect(r.logs).toEqual(['200 OK 42 51'])
  })

  it('reads headers without regard to case', async () => {
    const r = await ok(
      `const h = pm.response.headers
       console.log(h.get('content-type'), h.has('X-REQUEST-ID'), h.has('nope'), typeof h.get('nope'))
       const keys = []; h.each((x) => keys.push(x.key))
       console.log(keys.join(','), JSON.stringify(h.toObject()))`,
      post(),
    )
    expect(r.logs).toEqual([
      'application/json; charset=utf-8 true false undefined',
      'Content-Type,X-Request-Id {"Content-Type":"application/json; charset=utf-8","X-Request-Id":"abc"}',
    ])
  })

  it('returns the body as text and as JSON', async () => {
    const r = await ok(`console.log(pm.response.text().length, pm.response.json().user.name)`, post())
    expect(r.logs).toEqual(['51 Ann'])
  })

  it('throws a clear error from json() on a body that is not JSON', async () => {
    const input = post({ response: jsonResponse({ body: '<html></html>' }) })
    expect(await failure(`pm.response.json()`, input)).toBe('pm.response.json: the response body is not valid JSON')
  })

  it('is not available in a pre-request script', async () => {
    expect(await failure(`pm.response.code`)).toBe('pm.response is only available in post-response scripts')
  })
})

describe('pm.cookies', () => {
  it('reads the response cookies', async () => {
    const r = await ok(
      `const c = pm.cookies
       console.log(c.get('session'), c.has('session'), c.has('x'), typeof c.get('x'))
       console.log(JSON.stringify(pm.cookies.toObject()), pm.response.cookies.get('session'))`,
      post(),
    )
    expect(r.logs).toEqual(['s1 true false undefined', '{"session":"s1"} s1'])
  })

  it('is empty in a pre-request script', async () => {
    const r = await ok(`console.log(pm.cookies.has('session'), JSON.stringify(pm.cookies.toObject()))`)
    expect(r.logs).toEqual(['false {}'])
  })
})

describe('pm.info', () => {
  it('describes the run', async () => {
    const r = await ok(
      `const i = pm.info; console.log(i.eventName, i.requestName, i.requestId, i.iteration, i.iterationCount)`,
      post(),
    )
    expect(r.logs).toEqual(['test Get user r1 0 1'])
  })
})

describe('pm.test', () => {
  it('records passing and failing sync tests in order', async () => {
    const r = await ok(`
      pm.test('passes', () => {})
      pm.test('fails', () => { pm.expect(1).to.equal(2) })
      pm.test('throws', () => { null.x })
    `)
    expect(r.tests).toEqual([
      { name: 'passes', passed: true, skipped: false },
      { name: 'fails', passed: false, skipped: false, error: 'expected 1 to equal 2' },
      { name: 'throws', passed: false, skipped: false, error: expect.stringMatching(/^TypeError: /) },
    ])
  })

  it('records an async test after its promise settles', async () => {
    const r = await ok(`
      pm.test('later', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        pm.expect('a').to.equal('a')
      })
      pm.test('later fail', () => new Promise((_, reject) => setTimeout(() => reject(new Error('nope')), 10)))
    `)
    expect(r.tests).toEqual([
      { name: 'later', passed: true, skipped: false },
      { name: 'later fail', passed: false, skipped: false, error: 'nope' },
    ])
  })

  it('waits for done() when the test takes a callback', async () => {
    const r = await ok(`
      pm.test('done ok', (done) => setTimeout(() => done(), 10))
      pm.test('done error', (done) => setTimeout(() => done(new Error('bad')), 10))
      pm.test('never done', (done) => {})
    `)
    expect(r.tests).toEqual([
      { name: 'done ok', passed: true, skipped: false },
      { name: 'done error', passed: false, skipped: false, error: 'bad' },
      { name: 'never done', passed: false, skipped: false, error: 'done() was not called' },
    ])
  })

  it('records skipped tests', async () => {
    const r = await ok(`pm.test.skip('later', () => { throw new Error('not run') })`)
    expect(r.tests).toEqual([{ name: 'later', passed: false, skipped: true }])
  })

  it('keeps tests recorded before the script threw', async () => {
    const out = await run(`pm.test('first', () => {}); throw new Error('boom')`)
    expect(out.error).toEqual({ message: 'boom', kind: 'error' })
    expect(out.result.tests).toEqual([{ name: 'first', passed: true, skipped: false }])
  })
})

describe('pm.expect', () => {
  it("is chai's expect", async () => {
    const r = await ok(`
      pm.test('deep', () => pm.expect({a: [1]}).to.deep.equal({a: [1]}))
      pm.test('include', () => pm.expect('hello').to.include('ell'))
      pm.test('message', () => pm.expect(1).to.equal(2))
      pm.test('custom', () => pm.expect(1, 'the count').to.equal(2))
    `)
    expect(r.tests.map((t) => [t.passed, t.error])).toEqual([
      [true, undefined],
      [true, undefined],
      [false, 'expected 1 to equal 2'],
      [false, 'the count: expected 1 to equal 2'],
    ])
  })

  it('fails the script with chai’s message outside a test', async () => {
    expect(await failure(`pm.expect(1).to.equal(2)`)).toBe('AssertionError: expected 1 to equal 2')
  })
})

describe('response assertions', () => {
  /** Runs each assertion as its own test against `response`; returns [name, passed] pairs and the errors. */
  async function check(assertions: string[], response = jsonResponse()) {
    const source = assertions.map((a, i) => `pm.test(${JSON.stringify(String(i))}, () => { ${a} })`).join('\n')
    const r = await ok(source, post({ response }))
    return r.tests.map((t, i) => ({ assertion: assertions[i], passed: t.passed, error: t.error }))
  }

  const passed = (results: { passed: boolean }[]) => results.map((r) => r.passed)

  it('checks the status by code or text', async () => {
    const results = await check([
      'pm.response.to.have.status(200)',
      "pm.response.to.have.status('OK')",
      'pm.response.to.have.status(201)',
      "pm.response.to.have.status('Created')",
      'pm.response.to.not.have.status(404)',
      'pm.response.to.not.have.status(200)',
      'pm.expect(pm.response).to.have.status(200)',
    ])
    expect(passed(results)).toEqual([true, true, false, false, true, false, true])
    expect(results[2].error).toBe('expected response to have status code 201 but got 200')
    expect(results[3].error).toBe("expected response to have status reason 'Created' but got 'OK'")
    expect(results[5].error).toBe('expected response to not have status code 200')
  })

  it('checks the status class', async () => {
    const at = (code: number) =>
      check(
        ['to.be.ok', 'to.be.success', 'to.be.clientError', 'to.be.serverError', 'to.be.error'].map(
          (a) => `pm.response.${a}`,
        ),
        jsonResponse({ code }),
      )
    expect(passed(await at(200))).toEqual([true, true, false, false, false])
    expect(passed(await at(204))).toEqual([false, true, false, false, false])
    expect(passed(await at(404))).toEqual([false, false, true, false, true])
    expect(passed(await at(503))).toEqual([false, false, false, true, true])
    const negated = await check(['pm.response.to.not.be.ok', 'pm.response.to.not.be.error'])
    expect(passed(negated)).toEqual([false, true])
    expect(negated[0].error).toBe('expected response to not have status code 200')
    const failed = await check(['pm.response.to.be.clientError'])
    expect(failed[0].error).toBe('expected response to have a 4xx status code but got 200')
  })

  it("keeps chai's own ok for other values", async () => {
    const results = await check(['pm.expect(1).to.be.ok', 'pm.expect(0).to.be.ok'])
    expect(passed(results)).toEqual([true, false])
    expect(results[1].error).toBe('expected +0 to be truthy')
  })

  it('checks headers', async () => {
    const results = await check([
      "pm.response.to.have.header('content-type')",
      "pm.response.to.have.header('X-Request-Id', 'abc')",
      "pm.response.to.have.header('X-Request-Id', 'xyz')",
      "pm.response.to.have.header('Missing')",
      "pm.response.to.not.have.header('Missing')",
    ])
    expect(passed(results)).toEqual([true, true, false, false, true])
    expect(results[2].error).toBe("expected header 'X-Request-Id' to have value 'xyz' but got 'abc'")
    expect(results[3].error).toBe("expected response to have header 'Missing'")
  })

  it('checks the body', async () => {
    const response = jsonResponse({ body: 'hello world' })
    const results = await check(
      [
        'pm.response.to.have.body()',
        "pm.response.to.have.body('hello world')",
        "pm.response.to.have.body('hello')",
        'pm.response.to.have.body(/wor/)',
        'pm.response.to.have.body(/^x/)',
        "pm.response.to.not.have.body('x')",
      ],
      response,
    )
    expect(passed(results)).toEqual([true, true, false, true, false, true])
    expect(results[2].error).toBe("expected response body to equal 'hello'")
    expect(results[4].error).toBe('expected response body to match /^x/')
  })

  it('checks the JSON body and paths in it', async () => {
    const results = await check([
      'pm.response.to.be.json',
      'pm.response.to.have.jsonBody()',
      "pm.response.to.have.jsonBody('user.name')",
      "pm.response.to.have.jsonBody('user.name', 'Ann')",
      "pm.response.to.have.jsonBody('user.tags.1.c', 3)",
      "pm.response.to.have.jsonBody('user.tags', ['a', {c: 3}])",
      "pm.response.to.have.jsonBody('user.age')",
      "pm.response.to.have.jsonBody('user.name', 'Bob')",
      "pm.response.to.not.have.jsonBody('user.age')",
    ])
    expect(passed(results)).toEqual([true, true, true, true, true, true, false, false, true])
    expect(results[6].error).toBe("expected response JSON to have path 'user.age'")
    expect(results[7].error).toBe("expected response JSON at 'user.name' to deeply equal 'Bob' but got 'Ann'")
  })

  it('fails the JSON checks on a body that is not JSON', async () => {
    const results = await check(
      ['pm.response.to.be.json', "pm.response.to.have.jsonBody('a')", 'pm.response.to.not.be.json'],
      jsonResponse({ body: '<html>' }),
    )
    expect(passed(results)).toEqual([false, false, true])
    expect(results[0].error).toBe('expected response body to be valid JSON')
    expect(results[1].error).toBe('expected response body to be valid JSON')
  })

  it('refuses response assertions on something that is not a response', async () => {
    const results = await check(['pm.expect({code: 200}).to.have.status(200)'])
    expect(results[0].error).toBe('status: expected a response, got {"code":200}')
  })
})

describe('iteration data', () => {
  const row = { user: 'ann', id: 7, nested: { a: [1, 'x'] }, empty: null }

  it('reads the row through pm.iterationData, values as they are in the data file', async () => {
    const r = await ok(
      `console.log(pm.iterationData.get('user'), pm.iterationData.get('id') === 7, pm.iterationData.get('nope'))
       console.log(JSON.stringify(pm.iterationData.get('nested')), pm.iterationData.get('empty') === null)
       console.log(pm.iterationData.has('user'), pm.iterationData.has('empty'), pm.iterationData.has('nope'))
       console.log(JSON.stringify(pm.iterationData.toObject()), JSON.stringify(pm.iterationData))`,
      makeInput({ iterationData: row }),
    )
    const all = JSON.stringify(row)
    expect(r.logs).toEqual(['ann true undefined', '{"a":[1,"x"]} true', 'true true false', `${all} ${all}`])
  })

  it('unsets a key for the rest of the script only', async () => {
    const r = await ok(
      `pm.iterationData.unset('user')
       console.log(pm.iterationData.has('user'), pm.variables.get('user'), pm.iterationData.has('id'))`,
      makeInput({ iterationData: row }),
    )
    expect(r.logs).toEqual(['false undefined true'])
    expect(r.variables).toEqual({ local: {}, environment: {}, collection: {}, globals: {} })
  })

  it('gives copies, so changing a returned value leaves the row alone', async () => {
    const r = await ok(
      `pm.iterationData.get('nested').a.push(2)
       pm.iterationData.toObject().user = 'bob'
       console.log(JSON.stringify(pm.iterationData.get('nested')), pm.iterationData.get('user'))`,
      makeInput({ iterationData: row }),
    )
    expect(r.logs).toEqual(['{"a":[1,"x"]} ann'])
  })

  it('resolves data after local variables and before the environment', async () => {
    const input = makeInput({
      iterationData: { a: 'data-a', b: 'data-b', n: 5, o: { x: 1 }, z: null },
      variables: { local: { a: 'local-a' }, environment: { a: 'env-a', b: 'env-b', c: 'env-c' } },
    })
    const r = await ok(
      `console.log(pm.variables.get('a'), pm.variables.get('b'), pm.variables.get('c'))
       const v = pm.variables
       console.log(v.get('n'), v.get('o'), JSON.stringify(v.get('z')), v.has('z'))
       console.log(pm.variables.replaceIn('{{a}}/{{b}}/{{n}}/{{o}}/{{c}}/{{missing}}'))
       console.log(JSON.stringify(pm.variables.toObject()))`,
      input,
    )
    expect(r.logs).toEqual([
      'local-a data-b env-c',
      '5 {"x":1} "" true',
      'local-a/data-b/5/{"x":1}/env-c/{{missing}}',
      '{"a":"local-a","b":"data-b","c":"env-c","n":"5","o":"{\\"x\\":1}","z":""}',
    ])
  })

  it('exposes the row as the frozen legacy global data', async () => {
    const r = await ok(
      `data.user = 'bob'
       console.log(data.user, data.id, Object.isFrozen(data))`,
      makeInput({ iterationData: row }),
    )
    expect(r.logs).toEqual(['ann 7 true'])
  })

  it('treats a key named __proto__ as data', async () => {
    const r = await ok(
      `const d = pm.iterationData
       console.log(d.get('__proto__'), pm.variables.get('__proto__'), d.has('toString'))`,
      makeInput({ iterationData: JSON.parse('{"__proto__":"p"}') }),
    )
    expect(r.logs).toEqual(['p p false'])
  })

  it('is empty outside the runner', async () => {
    const r = await ok(`console.log(JSON.stringify(pm.iterationData.toObject()), JSON.stringify(data))`)
    expect(r.logs).toEqual(['{} {}'])
  })

  it('reflects the iteration in pm.info', async () => {
    const input = makeInput()
    const r = await ok(
      `console.log(pm.info.iteration, pm.info.iterationCount)`,
      makeInput({ info: { ...input.info, iteration: 2, iterationCount: 5 } }),
    )
    expect(r.logs).toEqual(['2 5'])
  })
})

describe('postman.setNextRequest', () => {
  it('records the next request, or null to stop', async () => {
    expect((await ok(`postman.setNextRequest('Login')`)).nextRequest).toBe('Login')
    expect((await ok(`postman.setNextRequest(null)`)).nextRequest).toBeNull()
  })
})

describe('legacy globals', () => {
  it('records tests[name] = bool as tests', async () => {
    const r = await ok(
      `tests['is 200'] = responseCode.code === 200; tests['bad'] = false; pm.test('pm', () => {})`,
      post(),
    )
    expect(r.tests).toEqual([
      { name: 'pm', passed: true, skipped: false },
      { name: 'is 200', passed: true, skipped: false },
      { name: 'bad', passed: false, skipped: false },
    ])
  })

  it('exposes the response as responseBody, responseCode, responseTime and responseHeaders', async () => {
    const r = await ok(
      `console.log(JSON.parse(responseBody).id, responseCode.code, responseCode.name, responseTime)
       console.log(responseHeaders['X-Request-Id'])`,
      post(),
    )
    expect(r.logs).toEqual(['7 200 OK 42', 'abc'])
  })

  it('does not define the response globals in a pre-request script', async () => {
    const r = await ok(`console.log(typeof responseBody, typeof responseCode)`)
    expect(r.logs).toEqual(['undefined undefined'])
  })

  it('reads and writes environment and global variables through postman.*', async () => {
    const input = makeInput({ variables: { environment: { e: 'E', drop: '1' }, globals: { g: 'G', gone: '1' } } })
    const r = await ok(
      `console.log(postman.getEnvironmentVariable('e'), postman.getGlobalVariable('g'))
       postman.setEnvironmentVariable('e2', 2)
       postman.clearEnvironmentVariable('drop')
       postman.setGlobalVariable('g2', {x: 1})
       postman.clearGlobalVariable('gone')`,
      input,
    )
    expect(r.logs).toEqual(['E G'])
    expect(r.variables.environment).toEqual({ e: 'E', e2: '2' })
    expect(r.variables.globals).toEqual({ g: 'G', g2: '{"x":1}' })
  })

  it('names the legacy call when no environment is selected', async () => {
    const input = makeInput({ variables: { environment: null } })
    expect(await failure(`postman.setEnvironmentVariable('a', 1)`, input)).toBe(
      'postman.setEnvironmentVariable: no environment is selected',
    )
  })
})

describe('unsupported members', () => {
  it('throws on an unknown pm member', async () => {
    expect(await failure(`pm.foo`)).toBe('pm.foo is not supported in Astral Maria')
  })

  it.each(['vault', 'visualizer', 'execution', 'require'])('pm.%s is unsupported', async (name) => {
    expect(await failure(`pm.${name}`)).toBe(`pm.${name} is not supported in Astral Maria`)
  })

  it('throws on an unknown postman member', async () => {
    expect(await failure(`postman.getResponseHeader('x')`)).toBe(
      'postman.getResponseHeader is not supported in Astral Maria',
    )
  })

  it('still lets pm be logged and checked', async () => {
    const r = await ok(`console.log(typeof pm, 'test' in pm, 'foo' in pm, String(pm))`)
    expect(r.logs).toEqual(['object true false [object Object]'])
  })
})

describe('pm.sendRequest', () => {
  const hooks = (seen: unknown[]): EngineHooks => ({
    sendRequest: async (raw) => {
      seen.push(raw)
      return jsonResponse({ code: 201, status: 'Created', body: '{"token":"t1"}' })
    },
  })

  it('passes the request through and gives the callback a response object', async () => {
    const seen: unknown[] = []
    const r = await ok(
      `pm.sendRequest({url: 'http://x/login', method: 'POST'}, (err, res) => {
         console.log(err, res.code, res.status, res.json().token, res.text(), res.headers.get('x-request-id'))
         pm.test('created', () => res.to.have.status(201))
       })`,
      makeInput(),
      hooks(seen),
    )
    expect(seen).toEqual([{ url: 'http://x/login', method: 'POST' }])
    expect(r.logs).toEqual(['null 201 Created t1 {"token":"t1"} abc'])
    expect(r.tests).toEqual([{ name: 'created', passed: true, skipped: false }])
  })

  it('returns a promise when no callback is passed', async () => {
    const seen: unknown[] = []
    const r = await ok(
      `const res = await pm.sendRequest('http://x'); pm.variables.set('token', res.json().token)`,
      makeInput(),
      hooks(seen),
    )
    expect(seen).toEqual(['http://x'])
    expect(r.variables.local).toEqual({ token: 't1' })
  })

  it('delivers failures to the callback and rejects the promise', async () => {
    const failing: EngineHooks = { sendRequest: () => Promise.reject(new Error('connection refused')) }
    const r = await ok(
      `pm.sendRequest('http://x', (err, res) => console.log(err.message, typeof res))
       try { await pm.sendRequest('http://x') } catch (e) { console.log('caught', e.message) }`,
      makeInput(),
      failing,
    )
    expect(r.logs).toEqual(['connection refused undefined', 'caught connection refused'])
  })
})

describe('Node-style helpers', () => {
  // A JWT whose payload is {"role":"USER","iat":1700000000,"exp":1700003600,"name":"Jörg"}, base64url without padding.
  const payload = { role: 'USER', iat: 1700000000, exp: 1700003600, name: 'Jörg' }
  const token = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.')

  it('decodes a JWT payload with Buffer.from(..., "base64") as a Postman script does', async () => {
    const r = await ok(
      `const json = pm.response.json()
       pm.environment.set('token', json.token)
       const base64Payload = json.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
       const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'))
       pm.test('role and expiration', () => {
         pm.expect(payload.role).to.eql('USER')
         pm.expect(payload.exp).to.be.above(payload.iat)
       })
       console.log(payload.name)`,
      post({ response: jsonResponse({ body: JSON.stringify({ token }) }) }),
    )
    expect(r.tests).toEqual([{ name: 'role and expiration', passed: true, skipped: false }])
    expect(r.logs).toEqual(['Jörg'])
    expect(r.variables.environment).toEqual({ token })
  })

  it('round-trips utf8, base64, base64url, hex and latin1 like Node', async () => {
    const r = await ok(
      `const b = Buffer.from('Jörg 🙂')
       console.log(b.length, b.toString('base64'), b.toString('base64url'), b.toString('hex'))
       console.log(Buffer.from(b.toString('base64'), 'base64').toString(), Buffer.from(b.toString('hex'), 'hex').toString('utf8'))
       console.log(Buffer.from('ÿ', 'latin1')[0], Buffer.byteLength('Jörg'), Buffer.isBuffer(b), b instanceof Uint8Array)
       console.log(Buffer.concat([Buffer.from('a'), Buffer.from('bc')]).toString(), JSON.stringify(Buffer.from('hi')))`,
    )
    const b = Buffer.from('Jörg 🙂')
    expect(r.logs).toEqual([
      `${b.length} ${b.toString('base64')} ${b.toString('base64url')} ${b.toString('hex')}`,
      'Jörg 🙂 Jörg 🙂',
      '255 5 true true',
      'abc {"type":"Buffer","data":[104,105]}',
    ])
  })

  it('decodes unpadded base64url and skips characters outside the alphabet, like Node', async () => {
    const r = await ok(`console.log(Buffer.from('SGk_-w', 'base64').toString('hex'), Buffer.from('SG k=\\n', 'base64').toString())`)
    expect(r.logs).toEqual([`${Buffer.from('SGk_-w', 'base64').toString('hex')} Hi`])
  })

  it('provides atob, btoa, TextEncoder and TextDecoder', async () => {
    const r = await ok(
      `console.log(btoa('user:pass'), atob('dXNlcjpwYXNz'), new TextDecoder().decode(new TextEncoder().encode('Jörg')))`,
    )
    expect(r.logs).toEqual(['dXNlcjpwYXNz user:pass Jörg'])
    expect(await failure(`btoa('Jörg 🙂')`)).toBe('btoa: the string contains characters outside of the Latin1 range')
  })

  it("supports require('buffer'), require('atob') and require('btoa') and still refuses other modules", async () => {
    const r = await ok(`const { Buffer: B } = require('buffer'); console.log(B === Buffer, require('btoa')('a'), require('atob')('YQ=='))`)
    expect(r.logs).toEqual(['true YQ== a'])
    expect(await failure(`require('fs')`)).toBe("require('fs') is not supported in Astral Maria")
  })

  it('names an unsupported encoding', async () => {
    expect(await failure(`Buffer.from('a', 'utf16le')`)).toBe('Buffer: unsupported encoding "utf16le" in Astral Maria')
  })
})
