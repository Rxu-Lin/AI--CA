import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness({ legacyKey = '', blockedStorage = false, fetch = async () => new Response(JSON.stringify({ configured: false })) } = {}) {
  const storage = new Map(legacyKey ? [['ai-canvas-fal-layer-key', legacyKey]] : [])
  const context = vm.createContext({ Response, AbortSignal, setTimeout, clearTimeout, fetch, window: { sessionStorage: {
    getItem: key => { if (blockedStorage) throw new Error('blocked'); return storage.get(key) ?? null },
    setItem: (key, value) => { if (blockedStorage) throw new Error('blocked'); storage.set(key, value) },
    removeItem: key => { if (blockedStorage) throw new Error('blocked'); storage.delete(key) },
  } } })
  const modules = new Map()
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    const exports = {}; modules.set(name, exports)
    const code = ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const require = path => path === './layerDocument.ts' ? {} : load(path.replace(/^\.\//, '').replace(/\.ts$/, ''))
    vm.runInContext(`(function(exports, require) {${code}\n})`, context)(exports, require)
    return exports
  }
  return { config: load('falConfig'), layers: load('layerSplitClient'), upscale: load('upscaleClient'), storage }
}

test('legacy session keys are reused and save/clear notify shared consumers without localStorage', () => {
  const { config, storage } = harness({ legacyKey: 'Key legacy-id:secret' })
  assert.equal(config.readFalApiKey(), 'legacy-id:secret')
  assert.equal(config.getFalConfig(), config.getFalConfig(), 'snapshot identity is stable between updates')
  let updates = 0
  const unsubscribe = config.subscribeFalConfig(() => updates++)
  config.saveFalApiKey('Authorization: Key replacement:secret')
  assert.equal(config.readFalApiKey(), 'replacement:secret')
  assert.equal(storage.get('ai-canvas-fal-layer-key'), 'replacement:secret')
  assert.equal(config.falConfigReady(), true)
  assert.equal(config.falConfigLabel(), '已填写')
  assert.throws(() => config.saveFalApiKey('bad\nkey'), /格式/)
  assert.equal(config.readFalApiKey(), 'replacement:secret')
  config.saveFalApiKey('')
  assert.equal(storage.size, 0)
  assert.equal(config.falConfigReady(), false)
  assert.equal(updates, 2)
  unsubscribe()
  config.saveFalApiKey('memory-only-test')
  assert.equal(updates, 2)
})

test('server configuration is checked once for both services and never copies a server key into state or requests', async () => {
  const calls = []
  let resolve
  const { config, layers, upscale } = harness({ fetch: async (url, init) => {
    calls.push({ url, init })
    if (url === '/api/layers/config') return new Promise(done => { resolve = done })
    return new Response(JSON.stringify({ status: 'IN_QUEUE' }))
  } })
  const first = config.loadFalServerConfig(), second = config.loadFalServerConfig()
  assert.equal(first, second)
  assert.equal(calls.length, 1)
  resolve(new Response(JSON.stringify({ configured: true, apiKey: 'server-secret-must-be-ignored' })))
  await Promise.all([first, second])
  await config.loadFalServerConfig()
  assert.equal(calls.length, 1)
  assert.equal(config.falConfigReady(), true)
  assert.equal(config.falConfigLabel(), '服务器已配置')
  assert.equal(JSON.stringify(config.getFalConfig()).includes('server-secret'), false)
  await layers.layerRequest('status', { requestId: 'existing-layer' })
  await upscale.upscaleRequest('status', { requestId: 'existing-upscale' })
  assert.ok(calls.slice(1).every(call => !Object.hasOwn(JSON.parse(call.init.body), 'apiKey')))
})

test('layer and upscale requests always use the latest shared key, including saved task resumption', async () => {
  const calls = []
  const { config, layers, upscale } = harness({ fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ status: 'IN_QUEUE' }))
  } })
  config.saveFalApiKey('first-key')
  await layers.layerRequest('status', { requestId: 'keep-this-layer-task', apiKey: 'must-not-override' })
  config.saveFalApiKey('second-key')
  await upscale.upscaleRequest('status', { requestId: 'keep-this-upscale-task' })
  await layers.layerRequest('status', { requestId: 'keep-this-layer-task' })
  assert.deepEqual(calls.map(call => call.body.apiKey), ['first-key', 'second-key', 'second-key'])
  assert.deepEqual(calls.map(call => call.url), ['/api/layers/status', '/api/upscale/status', '/api/layers/status'])
  assert.equal(calls[2].body.requestId, calls[0].body.requestId)
})

test('401/403 update shared status, never resubmit and can be cleared by saving credentials', async () => {
  for (const status of [401, 403]) {
    let calls = 0
    const { config, layers, upscale } = harness({ fetch: async () => { calls++; return new Response(JSON.stringify({ error: 'provider rejected' }), { status }) } })
    config.saveFalApiKey('test-key')
    await assert.rejects(layers.layerRequest('segment-submit', {}), /顶部 API 设置/)
    assert.equal(config.falConfigReady(), false)
    assert.equal(config.falConfigLabel(), '认证 / 权限异常')
    config.saveFalApiKey('test-key')
    assert.equal(config.falConfigReady(), true)
    await assert.rejects(upscale.upscaleRequest('submit', {}), /顶部 API 设置/)
    assert.equal(config.falConfigReady(), false)
    assert.equal(calls, 2, 'each explicit action performs only one request')
  }
})

test('late authentication failures from an old key cannot invalidate newly saved configuration', async () => {
  let resolve
  const { config, upscale } = harness({ fetch: () => new Promise(done => { resolve = done }) })
  config.saveFalApiKey('old-key')
  const request = upscale.upscaleRequest('status', { requestId: 'retained-task' })
  config.saveFalApiKey('new-key')
  resolve(new Response('{}', { status: 401 }))
  await assert.rejects(request)
  assert.equal(config.readFalApiKey(), 'new-key')
  assert.equal(config.getFalConfig().authError, '')
  assert.equal(config.falConfigReady(), true)
})

test('blocked sessionStorage supports in-memory sharing; server config failures can be retried', async () => {
  let calls = 0
  const { config } = harness({ blockedStorage: true, fetch: async () => ++calls === 1 ? new Response('failure', { status: 500 }) : new Response('{"configured":true}') })
  config.saveFalApiKey('session-memory')
  assert.equal(config.readFalApiKey(), 'session-memory')
  await config.loadFalServerConfig()
  assert.equal(config.getFalConfig().serverError, true)
  assert.equal(config.getFalConfig().loading, false)
  await config.loadFalServerConfig(true)
  assert.equal(config.getFalConfig().serverConfigured, true)
  assert.equal(config.getFalConfig().serverError, false)
  config.saveFalApiKey('')
  assert.equal(config.falConfigReady(), true, 'clearing a browser key restores the configured server fallback')
})
