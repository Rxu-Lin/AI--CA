import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'

// fal's queue endpoint is deliberately fixed: the browser never forwards its key to arbitrary URLs.
const endpoint = 'https://queue.fal.run/fal-ai/qwen-image-layered'
const precisionEndpoints = {
  sam3: 'fal-ai/sam-3/image',
  'gpt-image-2.5-flare': 'openai/gpt-image-2.5/flare/edit',
  'gpt-image-2.5-sunburst': 'openai/gpt-image-2.5/sunburst/edit',
} as const
type PrecisionModel = keyof typeof precisionEndpoints
const maxImageBytes = 25 * 1024 * 1024
const assetSession = '00000000-0000-4000-8000-000000000000'
type Dependencies = {
  readBody: (req: IncomingMessage) => Promise<string>
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  fetchUpstream: (url: string, init?: RequestInit) => Promise<Response>
  loadImageBuffer: (url: string) => Promise<{ buffer: Buffer; mediaType: string }>
  consumeGenerationQuota: (req: IncomingMessage) => boolean
  cacheDir?: string
}
type Json = Record<string, unknown>

export class LayerSplitError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode }
}
function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LayerSplitError('分层接口返回了无效数据。', 502)
  return value as Json
}
function requestId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,160}$/.test(value)) throw new LayerSplitError('分层任务编号无效。')
  return value
}
function providerKey(value: unknown) {
  const key = (typeof value === 'string' ? value : process.env.FAL_KEY || '').trim()
  if (!key) throw new LayerSplitError('请先填写 fal API Key，或在服务器设置 FAL_KEY。API Mart 密钥不适用于图层拆分。', 401)
  if (key.length > 512 || /[\r\n]/.test(key)) throw new LayerSplitError('fal API Key 格式不正确。')
  return key
}
function safeError(value: unknown, key: string) {
  const message = typeof value === 'string' ? value : '分层接口请求失败，请检查密钥、账户额度或稍后重试。'
  return message.split(key).join('[redacted]').slice(0, 500)
}
async function boundedBytes(response: Response) {
  if (!response.ok) throw new LayerSplitError(`下载分层图像失败（${response.status}），可继续获取结果。`, 502)
  if (Number(response.headers.get('content-length')) > maxImageBytes) throw new LayerSplitError('单个图层超过 25 MB。', 502)
  const reader = response.body?.getReader()
  if (!reader) throw new LayerSplitError('图层文件为空。', 502)
  const parts: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maxImageBytes) throw new LayerSplitError('单个图层超过 25 MB。', 502)
      parts.push(value)
    }
  } catch (error) { await reader.cancel(); throw error }
  return Buffer.concat(parts, length)
}
export function pngDimensions(buffer: Buffer) {
  if (buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.subarray(12, 16).toString() !== 'IHDR') {
    throw new LayerSplitError('分层接口未返回 PNG 图层。', 502)
  }
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  if (!width || !height || width * height > 16_777_216) throw new LayerSplitError('图层像素尺寸无效或超过 1600 万像素。', 502)
  return { width, height }
}

export function createLayerSplitService(deps: Dependencies) {
  function modelName(value: unknown): PrecisionModel | undefined {
    if (value === undefined || value === 'qwen') return undefined
    if (typeof value !== 'string' || !Object.hasOwn(precisionEndpoints, value)) throw new LayerSplitError('不支持的分层模型。')
    return value as PrecisionModel
  }
  async function queue(operation: string, key: string, body?: unknown, model?: PrecisionModel) {
    const modelPath = model ? precisionEndpoints[model] : ''
    // Queue tracking uses owner/app, without /image or /flare/edit (fal Queue API).
    const base = model ? `https://queue.fal.run/${operation ? modelPath.split('/').slice(0, 2).join('/') : modelPath}` : endpoint
    const response = await deps.fetchUpstream(`${base}${operation}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    const data = await response.json().catch(() => ({})) as Json
    if (!response.ok) throw new LayerSplitError(safeError(data.detail || data.error, key), response.status)
    if (data.error) throw new LayerSplitError(safeError(data.error, key), 502)
    return record(data)
  }
  async function inputPng(value: unknown, label: string) {
    if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) throw new LayerSplitError(`${label}必须为 PNG 图片。`)
    if (value.length > Math.ceil(maxImageBytes * 4 / 3) + 50) throw new LayerSplitError(`${label}不能超过 25 MB。`, 413)
    const image = await deps.loadImageBuffer(value)
    return { url: value, ...pngDimensions(image.buffer) }
  }
  async function segmentSubmit(body: Json) {
    const key = providerKey(body.apiKey)
    const image = await inputPng(body.imageUrl, '原图')
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : ''
    const points = body.points === undefined ? [] : body.points
    if (!Array.isArray(points) || points.length > 32) throw new LayerSplitError('最多添加 32 个标记。')
    const pointPrompts = points.map(item => {
      const p = record(item)
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || Number(p.x) < 0 || Number(p.x) >= image.width || Number(p.y) < 0 || Number(p.y) >= image.height || ![0, 1].includes(Number(p.label)) || typeof p.label !== 'number') throw new LayerSplitError('标记坐标无效。')
      return { x: p.x, y: p.y, label: p.label, object_id: 0 }
    })
    let boxPrompts: Json[] = []
    if (body.box) {
      const box = record(body.box)
      if (!['x', 'y', 'width', 'height'].every(field => Number.isInteger(box[field])) || Number(box.x) < 0 || Number(box.y) < 0 || Number(box.width) < 2 || Number(box.height) < 2 || Number(box.x) + Number(box.width) > image.width || Number(box.y) + Number(box.height) > image.height) throw new LayerSplitError('框选范围无效。')
      boxPrompts = [{ x_min: box.x, y_min: box.y, x_max: Number(box.x) + Number(box.width), y_max: Number(box.y) + Number(box.height), object_id: 0 }]
    }
    if (!prompt && !pointPrompts.some(p => p.label === 1) && !boxPrompts.length) throw new LayerSplitError('请描述元素，或添加包含标记 / 框选。')
    const result = await queue('', key, {
      image_url: image.url, prompt, point_prompts: pointPrompts, box_prompts: boxPrompts,
      apply_mask: false, return_multiple_masks: false, max_masks: 1, output_format: 'png',
    }, 'sam3')
    return { requestId: requestId(result.request_id), model: 'sam3' }
  }
  async function editSubmit(body: Json) {
    const key = providerKey(body.apiKey)
    const model = modelName(body.model)
    if (!model || model === 'sam3') throw new LayerSplitError('请选择 GPT 补全模型。')
    if (body.task !== 'background' && body.task !== 'layer') throw new LayerSplitError('补全任务类型无效。')
    const image = await inputPng(body.imageUrl, '编辑图像')
    const mask = await inputPng(body.maskUrl, '选区')
    if (image.width !== mask.width || image.height !== mask.height) throw new LayerSplitError('选区与原图尺寸必须一致。')
    const instruction = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : ''
    const prompt = body.task === 'background'
      ? 'Remove the foreground objects inside the white mask and reconstruct the background that was occluded by them. Continue the existing scene, perspective, lighting, texture and shadows naturally. Do not reproduce the removed objects. Preserve all unmasked image content and exact framing. '
      : 'Complete or repair only the selected part of this isolated image layer, following its existing structure, perspective, material, lighting and style. Keep all unmasked content and exact framing. Maintain transparency outside the object; do not invent a background or a checkerboard pattern. '
    const result = await queue('', key, {
      image_urls: [image.url], mask_url: mask.url, prompt: prompt + instruction,
      image_size: 'auto', background: body.task === 'background' ? 'opaque' : 'transparent',
      output_format: 'png', quality: 'high', num_images: 1, enable_safety_checker: true,
    }, model)
    return { requestId: requestId(result.request_id), model }
  }
  async function submit(body: Json) {
    const key = providerKey(body.apiKey)
    if (!Number.isInteger(body.numLayers) || Number(body.numLayers) < 2 || Number(body.numLayers) > 8) throw new LayerSplitError('请选择 2–8 个图层。')
    // The client supplies a normalized PNG. No arbitrary local/remote URLs are fetched at submission.
    if (typeof body.imageUrl !== 'string' || !body.imageUrl.startsWith('data:image/png;base64,')) throw new LayerSplitError('请重新打开原图后再拆分。')
    if (body.imageUrl.length > Math.ceil(maxImageBytes * 4 / 3) + 50) throw new LayerSplitError('原图不能超过 25 MB。', 413)
    const image = await deps.loadImageBuffer(body.imageUrl)
    pngDimensions(image.buffer)
    const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 2000) : ''
    const result = await queue('', key, {
      image_url: body.imageUrl, num_layers: body.numLayers, output_format: 'png',
      enable_safety_checker: true, ...(caption ? { prompt: caption } : {}),
    })
    return { requestId: requestId(result.request_id) }
  }
  async function status(body: Json) {
    const result = await queue(`/requests/${requestId(body.requestId)}/status`, providerKey(body.apiKey), undefined, modelName(body.model))
    if (!['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(String(result.status))) throw new LayerSplitError('无法识别分层任务状态，请继续获取结果。', 502)
    return { status: result.status, queuePosition: result.queue_position }
  }
  async function result(body: Json) {
    const taskId = requestId(body.requestId)
    const model = modelName(body.model)
    const data = await queue(`/requests/${taskId}`, providerKey(body.apiKey), undefined, model)
    if (Array.isArray(data.has_nsfw_concepts) && data.has_nsfw_concepts.some(Boolean)) throw new LayerSplitError('分层结果未通过内容检查，请更换图片。', 422)
    const outputs = model === 'sam3' ? data.masks : data.images
    if (!Array.isArray(outputs) || outputs.length < (model ? 1 : 2) || outputs.length > (model ? 1 : 16)) throw new LayerSplitError(model === 'sam3' ? '没有识别到该元素，请调整描述或标记。' : model ? '补全接口没有返回有效图片。' : '分层接口没有返回至少两个有效图层。', 502)
    const images: Array<{ imageUrl: string; width: number; height: number }> = []
    const directory = deps.cacheDir || path.resolve(process.cwd(), '.project-cache', assetSession, 'images')
    await mkdir(directory, { recursive: true })
    for (const [index, item] of outputs.entries()) {
      const url = record(item).url
      if (typeof url !== 'string') throw new LayerSplitError('图层缺少下载地址。', 502)
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !(parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media'))) {
        throw new LayerSplitError('分层接口返回了不受支持的图层地址。', 502)
      }
      const response = await deps.fetchUpstream(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
      const buffer = await boundedBytes(response)
      const dimensions = pngDimensions(buffer)
      if (images[0] && (images[0].width !== dimensions.width || images[0].height !== dimensions.height)) throw new LayerSplitError('返回的图层尺寸不一致，无法对齐。', 502)
      const digest = createHash('sha256').update(model ? `${model}:${taskId}` : taskId).digest('hex').slice(0, 24)
      const filename = `layer-${digest}-${index}.png`
      await writeFile(path.join(directory, filename), buffer)
      images.push({ imageUrl: `/api/projects/assets/${assetSession}/images/${filename}`, ...dimensions })
    }
    return { images }
  }
  return { submit, status, result, segmentSubmit, editSubmit }
}

export function layerSplitPlugin(deps: Dependencies): Plugin {
  const service = createLayerSplitService(deps)
  function configure(server: Pick<ViteDevServer, 'middlewares'>) {
    server.middlewares.use('/api/layers', async (req, res, next) => {
      const route = (req.url || '').split('?')[0]
      if (route === '/config' && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store')
        deps.sendJson(res, 200, { configured: Boolean(process.env.FAL_KEY?.trim()) }); return
      }
      const operations = { '/submit': 'submit', '/status': 'status', '/result': 'result', '/segment-submit': 'segmentSubmit', '/edit-submit': 'editSubmit' } as const
      if (!Object.hasOwn(operations, route)) { next(); return }
      res.setHeader('Cache-Control', 'no-store')
      if (req.method !== 'POST') { deps.sendJson(res, 405, { error: '仅支持 POST 请求。' }); return }
      // Prevent cross-origin pages from spending a locally configured server key.
      try {
        const origin = req.headers.origin
        if (origin && new URL(origin).host !== req.headers.host) throw new LayerSplitError('请从本站打开图层拆分。', 403)
        if (route.endsWith('submit') && !deps.consumeGenerationQuota(req)) throw new LayerSplitError('请求过于频繁，请稍后重试。', 429)
        const body = record(JSON.parse(await deps.readBody(req)))
        const operation = operations[route as keyof typeof operations]
        deps.sendJson(res, 200, await service[operation](body))
      } catch (error) {
        deps.sendJson(res, error instanceof LayerSplitError ? error.statusCode : 500, {
          error: error instanceof LayerSplitError ? error.message : '分层服务连接失败，请检查网络后继续获取结果。',
        })
      }
    })
  }
  return { name: 'layer-split', configureServer: configure, configurePreviewServer: configure }
}
