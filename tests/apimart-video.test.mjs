import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const plain = value => JSON.parse(JSON.stringify(value))
function contextFrom(file, names, dependencies = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const selected = ast.statements.filter(statement => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return names.includes(statement.name?.text)
    return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(value => names.includes(value.name.getText(ast)))
  })
  assert.equal(selected.length, names.length)
  const context = vm.createContext({ URL, Buffer, ...dependencies })
  vm.runInContext(ts.transpileModule(selected.map(value => value.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context)
  return context
}

const config = { mode: 'apimart', apiKey: 'test-key', endpoint: 'https://api.apimart.ai/v1/images/generations', videoModel: 'muse-video-ext', size: '1536x864' }
const submitted = { code: 200, data: [{ status: 'submitted', task_id: 'muse-task' }] }
const completed = { data: { status: 'completed', result: { videos: [{ url: ['https://example.com/result.mp4'] }] } } }
function harness(responses = [submitted, completed], byteSizes = {}) {
  const calls = [], waits = [], uploads = [], downloads = []
  let sequence = 0
  const context = contextFrom('../vite.config.ts', [
    'UpstreamHttpError', 'apiMartVideoModelConfigs', 'requestApiMartVideo', 'prepareMuseVideoReferenceImages',
    'apiMartVideoEndpoint', 'apiMartSiblingEndpoint', 'aspectRatioFromSize', 'apiMartTaskEndpoint',
    'apiMartTaskId', 'apiMartTaskData', 'apiMartTaskStatus', 'apiMartTaskError', 'apiMartVideoUrl',
    'postJson', 'getJson', 'parseJsonLikeResponse', 'httpFailureMessage', 'knownErrorText', 'stringValue', 'compactJson',
    'validateReferenceImage', 'supportedReferenceMediaTypes', 'maxReferenceImageBytes',
    'parseDataUrl', 'extensionFromMediaType', 'dataUrlFromImage',
  ], {
    randomUUID: () => `operation-${++sequence}`,
    setTimeout: (callback, delay) => { waits.push(delay); callback() },
    fetchUpstream: async (endpoint, options) => {
      calls.push({ endpoint, method: options.method, headers: plain(options.headers), payload: options.body ? JSON.parse(options.body) : undefined })
      const response = typeof responses === 'function' ? responses(calls.length) : responses[calls.length - 1]
      assert.ok(response, 'unexpected upstream request')
      return new Response(JSON.stringify(response))
    },
    formatUpstreamFetchError: error => error.message,
    loadImageBuffer: async url => {
      downloads.push(url)
      return url.startsWith('data:') ? context.parseDataUrl(url) : { mediaType: 'image/png', buffer: Buffer.alloc(byteSizes[url] ?? 8, 1) }
    },
    uploadApiMartReferenceImage: async (...args) => { uploads.push(args); return 'https://example.com/upload.png' },
    uploadApiMartReferenceVideo: async (...args) => { uploads.push(args); return 'https://example.com/upload.mp4' },
  })
  return { context, calls, waits, downloads, uploads, run: (overrides = {}, images = [], videos = [], prompt = '镜头缓慢推进') => context.requestApiMartVideo({ ...config, ...overrides }, prompt, images, videos) }
}

test('Muse sends the documented fixed spec, aspect_ratio and unique idempotency key', async () => {
  const h = harness()
  const result = await h.run({ videoDuration: 5, videoResolution: '1080p', size: '1536x1024' })
  assert.equal(result.data[0].url, 'https://example.com/result.mp4')
  assert.equal(h.calls[0].endpoint, 'https://api.apimart.ai/v1/videos/generations')
  assert.deepEqual(h.calls[0].payload, { model: 'muse-video-ext', prompt: '镜头缓慢推进', duration: 10, resolution: '720p', aspect_ratio: '3:2', n: 1 })
  assert.equal(h.calls[0].headers['Idempotency-Key'], 'operation-1')
  assert.equal(h.calls[1].endpoint, 'https://api.apimart.ai/v1/tasks/muse-task?language=zh')
  assert.deepEqual(h.waits, [5000])
})

test('Muse accepts nine ordered references, counts raw bytes and omits automatic aspect ratio', async () => {
  const h = harness()
  const references = ['data:image/png;base64,aW1hZ2U=', '/api/projects/assets/local.png', ...Array.from({ length: 7 }, (_, i) => `https://example.com/${i}.png`)]
  await h.run({ size: 'auto' }, references)
  const payload = h.calls[0].payload
  assert.equal(payload.image_urls.length, 9)
  assert.deepEqual(h.downloads, references)
  assert.equal(payload.image_urls[0], references[0])
  assert.ok(payload.image_urls.every(url => url.startsWith('data:image/png;base64,')))
  for (const key of ['size', 'aspect_ratio', 'video_urls', 'generate_audio', 'audio']) assert.equal(Object.hasOwn(payload, key), false)
  assert.equal(h.uploads.length, 0)
})

test('Muse rejects excess references, videos, empty prompts and invalid ratios before any upload or submission', async () => {
  for (const [overrides, images, videos, prompt, message] of [
    [{}, Array(10).fill('https://example.com/ref.png'), [], 'test', /最多支持 9 张/],
    [{}, [], ['https://example.com/ref.mp4'], 'test', /不支持参考视频/],
    [{}, [], [], '  ', /必须填写提示词/],
    [{ size: '21:9' }, [], [], 'test', /暂不支持/],
  ]) {
    const h = harness()
    await assert.rejects(h.run(overrides, images, videos, prompt), message)
    assert.equal(h.calls.length + h.downloads.length + h.uploads.length, 0)
  }
})

test('11 MiB is a combined decoded-byte limit, including remote references', async () => {
  const h = harness(undefined, { '/local.png': 6 * 1024 * 1024, 'https://example.com/ref.png': 5 * 1024 * 1024 + 1 })
  await assert.rejects(h.run({}, ['/local.png', 'https://example.com/ref.png']), /合计不能超过 11 MiB/)
  assert.equal(h.calls.length, 0)
  const boundary = harness(undefined, { '/local.png': 6 * 1024 * 1024, 'https://example.com/ref.png': 5 * 1024 * 1024 })
  await boundary.run({}, ['/local.png', 'https://example.com/ref.png'])
  assert.equal(boundary.calls[0].payload.image_urls.length, 2)
})

test('Muse waits for terminal success and reports failure even if a URL is present', async () => {
  const pending = { data: { ...completed.data, status: 'processing', progress: 100 } }
  const h = harness([submitted, pending, completed])
  await h.run()
  assert.equal(h.calls.length, 3)
  const failed = harness([submitted, { data: { ...completed.data, status: 'failed', error: { message: 'reference rejected' } } }])
  await assert.rejects(failed.run(), /reference rejected/)
  const timeout = harness(index => index === 1 ? submitted : pending)
  await assert.rejects(timeout.run(), /muse-task.*避免重复提交扣费/)
  assert.equal(timeout.calls.filter(call => call.method === 'POST').length, 1)
})

test('Seedance and MiniMax retain their original upload and request protocols', async () => {
  for (const model of ['seedance-2.5', 'seedance-2.0', 'MiniMax-H3']) {
    const h = harness()
    await h.run({ videoModel: model }, ['/local.png'])
    const request = h.calls[0]
    assert.equal(request.payload.model, model)
    assert.equal(request.payload[model === 'MiniMax-H3' ? 'aspect_ratio' : 'size'], '16:9')
    assert.equal(request.payload.generate_audio, model === 'MiniMax-H3' ? undefined : true)
    assert.equal(request.payload.duration, 5)
    assert.equal(request.headers['Idempotency-Key'], undefined)
    assert.equal(h.uploads.length, 1)
    assert.deepEqual(h.waits, [3000])
  }
})

const ui = contextFrom('../src/App.tsx', [
  'apiMartVideoModels', 'findApiMartVideoModel', 'imageInputHandlePrefix', 'videoInputHandlePrefix',
  'imageInputHandleIndex', 'isImageInputHandle', 'videoInputHandleIndex', 'isVideoInputHandle',
  'referenceInputSlots', 'videoInputLimitError', 'limitVideoInputEdges', 'normalizeImageInputEdges',
])
const muse = ui.findApiMartVideoModel('muse-video-ext')
test('Muse node grows to Image 9 but never Image 10, and exposes no video input', () => {
  for (let count = 0; count <= 9; count++) {
    const indexes = new Set(Array.from({ length: count }, (_, i) => i + 1))
    const slots = plain(ui.referenceInputSlots(indexes, 'image-', muse.maxReferenceImages))
    assert.equal(slots.length, Math.min(9, count + 1))
    assert.equal(slots.filter(slot => slot.connected).length, count)
  }
  assert.deepEqual(plain(ui.referenceInputSlots(new Set(), 'video-', muse.maxReferenceVideos)), [])
  const edges = Array.from({ length: 9 }, (_, i) => ({ target: 'muse', targetHandle: `image-${i + 1}` }))
  assert.match(ui.videoInputLimitError('muse', 'image-10', edges, muse), /9.*参考图/)
  assert.match(ui.videoInputLimitError('muse', 'video-1', [], muse), /0.*参考视频/)
  assert.equal(ui.videoInputLimitError('muse', 'image-9', edges.slice(0, 8), muse), null)
  const backend = harness().context
  const serverModel = plain(vm.runInContext("apiMartVideoModelConfigs['muse-video-ext']", backend))
  const { id, ...frontendModel } = plain(muse)
  assert.equal(id, 'muse-video-ext')
  assert.deepEqual(frontendModel, serverModel)
})

test('switching to Muse keeps first nine images, preserves source nodes and removes unsupported video links', () => {
  const nodes = [{ id: 'out', data: { kind: 'video' } }, { id: 'clip', data: { kind: 'video-reference' } }, ...Array.from({ length: 12 }, (_, i) => ({ id: `ref-${i}`, data: { kind: 'reference' } }))]
  const edges = [...nodes.slice(2).map((node, i) => ({ source: node.id, target: 'out', targetHandle: `image-${i + 1}` })), { source: 'clip', target: 'out' }, { source: 'ref-0', target: 'elsewhere', targetHandle: 'image-1' }]
  const original = JSON.stringify({ nodes, edges })
  const result = plain(ui.limitVideoInputEdges(edges, nodes, 'out', muse))
  assert.equal(result.length, 10)
  assert.deepEqual(result.slice(0, 9).map(edge => edge.source), nodes.slice(2, 11).map(node => node.id))
  assert.equal(result.at(-1).target, 'elsewhere')
  assert.equal(JSON.stringify({ nodes, edges }), original)
})
