import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const compile = (value) => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const promptModule = vm.createContext({ exports: {} })
vm.runInContext(compile(readFileSync(new URL('../src/workflowPrompts.ts', import.meta.url), 'utf8')), promptModule)
const { migrateLegacyPromptNodes, generationPromptText, whiteModelAnimationPrompt } = promptModule.exports
const mediaModule = vm.createContext({ exports: {} })
vm.runInContext(compile(readFileSync(new URL('../src/canvasMediaClipboard.ts', import.meta.url), 'utf8')), mediaModule)
const versionsModule = vm.createContext({ exports: {} })
vm.runInContext(compile(readFileSync(new URL('../src/resultVersions.ts', import.meta.url), 'utf8')), versionsModule)
const { includeCurrentResults, indexResultVersions, nodeResultVersions } = versionsModule.exports
const plain = (value) => JSON.parse(JSON.stringify(value))
const node = (id, kind, data = {}) => ({ id, type: 'workflow', position: { x: 10, y: 20 }, data: { kind, status: 'idle', ...data } })
const edge = (id, source, target, targetHandle) => ({ id, source, target, targetHandle, sourceHandle: 'output' })

function helpers(names, dependencies = {}) {
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functions = []
  function visit(value) {
    if (ts.isFunctionDeclaration(value) && names.includes(value.name?.text)) functions.push(value.getText(ast))
    ts.forEachChild(value, visit)
  }
  visit(ast)
  assert.equal(functions.length, names.length)
  const context = vm.createContext({ require, exports: {}, generationPromptText, ...versionsModule.exports, ...dependencies })
  vm.runInContext(compile(functions.join('\n')), context)
  return context
}

test('shared legacy prompt migrates into image and video without changing saved source data', () => {
  const mention = { token: '@Image1', nodeId: 'ref', kind: 'image', label: '产品' }
  const nodes = [node('p', 'prompt', { prompt: '润色 @Image1', promptMentions: [mention] }), node('i', 'image'), node('v', 'video'), node('ref', 'reference')]
  const edges = [edge('pi', 'p', 'i', 'prompt'), edge('pv', 'p', 'v', 'prompt'), edge('ri', 'ref', 'i', 'image-1')]
  const before = JSON.stringify({ nodes, edges })
  const result = migrateLegacyPromptNodes(nodes, edges)
  assert.deepEqual(plain(result.nodes.map(value => value.id)), ['i', 'v', 'ref'])
  for (const id of ['i', 'v']) {
    const data = result.nodes.find(value => value.id === id).data
    assert.equal(data.prompt, '润色 @Image1')
    assert.deepEqual(plain(data.promptMentions), [mention])
  }
  assert.deepEqual(plain(result.edges), [edges[2]])
  assert.equal(JSON.stringify({ nodes, edges }), before)
  const restored = plain(result)
  const again = migrateLegacyPromptNodes(restored.nodes, restored.edges)
  assert.equal(again.nodes, restored.nodes)
  assert.equal(again.edges, restored.edges)
})

test('unconnected drafts become image nodes and inherited reference links survive migration', () => {
  const nodes = [node('draft', 'prompt', { prompt: '未使用草稿' }), node('p', 'prompt', { prompt: '主体' }), node('i', 'image', { prompt: '额外要求' }), node('ref', 'reference')]
  const edges = [edge('rp', 'ref', 'p', 'image'), edge('pi', 'p', 'i', 'prompt')]
  const result = migrateLegacyPromptNodes(nodes, edges)
  const draft = result.nodes.find(value => value.id === 'draft')
  assert.equal(draft.data.kind, 'image')
  assert.equal(draft.data.prompt, '未使用草稿')
  assert.deepEqual(plain(draft.position), { x: 10, y: 20 })
  assert.equal(result.nodes.find(value => value.id === 'i').data.prompt, '主体\n\n额外要求')
  assert.equal(result.edges.length, 1)
  assert.equal(result.edges[0].source, 'ref')
  assert.equal(result.edges[0].target, 'i')
  assert.equal(result.edges[0].targetHandle, 'image-1')
})

test('previous hidden generation text becomes editable and clearing it stays empty', () => {
  const old = [node('i', 'image', { prompt: '', generationPrompt: '旧灯光提示词' })]
  const result = migrateLegacyPromptNodes(old, [])
  assert.equal(result.nodes[0].data.prompt, '旧灯光提示词')
  const cleared = [{ ...result.nodes[0], data: { ...result.nodes[0].data, prompt: '', generationPrompt: '' } }]
  assert.equal(migrateLegacyPromptNodes(cleared, []).nodes, cleared)
  assert.equal(generationPromptText({ prompt: '', generationPrompt: 'previous' }), '')
})

const inputHelpers = ['imageInputHandleIndex', 'isImageInputHandle', 'videoInputHandleIndex', 'isVideoInputHandle', 'promptMentionOptionsForNode', 'promptContainsMentionToken', 'activePromptMentions', 'compilePromptMentions', 'promptWithReferenceImageOrder', 'promptWithReferenceVideoOrder']
const inputDependencies = { imageInputHandlePrefix: 'image-', videoInputHandlePrefix: 'video-' }

test('@ references belong to the current generation node and follow port order', () => {
  const context = helpers(inputHelpers, inputDependencies)
  const nodes = [node('i', 'image'), node('v', 'video'), node('a', 'reference', { imageUrl: '/a.png' }), node('b', 'reference', { imageUrl: '/b.png' }), node('clip', 'video-reference', { videoUrl: '/clip.mp4' })]
  const edges = [edge('bi', 'b', 'i', 'image-2'), edge('ai', 'a', 'i', 'image-1'), edge('cv', 'clip', 'v', 'video-1')]
  assert.deepEqual(plain(context.promptMentionOptionsForNode('i', nodes, edges).map(value => [value.token, value.nodeId])), [['@Image1', 'a'], ['@Image2', 'b']])
  assert.deepEqual(plain(context.promptMentionOptionsForNode('v', nodes, edges).map(value => [value.token, value.nodeId])), [['@Video1', 'clip']])
})

function generationHarness(kind, prompt) {
  const requests = []
  const context = helpers([...inputHelpers, 'generateImageInNode', 'generateVideoInNode', 'useVersionAsOutput',
    'referenceSizeInputUrl', 'referenceRequestSize'], {
    ...inputDependencies,
    versionsByNode: new Map(), generationProjectRef: { current: 0 },
    nodes: [node('output', kind, { prompt, size: '1024x1024' })], edges: [], history: [],
    apiConfig: { mode: kind === 'video' ? 'apimart' : 'mock', model: 'mock-image', videoModel: 'test-video', imageSize: '1K', size: '1024x1024' },
    defaultApiConfig: { size: '1024x1024' },
    findApiMartVideoModel: () => ({ id: 'test-video', label: 'Video', resolutions: ['720p'], defaultResolution: '720p', minDuration: 1, maxDuration: 10, defaultDuration: 5, maxReferenceVideos: 2 }),
    normalizeLightDirection: () => ({ enabled: false }), promptWithLightDirection: value => value,
    setToast: message => { context.toast = message }, setIsGenerating() {},
    updateNodeData: (id, patch) => { context.nodes = context.nodes.map(value => value.id === id ? { ...value, data: { ...value.data, ...patch } } : value) },
    setHistory: update => { context.history = update(context.history) },
    requestGeneratedImage: async (...args) => { requests.push(args); return '/result.png' },
    requestGeneratedVideo: async (...args) => { requests.push(args); return '/result.mp4' },
  })
  return { context, requests }
}

test('Reference Size follows Image 1 through replacement and keeps exact sizes on each output version', async () => {
  const { context, requests } = generationHarness('image', '产品摄影')
  context.nodes[0].data.followReferenceSize = true
  context.apiConfig.mode = 'change2pro'
  context.apiConfig.imageSize = '2K'
  context.aspectRatioOptions = [{ value: '16:9', size: '1536x864' }, { value: '9:16', size: '864x1536' }]
  context.nodes.push(node('first', 'reference', { size: '1024x1024' }), node('second', 'reference', { imageUrl: '/other' }))
  context.edges = [edge('b', 'second', 'output', 'image-2'), edge('a', 'first', 'output', 'image-1')]
  context.readReferenceDimensions = async url => {
    assert.ok(['/portrait', '/landscape'].includes(url))
    return url === '/portrait' ? { width: 1200, height: 2132 } : { width: 2100, height: 1200 }
  }
  context.fitImageToExactSize = async (url, width, height, fit) => {
    assert.equal(fit, 'cover')
    return `${url}-${width}x${height}`
  }
  await context.generateImageInNode('output')
  assert.equal(requests.length, 0, 'empty Image 1 cannot borrow Image 2')
  for (const url of ['/portrait', '/landscape']) {
    context.nodes[1].data.imageUrl = url
    await context.generateImageInNode('output')
  }
  assert.deepEqual(requests.map(([, config]) => [config.size, config.imageSize]), [['864x1536', '2K'], ['1536x864', '2K']])
  assert.deepEqual(plain(context.history.map(v => [v.size, v.imageUrl])), [
    ['2100x1200', '/result.png-2100x1200'], ['1200x2132', '/result.png-1200x2132'],
  ])
  assert.equal(context.nodes[0].data.size, '2100x1200')
  assert.equal(context.nodes[0].data.followReferenceSize, true)
  context.readReferenceDimensions = async () => { throw new Error('解码失败') }
  await context.generateImageInNode('output')
  assert.equal(requests.length, 2)
  assert.equal(context.nodes[0].data.imageUrl, '/result.png-2100x1200')
})

test('exact-size cover centers the crop on each axis and skips resampling on an exact match', async () => {
  const image = { naturalWidth: 120, naturalHeight: 80 }
  const draws = []
  const canvas = {
    getContext: () => ({ drawImage: (_image, ...args) => draws.push(args) }),
    toDataURL: () => 'resized',
  }
  const { fitImageToExactSize } = helpers(['fitImageToExactSize'], {
    document: { createElement: () => canvas }, loadCanvasImage: async () => image,
    imageAsDataUrl: async url => url, cacheCanvasImage: async url => url,
  })
  assert.equal(await fitImageToExactSize('source', 120, 80, 'cover'), 'source')
  assert.equal(await fitImageToExactSize('source', 40, 80, 'cover'), 'resized')
  assert.equal(await fitImageToExactSize('source', 120, 40, 'cover'), 'resized')
  assert.deepEqual(draws, [[40, 0, 40, 80, 0, 0, 40, 80], [0, 20, 120, 40, 0, 0, 120, 40]])
  assert.deepEqual([canvas.width, canvas.height], [120, 40])
})

function quickWorkflowHarness() {
  const requests = [], fitViews = []
  let sequence = 0
  const context = helpers([
    'addQuickStartWorkflow', 'addWhiteModelAnimationQuickWorkflow', 'addImageToImageQuickWorkflow',
    'addVideoQuickWorkflow', ...inputHelpers, 'generateVideoInNode',
  ], {
    ...inputDependencies, whiteModelAnimationPrompt, generationProjectRef: { current: 0 },
    nodes: [node('existing', 'image', { prompt: '已有画布内容' })], edges: [], history: [],
    apiConfig: { mode: 'apimart', model: 'gpt-image-2', videoModel: 'MiniMax-H3', imageSize: '2K', size: '864x1536' },
    defaultApiConfig: { size: '1024x1024' }, defaultLightDirection: { enabled: false },
    findApiMartVideoModel: id => id === 'seedance-2.5'
      ? { id, label: 'Seedance 2.5', resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', minDuration: 4, maxDuration: 30, defaultDuration: 5, maxReferenceVideos: 10 }
      : { id: 'MiniMax-H3', label: 'MiniMax H3', resolutions: ['2K'], defaultResolution: '2K', minDuration: 4, maxDuration: 15, defaultDuration: 6, maxReferenceVideos: 0 },
    id: prefix => `${prefix}-${++sequence}`, MarkerType: { ArrowClosed: 'arrow-closed' }, workflowEdgeColor: '#fff',
    window: { innerWidth: 1280, innerHeight: 840, setTimeout: callback => callback() },
    flowInstance: { screenToFlowPosition: () => ({ x: 720, y: 460 }), fitView: settings => { fitViews.push(settings) } },
    setNodes: update => { context.nodes = update(context.nodes) },
    setEdges: update => { context.edges = update(context.edges) },
    setSelectedNodeId: id => { context.selectedNodeId = id },
    setShowQuickWorkflows: value => { context.showQuickWorkflows = value },
    setShowPromptLibrary: value => { context.showPromptLibrary = value },
    markDirty: () => { context.dirty = true },
    setToast: value => { context.toast = value }, setIsGenerating() {},
    updateNodeData: (id, patch) => { context.nodes = context.nodes.map(value => value.id === id ? { ...value, data: { ...value.data, ...patch } } : value) },
    setHistory: update => { context.history = update(context.history) },
    requestGeneratedVideo: async (...args) => { requests.push(args); return '/white-model-animation.mp4' },
  })
  return { context, requests, fitViews }
}

test('white-model animation replaces only the quick-menu image-to-image action', () => {
  const menu = source.slice(source.indexOf('<section id="quick-workflow-panel"'), source.indexOf('<div className="prompt-library-popover"'))
  assert.match(menu, /onClick=\{addWhiteModelAnimationQuickWorkflow\}/)
  assert.match(menu, /<strong>白膜动态生成<\/strong>/)
  assert.doesNotMatch(menu, /图生图|addImageToImageQuickWorkflow/)
  assert.match(source, /className="canvas-quick-start-button" type="button" onClick=\{addImageToImageQuickWorkflow\}/)
})

test('white-model animation creates two correctly wired references and pins Seedance 2.5', () => {
  const { context, fitViews, requests } = quickWorkflowHarness()
  const original = plain(context.nodes)
  context.addWhiteModelAnimationQuickWorkflow()
  assert.deepEqual(plain(context.nodes[0]), { ...original[0], selected: false })
  const created = context.nodes.slice(1)
  assert.deepEqual(plain(created.map(value => value.data.kind)), ['video-reference', 'reference', 'video'])
  const [videoRef, imageRef, output] = created
  assert.match(videoRef.data.title, /白膜.*纯运动/)
  assert.match(imageRef.data.title, /静帧.*唯一视觉外观/)
  assert.equal(imageRef.position.x, videoRef.position.x)
  assert.ok(imageRef.position.y < videoRef.position.y, 'Image is above Video to match the target input order and avoid crossing wires')
  assert.equal(videoRef.position.y - imageRef.position.y, 430)
  assert.equal(output.data.model, 'seedance-2.5', 'global MiniMax selection must not change the preset model')
  assert.equal(output.data.videoResolution, '720p')
  assert.equal(output.data.videoDuration, 5)
  assert.equal(output.data.prompt, whiteModelAnimationPrompt)
  assert.deepEqual(plain(output.data.referenceRequirements), { images: 1, videos: 1 })
  assert.equal(output.selected, true)
  assert.equal(context.selectedNodeId, output.id)
  assert.deepEqual(plain(context.edges.map(value => [value.source, value.target, value.targetHandle, value.sourceHandle])), [
    [imageRef.id, output.id, 'image-1', 'output'], [videoRef.id, output.id, 'video-1', 'output'],
  ])
  assert.deepEqual(plain(fitViews[0].nodes.map(value => value.id)), plain(created.map(value => value.id)))
  assert.equal(context.showQuickWorkflows, false)
  assert.equal(context.showPromptLibrary, false)
  assert.equal(context.dirty, true)
  assert.equal(requests.length, 0, 'creating a workflow must never start paid generation')
  const restored = plain({ nodes: context.nodes, edges: context.edges })
  assert.deepEqual(restored.nodes.at(-1).data.referenceRequirements, { images: 1, videos: 1 })
  context.addWhiteModelAnimationQuickWorkflow()
  assert.equal(new Set(context.nodes.map(value => value.id)).size, context.nodes.length)
  assert.equal(new Set(context.edges.map(value => value.id)).size, context.edges.length)
})

test('the complete preset preserves motion, appearance, consistency and limitation instructions', () => {
  assert.equal(whiteModelAnimationPrompt.split('\n').length, 5)
  for (const instruction of [
    '以我上传的白膜视频作为**纯运动参考**，以静帧参考图作为**唯一视觉外观依据**。严格区分两类素材的作用：',
    '**运动遵循白膜视频：**准确匹配镜头移动路径、运镜方向、速度变化、推拉摇移、旋转、镜头时序',
    '不继承白膜视频中的物体形状、几何轮廓、比例、模型结构、表面细节、颜色、材质、灯光及背景外观',
    '不因匹配运动而将参考图中的物体变形成白膜模型。',
    '**画面严格遵循静帧参考图：**以参考图确定主体造型、比例、结构、场景设计',
    '将参考图中的主体与场景按照白膜视频的运动逻辑进行动画化，而非将白膜模型重新贴图。',
    '参考图未展示的区域，应依据其既有结构、材质与风格合理延展，不引入白膜模型的外观特征。',
    '**全程保持时序一致性：**主体身份、形状、比例、材质与纹理稳定',
    '避免造型漂移、物体变形、纹理游移、画面闪烁、曝光跳变、无依据的物体增减与额外运镜。',
    '**参考图中的画面，按照白膜视频的镜头运动和物体运动节奏自然动起来。**',
    '注：提示词能明确参考分工，但无法保证模型完全隔离白膜几何；若生成界面支持，建议将白膜设为运动参考、静帧设为外观参考。',
  ]) assert.ok(whiteModelAnimationPrompt.includes(instruction), instruction)
})

test('white-model animation blocks missing or disconnected inputs before any generation request', async () => {
  for (const state of ['empty', 'image-only', 'video-only', 'disconnected-image', 'disconnected-video']) {
    const { context, requests } = quickWorkflowHarness()
    context.addWhiteModelAnimationQuickWorkflow()
    const [videoRef, imageRef, output] = context.nodes.slice(1)
    if (state !== 'empty' && state !== 'video-only') imageRef.data.imageUrl = '/appearance.png'
    if (state !== 'empty' && state !== 'image-only') videoRef.data.videoUrl = '/motion.mp4'
    if (state.startsWith('disconnected')) context.edges = context.edges.filter(value => value.source !== (state === 'disconnected-image' ? imageRef.id : videoRef.id))
    await context.generateVideoInNode(output.id)
    assert.equal(requests.length, 0, state)
    assert.match(context.nodes.find(value => value.id === output.id).data.error, /白膜参考视频和静帧参考图/)
    assert.equal(context.history.length, 0)
  }
})

test('white-model Run sends the stored prompt and separates image/video reference arrays', async () => {
  const { context, requests } = quickWorkflowHarness()
  context.addWhiteModelAnimationQuickWorkflow()
  const [videoRef, imageRef, output] = context.nodes.slice(1)
  videoRef.data.videoUrl = '/motion.mp4'
  videoRef.data.videoDurationSeconds = 5
  imageRef.data.imageUrl = '/appearance.png'
  await context.generateVideoInNode(output.id)
  assert.equal(requests.length, 1)
  assert.ok(requests[0][0].startsWith(whiteModelAnimationPrompt))
  assert.equal(requests[0][1].videoModel, 'seedance-2.5')
  assert.deepEqual(plain(requests[0][2]), ['/appearance.png'])
  assert.deepEqual(plain(requests[0][3]), ['/motion.mp4'])
  assert.equal(context.nodes.find(value => value.id === output.id).data.status, 'done')
  assert.equal(context.history[0].prompt, whiteModelAnimationPrompt)
  assert.equal(context.history[0].model, 'seedance-2.5')
})

test('ordinary image and video quick-start workflows retain their previous defaults', () => {
  for (const kind of ['image', 'video']) {
    const { context } = quickWorkflowHarness()
    context[kind === 'image' ? 'addImageToImageQuickWorkflow' : 'addVideoQuickWorkflow']()
    const created = context.nodes.slice(1)
    assert.deepEqual(plain(created.map(value => value.data.kind)), ['reference', kind])
    assert.equal(created[1].data.prompt, '')
    assert.equal(created[1].data.model, kind === 'image' ? 'gpt-image-2' : 'MiniMax-H3')
    assert.equal(created[1].data.referenceRequirements, undefined)
    assert.equal(context.edges.length, 1)
    assert.equal(context.edges[0].targetHandle, 'image-1')
  }
})

for (const kind of ['image', 'video']) {
  test(`${kind} reruns preserve an unarchived output, separate browsing from output, and survive a failed run`, async () => {
    const { context } = generationHarness(kind, '第一轮')
    const field = kind === 'image' ? 'imageUrl' : 'videoUrl'
    const generate = context[kind === 'image' ? 'generateImageInNode' : 'generateVideoInNode']
    const request = kind === 'image' ? 'requestGeneratedImage' : 'requestGeneratedVideo'
    context.nodes[0].data[field] = '/original'
    context.nodes[0].data.status = 'done'
    await generate('output')
    const versions = choice => nodeResultVersions(context.nodes[0], indexResultVersions(context.history), choice)
    assert.equal(versions().items.length, 2)
    assert.equal(versions().outputIndex, 1)
    const choice = { index: 0, count: 2 }
    assert.equal(versions(choice).items[versions(choice).viewedIndex].url, '/original')
    assert.notEqual(context.nodes[0].data[field], '/original')
    context.versionsByNode.set('output', versions(choice))
    context.useVersionAsOutput('output')
    assert.equal(versions().outputIndex, 0)
    context[request] = async () => { throw new Error('任务失败') }
    await generate('output')
    assert.equal(versions().items.length, 2)
    assert.equal(context.nodes[0].data[field], '/original')
    context[request] = async () => '/third'
    await generate('output')
    assert.equal(versions(choice).items.length, 3)
    assert.equal(versions(choice).viewedIndex, 2)
    assert.equal(context.nodes[0].data[field], '/third')
    if (kind === 'video') assert.equal(context.history[0].videoDurationSeconds, 5)
  })
  test(`${kind} downstream requests use the committed version until the user promotes the one being viewed`, async () => {
    const { context, requests } = generationHarness(kind, '下游素材')
    const field = kind === 'image' ? 'imageUrl' : 'videoUrl'
    const previous = { id: 'source', mediaType: kind, status: '成功', [field]: '/version-one' }
    const source = node('source', kind, { [field]: '/version-two', status: 'done' })
    context.nodes.push(source)
    context.history = [{ ...previous, [field]: '/version-two' }, previous]
    context.edges.push(edge('link', 'source', 'output', kind + '-1'))
    context.versionsByNode.set(source.id, nodeResultVersions(source, indexResultVersions(context.history), { index: 0, count: 2 }))
    const generate = kind === 'image' ? context.generateImageInNode : context.generateVideoInNode
    const references = kind === 'image' ? 2 : 3
    await generate('output')
    assert.deepEqual(plain(requests[0][references]), ['/version-two'])
    context.useVersionAsOutput(source.id)
    await generate('output')
    assert.deepEqual(plain(requests[1][references]), ['/version-one'])
    assert.equal(context.nodes.find(item => item.id === source.id).data.outputVersion, 1)
  })
  test(`a pending ${kind} run cannot add a result to a newly opened project with the same node ID`, async () => {
    const { context } = generationHarness(kind, '先前项目')
    let finish
    context[kind === 'image' ? 'requestGeneratedImage' : 'requestGeneratedVideo'] = () => new Promise(resolve => { finish = resolve })
    const pending = (kind === 'image' ? context.generateImageInNode : context.generateVideoInNode)('output')
    context.generationProjectRef.current++
    context.nodes = [node('output', kind, { prompt: '新项目' })]
    finish('/old-project-result')
    await pending
    assert.equal(context.history.length, 0)
    assert.equal(context.nodes[0].data.status, 'idle')
  })
  test(`${kind} generation reads its attached prompt without any prompt edge`, async () => {
    const { context, requests } = generationHarness(kind, '生成一片森林')
    await context[kind === 'image' ? 'generateImageInNode' : 'generateVideoInNode']('output')
    assert.equal(requests.length, 1)
    assert.equal(requests[0][0], '生成一片森林')
    assert.equal(context.nodes[0].data.status, 'done')
    assert.equal(context.history[0].prompt, '生成一片森林')
  })
  test(`${kind} with empty or disconnected references makes no API call`, async () => {
    const { context, requests } = generationHarness(kind, '')
    const generate = context[kind === 'image' ? 'generateImageInNode' : 'generateVideoInNode']
    await generate('output')
    assert.equal(requests.length, 0)
    context.nodes[0].data.prompt = '处理 @Image1'
    context.nodes[0].data.promptMentions = [{ token: '@Image1', nodeId: 'removed-ref', kind: 'image', label: 'missing' }]
    await generate('output')
    assert.equal(requests.length, 0)
    assert.equal(context.nodes[0].data.status, 'error')
    assert.match(context.nodes[0].data.error, /未连接/)
  })
}

test('version numbers survive duplicate media and exclude other nodes, failures and unavailable media', () => {
  const output = node('a', 'image', { imageUrl: '/same', status: 'done', outputVersion: 1 })
  const record = { id: 'a', imageUrl: '/same', status: '成功', createdAt: 'same time' }
  const history = [{ ...record, prompt: 'second' }, { ...record, id: 'b' }, { ...record, imageUrl: undefined },
    { ...record, status: '失败' }, { ...record, prompt: 'first' }]
  assert.equal(includeCurrentResults(history, [output]), history)
  const versions = nodeResultVersions(output, indexResultVersions(history))
  assert.deepEqual(plain(versions.items.map(item => item.prompt)), ['first', 'second'])
  assert.equal(versions.viewedIndex, 0)
  delete output.data.outputVersion
  assert.equal(nodeResultVersions(output, indexResultVersions(history)).outputIndex, 1)
})

test('a version row copies its own image or video and metadata to the right of a grouped source', () => {
  const copies = []
  const context = helpers(['copyVersionToCanvas', 'getAbsoluteNodePosition', 'getWorkflowNodeSize', 'numericNodeDimension'], {
    ...mediaModule.exports, versionsByNode: new Map(),
    pasteNodeResults: (payload, position, anchor) => copies.push({ data: payload.items[0].data, position, anchor }),
  })
  for (const kind of ['image', 'video']) {
    const field = kind === 'video' ? 'videoUrl' : 'imageUrl'
    const parent = { ...node('group', 'group'), position: { x: 900, y: 200 } }
    const source = { ...node('source', kind, { [field]: '/latest', title: '山景', status: 'done', prompt: '新提示词', videoDuration: 9 }),
      parentId: parent.id, measured: { width: 345, height: 290 } }
    const old = { id: source.id, status: '成功', mediaType: kind, [field]: '/first', size: '720x480', prompt: '旧提示词', model: '旧模型', videoDurationSeconds: 2 }
    const versions = nodeResultVersions(source, indexResultVersions([{ ...old, [field]: '/latest' }, old]))
    context.nodes = [parent, source]
    context.versionsByNode.set(source.id, versions)
    context.copyVersionToCanvas(source.id, 0)
    const copy = copies.at(-1)
    assert.equal(copy.data.kind, kind === 'video' ? 'video-reference' : 'reference')
    assert.equal(copy.data[field], '/first')
    assert.equal(copy.data.prompt, '旧提示词')
    assert.equal(copy.data.model, '旧模型')
    assert.equal(copy.data.size, '720x480')
    assert.equal(copy.data.sourceName, '版本 1 · 山景')
    if (kind === 'video') assert.equal(copy.data.videoDurationSeconds, 2)
    assert.equal(copy.anchor, source.id)
    assert.deepEqual(plain(copy.position), { x: 1331, y: 220 })
    assert.equal(versions.viewedIndex, 1)
    assert.equal(source.data[field], '/latest')
  }
})

test('copying versions skips occupied right-hand slots and keeps the first free space on the source row', () => {
  const context = helpers(['findFreeWorkflowNodePosition', 'getAbsoluteNodePosition', 'getWorkflowNodeSize', 'numericNodeDimension'], {})
  const preferred = { x: 400, y: 120 }
  const size = { width: 312, height: 510 }
  const obstacle = (id, x, y) => ({ ...node(id, 'reference'), position: { x, y }, measured: { width: 312, height: 300 } })
  const occupied = Array.from({ length: 8 }, (_, i) => obstacle(String(i), 400 + 350 * i, 280)).reverse()
  occupied.push(obstacle('upper', 4000, -300), obstacle('separate', 8000, 120))
  assert.deepEqual(plain(context.findFreeWorkflowNodePosition(preferred, size, occupied, 'right')), { x: 3200, y: 120 })
  assert.deepEqual(plain(context.findFreeWorkflowNodePosition(preferred, size, [obstacle('above', 400, -300)], 'right')), preferred)
})

test('new image results clear a widescreen source and reserve their own full width', () => {
  const { findImageResultPosition } = helpers([
    'findImageResultPosition', 'findFreeWorkflowNodePosition', 'getAbsoluteNodePosition',
    'getWorkflowNodeSize', 'numericNodeDimension', 'generationCardWidth', 'parseImageSize',
  ])
  const source = node('wide', 'image', { size: '1920x1080' })
  const blocker = { ...node('ref', 'reference'), position: { x: 940, y: 20 }, measured: { width: 312, height: 300 } }
  const start = { x: 539, y: 20 }
  const wide = { width: 1920, height: 1080 }
  assert.deepEqual(plain(findImageResultPosition(source, [source], wide, 240)), start)
  assert.deepEqual(plain(findImageResultPosition(source, [source, blocker], { width: 1024, height: 1024 }, 240)), start)
  assert.notDeepEqual(plain(findImageResultPosition(source, [source, blocker], wide, 240)), start)
})

test('importing during a rerun restores the last usable media and leaves an edited outpaint region clear', () => {
  const context = helpers(['normalizeImportedProject', 'cleanNode', 'cleanEdge'], {
    migrateLegacyPromptNodes, normalizeImageInputEdges: edges => edges,
  })
  const history = ['saved', 'draft'].map(id => ({ id, imageUrl: '/archived', status: '成功' }))
  const restored = context.normalizeImportedProject({
    nodes: [node('saved', 'image', { status: 'generating', generationPanelOpen: true, resultCopied: true }), node('draft', 'outpaint'), node('empty', 'video', { status: 'generating' })],
    edges: [], history,
  })
  assert.equal(restored.nodes[0].data.imageUrl, '/archived')
  assert.equal(restored.nodes[0].data.status, 'done')
  assert.equal(restored.nodes[0].data.generationPanelOpen, undefined)
  assert.equal(restored.nodes[0].data.resultCopied, undefined)
  assert.equal(restored.nodes[1].data.imageUrl, undefined)
  assert.equal(restored.nodes[2].data.status, 'idle')
})

test('image and video show all generation controls in the active floating panel only', async () => {
  const React = await import('react')
  const icons = await import('lucide-react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const selectModule = vm.createContext({ require, exports: {} })
  vm.runInContext(compile(readFileSync(new URL('../src/GenerationSelect.tsx', import.meta.url), 'utf8')), selectModule)
  const model = { id: 'test', label: 'test', resolutions: ['1K'], defaultResolution: '1K', minDuration: 1, maxDuration: 10, defaultDuration: 5, maxReferenceVideos: 1 }
  const aspectRatio = { value: '1:1', label: '1:1', size: '1024x1024', cssRatio: '1 / 1' }
  const context = helpers(['WorkflowCard', 'promptContainsMentionToken', 'activePromptMentions', 'parseImageSize', 'generationCardWidth'], {
    ...React, ...icons, ImageIcon: icons.Image, mediaDataForCopy: mediaModule.exports.mediaDataForCopy,
    ...inputDependencies,
    useUpdateNodeInternals: () => () => {},
    // React Flow supplies this context in the browser; render inert handles for the card test.
    Handle: ({ id, type }) => React.createElement('span', { 'data-handle': id, 'data-type': type }),
    UnifiedRange: ({ value, 'aria-label': label }) => React.createElement('input', { type: 'range', value, 'aria-label': label, readOnly: true }),
    GenerationSelect: selectModule.exports.default,
    Position: { Left: 'left', Right: 'right' },
    getAspectRatioOption: () => aspectRatio, aspectRatioOptions: [aspectRatio],
    defaultApiConfig: { size: '1024x1024' },
    defaultOutpaintInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    findApiMartModel: () => model, findApiMartVideoModel: () => model,
    apiMartModels: [model], apiMartVideoModels: [model], apiModelDisplayName: () => 'Test Model',
  })
  for (const kind of ['image', 'video']) {
    const props = {
      id: kind, selected: true,
      data: { kind, title: kind, status: 'idle', apiMode: 'mock', prompt: '当前节点的提示词' },
    }
    const hidden = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, selected: false }))
    assert.doesNotMatch(hidden, /<textarea|generation-panel|运行生成|运行视频生成|图像生成模型|视频生成模型/)
    for (const [size, width] of [['1536x864', 429], ['1920x1080', 429], ['854x480', 429], ['864x1536', 330], ['1024x1024', 330], ['2560x1080', 330]]) {
      const frame = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, selected: false, data: { ...props.data, size } }))
      assert.match(frame, new RegExp(`class="workflow-node [^"]*" style="width:${width}px"`), `${kind} frame for ${size}`)
    }
    const html = renderToStaticMarkup(React.createElement(context.WorkflowCard, props))
    assert.equal((html.match(/<textarea/g) || []).length, 1)
    assert.match(html, /floating-prompt-control.*nodrag nopan nowheel/)
    assert.match(html, new RegExp(`aria-label="${kind === 'image' ? '图像' : '视频'}生成提示词"`))
    assert.ok(html.indexOf('floating-prompt-control') > html.indexOf('data-handle="output"'))
    assert.match(html, /data-handle="image-1"/)
    assert.doesNotMatch(html, /data-handle="prompt"|Prompt 输入|Prompt 输出/)
    assert.match(html, /当前节点的提示词/)
    const panelStart = html.indexOf('<section class="generation-panel')
    const card = html.slice(0, panelStart)
    const panel = html.slice(panelStart)
    assert.doesNotMatch(card, /<select|<textarea|node-model-picker|node-run-button|aspect-ratio-control/)
    assert.match(panel, new RegExp(`aria-label="${kind === 'image' ? '图像' : '视频'}生成模型"`))
    assert.match(panel, /画面比例/)
    assert.match(panel, /清晰度/)
    assert.equal((panel.match(/role="combobox"/g) || []).length, 3)
    assert.match(panel, /generation-submit/)
    assert.match(panel, /generation-submit-run/)
    assert.match(panel, />Run<\/button>/)
    assert.doesNotMatch(panel, />生成视频<\/button>/)
    if (kind === 'image') {
      assert.match(panel, /image-generation-toolbar/)
    }
    if (kind === 'video') assert.match(panel, /视频生成时长/)
    const resultData = { ...props.data, status: 'done', [kind === 'video' ? 'videoUrl' : 'imageUrl']: kind === 'video' ? '/output.mp4' : '/output.png' }
    const result = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, selected: false, data: resultData }))
    const actions = result.match(/<div class="node-actions">([\s\S]*?)<\/div>/)?.[1] || ''
    assert.match(actions, new RegExp(`aria-label="放大查看${kind === 'video' ? '视频' : '图片'}"`))
    assert.doesNotMatch(html, /放大查看/)
    const busyHtml = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, data: { ...resultData, status: 'generating' } }))
    assert.doesNotMatch(busyHtml, /放大查看/)
    assert.equal((busyHtml.match(/<button[^>]*role="combobox"[^>]*disabled=""/g) || []).length, 3)
    const busyButton = busyHtml.match(/<button class="generation-submit generation-submit-run"[^>]*>[\s\S]*?<\/button>/)?.[0]
    assert.ok(busyButton, 'generating keeps the same square Run button')
    assert.match(busyButton, /disabled=""/)
    assert.match(busyButton, /aria-label="正在生成"/)
    assert.match(busyButton, /export-spinner/)
    assert.doesNotMatch(busyButton, />生成中…|>Run<\/button>/)
    const inactiveSelection = renderToStaticMarkup(React.createElement(context.WorkflowCard, { ...props, data: { ...props.data, generationPanelOpen: false } }))
    assert.doesNotMatch(inactiveSelection, /generation-panel|<textarea/)
  }
})

test('multi-angle generation uses the model selected in the editor', async () => {
  let sequence = 0
  const executions = []
  const context = helpers(['submitMultiAngle'], {
    multiAngleSession: { nodeId: 'source', sourceImageUrl: '/source.png' },
    nodes: [node('source', 'reference', { imageUrl: '/source.png', title: 'Source' })],
    edges: [],
    apiConfig: { mode: 'apimart', model: 'model-a', imageSize: '1K' },
    imageGenerationModelOptions: [
      { id: 'model-a', label: 'Model A' },
      { id: 'model-b', label: 'Model B' },
    ],
    findApiMartModel: id => ({ id, resolutions: ['2K'], defaultResolution: '2K' }),
    findImageResultPosition: node => node.position,
    id: prefix => `${prefix}-${++sequence}`,
    defaultLightDirection: { x: 0, y: 0, enabled: false },
    MarkerType: { ArrowClosed: 'arrow-closed' },
    workflowEdgeColor: '#fff',
    imageInputHandlePrefix: 'image-',
    normalizeImageInputEdges: values => values,
    setNodes: update => { context.nodes = update(context.nodes) },
    setEdges: update => { context.edges = update(context.edges) },
    setSelectedNodeId: value => { context.selectedNodeId = value },
    setMultiAngleSession: value => { context.multiAngleSession = value },
    markDirty: () => { context.dirty = true },
    setToast: value => { context.toast = value },
    window: { setTimeout: callback => callback() },
    flowInstance: null,
    executeMultiAngleGeneration: (...args) => { executions.push(args) },
  })
  const result = {
    presetId: 'custom', presetLabel: '自定义', horizontal: 0, vertical: 0,
    framing: 'medium', lens: 'standard', roll: 0,
    modelId: 'model-b', modelLabel: 'Model B', prompt: 'new angle',
    sourceWidth: 1200, sourceHeight: 800,
  }

  await context.submitMultiAngle(result)

  const output = context.nodes.find(value => value.id.startsWith('multi-angle-result-'))
  assert.equal(output.data.model, 'model-b')
  assert.equal(output.data.imageSize, '2K')
  assert.equal(context.edges[0].source, 'source')
  assert.equal(context.edges[0].target, output.id)
  assert.equal(executions[0][0], output)
  assert.equal(executions[0][2], result)
  assert.match(context.toast, /Model B/)
})
