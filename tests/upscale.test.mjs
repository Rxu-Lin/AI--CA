import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createCanvas } from '@napi-rs/canvas'
import { createUpscaleService, upscalePlugin } from '../server/upscalePlugin.ts'
import { upscaleDimensions, upscaleCost, upscaleModes } from '../src/upscale.ts'

const plain = value => JSON.parse(JSON.stringify(value))
function png(width = 30, height = 18) {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ccc'; context.fillRect(0, 0, width, height)
  context.fillStyle = '#222'; context.fillRect(width / 3, height / 3, width / 3, height / 3)
  return canvas.toBuffer('image/png')
}
const input = { apiKey: 'test-fal', imageUrl: `data:image/png;base64,${png().toString('base64')}`, mode: 'fidelity', factor: 2 }
const job = { requestId: 'upscale-test-task', mode: 'fidelity', factor: 2, width: 30, height: 18 }
async function harness(responses) {
  const calls = [], cacheDir = await mkdtemp(path.join(tmpdir(), 'canvas-upscale-'))
  const deps = {
    cacheDir,
    fetchUpstream: async (url, init) => {
      calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined })
      const next = responses[calls.length - 1]
      assert.ok(next, `unexpected request ${calls.length}`)
      return next instanceof Response ? next : new Response(JSON.stringify(next))
    },
  }
  return { service: createUpscaleService(deps), calls, cacheDir }
}

test('all three modes submit precise PNG upscales without cropping or creative face reconstruction', async () => {
  for (const [mode, model] of [['fidelity', 'High Fidelity V3'], ['text', 'Text Refine'], ['cgi', 'CGI']]) {
    const h = await harness([{ request_id: job.requestId }])
    const output = await h.service.submit({ ...input, mode, factor: 4 })
    assert.deepEqual(output, { requestId: job.requestId, width: 30, height: 18, outputWidth: 120, outputHeight: 72 })
    assert.equal(h.calls[0].url, 'https://queue.fal.run/topaz/upscale/image/precision')
    assert.equal(h.calls[0].headers.Authorization, 'Key test-fal')
    assert.deepEqual(h.calls[0].body, { image_url: input.imageUrl, model, upscale_factor: 4, output_format: 'png', crop_to_fill: false, subject_detection: 'All', face_enhancement: false, enable_safety_checker: true })
  }
})
test('manual controls are bounded and text strength is only sent to Text Refine', async () => {
  for (const mode of ['fidelity', 'text', 'cgi']) {
    const h = await harness([{ request_id: job.requestId }])
    await h.service.submit({ ...input, mode, sharpen: 0.3, denoise: 0.15, strength: 0.4 })
    assert.equal(h.calls[0].body.sharpen, 0.3)
    assert.equal(h.calls[0].body.denoise, 0.15)
    assert.equal(h.calls[0].body.strength, mode === 'text' ? 0.4 : undefined)
  }
  const h = await harness([])
  for (const patch of [{ sharpen: NaN }, { denoise: 2 }, { strength: 0 }, { sharpen: '1' }]) await assert.rejects(h.service.submit({ ...input, ...patch }), /参数无效/)
  assert.equal(h.calls.length, 0)
})
test('copied Key headers are normalized and rejected fal credentials show actionable authentication errors', async () => {
  for (const apiKey of ['Key test-id:test-secret', 'Authorization: Key test-id:test-secret', ' test-id:test-secret ']) {
    const h = await harness([{ request_id: job.requestId }])
    await h.service.submit({ ...input, apiKey })
    assert.equal(h.calls[0].headers.Authorization, 'Key test-id:test-secret')
  }
  const unauthorized = await harness([new Response(JSON.stringify({ detail: 'Cannot access application "fal-ai/topaz". Authentication is required to access this application.' }), { status: 401 })])
  await assert.rejects(unauthorized.service.submit(input), error => error.statusCode === 401 && error.message.startsWith('fal 身份验证失败') && error.message.includes('API Mart'))
  assert.equal(unauthorized.calls.length, 1, 'authentication failure never retries the paid submission')
  const forbidden = await harness([new Response(JSON.stringify({ detail: 'Forbidden' }), { status: 403 })])
  await assert.rejects(forbidden.service.status({ ...job, apiKey: 'test' }), error => error.statusCode === 403 && error.message.includes('模型调用权限'))
  assert.equal(forbidden.calls.length, 1)
})
test('invalid credentials, size, factor and image inputs never reach paid endpoint', async () => {
  const h = await harness([])
  for (const patch of [{ apiKey: '' }, { apiKey: 'bad\nkey' }, { mode: 'invent' }, { factor: 8 }, { factor: '2' }, { imageUrl: 'https://example.com/source.png' }, { imageUrl: 'data:image/png;base64,YmFk' }]) await assert.rejects(h.service.submit({ ...input, ...patch }))
  await assert.rejects(h.service.status({ apiKey: 'test', requestId: '../steal' }))
  assert.equal(h.calls.length, 0)
  assert.deepEqual(upscaleDimensions(1200, 2132, 4), { width: 4800, height: 8528 })
  assert.equal(upscaleCost(4800, 8528), 0.16)
  assert.equal(upscaleCost(2400, 4264), 0.08)
  assert.throws(() => upscaleDimensions(5000, 5000, 2), /6400/)
  assert.throws(() => upscaleDimensions(9000, 100, 2), /16384/)
})
test('polling uses the parent queue path, ignores returned URLs and never resubmits', async () => {
  const h = await harness([{ status: 'IN_QUEUE', queue_position: 3, response_url: 'https://attacker.example' }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED' }])
  for (const status of ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']) assert.equal((await h.service.status({ ...job, apiKey: 'test' })).status, status)
  assert.ok(h.calls.every(call => call.method === 'GET' && call.url === `https://queue.fal.run/topaz/upscale/requests/${job.requestId}/status`))
})
test('output bytes are preserved, validated against exact dimensions and cached without credentials', async () => {
  const bytes = png(60, 36)
  const h = await harness([{ image: { url: 'https://v3b.fal.media/upscaled.png' } }, new Response(bytes)])
  const output = await h.service.result({ ...job, apiKey: 'test' })
  assert.equal(h.calls[0].url, `https://queue.fal.run/topaz/upscale/requests/${job.requestId}`)
  assert.equal(h.calls[1].headers, undefined)
  assert.equal(output.width, 60); assert.equal(output.height, 36)
  assert.match(output.imageUrl, /^\/api\/projects\/assets\/.+\/images\/upscale-[a-f0-9]+\.png$/)
  assert.deepEqual(await readFile(path.join(h.cacheDir, path.basename(output.imageUrl))), bytes)
  const wrong = await harness([{ image: { url: 'https://fal.media/wrong.png' } }, new Response(png(60, 60))])
  await assert.rejects(wrong.service.result({ ...job, apiKey: 'test' }), /尺寸.*不一致/)
})
test('unsafe result URLs, oversized downloads, malformed PNG and provider errors are rejected', async () => {
  for (const url of ['http://fal.media/a', 'https://fal.media.attacker.test/a', 'https://test:pass@fal.media/a', 'https://fal.media:8443/a']) {
    const h = await harness([{ image: { url } }])
    await assert.rejects(h.service.result({ ...job, apiKey: 'test' }), /地址/)
    assert.equal(h.calls.length, 1)
  }
  for (const response of [new Response('bad'), new Response('too big', { headers: { 'content-length': String(161 * 1024 * 1024) } })]) {
    const h = await harness([{ image: { url: 'https://fal.media/a.png' } }, response])
    await assert.rejects(h.service.result({ ...job, apiKey: 'test' }))
  }
  const failure = await harness([new Response(JSON.stringify({ detail: 'test-fal rejected' }), { status: 429 })])
  await assert.rejects(failure.service.submit(input), error => error.statusCode === 429 && !error.message.includes('test-fal'))
  assert.equal(failure.calls.length, 1)
})
test('local middleware rejects foreign origins and applies quota only to paid submissions', async () => {
  let middleware, quotaCalls = 0, response
  const plugin = upscalePlugin({
    readBody: async () => JSON.stringify({ ...job, apiKey: 'test' }), sendJson: (_res, status, body) => { response = { status, body } },
    consumeGenerationQuota: () => { quotaCalls++; return false }, fetchUpstream: async () => new Response(JSON.stringify({ status: 'IN_QUEUE' })),
  })
  plugin.configureServer({ middlewares: { use: (_path, handler) => { middleware = handler } } })
  const res = { setHeader() {} }
  await middleware({ url: '/submit', method: 'POST', headers: { host: 'localhost:5174', origin: 'https://untrusted.example' } }, res, () => {})
  assert.equal(response.status, 403); assert.equal(quotaCalls, 0)
  await middleware({ url: '/submit', method: 'POST', headers: { host: 'localhost:5174', origin: 'http://localhost:5174' } }, res, () => {})
  assert.equal(response.status, 429); assert.equal(quotaCalls, 1)
  await middleware({ url: '/status', method: 'POST', headers: { host: 'localhost:5174' } }, res, () => {})
  assert.equal(response.status, 200); assert.equal(quotaCalls, 1)
})

function functionsFrom(file, names, dependencies) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const selected = []
  function visit(node) { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) selected.push(node.getText(ast)); ts.forEachChild(node, visit) }
  visit(ast); assert.equal(selected.length, names.length)
  const context = vm.createContext({ exports: {}, ...dependencies })
  vm.runInContext(ts.transpileModule(selected.join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context
}
test('canvas submission creates one connected result, retains original and stores a resumable job without image payload or key', async () => {
  const source = { id: 'source', position: { x: 100, y: 200 }, data: { imageUrl: '/original.png', title: '产品', prompt: 'original prompt', status: 'done' } }
  let nodes = [source], edges = [], session, selected, dirty = 0, run
  const context = functionsFrom('src/App.tsx', ['submitUpscale', 'cleanNode', 'cleanEdge', 'buildPackageProject'], {
    nodes, upscaleSession: { nodeId: source.id }, upscaleDimensions, upscaleModes,
    cacheCanvasImage: async () => '/cached-original.png', upscaleRequest: async () => ({ requestId: job.requestId, width: 30, height: 18 }),
    id: prefix => `${prefix}-1`, getAbsoluteNodePosition: node => node.position, findFreeWorkflowNodePosition: position => position,
    setNodes: fn => { nodes = fn(nodes) }, setEdges: fn => { edges = fn(edges) }, setSelectedNodeId: value => { selected = value },
    setUpscaleSession: value => { session = value }, markDirty: () => { dirty++ }, finishUpscale: (id, value) => { run = { id, job: value } },
    MarkerType: { ArrowClosed: 'arrowclosed' }, workflowEdgeColor: '#ccc', imageInputHandlePrefix: 'image-', window: { setTimeout() {} },
    sketchSceneIds: () => [], readModel3DScenes: async () => ({}), addImageToProjectPackage: async (_session, _url, index) => `images/${index}.png`,
  })
  await context.submitUpscale({ imageUrl: input.imageUrl, width: 30, height: 18, mode: 'fidelity', factor: 2 })
  assert.equal(nodes.length, 2); assert.equal(nodes[0].data, source.data)
  assert.equal(nodes[1].data.size, '60x36'); assert.equal(nodes[1].data.sourceImageUrl, '/cached-original.png')
  assert.equal(edges[0].source, source.id); assert.equal(edges[0].target, nodes[1].id); assert.equal(edges[0].targetHandle, 'image-1')
  assert.equal(selected, nodes[1].id); assert.equal(session.nodeId, selected); assert.equal(run.id, selected); assert.equal(dirty, 1)
  assert.equal(JSON.stringify(nodes[1].data.upscaleJob).includes('imageUrl'), false)
  nodes[1].data.onOpenUpscale = () => {}
  const exported = await context.buildPackageProject('qa', '高清修复', nodes, edges, [])
  assert.equal(exported.nodes[1].data.onOpenUpscale, undefined)
  assert.deepEqual(plain(exported.nodes[1].data.upscaleJob), job)
  assert.equal(exported.nodes[1].data.sourceImageUrl, 'images/2.png')
})
test('completion updates the correct node and history, while failed polling preserves the original job for resume', async () => {
  let nodes = [{ id: 'result', data: { upscaleJob: job, status: 'generating', sourceImageUrl: '/original.png' } }], history = [], progress = {}, dirty = 0
  const active = { current: new Map() }
  const dependencies = { AbortController, activeUpscaleRunsRef: active, upscaleModes,
    setNodes: fn => { nodes = fn(nodes) }, setHistory: fn => { history = fn(history) }, setUpscaleProgress: fn => { progress = fn(progress) },
    markDirty: () => { dirty++ }, setToast() {}, collectUpscale: async () => ({ imageUrl: '/cached-result.png', width: 60, height: 36 }),
  }
  const context = functionsFrom('src/App.tsx', ['finishUpscale'], dependencies)
  await context.finishUpscale('result', job)
  assert.equal(nodes[0].data.status, 'done'); assert.equal(nodes[0].data.size, '60x36'); assert.equal(history.length, 1)
  assert.equal(history[0].imageUrl, '/cached-result.png'); assert.equal(active.current.size, 0); assert.deepEqual(plain(progress), {})
  context.collectUpscale = async () => { throw new Error('poll interrupted') }
  await context.finishUpscale('result', job)
  assert.equal(nodes[0].data.status, 'error'); assert.equal(nodes[0].data.upscaleJob.requestId, job.requestId); assert.equal(dirty, 2)
  context.collectUpscale = dependencies.collectUpscale
  await context.finishUpscale('result', job)
  assert.equal(history.length, 1, 'resume does not duplicate history')
})

test('aborted jobs cannot overwrite another project or clear a newer run with the same node ID', async () => {
  let resolve, historyWrites = 0, progressWrites = 0
  const active = { current: new Map() }
  const context = functionsFrom('src/App.tsx', ['finishUpscale'], {
    AbortController, activeUpscaleRunsRef: active, upscaleModes, setNodes() {}, setHistory() { historyWrites++ },
    setUpscaleProgress() { progressWrites++ }, markDirty() {}, setToast() {},
    collectUpscale: () => new Promise(done => { resolve = done }),
  })
  const pending = context.finishUpscale('same-node', job)
  active.current.get('same-node').abort()
  const replacement = new AbortController()
  active.current.set('same-node', replacement)
  resolve({ imageUrl: '/old-result.png', width: 60, height: 36 })
  await pending
  assert.equal(historyWrites, 0)
  assert.equal(progressWrites, 1)
  assert.equal(active.current.get('same-node'), replacement)
})
