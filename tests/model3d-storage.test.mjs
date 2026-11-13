import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { IDBFactory, IDBObjectStore, IDBCursor } from 'fake-indexeddb'

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const storeCode = compile(readFileSync(new URL('../src/model3dSceneStore.ts', import.meta.url), 'utf8'))
const legacyKey = 'cpd-model3d-scene-v1'
const plain = (value) => JSON.parse(JSON.stringify(value))
function storageHarness(indexedDB = new IDBFactory()) {
  const data = new Map()
  let writes = 0
  const window = {
    indexedDB,
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        writes += 1
        if (value.length > 5 * 1024 * 1024) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        data.set(key, value)
      },
      removeItem: (key) => data.delete(key),
    },
  }
  const reload = () => {
    const context = vm.createContext({ window, exports: {}, Error, DOMException })
    vm.runInContext(storeCode, context)
    return context.exports
  }
  return { data, window, reload, store: reload(), get writes() { return writes } }
}
const scene = (url = 'data:model/obj;base64,dGVzdA==') => ({
  version: 2, savedAt: '2026-09-12T00:00:00.000Z',
  items: [{ kind: 'imported-model', name: '大模型', color: '#FF0000', source: { fileName: 'model.obj', format: 'OBJ', url }, transform: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } }],
  selectedIndex: 0, viewportId: 'portrait', backgroundColor: '#FFFFFF', focalLength: 120,
  showProjection: false, lightEnabled: true, lightIntensity: 1, lightAzimuth: -55, lightElevation: 38,
  camera: { position: [4, 5, 6], up: [0, 1, 0], target: [1, 1, 1] },
})
function abortNextPut(t) {
  const original = IDBObjectStore.prototype.put
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = original.apply(this, args)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  }, { times: 1 })
}

test('8 MiB model saves without localStorage writes and survives a fresh module/session', async () => {
  const h = storageHarness()
  const large = scene(`data:model/obj;base64,${'A'.repeat(8 * 1024 * 1024)}`)
  assert.throws(() => h.window.localStorage.setItem('capacity-check', JSON.stringify(large)), { name: 'QuotaExceededError' })
  const before = h.writes
  await h.store.saveModel3DDraft(large)
  assert.equal(h.writes, before)
  assert.deepEqual(plain(await h.reload().readModel3DDraft()), large)
})

test('request success followed by transaction abort never reports saved or discards the old draft', async (t) => {
  const h = storageHarness()
  const original = scene()
  await h.store.saveModel3DDraft(original)
  h.data.set(legacyKey, JSON.stringify(original))
  abortNextPut(t)
  await assert.rejects(h.store.saveModel3DDraft({ ...original, focalLength: 18 }))
  assert.equal(h.data.has(legacyKey), true)
  assert.deepEqual(plain(await h.reload().readModel3DDraft()), original)
})

test('legacy scene migrates once and the committed IndexedDB copy takes precedence', async () => {
  const h = storageHarness()
  h.data.set(legacyKey, JSON.stringify(scene()))
  assert.deepEqual(plain(await h.store.readModel3DDraft()), scene())
  assert.equal(h.data.has(legacyKey), false)
  h.data.set(legacyKey, JSON.stringify({ ...scene(), focalLength: 18 }))
  assert.equal((await h.reload().readModel3DDraft()).focalLength, 120)
})

test('failed migration preserves a readable legacy copy and explicit saving rejects with a useful error', async () => {
  const reason = new DOMException('Storage is blocked', 'SecurityError')
  const h = storageHarness({ open() { throw reason } })
  h.data.set(legacyKey, JSON.stringify(scene()))
  assert.deepEqual(plain(await h.store.readModel3DDraft()), scene())
  assert.equal(h.data.has(legacyKey), true)
  await assert.rejects(h.store.saveModel3DDraft(scene()), { name: 'SecurityError' })
  assert.match(h.store.model3DStorageErrorMessage(reason), /禁止本地存储/)
  h.data.clear()
  await assert.rejects(h.store.readModel3DDraft(), { name: 'SecurityError' })
  assert.match(h.store.model3DStorageErrorMessage(new DOMException('', 'QuotaExceededError')), /空间不足/)
})

test('unavailable IndexedDB cannot be mistaken for a persistent save', async () => {
  const h = storageHarness()
  delete h.window.indexedDB
  await assert.rejects(h.store.saveModel3DDraft(scene()), /INDEXED_DB_UNAVAILABLE/)
  assert.match(h.store.model3DStorageErrorMessage(new Error('INDEXED_DB_UNAVAILABLE')), /禁止本地存储/)
})

test('reset removes only the draft, preserving canvas scenes', async () => {
  const h = storageHarness()
  await h.store.saveModel3DDraft(scene())
  await h.store.saveModel3DScene('canvas-scene', scene())
  h.data.set(legacyKey, JSON.stringify(scene()))
  await h.store.deleteModel3DDraft()
  const reopened = h.reload()
  assert.equal(await reopened.readModel3DDraft(), null)
  assert.equal(h.data.has(legacyKey), false)
  assert.deepEqual(plain(await reopened.readModel3DScene('canvas-scene')), scene())
})

const componentSource = readFileSync(new URL('../src/Model3DStudio.tsx', import.meta.url), 'utf8')
function componentFunction(name, dependencies) {
  const ast = ts.createSourceFile('Model3DStudio.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(declaration)
  const context = vm.createContext({ Error, ...dependencies })
  vm.runInContext(compile(declaration), context)
  return context[name]
}

test('save button stays pending until commit and reports the real failure on rejection', async () => {
  const statuses = [], errors = []
  let finish
  const deferred = new Promise((resolve) => { finish = resolve })
  const dependencies = {
    loading: false, saveStatus: 'idle', captureSavedScene: scene,
    setSaveStatus: (status) => statuses.push(status), setError: (error) => errors.push(error),
    saveModel3DDraft: () => deferred,
    window: { setTimeout() {} }, model3DStorageErrorMessage: storageHarness().store.model3DStorageErrorMessage,
  }
  const save = componentFunction('saveSceneLocally', dependencies)
  const pending = save()
  assert.deepEqual(statuses, ['saving'])
  finish()
  await pending
  assert.deepEqual(statuses, ['saving', 'saved'])
  const failingSave = componentFunction('saveSceneLocally', { ...dependencies, saveModel3DDraft: async () => { throw new DOMException('', 'QuotaExceededError') } })
  await failingSave()
  assert.equal(statuses.at(-1), 'error')
  assert.match(errors.at(-1), /空间不足/)
})

test('closing or resetting during asynchronous model restoration disposes the stale model', async () => {
  let finish
  const object = { name: 'decoded model' }
  const deferred = new Promise((resolve) => { finish = resolve })
  const sequence = { current: 1 }
  const disposed = []
  const dependencies = {
    loadSequenceRef: sequence, viewportPresets: [], defaultBackgroundColor: '#111820',
    defaultLightIntensity: 1, defaultLightAzimuth: -55, defaultLightElevation: 38,
    parseSavedModelSource: () => deferred,
    cleanModel3DScene: storageHarness().store.cleanModel3DScene,
    addSceneObject() { assert.fail('Cancelled restore must not add a model') },
    disposeModel: (value) => disposed.push(value),
  }
  for (const name of ['setViewportId', 'setBackgroundColor', 'setFocalLength', 'setShowProjection', 'setLightEnabled', 'setLightIntensity', 'setLightAzimuth', 'setLightElevation']) dependencies[name] = () => {}
  const restore = componentFunction('restoreSavedScene', dependencies)
  const pending = restore(scene())
  sequence.current += 1
  finish(object)
  await pending
  assert.deepEqual(disposed, [object])
})

const retiredItems = () => [
  { kind: 'parametric-box', name: '旧参数模型', settings: { length: 320, baseColor: '#ffffff' }, transform: scene().items[0].transform },
  { kind: 'parametric-part', name: '旧拆分零件', part: 'lid', settings: { lidHeight: 55 }, transform: scene().items[0].transform },
]
const sphereItem = () => ({ kind: 'parametric-primitive', name: '球体模型', primitiveSettings: { kind: 'sphere', radius: 150, height: 200, length: 200, width: 200, widthSegments: 48, heightSegments: 32, color: '#aabbcc' }, transform: scene().items[0].transform })
async function rawScene(h, operation, key, value) {
  const request = h.window.indexedDB.open('cpd-model3d-scenes', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('scenes')
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scenes', operation === 'get' ? 'readonly' : 'readwrite')
    const store = tx.objectStore('scenes')
    const result = operation === 'get' ? store.get(key) : store.put(value, key)
    tx.oncomplete = () => { db.close(); resolve(result.result) }
    tx.onabort = () => { db.close(); reject(tx.error) }
  })
}

test('retired procedural records are purged from every stored scene and legacy draft while other data and selection survive', async () => {
  const h = storageHarness()
  const mixed = { ...scene(), items: [retiredItems()[0], sphereItem(), retiredItems()[1], scene().items[0]], selectedIndex: 3 }
  await rawScene(h, 'put', 'mixed-scene', mixed)
  await rawScene(h, 'put', 'retired-only', { ...scene(), items: retiredItems(), selectedIndex: 0 })
  await rawScene(h, 'put', 'unchanged-scene', scene())
  h.data.set(legacyKey, JSON.stringify(mixed))
  h.data.set('unrelated-setting', 'keep')
  await h.store.removeRetiredModel3DData()
  const cleaned = await rawScene(h, 'get', 'mixed-scene')
  assert.deepEqual(plain(cleaned.items), [sphereItem(), scene().items[0]])
  assert.equal(cleaned.selectedIndex, 1)
  assert.deepEqual(plain(cleaned.camera), scene().camera)
  assert.deepEqual(plain(await rawScene(h, 'get', 'unchanged-scene')), scene())
  const empty = await rawScene(h, 'get', 'retired-only')
  assert.equal(empty.items.length, 0); assert.equal(empty.selectedIndex, -1)
  assert.equal(h.data.has(legacyKey), false)
  assert.equal(h.data.get('unrelated-setting'), 'keep')
  assert.deepEqual(plain((await h.reload().readModel3DDraft()).items), [sphereItem(), scene().items[0]])
  await h.store.removeRetiredModel3DData()
  assert.deepEqual(plain(await rawScene(h, 'get', 'mixed-scene')), plain(cleaned), 'cleanup is idempotent')
})

test('old imported project records cannot reintroduce retired models; sphere parameters persist without geometry blobs', async () => {
  const h = storageHarness()
  const mixed = { ...scene(), items: [...retiredItems(), sphereItem(), scene().items[0]], selectedIndex: 2 }
  await h.store.saveModel3DScenes({ 'imported-project': mixed })
  await h.store.saveModel3DDraft(mixed)
  const restored = await h.reload().readModel3DScene('imported-project')
  assert.deepEqual(plain(restored.items), [sphereItem(), scene().items[0]])
  assert.equal(restored.selectedIndex, 0)
  assert.equal(JSON.stringify(restored.items[0]).includes('geometry'), false)
  assert.deepEqual(plain((await h.reload().readModel3DDraft()).items), plain(restored.items))
})

test('cleanup preserves the current draft when a stale legacy backup still contains retired objects', async () => {
  const h = storageHarness()
  const current = { ...scene(), items: [sphereItem(), scene().items[0]], focalLength: 85 }
  await h.store.saveModel3DDraft(current)
  h.data.set(legacyKey, JSON.stringify({ ...scene(), items: retiredItems(), focalLength: 18 }))
  await h.store.removeRetiredModel3DData()
  assert.deepEqual(plain(await h.reload().readModel3DDraft()), current)
  assert.equal(h.data.has(legacyKey), false)
})

test('failed cleanup rolls back every scene and keeps the legacy backup readable', async t => {
  const h = storageHarness()
  const mixed = { ...scene(), items: [...retiredItems(), scene().items[0]], selectedIndex: 2 }
  await rawScene(h, 'put', 'saved-project', mixed)
  h.data.set(legacyKey, JSON.stringify(mixed))
  const update = IDBCursor.prototype.update
  t.mock.method(IDBCursor.prototype, 'update', function (...args) {
    const request = update.apply(this, args)
    request.addEventListener('success', () => this.source.transaction.abort())
    return request
  }, { times: 1 })
  await assert.rejects(h.store.removeRetiredModel3DData())
  assert.deepEqual(plain(await rawScene(h, 'get', 'saved-project')), mixed)
  assert.equal(h.data.has(legacyKey), true)
})
