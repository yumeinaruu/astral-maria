// The pm runtime: plain JavaScript evaluated inside the QuickJS VM before every script. prelude.ts wraps it in a
// function that has `chai` (chai's exports) in scope, so nothing here becomes a global unless it is defined on
// globalThis explicitly.
//
// It reads the frozen JSON input `__input` (ScriptInput in types.ts) and installs `pm`, `postman`, the legacy
// globals and `__finish`, which the engine calls once the script has settled and which returns ScriptResult.
// The API follows Postman's public documentation; nothing is copied from Postman.

/* global chai */

const g = globalThis
const input = g.__input
const isPost = input.phase === 'post-response'
const hostSend = g.__sendRequest
const warn = g.console.warn

// pm.sendRequest is the only way to reach the bridge.
delete g.__sendRequest

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const define = (name, value, writable = true) =>
  Object.defineProperty(g, name, { value, writable, configurable: writable, enumerable: false })

/** Sets a key on a plain object even when it is `__proto__`. */
function put(object, key, value) {
  Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: true })
}

function unsupported(name) {
  return new Error(name + ' is not supported in Astral Maria')
}

/** Proxies `target` so reading a member it does not have throws the "not supported" error. */
function guard(target, label) {
  return new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === 'symbol' || key in t) return Reflect.get(t, key, receiver)
      // Probed by await, console formatting and JSON; answer "absent" instead of throwing.
      if (key === 'then' || key === 'toJSON') return undefined
      throw unsupported(label + '.' + key)
    },
  })
}

/** Variable values are strings: strings stay, undefined and null become '', objects go through JSON. */
function toValue(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  }
  return String(value)
}

function errorText(e) {
  if (typeof e === 'object' && e !== null && typeof e.message === 'string') {
    const name = e.name
    return typeof name === 'string' && name !== '' && name !== 'Error' && name !== 'AssertionError'
      ? name + ': ' + e.message
      : e.message
  }
  return String(e)
}

function display(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch (e) {
    return String(value)
  }
}

// ---- Variables ---------------------------------------------------------------------------------------------------

/** Stores have no prototype, so any key (`__proto__`, `constructor`) is plain data. */
function toStore(object) {
  const store = Object.create(null)
  for (const key of Object.keys(object)) store[key] = String(object[key])
  return store
}

function plainCopy(store) {
  const out = {}
  for (const key of Object.keys(store)) put(out, key, store[key])
  return out
}

const stores = {
  local: toStore(input.variables.local),
  environment: input.variables.environment === null ? null : toStore(input.variables.environment),
  collection: toStore(input.variables.collection),
  globals: toStore(input.variables.globals),
}

/** Resolution order, highest first. */
const RESOLUTION = ['local', 'environment', 'collection', 'globals']

function lookup(scope, key) {
  const store = stores[scope]
  key = String(key)
  return store !== null && hasOwn(store, key) ? store[key] : undefined
}

function resolve(key) {
  for (const scope of RESOLUTION) {
    const value = lookup(scope, key)
    if (value !== undefined) return value
  }
  return undefined
}

function writableStore(scope, api) {
  const store = stores[scope]
  if (store === null) throw new Error(api + ': no environment is selected')
  return store
}

function setVar(scope, api, key, value) {
  writableStore(scope, api)[String(key)] = toValue(value)
}

function unsetVar(scope, key) {
  const store = stores[scope]
  if (store !== null) delete store[String(key)]
}

const VARIABLE = /\{\{\s*([^{}\s]+)\s*\}\}/g

function replaceIn(text, get) {
  if (typeof text !== 'string') return text
  return text.replace(VARIABLE, (match, name) => {
    const value = get(name)
    return value === undefined ? match : value
  })
}

function scopeApi(scope, label) {
  const api = {
    get: (key) => lookup(scope, key),
    set: (key, value) => setVar(scope, label + '.set', key, value),
    unset: (key) => unsetVar(scope, key),
    has: (key) => lookup(scope, key) !== undefined,
    toObject: () => (stores[scope] === null ? {} : plainCopy(stores[scope])),
    clear: () => {
      if (stores[scope] !== null) stores[scope] = Object.create(null)
    },
    replaceIn: (text) => replaceIn(text, (name) => lookup(scope, name)),
  }
  return api
}

const environment = scopeApi('environment', 'pm.environment')
Object.defineProperty(environment, 'name', {
  get: () => (stores.environment === null ? undefined : input.environmentName),
  enumerable: true,
})

const variables = {
  get: (key) => resolve(key),
  set: (key, value) => setVar('local', 'pm.variables.set', key, value),
  unset: (key) => unsetVar('local', key),
  has: (key) => resolve(key) !== undefined,
  toObject() {
    const out = {}
    for (const scope of RESOLUTION.slice().reverse()) {
      if (stores[scope] !== null) for (const key of Object.keys(stores[scope])) put(out, key, stores[scope][key])
    }
    return out
  },
  replaceIn: (text) => replaceIn(text, resolve),
}

// ---- Key/value lists (query params, headers) ---------------------------------------------------------------------

/**
 * A list over rows `{ key, value, enabled }`. Reads see enabled rows only; `ignoreCase` matches keys as header names
 * do. `onChange` is called before every mutation; read-only lists pass none and get no mutators.
 */
function keyValueList(rows, ignoreCase, label, onChange) {
  const norm = ignoreCase ? (key) => String(key).toLowerCase() : (key) => String(key)
  const matches = (row, key) => norm(row.key) === norm(key)
  const enabled = () => rows().filter((row) => row.enabled)
  const pair = (item, api) => {
    if (typeof item !== 'object' || item === null) throw new TypeError(label + '.' + api + ': expected {key, value}')
    return { key: String(item.key === undefined ? '' : item.key), value: toValue(item.value) }
  }
  const keyOf = (item) => (typeof item === 'object' && item !== null ? item.key : item)

  const list = {
    get(key) {
      const row = enabled().find((r) => matches(r, key))
      return row === undefined ? undefined : row.value
    },
    has(key, value) {
      return enabled().some((r) => matches(r, key) && (value === undefined || r.value === String(value)))
    },
    toObject() {
      const out = {}
      for (const row of enabled()) if (!hasOwn(out, row.key)) put(out, row.key, row.value)
      return out
    },
    each(fn) {
      for (const row of enabled()) fn({ key: row.key, value: row.value })
    },
  }
  if (!onChange) return list

  list.add = (item) => {
    const { key, value } = pair(item, 'add')
    onChange()
    rows().push({ key, value, enabled: true })
  }
  list.upsert = (item) => {
    const { key, value } = pair(item, 'upsert')
    onChange()
    const row = rows().find((r) => matches(r, key))
    if (row) {
      row.value = value
      row.enabled = true
    } else {
      rows().push({ key, value, enabled: true })
    }
  }
  list.remove = (item) => {
    const key = keyOf(item)
    onChange()
    const all = rows()
    for (let i = all.length - 1; i >= 0; i--) if (matches(all[i], key)) all.splice(i, 1)
  }
  return list
}

// ---- URLs --------------------------------------------------------------------------------------------------------

const VARIABLE_PART = /(\{\{[^{}]*\}\})/

/** Applies `fn` to the text between `{{variables}}`; the variables themselves are kept as written. */
function outsideVariables(text, fn) {
  return text
    .split(VARIABLE_PART)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

const encodePart = (text) =>
  outsideVariables(text, (part) => {
    try {
      return encodeURIComponent(part)
    } catch (e) {
      return part
    }
  })

const decodePart = (text) =>
  outsideVariables(text, (part) => {
    try {
      return decodeURIComponent(part)
    } catch (e) {
      return part
    }
  })

/** Index of the first `ch` from `from` on that is not inside a `{{variable}}`, or -1. */
function indexOutside(text, ch, from) {
  for (let i = from || 0; i < text.length; i++) {
    if (text.startsWith('{{', i)) {
      const end = text.indexOf('}}', i + 2)
      if (end >= 0 && !/[{}]/.test(text.slice(i + 2, end))) {
        i = end + 1
        continue
      }
    }
    if (text[i] === ch) return i
  }
  return -1
}

function splitOutside(text, ch) {
  const parts = []
  let start = 0
  for (let at = indexOutside(text, ch, 0); at >= 0; at = indexOutside(text, ch, start)) {
    parts.push(text.slice(start, at))
    start = at + 1
  }
  parts.push(text.slice(start))
  return parts
}

function cutFragment(text) {
  const hash = indexOutside(text, '#', 0)
  return hash < 0 ? [text, ''] : [text.slice(0, hash), text.slice(hash)]
}

/** Splits a URL into the base (keeping any #fragment) and its decoded, enabled query params. */
function parseUrl(text) {
  const [before, fragment] = cutFragment(text)
  const q = indexOutside(before, '?', 0)
  if (q < 0) return { url: text, params: [] }
  const params = splitOutside(before.slice(q + 1), '&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = indexOutside(pair, '=', 0)
      return eq < 0
        ? { key: decodePart(pair), value: '', enabled: true }
        : { key: decodePart(pair.slice(0, eq)), value: decodePart(pair.slice(eq + 1)), enabled: true }
    })
  return { url: before.slice(0, q) + fragment, params }
}

function buildUrl(url, params) {
  const [base, fragment] = cutFragment(url)
  const pairs = params
    .filter((p) => p.enabled && (p.key !== '' || p.value !== ''))
    .map((p) => encodePart(p.key) + '=' + encodePart(p.value))
  if (pairs.length === 0) return url
  return base + (indexOutside(base, '?', 0) >= 0 ? '&' : '?') + pairs.join('&') + fragment
}

// ---- pm.request --------------------------------------------------------------------------------------------------

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const request = JSON.parse(JSON.stringify(input.request))
let warnedPostChange = false

/** Called before every request change. After the send the changes still apply to `pm.request`, but go nowhere. */
function changeRequest() {
  if (isPost && !warnedPostChange) {
    warnedPostChange = true
    warn('pm.request changes in a post-response script have no effect')
  }
}

const requestUrl = {
  query: keyValueList(() => request.params, false, 'pm.request.url.query', changeRequest),
  toString: () => buildUrl(request.url, request.params),
  toJSON: () => buildUrl(request.url, request.params),
}

const requestBody = {
  get mode() {
    return request.body.mode
  },
  get raw() {
    return request.body.mode === 'raw' ? request.body.content : undefined
  },
  update(value) {
    let raw
    if (typeof value === 'string') raw = value
    else if (typeof value === 'object' && value !== null && value.mode === 'raw') raw = toValue(value.raw)
    else throw new Error('pm.request.body.update: only raw bodies are supported')
    changeRequest()
    const language = request.body.mode === 'raw' ? request.body.language : 'text'
    request.body = { mode: 'raw', language, content: raw }
  },
  toString: () => (request.body.mode === 'raw' ? request.body.content : ''),
}

const pmRequest = {
  get method() {
    return request.method
  },
  set method(value) {
    const method = String(value).toUpperCase()
    if (!METHODS.includes(method)) throw new Error('pm.request.method: unsupported method ' + method)
    changeRequest()
    request.method = method
  },
  get url() {
    return requestUrl
  },
  set url(value) {
    const parsed = parseUrl(String(value))
    changeRequest()
    request.url = parsed.url
    request.params = parsed.params
  },
  headers: keyValueList(() => request.headers, true, 'pm.request.headers', changeRequest),
  body: requestBody,
}

// ---- Responses ---------------------------------------------------------------------------------------------------

/** Every response object handed to scripts; the response assertions accept only these. */
const responses = new WeakSet()

function cookieList(cookies) {
  const find = (name) => cookies.find((c) => c.name === String(name))
  return {
    get(name) {
      const cookie = find(name)
      return cookie === undefined ? undefined : cookie.value
    },
    has: (name) => find(name) !== undefined,
    toObject() {
      const out = {}
      for (const c of cookies) if (!hasOwn(out, c.name)) put(out, c.name, c.value)
      return out
    },
  }
}

/** Wraps a plain ScriptResponse; `label` names it in errors (`pm.response.json: ...`). */
function makeResponse(data, label) {
  const body = data.body === undefined || data.body === null ? '' : String(data.body)
  const headerRows = (Array.isArray(data.headers) ? data.headers : []).map((h) => ({
    key: String(h[0]),
    value: String(h[1]),
    enabled: true,
  }))
  const response = {
    code: data.code,
    status: data.status,
    responseTime: data.responseTime,
    responseSize: data.responseSize,
    headers: keyValueList(() => headerRows, true, label + '.headers'),
    cookies: cookieList(Array.isArray(data.cookies) ? data.cookies : []),
    text: () => body,
    json() {
      try {
        return JSON.parse(body)
      } catch (e) {
        throw new Error(label + '.json: the response body is not valid JSON')
      }
    },
    get to() {
      return chai.expect(response).to
    },
  }
  responses.add(response)
  return response
}

const response = isPost && input.response ? makeResponse(input.response, 'pm.response') : undefined
const cookies = response ? response.cookies : cookieList([])

// ---- Response assertions (a chai plugin) -------------------------------------------------------------------------

chai.use(function (api, utils) {
  const Assertion = api.Assertion

  function subject(assertion, name) {
    const object = utils.flag(assertion, 'object')
    if (!responses.has(object)) throw new api.AssertionError(name + ': expected a response, got ' + display(object))
    return object
  }

  function parseBody(res) {
    try {
      return { valid: true, value: JSON.parse(res.text()) }
    } catch (e) {
      return { valid: false }
    }
  }

  function assertCode(assertion, res, expected) {
    assertion.assert(
      res.code === expected,
      'expected response to have status code #{exp} but got #{act}',
      'expected response to not have status code #{act}',
      expected,
      res.code,
    )
  }

  Assertion.addMethod('status', function (expected) {
    const res = subject(this, 'status')
    if (typeof expected === 'number') return assertCode(this, res, expected)
    this.assert(
      res.status === expected,
      'expected response to have status reason #{exp} but got #{act}',
      'expected response to not have status reason #{act}',
      expected,
      res.status,
    )
  })

  Assertion.overwriteProperty('ok', function (original) {
    return function () {
      const object = utils.flag(this, 'object')
      if (!responses.has(object)) return original.call(this)
      assertCode(this, object, 200)
    }
  })

  const classes = {
    success: [[2], 'a 2xx'],
    clientError: [[4], 'a 4xx'],
    serverError: [[5], 'a 5xx'],
    error: [[4, 5], 'a 4xx or 5xx'],
  }
  for (const name of Object.keys(classes)) {
    const [hundreds, text] = classes[name]
    Assertion.addProperty(name, function () {
      const res = subject(this, name)
      this.assert(
        hundreds.includes(Math.floor(res.code / 100)),
        'expected response to have ' + text + ' status code but got #{act}',
        'expected response to not have ' + text + ' status code but got #{act}',
        undefined,
        res.code,
      )
    })
  }

  Assertion.addMethod('header', function (name, value) {
    const res = subject(this, 'header')
    if (arguments.length < 2) {
      this.assert(
        res.headers.has(name),
        'expected response to have header #{exp}',
        'expected response to not have header #{exp}',
        String(name),
      )
      return
    }
    const header = utils.inspect(String(name))
    this.assert(
      res.headers.has(name, value),
      'expected header ' + header + ' to have value #{exp} but got #{act}',
      'expected header ' + header + ' to not have value #{exp}',
      String(value),
      res.headers.get(name),
    )
  })

  Assertion.addMethod('body', function (expected) {
    const body = subject(this, 'body').text()
    if (expected === undefined) {
      this.assert(body !== '', 'expected response to have a body', 'expected response to not have a body')
    } else if (expected instanceof RegExp) {
      expected.lastIndex = 0
      this.assert(
        expected.test(body),
        'expected response body to match #{exp}',
        'expected response body to not match #{exp}',
        expected,
      )
    } else {
      this.assert(
        body === String(expected),
        'expected response body to equal #{exp}',
        'expected response body to not equal #{exp}',
        String(expected),
      )
    }
  })

  Assertion.addProperty('json', function () {
    this.assert(
      parseBody(subject(this, 'json')).valid,
      'expected response body to be valid JSON',
      'expected response body to not be valid JSON',
    )
  })

  Assertion.addMethod('jsonBody', function (path, value) {
    const parsed = parseBody(subject(this, 'jsonBody'))
    if (path === undefined) {
      this.assert(
        parsed.valid,
        'expected response body to be valid JSON',
        'expected response body to not be valid JSON',
      )
      return
    }
    // A path into a body that is not JSON fails either way.
    if (!parsed.valid) throw new api.AssertionError('expected response body to be valid JSON')
    let current = parsed.value
    let found = true
    for (const segment of String(path).split('.')) {
      if (typeof current !== 'object' || current === null || !hasOwn(current, segment)) {
        found = false
        current = undefined
        break
      }
      current = current[segment]
    }
    const where = utils.inspect(String(path))
    if (arguments.length < 2) {
      this.assert(
        found,
        'expected response JSON to have path ' + where,
        'expected response JSON to not have path ' + where,
      )
      return
    }
    this.assert(
      found && utils.eql(current, value),
      'expected response JSON at ' + where + ' to deeply equal #{exp} but got #{act}',
      'expected response JSON at ' + where + ' to not deeply equal #{exp}',
      value,
      current,
    )
  })
})

// ---- pm.test -----------------------------------------------------------------------------------------------------

/** In call order; an entry stays pending until its test settles. */
const testResults = []

function test(name, fn) {
  const entry = { name: String(name), passed: false, skipped: false, pending: true, waitsFor: 'promise' }
  testResults.push(entry)
  if (typeof fn !== 'function') {
    entry.pending = false
    entry.skipped = true
    return pm
  }
  const settle = (passed, error) => {
    if (!entry.pending) return
    entry.pending = false
    entry.passed = passed
    if (!passed) entry.error = errorText(error)
  }
  const rejected = (e) => settle(false, e === undefined ? new Error('the test was rejected') : e)
  try {
    if (fn.length > 0) {
      entry.waitsFor = 'done'
      const returned = fn((error) => (error === undefined || error === null ? settle(true) : settle(false, error)))
      if (returned && typeof returned.then === 'function') returned.then(undefined, rejected)
    } else {
      const returned = fn()
      if (returned && typeof returned.then === 'function') returned.then(() => settle(true), rejected)
      else settle(true)
    }
  } catch (e) {
    settle(false, e)
  }
  return pm
}

test.skip = function skip(name) {
  testResults.push({ name: String(name), passed: false, skipped: true, pending: false })
  return pm
}

// ---- pm.sendRequest ----------------------------------------------------------------------------------------------

function sendRequest(req, callback) {
  if (callback !== undefined && typeof callback !== 'function') {
    throw new TypeError('pm.sendRequest: the callback must be a function')
  }
  const send = (done) => hostSend(req, (error, data) => done(error, error ? undefined : makeResponse(data, 'response')))
  if (callback) {
    send((error, res) => callback(error || null, res))
    return undefined
  }
  return new Promise((resolve, reject) => send((error, res) => (error ? reject(error) : resolve(res))))
}

// ---- pm ----------------------------------------------------------------------------------------------------------

const pm = guard(
  {
    environment,
    globals: scopeApi('globals', 'pm.globals'),
    collectionVariables: scopeApi('collection', 'pm.collectionVariables'),
    variables,
    request: pmRequest,
    get response() {
      if (!response) throw new Error('pm.response is only available in post-response scripts')
      return response
    },
    cookies,
    info: input.info,
    test,
    expect: chai.expect,
    sendRequest,
  },
  'pm',
)
define('pm', pm)

// ---- postman and the legacy globals ------------------------------------------------------------------------------

let nextRequest
let nextRequestSet = false

define(
  'postman',
  guard(
    {
      setNextRequest(name) {
        nextRequestSet = true
        nextRequest = name === null || name === undefined ? null : String(name)
      },
      setEnvironmentVariable: (key, value) => setVar('environment', 'postman.setEnvironmentVariable', key, value),
      getEnvironmentVariable: (key) => lookup('environment', key),
      clearEnvironmentVariable: (key) => unsetVar('environment', key),
      setGlobalVariable: (key, value) => setVar('globals', 'postman.setGlobalVariable', key, value),
      getGlobalVariable: (key) => lookup('globals', key),
      clearGlobalVariable: (key) => unsetVar('globals', key),
    },
    'postman',
  ),
)

define('tests', {})

if (response) {
  define('responseBody', response.text())
  define('responseCode', { code: response.code, name: response.status, detail: response.status })
  define('responseTime', response.responseTime)
  define('responseHeaders', response.headers.toObject())
}

// ---- The result --------------------------------------------------------------------------------------------------

function finishTests() {
  const out = testResults.map((t) => {
    const result = { name: t.name, passed: t.passed, skipped: t.skipped }
    if (t.pending) {
      result.passed = false
      result.error = t.waitsFor === 'done' ? 'done() was not called' : 'the test did not finish'
    } else if (t.error !== undefined) {
      result.error = t.error
    }
    return result
  })
  const legacy = g.tests
  if (typeof legacy === 'object' && legacy !== null) {
    for (const name of Object.keys(legacy)) out.push({ name, passed: Boolean(legacy[name]), skipped: false })
  }
  return out
}

define(
  '__finish',
  function __finish() {
    const result = {
      request: isPost ? input.request : request,
      variables: {
        local: plainCopy(stores.local),
        environment: stores.environment === null ? null : plainCopy(stores.environment),
        collection: plainCopy(stores.collection),
        globals: plainCopy(stores.globals),
      },
      tests: finishTests(),
    }
    if (nextRequestSet) result.nextRequest = nextRequest
    return result
  },
  false,
)
