import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createCanvas, Image, ImageData } from '@napi-rs/canvas'
import { initializeCanvas, writePsd, readPsd } from 'ag-psd'
import { createLayerSplitService } from '../server/layerSplitPlugin.ts'
import { createFineDocument, extractFineElement, maskCanvas, readMask, patchRasterLayer, rasterLayerCanvas, mapFineDraftImages, emptyFineDraft, undoLayerFill } from '../src/fineLayerDocument.ts'
import { buildLayerPsd, renderLayerDocument } from '../src/layerDocument.ts'
import { collectFineTask } from '../src/layerSplitClient.ts'

globalThis.document = { createElement: () => createCanvas(1, 1) }
globalThis.Image = Image
initializeCanvas(createCanvas, (w, h) => new ImageData(w, h))
const width = 24, height = 16
const source = createCanvas(width, height), ctx = source.getContext('2d'), pixels = ctx.createImageData(width, height)
for (let i = 0; i < width * height; i++) { pixels.data.set([i % 251, (i * 7) % 255, (i * 11) % 255, 255], i * 4) }
ctx.putImageData(pixels, 0, 0)
const sourceUrl = source.toDataURL('image/png')
const sourceBytes = source.toBuffer('image/png')
function selection(left = 3, top = 4, w = 8, h = 6) {
  const mask = new Uint8Array(width * height)
  for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) mask[y * width + x] = 255
  return maskCanvas(mask, width, height).toDataURL('image/png')
}
const maskUrl = selection()
const generated = createCanvas(width, height)
generated.getContext('2d').fillStyle = '#ffeedd'; generated.getContext('2d').fillRect(0, 0, width, height)
const generatedUrl = generated.toDataURL('image/png')
const rgba = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
async function harness(responses) {
  const calls = [], cacheDir = await mkdtemp(path.join(tmpdir(), 'fine-layer-'))
  const service = createLayerSplitService({ cacheDir,
    loadImageBuffer: async url => ({ buffer: Buffer.from(url.split(',')[1], 'base64'), mediaType: 'image/png' }),
    fetchUpstream: async (url, init) => {
      calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined })
      const next = responses[calls.length - 1]
      assert.ok(next, 'unexpected provider call')
      return next instanceof Response ? next : new Response(JSON.stringify(next))
    },
  })
  return { service, calls, cacheDir }
}
test('SAM sends raw masks and original pixel coordinates; visual prompts do not inherit the wheel default', async () => {
  const h = await harness([{ request_id: 'sam-task-1234' }])
  const result = await h.service.segmentSubmit({ apiKey: 'test', imageUrl: sourceUrl, points: [{ x: 5, y: 6, label: 1 }, { x: 0, y: 0, label: 0 }], box: { x: 2, y: 3, width: 12, height: 8 } })
  assert.deepEqual(result, { requestId: 'sam-task-1234', model: 'sam3' })
  assert.equal(h.calls[0].url, 'https://queue.fal.run/fal-ai/sam-3/image')
  assert.deepEqual(h.calls[0].body, { image_url: sourceUrl, prompt: '', point_prompts: [{ x: 5, y: 6, label: 1, object_id: 0 }, { x: 0, y: 0, label: 0, object_id: 0 }], box_prompts: [{ x_min: 2, y_min: 3, x_max: 14, y_max: 11, object_id: 0 }], apply_mask: false, return_multiple_masks: false, max_masks: 1, output_format: 'png' })
})
test('invalid SAM selection fails before spending a provider request', async () => {
  const h = await harness([]), base = { apiKey: 'test', imageUrl: sourceUrl }
  for (const input of [{}, { points: [{ x: 99, y: 0, label: 1 }] }, { points: [{ x: 3, y: 4, label: '1' }] }, { box: { x: 20, y: 0, width: 8, height: 8 } }, { points: Array(33).fill({ x: 1, y: 1, label: 1 }) }]) await assert.rejects(h.service.segmentSubmit({ ...base, ...input }))
  await assert.rejects(h.service.segmentSubmit({ ...base, imageUrl: 'http://localhost/private', prompt: 'bottle' }), /PNG/)
  assert.equal(h.calls.length, 0)
})
for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) test(`${model} submits one masked edit with safety enabled and correct transparency`, async () => {
  const h = await harness([{ request_id: 'fill-task-1234' }, { request_id: 'fill-task-5678' }])
  await h.service.editSubmit({ apiKey: 'test', imageUrl: sourceUrl, maskUrl, model, task: 'background', prompt: '延续建筑' })
  await h.service.editSubmit({ apiKey: 'test', imageUrl: sourceUrl, maskUrl, model, task: 'layer', prompt: '补全瓶身' })
  assert.equal(h.calls[0].url, `https://queue.fal.run/openai/gpt-image-2.5/${model.endsWith('flare') ? 'flare' : 'sunburst'}/edit`)
  assert.equal(h.calls[0].body.mask_url, maskUrl)
  assert.deepEqual(h.calls[0].body.image_urls, [sourceUrl])
  assert.equal(h.calls[0].body.background, 'opaque')
  assert.equal(h.calls[1].body.background, 'transparent')
  for (const call of h.calls) { assert.equal(call.body.enable_safety_checker, true); assert.equal(call.body.num_images, 1); assert.equal(call.body.output_format, 'png') }
})
test('fill rejects unknown endpoints, missing mask and mismatched sizes before submission', async () => {
  const h = await harness([]), base = { apiKey: 'test', imageUrl: sourceUrl, maskUrl, model: 'gpt-image-2.5-flare', task: 'layer' }
  for (const extra of [{ model: 'https://attacker.com' }, { model: 'sam3' }, { maskUrl: '' }, { task: 'whatever' }, { maskUrl: createCanvas(2, 2).toDataURL('image/png') }]) await assert.rejects(h.service.editSubmit({ ...base, ...extra }))
  assert.equal(h.calls.length, 0)
})
test('queue status uses owner/app without endpoint suffix; errors do not trigger a new paid task', async () => {
  const h = await harness([{ status: 'IN_QUEUE' }, { status: 'COMPLETED' }, { error: 'key-secret failure' }])
  await h.service.status({ apiKey: 'key-secret', requestId: 'task-1234', model: 'sam3' })
  await h.service.status({ apiKey: 'key-secret', requestId: 'task-1234', model: 'gpt-image-2.5-flare' })
  await assert.rejects(h.service.status({ apiKey: 'key-secret', requestId: 'task-1234', model: 'gpt-image-2.5-sunburst' }), error => !error.message.includes('key-secret'))
  assert.equal(h.calls[0].url, 'https://queue.fal.run/fal-ai/sam-3/requests/task-1234/status')
  assert.equal(h.calls[1].url, 'https://queue.fal.run/openai/gpt-image-2.5/requests/task-1234/status')
  assert.ok(h.calls.every(call => call.method === 'GET'))
})
test('SAM and GPT outputs cache a single PNG without exposing credentials to the CDN', async () => {
  for (const model of ['sam3', 'gpt-image-2.5-flare']) {
    const h = await harness([{ [model === 'sam3' ? 'masks' : 'images']: [{ url: 'https://v3.fal.media/result.png' }] }, new Response(sourceBytes)])
    const result = await h.service.result({ apiKey: 'secret', requestId: 'task-1234', model })
    assert.equal(result.images.length, 1)
    assert.equal(h.calls[1].headers, undefined)
    assert.deepEqual(await readFile(path.join(h.cacheDir, path.basename(result.images[0].imageUrl))), sourceBytes)
  }
})
test('disjoint cutouts and original background recompose byte-for-byte with no AI resampling', async () => {
  const first = await extractFineElement(sourceUrl, maskUrl, width, height, [], '产品')
  const second = await extractFineElement(sourceUrl, selection(7, 2, 10, 10), width, height, [first], '台面')
  const doc = await createFineDocument(sourceUrl, [first, second], width, height)
  assert.deepEqual(rgba(await renderLayerDocument(doc)), pixels.data)
  const m1 = await readMask(first.maskUrl, width, height), m2 = await readMask(second.maskUrl, width, height)
  assert.equal(m1.some((value, i) => value && m2[i]), false)
  assert.deepEqual(doc.layers.map(layer => layer.name), ['背景 · 原图像素', '产品', '台面'])
  assert.equal(doc.width, width); assert.equal(doc.height, height)
  await assert.rejects(extractFineElement(sourceUrl, maskUrl, width, height, [first], '重复'), /为空或已提取/)
})
test('GPT may change every pixel upstream, but only the hidden background receives its pixels', async () => {
  const element = await extractFineElement(sourceUrl, maskUrl, width, height, [], '产品')
  const doc = await createFineDocument(sourceUrl, [element], width, height, generatedUrl)
  assert.deepEqual(rgba(await renderLayerDocument(doc)), pixels.data, 'visible source is untouched')
  const exposed = rgba(await renderLayerDocument({ ...doc, layers: doc.layers.map(layer => ({ ...layer, visible: layer.id !== element.id })) }))
  const mask = await readMask(maskUrl, width, height), fill = rgba(generated)
  for (let i = 0; i < mask.length; i++) assert.deepEqual(exposed.slice(i * 4, i * 4 + 4), (mask[i] ? fill : pixels.data).slice(i * 4, i * 4 + 4))
  assert.equal(doc.layers[0].name, '背景补全 · GPT')
})
test('single-layer repair preserves every unselected pixel and leaves the source document immutable', async () => {
  const element = await extractFineElement(sourceUrl, maskUrl, width, height, [], '产品')
  const doc = await createFineDocument(sourceUrl, [element], width, height), before = JSON.stringify(doc)
  const selectionUrl = selection(4, 5, 5, 5), selected = await readMask(selectionUrl, width, height)
  const original = rgba(await rasterLayerCanvas(doc, element.id))
  const patched = await patchRasterLayer(doc, element.id, selectionUrl, generatedUrl)
  const actual = rgba(await rasterLayerCanvas(patched, element.id)), fill = rgba(generated)
  for (let i = 0; i < selected.length; i++) assert.deepEqual(actual.slice(i * 4, i * 4 + 4), (selected[i] ? fill : original).slice(i * 4, i * 4 + 4))
  assert.equal(JSON.stringify(doc), before)
  const reopened = JSON.parse(JSON.stringify(patched))
  reopened.layers.find(layer => layer.id === element.id).name = '已改名'
  const restored = undoLayerFill(reopened)
  assert.deepEqual(rgba(await rasterLayerCanvas(restored, element.id)), original)
  assert.equal(restored.layers.find(layer => layer.id === element.id).name, '已改名', 'undo only restores pixels, preserving later naming edits')
  assert.equal(restored.fillUndo, undefined)
  await assert.rejects(patchRasterLayer(doc, element.id, selectionUrl, createCanvas(100, 10).toDataURL('image/png')), /比例/)
})
test('precision PSD preserves independent background patch, original-size layers and transparency', async () => {
  const element = await extractFineElement(sourceUrl, maskUrl, width, height, [], '产品 Logo 原像素')
  const doc = await createFineDocument(sourceUrl, [element], width, height, generatedUrl)
  const bitmaps = new Map()
  for (const layer of doc.layers) bitmaps.set(layer.id, await rasterLayerCanvas(doc, layer.id))
  const psd = readPsd(writePsd(buildLayerPsd(doc, await renderLayerDocument(doc), bitmaps)), { useImageData: true })
  assert.equal(psd.width, width); assert.equal(psd.height, height)
  assert.deepEqual(psd.children.map(layer => layer.name), ['产品 Logo 原像素', '背景 · 原图像素', '背景补全 · GPT'])
  assert.equal(psd.children[0].imageData.data[3], 0)
  assert.deepEqual(psd.imageData.data, pixels.data)
})
test('draft checkpoints package every mask and task input; original request id survives restore', async () => {
  const draft = { ...emptyFineDraft(), maskUrl: 'selection.png', elements: [{ id: 'one', name: '产品', imageUrl: 'cutout.png', maskUrl: 'element-mask.png' }], pending: { requestId: 'paid-task-1234', model: 'gpt-image-2.5-flare', kind: 'background', imageUrl: 'source.png', maskUrl: 'fill-mask.png', resultImageUrl: 'result.png' } }
  const seen = [], packed = await mapFineDraftImages(draft, async url => { seen.push(url); return `images/${url}` })
  assert.deepEqual(new Set(seen), new Set(['selection.png', 'cutout.png', 'element-mask.png', 'source.png', 'fill-mask.png', 'result.png']))
  assert.equal(packed.pending.requestId, 'paid-task-1234')
  assert.equal(packed.pending.model, 'gpt-image-2.5-flare')
  assert.equal(JSON.stringify(packed).includes('apiKey'), false)
})
test('resuming a GPT task only queries its saved model and id, and abort stops polling', async () => {
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window
  const calls = []
  globalThis.window = { sessionStorage: { getItem: () => '' }, setTimeout, clearTimeout }
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(url.endsWith('/status') ? { status: 'COMPLETED' } : { images: [{ imageUrl: '/cached.png', width, height }] })) }
    const task = { requestId: 'already-paid-1234', model: 'gpt-image-2.5-flare' }
    const result = await collectFineTask(task, () => {})
    assert.equal(result.imageUrl, '/cached.png')
    assert.deepEqual(calls.map(call => call.url), ['/api/layers/status', '/api/layers/result'])
    assert.ok(calls.every(call => call.body.requestId === task.requestId && call.body.model === task.model))
    const controller = new AbortController()
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'IN_PROGRESS' }))
    const pending = collectFineTask(task, () => setTimeout(() => controller.abort(), 5), controller.signal)
    await assert.rejects(pending, error => error.name === 'AbortError')
  } finally { globalThis.fetch = previousFetch; globalThis.window = previousWindow }
})
function appFunctions(names, dependencies) {
  const text = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ast = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), found = []
  function visit(node) { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.push(node.getText(ast)); ts.forEachChild(node, visit) }
  visit(ast)
  assert.equal(found.length, names.length)
  const context = vm.createContext(dependencies)
  vm.runInContext(ts.transpileModule(found.join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context
}
test('precision result creates one connected node at source dimensions and clears only its completed draft', async () => {
  let index = 0
  const original = { id: 'source', position: { x: 10, y: 20 }, data: { kind: 'reference', imageUrl: '/original.png', fineLayerDraft: { version: 1 }, title: '原图' } }
  const context = appFunctions(['createFineLayerResult'], { nodes: [original], edges: [], layerSplitSession: { nodeId: 'source', sourceImageUrl: sourceUrl },
    cacheCanvasImage: async url => url === sourceUrl ? '/original-cache.png' : '/composite.png', renderLayerDocument: async () => ({ toDataURL: () => 'composite-data' }),
    id: prefix => `${prefix}-${++index}`, getAbsoluteNodePosition: node => node.position, findFreeWorkflowNodePosition: point => point,
    MarkerType: { ArrowClosed: 'arrow' }, workflowEdgeColor: '#aaa', imageInputHandlePrefix: 'image-', setSelectedNodeId() {}, markDirty() {}, setToast() {},
  })
  context.setNodes = update => { context.nodes = update(context.nodes) }; context.setEdges = update => { context.edges = update(context.edges) }; context.setLayerSplitSession = value => { context.layerSplitSession = value }
  const document = { width: 1152, height: 2048, layers: [] }
  await context.createFineLayerResult(document)
  assert.equal(context.nodes.length, 2)
  assert.equal(context.nodes[0].data.imageUrl, '/original.png')
  assert.equal(context.nodes[0].data.fineLayerDraft, undefined)
  assert.equal(context.nodes[1].data.size, '1152x2048')
  assert.equal(context.nodes[1].data.layerDocument, document)
  assert.equal(context.edges[0].source, 'source'); assert.equal(context.edges[0].target, context.nodes[1].id); assert.equal(context.edges[0].targetHandle, 'image-1')
})

test('real project ZIP retains selection, GPT resume checkpoint and persistent pixel undo', { skip: !process.env.SKETCH_TEST_API }, async () => {
  const base = new URL(process.env.SKETCH_TEST_API)
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname))
  const localFetch = (url, init) => fetch(new URL(url, base), init)
  const element = await extractFineElement(sourceUrl, maskUrl, width, height, [], '原图产品')
  const doc = await patchRasterLayer(await createFineDocument(sourceUrl, [element], width, height), element.id, selection(5, 5, 3, 3), generatedUrl)
  const draft = { ...emptyFineDraft(element.id), maskUrl, elements: [element], pending: {
    kind: 'layer', model: 'gpt-image-2.5-flare', requestId: 'persist-paid-task-1234', imageUrl: sourceUrl, maskUrl, document: doc, targetLayerId: element.id,
  } }
  const context = appFunctions(['readPackageResponse', 'startProjectPackage', 'addImageToProjectPackage', 'cleanNode', 'cleanEdge', 'buildPackageProject'], {
    fetch: localFetch, sketchSceneIds: () => [], readModel3DScenes: async () => ({}), mapFineDraftImages,
  })
  const session = await context.startProjectPackage()
  const project = await context.buildPackageProject(session, '精细分层测试', [{ id: 'fine', data: { kind: 'image', imageUrl: sourceUrl, sourceImageUrl: sourceUrl, layerDocument: doc, fineLayerDraft: draft } }], [], [])
  assert.equal(JSON.stringify(project).includes('data:image/'), false)
  assert.equal(JSON.stringify(project).includes('apiKey'), false)
  const zip = await localFetch(`/api/projects/package/finish?sessionId=${session}&filename=fine-qa.zip&download=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) })
  assert.equal(zip.status, 200)
  const restored = await localFetch('/api/projects/import-package', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: Buffer.from(await zip.arrayBuffer()) })
  const payload = await restored.json()
  assert.equal(restored.status, 200, payload.error)
  const data = payload.project.nodes[0].data
  assert.equal(data.fineLayerDraft.pending.requestId, 'persist-paid-task-1234')
  assert.equal(data.fineLayerDraft.pending.targetLayerId, element.id)
  assert.equal(data.layerDocument.fillUndo.id, element.id)
  for (const url of [data.fineLayerDraft.maskUrl, data.fineLayerDraft.elements[0].maskUrl, data.fineLayerDraft.pending.maskUrl]) {
    const cached = await localFetch(url)
    assert.deepEqual(Buffer.from(await cached.arrayBuffer()), Buffer.from(maskUrl.split(',')[1], 'base64'))
  }
  for (const url of [data.layerDocument.fillUndo.imageUrl, data.fineLayerDraft.pending.document.fillUndo.imageUrl]) {
    const cached = await localFetch(url)
    assert.deepEqual(Buffer.from(await cached.arrayBuffer()), Buffer.from(element.imageUrl.split(',')[1], 'base64'))
  }
})
