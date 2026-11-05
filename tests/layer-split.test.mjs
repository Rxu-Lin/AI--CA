import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createCanvas, Image, ImageData } from '@napi-rs/canvas'
import { initializeCanvas, writePsd, readPsd } from 'ag-psd'
import { createLayerSplitService, pngDimensions } from '../server/layerSplitPlugin.ts'
import { createLayerDocument, renderLayerDocument, buildLayerPsd, moveRasterLayer, validateLayerDocument, loadLayerImage } from '../src/layerDocument.ts'

initializeCanvas(createCanvas, (width, height) => new ImageData(width, height))
const plain = value => JSON.parse(JSON.stringify(value))
const job = { requestId: 'layer-task-1234', numLayers: 4, width: 300, height: 180, caption: '' }
function image(width = 30, height = 18, color = '#d6d6d6', shape = false) {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = color
  context.fillRect(shape ? width / 4 : 0, shape ? height / 4 : 0, shape ? width / 2 : width, shape ? height / 2 : height)
  return canvas
}
const png = image().toBuffer('image/png')
const pngUrl = `data:image/png;base64,${png.toString('base64')}`
const images = [image(30, 18), image(30, 18, '#ff000080', true)]
function sampleDoc() {
  return createLayerDocument(job, images.map(canvas => ({ imageUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height })))
}
async function serviceHarness(responses) {
  const calls = []
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'canvas-layer-api-'))
  const service = createLayerSplitService({
    cacheDir,
    loadImageBuffer: async url => ({ buffer: Buffer.from(url.split(',')[1], 'base64'), mediaType: 'image/png' }),
    fetchUpstream: async (url, init) => {
      calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined })
      const value = responses[calls.length - 1]
      assert.ok(value, `unexpected request ${calls.length}`)
      return value instanceof Response ? value : new Response(JSON.stringify(value))
    },
  })
  return { service, calls, cacheDir }
}

test('layer submission uses fixed fal endpoint, separate credential, PNG and safety checks', async () => {
  const h = await serviceHarness([{ request_id: job.requestId, status_url: 'https://attacker.example/steal' }])
  assert.deepEqual(await h.service.submit({ apiKey: ' fal-test-key ', imageUrl: pngUrl, numLayers: 4, caption: ' 产品与背景 ' }), { requestId: job.requestId })
  assert.equal(h.calls[0].url, 'https://queue.fal.run/fal-ai/qwen-image-layered')
  assert.equal(h.calls[0].headers.Authorization, 'Key fal-test-key')
  assert.equal(h.calls[0].redirect, 'error')
  assert.deepEqual(h.calls[0].body, { image_url: pngUrl, num_layers: 4, output_format: 'png', enable_safety_checker: true, prompt: '产品与背景' })
})

test('invalid inputs and missing key do not make paid requests', async () => {
  const h = await serviceHarness([])
  await assert.rejects(h.service.submit({ apiKey: '', imageUrl: pngUrl, numLayers: 4 }), /fal API Key/)
  for (const count of [0, 1, 9, 4.2, '4']) await assert.rejects(h.service.submit({ apiKey: 'test', imageUrl: pngUrl, numLayers: count }), /2–8/)
  await assert.rejects(h.service.submit({ apiKey: 'test', imageUrl: 'http://localhost/private', numLayers: 4 }), /重新打开/)
  await assert.rejects(h.service.status({ apiKey: 'test', requestId: '../anything' }), /编号无效/)
  assert.equal(h.calls.length, 0)
})

test('status and resume only query the original request; failures are not resubmitted', async () => {
  const h = await serviceHarness([{ status: 'IN_QUEUE', queue_position: 2 }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED' }])
  for (const status of ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']) assert.equal((await h.service.status({ apiKey: 'test', requestId: job.requestId })).status, status)
  assert.ok(h.calls.every(call => call.method === 'GET' && call.url.endsWith(`/requests/${job.requestId}/status`)))
  const failed = await serviceHarness([{ status: 'COMPLETED', error: 'fal-test-key rejected' }])
  await assert.rejects(failed.service.status({ apiKey: 'fal-test-key', requestId: job.requestId }), error => !error.message.includes('fal-test-key') && error.message.includes('[redacted]'))
  assert.equal(failed.calls.length, 1)
  const rejected = await serviceHarness([new Response(JSON.stringify({ detail: 'Insufficient balance' }), { status: 403 })])
  await assert.rejects(rejected.service.submit({ apiKey: 'test', imageUrl: pngUrl, numLayers: 4 }), error => error.statusCode === 403)
  assert.equal(rejected.calls.length, 1)
})

test('all returned layers are cached without credentials; PNG alpha and order remain intact', async () => {
  const h = await serviceHarness([
    { images: [{ url: 'https://v3b.fal.media/base.png' }, { url: 'https://v3b.fal.media/object.png' }] },
    new Response(images[0].toBuffer('image/png')), new Response(images[1].toBuffer('image/png')),
  ])
  const result = await h.service.result({ apiKey: 'test', requestId: job.requestId })
  assert.equal(result.images.length, 2)
  for (const [index, layer] of result.images.entries()) {
    assert.deepEqual({ width: layer.width, height: layer.height }, { width: 30, height: 18 })
    const bytes = await readFile(path.join(h.cacheDir, path.basename(layer.imageUrl)))
    assert.deepEqual(bytes, images[index].toBuffer('image/png'))
    assert.equal(h.calls[index + 1].headers, undefined, 'credentials never go to asset CDN')
  }
  assert.match(result.images[0].imageUrl, /^\/api\/projects\/assets\//)
})

test('unsafe asset locations, inconsistent sizes and non-PNG responses fail without partial success', async () => {
  for (const url of ['http://v3b.fal.media/a.png', 'https://example.com/a.png', 'https://fal.media.attacker.com/a.png', 'https://user:pass@fal.media/a.png']) {
    const h = await serviceHarness([{ images: [{ url }, { url: 'https://fal.media/b.png' }] }])
    await assert.rejects(h.service.result({ apiKey: 'test', requestId: job.requestId }), /地址/)
    assert.equal(h.calls.length, 1)
  }
  const mismatch = await serviceHarness([{ images: [{ url: 'https://fal.media/a.png' }, { url: 'https://fal.media/b.png' }] }, new Response(png), new Response(image(40, 10).toBuffer('image/png'))])
  await assert.rejects(mismatch.service.result({ apiKey: 'test', requestId: job.requestId }), /尺寸不一致/)
  assert.throws(() => pngDimensions(Buffer.from('<html>bad</html>')), /PNG/)
})

test('safety checker failure does not cache or expose blocked images', async () => {
  const h = await serviceHarness([{ has_nsfw_concepts: [true], images: [{ url: 'https://fal.media/a.png' }] }])
  await assert.rejects(h.service.result({ apiKey: 'test', requestId: job.requestId }), /内容检查/)
  assert.equal(h.calls.length, 1)
})

test('PSD round trip preserves original dimensions, top-to-bottom order, opacity, names, hidden flags and alpha', async () => {
  globalThis.document = { createElement: () => createCanvas(1, 1) }
  globalThis.Image = Image
  const doc = sampleDoc()
  doc.layers[0].name = '原始背景'
  doc.layers[1].name = '透明红色主体'
  doc.layers[1].opacity = 0.6
  const hidden = { ...doc.layers[1], id: 'hidden', name: '隐藏备用', visible: false, opacity: 0.25, x: 9, y: 12 }
  doc.layers.push(hidden)
  const bitmaps = new Map()
  for (const layer of doc.layers) {
    const canvas = createCanvas(doc.width, doc.height)
    const img = await loadLayerImage(layer.imageUrl)
    canvas.getContext('2d').drawImage(img, 0, 0, doc.width, doc.height)
    bitmaps.set(layer.id, canvas)
  }
  const composite = await renderLayerDocument(doc)
  const output = writePsd(buildLayerPsd(doc, composite, bitmaps))
  const restored = readPsd(output, { useImageData: true })
  assert.equal(restored.width, 300); assert.equal(restored.height, 180)
  assert.deepEqual(restored.children.map(layer => layer.name), ['隐藏备用', '透明红色主体', '原始背景'])
  assert.equal(restored.children[0].hidden, true)
  assert.equal(restored.children[0].left, 9); assert.equal(restored.children[0].top, 12)
  assert.ok(Math.abs(restored.children[1].opacity - 0.6) < 1 / 255)
  const alpha = restored.children[1].imageData
  assert.equal(alpha.data[3], 0)
  assert.ok(alpha.data[(90 * 300 + 150) * 4 + 3] > 120)
  const actual = Array.from(restored.imageData.data.slice((90 * 300 + 150) * 4, (90 * 300 + 150) * 4 + 4))
  const expected = Array.from(composite.getContext('2d').getImageData(150, 90, 1, 1).data)
  assert.deepEqual(actual, expected)
})

test('layer edits keep source document immutable and exported sizes are bounded', () => {
  const doc = sampleDoc()
  const before = JSON.stringify(doc)
  const moved = moveRasterLayer(doc, doc.layers[0].id, 1)
  assert.equal(moved.layers.at(-1).id, doc.layers[0].id)
  assert.equal(JSON.stringify(doc), before)
  assert.throws(() => validateLayerDocument({ ...doc, width: 20000, height: 20000 }), /尺寸/)
  assert.throws(() => validateLayerDocument({ ...doc, layers: [{ ...doc.layers[0], opacity: NaN }] }), /属性/)
})

function functionsFrom(file, names, dependencies = {}) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functions = []
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(functions.length, names.length)
  const context = vm.createContext({ ...dependencies })
  vm.runInContext(ts.transpileModule(functions.join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context
}

test('project package includes every raster layer and restores edited order without exporting API credentials', async () => {
  const doc = sampleDoc()
  doc.layers[0].visible = false
  doc.layers[1].opacity = 0.5
  const context = functionsFrom('src/App.tsx', ['cleanNode', 'cleanEdge', 'buildPackageProject'], {
    sketchSceneIds: () => [], readModel3DScenes: async () => ({}),
    addImageToProjectPackage: async (_session, _url, index) => `images/${index}.png`,
  })
  const source = { id: 'layers', data: { kind: 'image', status: 'done', imageUrl: '/composite.png', sourceImageUrl: '/source.png', layerDocument: doc, layerSplitJob: job, onOpenLayerSplit() {} } }
  const result = await context.buildPackageProject('qa', '分层测试', [source], [], [])
  assert.equal(result.nodes[0].data.layerDocument.layers[0].imageUrl, 'images/3.png')
  assert.equal(result.nodes[0].data.layerDocument.layers[1].imageUrl, 'images/4.png')
  assert.equal(result.nodes[0].data.onOpenLayerSplit, undefined)
  assert.equal(JSON.stringify(result).includes('apiKey'), false)
  const importer = functionsFrom('vite.config.ts', ['isJsonRecord', 'transformProjectImageValues'])
  const restored = plain(result)
  await importer.transformProjectImageValues(restored, value => `/cache/${value}`)
  assert.equal(restored.nodes[0].data.layerDocument.layers[1].imageUrl, '/cache/images/4.png')
  assert.equal(restored.nodes[0].data.layerDocument.layers[0].visible, false)
  assert.equal(restored.nodes[0].data.layerDocument.layers[1].opacity, 0.5)
})

test('Run creates a connected result with exact source dimensions; failures retain request id for resume', async () => {
  let index = 0
  const context = functionsFrom('src/App.tsx', ['submitLayerSplit', 'finishLayerSplit'], {
    AbortController, Map, layerSplitSession: { nodeId: 'original' },
    nodes: [{ id: 'original', position: { x: 0, y: 0 }, data: { imageUrl: '/original.png', title: '原图' } }], edges: [],
    cacheCanvasImage: async () => '/cache.png', layerRequest: async () => ({ requestId: job.requestId }),
    getAbsoluteNodePosition: node => node.position, findFreeWorkflowNodePosition: point => point,
    id: prefix => `${prefix}-${++index}`, MarkerType: { ArrowClosed: 'arrow' }, workflowEdgeColor: '#aaa', imageInputHandlePrefix: 'image-',
    activeLayerRunsRef: { current: new Map() },
    collectLayerSplit: async () => { throw new Error('Network failed; resume request') },
    setToast() {}, markDirty() {}, setSelectedNodeId() {}, setLayerJobProgress() {},
  })
  context.setNodes = updater => { context.nodes = updater(context.nodes) }
  context.setEdges = updater => { context.edges = updater(context.edges) }
  context.setLayerSplitSession = value => { context.layerSplitSession = value }
  await context.submitLayerSplit({ imageUrl: pngUrl, width: 1200, height: 2132, numLayers: 4, caption: 'test' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.nodes.length, 2)
  const node = context.nodes[1]
  assert.equal(node.data.size, '1200x2132')
  assert.equal(node.data.layerSplitJob.requestId, job.requestId)
  assert.equal(node.data.status, 'error')
  assert.equal(context.edges[0].source, 'original')
  assert.equal(context.edges[0].target, node.id)
  assert.equal(context.edges[0].targetHandle, 'image-1')
  assert.equal(context.nodes[0].data.imageUrl, '/original.png')
})

test('local ZIP round trip includes all transparent layer assets', { skip: !process.env.SKETCH_TEST_API }, async () => {
  const base = new URL(process.env.SKETCH_TEST_API)
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname))
  const localFetch = (url, options) => fetch(new URL(url, base), options)
  const context = functionsFrom('src/App.tsx', ['readPackageResponse', 'startProjectPackage', 'addImageToProjectPackage', 'cleanNode', 'cleanEdge', 'buildPackageProject'], {
    fetch: localFetch, sketchSceneIds: () => [], readModel3DScenes: async () => ({}), addVideoToProjectPackage: async () => { throw Error('unexpected') },
  })
  const doc = sampleDoc()
  const session = await context.startProjectPackage()
  const packaged = await context.buildPackageProject(session, 'Layer test', [{ id: 'layers', data: { kind: 'image', imageUrl: pngUrl, sourceImageUrl: pngUrl, layerDocument: doc } }], [], [])
  const zip = await localFetch(`/api/projects/package/finish?sessionId=${session}&filename=layer-qa.zip&download=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(packaged) })
  assert.equal(zip.status, 200)
  const bytes = Buffer.from(await zip.arrayBuffer())
  const restored = await localFetch('/api/projects/import-package', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes })
  const data = await restored.json()
  assert.equal(restored.status, 200, data.error)
  for (const [index, layer] of data.project.nodes[0].data.layerDocument.layers.entries()) {
    const asset = await localFetch(layer.imageUrl)
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), images[index].toBuffer('image/png'))
  }
})
