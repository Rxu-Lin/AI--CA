import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const serverSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const plain = (value) => JSON.parse(JSON.stringify(value))
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function declarations(source, names, kind = ts.ScriptKind.TS) {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, kind)
  const selected = ast.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return names.includes(statement.name?.text)
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((value) => names.includes(value.name.getText(ast)))
    return false
  })
  assert.equal(selected.length, names.length, 'all tested declarations must exist in the implementation')
  return selected.map((value) => value.getText(ast)).join('\n')
}

const serverNames = [
  'UpstreamHttpError', 'apiMartModelConfigs', 'stringValue', 'knownErrorText', 'httpFailureMessage', 'compactJson',
  'parseJsonLikeResponse', 'postJson', 'getJson', 'aspectRatioFromSize', 'apiMartSiblingEndpoint', 'apiMartTaskEndpoint',
  'apiMartTaskData', 'apiMartTaskId', 'apiMartImageUrl', 'apiMartMidjourneyImageUrl', 'apiMartMidjourneySize',
  'apiMartTaskStatus', 'apiMartTaskError', 'apiMartResolution', 'requestApiMartImage',
  'prepareGrsAiReferenceImages', 'shouldInlineGrsAiReference', 'validateReferenceImage', 'parseDataUrl',
  'extensionFromMediaType', 'dataUrlFromImage', 'supportedReferenceMediaTypes', 'maxReferenceImageBytes', 'maxTotalReferenceImageBytes',
]
const serverCode = compile(declarations(serverSource, serverNames))
const config = {
  mode: 'apimart', endpoint: 'https://api.apimart.ai/v1/images/generations', apiKey: ' test-key ',
  model: 'midjourney-v8.2', imageSize: '1K', size: '864x1536',
}
const submitted = { code: 200, data: [{ status: 'submitted', task_id: 'task_mj_82' }] }
const success = {
  id: 'task_mj_82', status: 'SUCCESS', action: 'IMAGINE', progress: '100%',
  grid_image_url: 'https://cdn.example/grid.png',
  image_urls: ['https://cdn.example/single-0.png', 'https://cdn.example/single-1.png', 'https://cdn.example/single-2.png', 'https://cdn.example/single-3.png'],
}

function harness(responses = [submitted, success]) {
  const calls = [], waits = [], localImages = [], uploads = []
  const context = vm.createContext({
    URL, Buffer, Error,
    setTimeout: (callback, delay) => { waits.push(delay); callback() },
    fetchUpstream: async (endpoint, options) => {
      calls.push({ endpoint, method: options.method, headers: plain(options.headers), payload: options.body ? JSON.parse(options.body) : undefined })
      const next = typeof responses === 'function' ? responses(calls.length) : responses[calls.length - 1]
      assert.ok(next, `unexpected upstream request ${calls.length}`)
      return new Response(JSON.stringify(next.body ?? next), { status: next.httpStatus ?? 200 })
    },
    formatUpstreamFetchError: (error) => error.message,
    loadImageBuffer: async (url) => { localImages.push(url); return { buffer: Buffer.from('local-image'), mediaType: 'image/png' } },
    uploadApiMartReferenceImage: async (...args) => { uploads.push(args); return 'https://cdn.example/upload.png' },
  })
  vm.runInContext(serverCode, context)
  return { context, calls, waits, localImages, uploads, run: (overrides = {}, refs = [], prompt = '产品海报') => context.requestApiMartImage({ ...config, ...overrides }, prompt, refs) }
}

test('Midjourney v8.2 is selectable and frontend/server capabilities match', () => {
  const context = vm.createContext({})
  vm.runInContext(compile(declarations(appSource, ['apiMartModels', 'findApiMartModel', 'apiMartVideoModels', 'apiModelDisplayName'], ts.ScriptKind.TSX)), context)
  const option = plain(context.findApiMartModel('midjourney-v8.2'))
  assert.equal(option.id, 'midjourney-v8.2')
  assert.equal(context.apiModelDisplayName(option.id), 'Midjourney v8.2')
  const server = harness().context
  const capabilities = plain(vm.runInContext("apiMartModelConfigs['midjourney-v8.2']", server))
  for (const key of ['label', 'resolutions', 'defaultResolution', 'maxReferenceImages']) assert.deepEqual(option[key], capabilities[key])
  assert.deepEqual(option.resolutions, ['1K', '2K'])
  assert.equal(capabilities.midjourneyVersion, '8.2')
})

test('Run submits the dedicated Imagine protocol and returns a cropped image, not the grid', async () => {
  const h = harness([submitted, { ...success, status: 'IN_PROGRESS' }, success])
  const result = await h.run()
  assert.deepEqual(h.calls[0], {
    endpoint: 'https://api.apimart.ai/v1/midjourney/generations', method: 'POST',
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    payload: { model: 'midjourney', version: '8.2', prompt: '产品海报', size: '9:16', hd: false },
  })
  assert.equal(h.calls[1].endpoint, 'https://api.apimart.ai/v1/midjourney/task_mj_82')
  assert.equal(h.calls[1].method, 'GET')
  assert.equal(h.calls.length, 3, 'partial images must not end a Midjourney task early')
  assert.deepEqual(h.waits, [3000, 3000])
  assert.equal(result.data[0].url, success.image_urls[0])
  assert.equal(result.apimart.image_urls.length, 4)
})

test('2K maps to HD, retains custom proxy prefix and reference ordering', async () => {
  const h = harness()
  const inline = 'data:image/png;base64,aW1hZ2U='
  await h.run({ endpoint: 'https://proxy.example/apimart/v1/images/generations?old=1', imageSize: '2K', size: '1200x2132' }, [inline, '/api/assets/local.png', 'https://example.com/ref.png'], '产品 --stylize 50')
  const request = h.calls[0]
  assert.equal(request.endpoint, 'https://proxy.example/apimart/v1/midjourney/generations')
  assert.equal(request.payload.hd, true)
  assert.equal(request.payload.size, '300:533')
  assert.equal(request.payload.prompt, '产品 --stylize 50')
  assert.deepEqual(request.payload.image_urls, [inline, `data:image/png;base64,${Buffer.from('local-image').toString('base64')}`, 'https://example.com/ref.png'])
  assert.deepEqual(h.localImages, ['/api/assets/local.png'])
  assert.equal(h.uploads.length, 0, 'Midjourney accepts inline references without the GPT 2.5 upload path')
  assert.equal(h.calls[1].endpoint, 'https://proxy.example/apimart/v1/midjourney/task_mj_82')
  for (const key of ['resolution', 'n', 'quality', 'speed']) assert.equal(Object.hasOwn(request.payload, key), false)
})

test('an unsupported saved resolution falls back to standard mode', async () => {
  const h = harness()
  await h.run({ imageSize: '4K', size: '1024x1024' })
  assert.equal(h.calls[0].payload.hd, false)
  assert.equal(h.calls[0].payload.size, '1:1')
})

test('nested task IDs and unified completed results are accepted', async () => {
  const h = harness([{ code: 200, data: { task_id: 'nested/id' } }, { data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/unified.png'] }] } } }])
  assert.equal((await h.run()).data[0].url, 'https://cdn.example/unified.png')
  assert.equal(h.calls[1].endpoint, 'https://api.apimart.ai/v1/midjourney/nested%2Fid')
  assert.equal(h.context.apiMartTaskId({ id: 'root-id', data: { status: 'submitted' } }), 'root-id')
})

test('native failure reports fail_reason even when a grid exists', async () => {
  const h = harness([submitted, { ...success, status: 'FAILURE', fail_reason: 'prompt moderation rejected' }])
  await assert.rejects(h.run(), /prompt moderation rejected/)
  assert.equal(h.calls.length, 2)
})

test('completed grid-only output is rejected instead of displaying four images as one', async () => {
  const h = harness([submitted, { status: 'SUCCESS', grid_image_url: success.grid_image_url, imageUrl: success.grid_image_url }])
  await assert.rejects(h.run(), /没有找到图片地址/)
})

test('MODAL does not hang or resubmit a billed task', async () => {
  const h = harness([submitted, { status: 'MODAL' }])
  await assert.rejects(h.run(), /需要额外参数/)
  assert.equal(h.calls.filter((value) => value.method === 'POST').length, 1)
})

test('waiting is bounded and timeout warns against duplicate billing', async () => {
  const h = harness((index) => index === 1 ? submitted : { status: 'IN_PROGRESS' })
  await assert.rejects(h.run(), /task_mj_82.*避免重复提交扣费/)
  assert.equal(h.calls.length, 241)
  assert.equal(h.calls.filter((value) => value.method === 'POST').length, 1)
  assert.equal(h.waits.reduce((total, delay) => total + delay, 0), 12 * 60 * 1000)
})

test('invalid ratio, missing key and oversized reference count fail before upstream submission', async () => {
  for (const [overrides, refs, error] of [
    [{ apiKey: '' }, [], /API Key/],
    [{ model: 'unknown' }, [], /可选列表/],
    [{ size: '0x1024' }, [], /有效宽高比/],
    [{ size: 'broken' }, [], /有效宽高比/],
    [{ size: '15:1' }, [], /14:1/],
    [{ size: '5:1', imageSize: '2K' }, [], /4:1/],
    [{}, Array(15).fill('https://example.com/image.png'), /在本网站.*14/],
  ]) {
    const h = harness()
    await assert.rejects(h.run(overrides, refs), error)
    assert.equal(h.calls.length, 0)
  }
})

test('upstream HTTP errors preserve the selected model and HD context', async () => {
  const h = harness([{ httpStatus: 403, body: { error: { message: 'model access denied' } } }])
  await assert.rejects(h.run({ imageSize: '2K' }), (error) => error.statusCode === 403 && /model access denied.*Midjourney v8.2.*2K/.test(error.message))
})

test('immediate submission errors preserve the upstream message', async () => {
  const h = harness([{ code: 400, message: 'unsupported prompt' }])
  await assert.rejects(h.run(), /unsupported prompt/)
  assert.equal(h.calls.length, 1)
})

for (const model of ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview', 'gemini-nano-banana-2.1']) {
  test(`${model} submits references and retrieves images through the unified API`, async () => {
    const h = harness([submitted, { data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/nano.png'] }] } } }])
    const refs = ['data:image/png;base64,aW1hZ2U=', 'https://example.com/ref.png']
    assert.equal((await h.run({ model, imageSize: '4K' }, refs)).data[0].url, 'https://cdn.example/nano.png')
    assert.equal(h.calls[0].endpoint, config.endpoint)
    assert.deepEqual(h.calls[0].payload, { model, prompt: '产品海报', size: '9:16', resolution: '4K', n: 1, image_urls: refs })
    assert.equal(h.calls[1].endpoint, 'https://api.apimart.ai/v1/tasks/task_mj_82?language=zh')
    assert.deepEqual(h.waits, [1000])
    assert.equal(h.uploads.length, 0, 'Nano Banana references do not require public URL uploads')
  })
}

test('existing GPT Image 2.5 keeps public uploads, lowercase resolution and quality', async () => {
  const h = harness([{ data: [{ url: 'https://cdn.example/gpt.png' }] }])
  await h.run({ model: 'gpt-image-2.5-flare', imageSize: '2K' }, ['/api/assets/local.png'])
  assert.equal(h.calls[0].endpoint, config.endpoint)
  assert.deepEqual(h.calls[0].payload, { model: 'gpt-image-2.5-flare', prompt: '产品海报', size: '9:16', resolution: '2k', n: 1, quality: 'medium', image_urls: ['https://cdn.example/upload.png'] })
  assert.equal(h.uploads.length, 1)
  assert.equal(h.uploads[0][4], false)
})

const gpt26Variants = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare']

test('Seedream 5.5 is selectable with matching image capabilities', () => {
  const context = vm.createContext({})
  vm.runInContext(compile(declarations(appSource, ['apiMartModels', 'findApiMartModel', 'apiMartVideoModels', 'apiModelDisplayName'], ts.ScriptKind.TSX)), context)
  const option = plain(context.findApiMartModel('seedream-5-5'))
  assert.equal(option.id, 'seedream-5-5')
  assert.equal(context.apiModelDisplayName(option.id), 'Seedream 5.5')
  const capabilities = plain(vm.runInContext("apiMartModelConfigs['seedream-5-5']", harness().context))
  for (const key of ['label', 'resolutions', 'defaultResolution', 'maxReferenceImages']) assert.deepEqual(option[key], capabilities[key])
  assert.deepEqual(option.resolutions, ['1K', '1.5K', '2K'])
  assert.equal(option.defaultResolution, '2K')
  assert.equal(option.maxReferenceImages, 10)
})

for (const imageSize of ['1K', '1.5K', '2K']) {
  test(`Seedream 5.5 sends ${imageSize} and reads its native async result`, async () => {
    const h = harness([{ task_id: 'task_seedream55', status: 'submitted' },
      { status: 'PROCESSING' }, { status: 'SUCCESS', result: { images: [{ url: ['https://cdn.example/seedream55.png'] }] } }])
    assert.equal((await h.run({ model: 'seedream-5-5', imageSize })).data[0].url, 'https://cdn.example/seedream55.png')
    assert.equal(h.calls[0].endpoint, config.endpoint)
    assert.deepEqual(h.calls[0].payload, { model: 'seedream-5-5', prompt: '产品海报', size: '9:16', resolution: imageSize, n: 1 })
    assert.equal(h.calls[1].endpoint, 'https://api.apimart.ai/v1/tasks/task_seedream55?language=zh')
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1)
  })
}

test('Seedream 5.5 keeps ten references in order and rejects eleven before reading or submitting', async () => {
  const refs = ['data:image/png;base64,aW1hZ2U=', '/api/assets/local.png',
    ...Array.from({ length: 8 }, (_, i) => `https://example.com/ref-${i}.png`)]
  const h = harness([{ data: [{ url: 'https://cdn.example/seedream55.png' }] }])
  await h.run({ model: 'seedream-5-5', imageSize: '4K' }, refs)
  assert.deepEqual(h.calls[0].payload.image_urls, [refs[0], `data:image/png;base64,${Buffer.from('local-image').toString('base64')}`, ...refs.slice(2)])
  assert.equal(h.calls[0].payload.resolution, '2K', 'unsupported saved resolutions use the model default')
  assert.equal(h.uploads.length, 0, 'Seedream accepts inline references directly')
  const excess = harness()
  await assert.rejects(excess.run({ model: 'seedream-5-5' }, [...refs, '/api/assets/extra.png']), /Seedream 5.5.*10 张参考图/)
  assert.equal(excess.calls.length, 0)
  assert.equal(excess.localImages.length, 0)
  assert.equal(excess.uploads.length, 0)
})

test('Seedream 5.5 reports rate limits and native task failure without retrying a paid submission', async () => {
  const limited = harness([{ httpStatus: 429, body: { error: { message: 'rate limit exceeded' } } }])
  await assert.rejects(limited.run({ model: 'seedream-5-5' }), /rate limit exceeded.*Seedream 5.5/)
  assert.equal(limited.calls.length, 1)
  const failed = harness([submitted, { status: 'FAILURE', fail_reason: 'generation rejected' }])
  await assert.rejects(failed.run({ model: 'seedream-5-5' }), /generation rejected/)
  assert.equal(failed.calls.filter(call => call.method === 'POST').length, 1)
})

for (const model of gpt26Variants) {
  test(`${model} is selectable with matching frontend/server limits`, () => {
    const context = vm.createContext({})
    vm.runInContext(compile(declarations(appSource, ['apiMartModels', 'findApiMartModel', 'apiMartVideoModels', 'apiModelDisplayName'], ts.ScriptKind.TSX)), context)
    const option = plain(context.findApiMartModel(model))
    assert.equal(option.id, model)
    assert.equal(context.apiModelDisplayName(option.id), model.endsWith('sunburst') ? 'GPT Image 2.6 Sunburst' : 'GPT Image 2.6 Flare')
    const capabilities = plain(vm.runInContext(`apiMartModelConfigs['${model}']`, harness().context))
    for (const key of ['label', 'resolutions', 'defaultResolution', 'maxReferenceImages']) assert.deepEqual(option[key], capabilities[key])
    assert.deepEqual(option.resolutions, ['1K', '2K', '4K'])
    assert.equal(option.maxReferenceImages, 16)
  })

  for (const imageSize of ['1K', '2K', '4K']) {
    test(`${model} submits ${imageSize} with auto quality and polls the image result`, async () => {
      const h = harness([submitted, { data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/gpt26.png'] }] } } }])
      assert.equal((await h.run({ model, imageSize })).data[0].url, 'https://cdn.example/gpt26.png')
      assert.equal(h.calls[0].endpoint, config.endpoint)
      assert.deepEqual(h.calls[0].payload, { model, prompt: '产品海报', size: '9:16', resolution: imageSize.toLowerCase(), quality: 'auto', n: 1 })
      assert.equal(h.calls[1].endpoint, 'https://api.apimart.ai/v1/tasks/task_mj_82?language=zh')
      assert.equal(h.uploads.length, 0)
    })
  }

  test(`${model} prepares up to 16 public references in input order and rejects 17 before uploading`, async () => {
    const refs = Array.from({ length: 16 }, (_, index) => `/api/assets/ref-${index}.png`)
    const h = harness([{ data: [{ url: 'https://cdn.example/gpt26.png' }] }])
    await h.run({ model, imageSize: '3K' }, refs)
    assert.deepEqual(h.uploads.map((args) => args[2]), refs)
    assert.deepEqual(h.uploads.map((args) => args[3]), refs.map((_, index) => index))
    assert.ok(h.uploads.every((args) => args[4] === false))
    assert.equal(h.calls[0].payload.image_urls.length, 16)
    assert.equal(h.calls[0].payload.resolution, '1k', 'unsupported saved resolutions use the model default')
    const excess = harness()
    await assert.rejects(excess.run({ model }, [...refs, '/api/assets/extra.png']), /GPT Image 2.6.*16 张参考图/)
    assert.equal(excess.uploads.length, 0)
    assert.equal(excess.calls.length, 0)
  })

  test(`${model} preserves upstream access and task failures without returning a different model`, async () => {
    const denied = harness([{ httpStatus: 403, body: { error: { message: 'model access denied' } } }])
    await assert.rejects(denied.run({ model }), /model access denied.*GPT Image 2.6/)
    assert.equal(denied.calls.length, 1)
    assert.equal(denied.calls[0].payload.model, model)
    const failed = harness([submitted, { data: { status: 'failed', error: { message: 'generation failed upstream' } } }])
    await assert.rejects(failed.run({ model }), /generation failed upstream/)
    assert.equal(failed.calls.filter((call) => call.method === 'POST').length, 1)
  })
}

test('legacy GPT Image 2.6 uses Flare without a third menu entry or mutating the saved request', async () => {
  const context = vm.createContext({})
  vm.runInContext(compile(declarations(appSource, ['apiMartModels', 'findApiMartModel', 'apiMartVideoModels', 'apiModelDisplayName'], ts.ScriptKind.TSX)), context)
  assert.deepEqual(plain(vm.runInContext("apiMartModels.filter(option => option.id.startsWith('gpt-image-2.6')).map(option => option.id)", context)), gpt26Variants)
  assert.equal(context.findApiMartModel('gpt-image-2.6').id, 'gpt-image-2.6-flare')
  assert.equal(context.apiModelDisplayName('gpt-image-2.6'), 'GPT Image 2.6 Flare')
  const h = harness([{ data: [{ url: 'https://cdn.example/gpt26.png' }] }])
  const saved = Object.freeze({ ...config, model: 'gpt-image-2.6', imageSize: '4K' })
  await h.context.requestApiMartImage(saved, '保持原图主体', ['/api/assets/ref.png'])
  assert.equal(saved.model, 'gpt-image-2.6')
  assert.equal(h.calls[0].payload.model, 'gpt-image-2.6-flare')
  assert.equal(h.calls[0].payload.resolution, '4k')
  assert.equal(h.calls[0].payload.quality, 'auto')
  assert.equal(h.uploads.length, 1)
})
