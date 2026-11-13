import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { upscaleDimensions, upscaleMaxPixels, upscaleMaxSide, upscaleModes } from '../src/upscale.ts'

const endpoint = 'https://queue.fal.run/topaz/upscale'
const assetSession = '00000000-0000-4000-8000-000000000000'
const maxInputBytes = 25 * 1024 * 1024
const maxOutputBytes = 160 * 1024 * 1024
type Json = Record<string, unknown>
type Dependencies = {
  readBody: (req: IncomingMessage) => Promise<string>
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  fetchUpstream: (url: string, init?: RequestInit) => Promise<Response>
  consumeGenerationQuota: (req: IncomingMessage) => boolean
  cacheDir?: string
}
export class UpscaleError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode }
}
function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpscaleError('高清修复返回了无效数据。', 502)
  return value as Json
}
function taskId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,160}$/.test(value)) throw new UpscaleError('高清修复任务编号无效。')
  return value
}
function keyFor(value: unknown) {
  // Accept a copied Authorization header without sending a duplicate "Key" prefix.
  const key = (typeof value === 'string' ? value : process.env.FAL_KEY || '').trim().replace(/^(?:Authorization\s*:\s*)?Key\s+/i, '').trim()
  if (!key) throw new UpscaleError('请在顶部 API 设置 → fal 专项服务填写 fal API Key。', 401)
  if (key.length > 512 || /[\r\n]/.test(key)) throw new UpscaleError('fal API Key 格式不正确。')
  return key
}
export function upscalePngDimensions(buffer: Buffer) {
  if (buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.subarray(12, 16).toString() !== 'IHDR') throw new UpscaleError('高清修复需要有效的 PNG 图像。', 502)
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  if (!width || !height || width * height > upscaleMaxPixels || Math.max(width, height) > upscaleMaxSide) throw new UpscaleError('高清图像尺寸超过当前画布支持范围。', 502)
  return { width, height }
}

export function createUpscaleService(deps: Dependencies) {
  async function queue(operation: string, key: string, body?: object) {
    const response = await deps.fetchUpstream(`${endpoint}${operation}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    const data = record(await response.json().catch(() => ({})))
    if (!response.ok || data.error) {
      if (response.status === 401) throw new UpscaleError('fal 身份验证失败。请在顶部 API 设置 → fal 专项服务填写完整有效的密钥；API Mart 密钥不能用于高清修复。', 401)
      if (response.status === 403) throw new UpscaleError('fal 拒绝访问 Topaz。请检查该密钥的模型调用权限及所属账户状态；如使用自定义权限，需要允许调用 Topaz 模型。', 403)
      const detail = data.detail || data.error
      const message = typeof detail === 'string' ? detail : `高清修复请求失败（${response.status}），请检查密钥、账户额度或稍后继续获取。`
      throw new UpscaleError(message.split(key).join('[redacted]').slice(0, 500), response.ok ? 502 : response.status)
    }
    return data
  }
  async function submit(body: Json) {
    const key = keyFor(body.apiKey)
    const mode = upscaleModes.find(item => item.id === body.mode)
    if (!mode) throw new UpscaleError('请选择有效的修复模式。')
    if (typeof body.imageUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(body.imageUrl)) throw new UpscaleError('请重新打开原图后进行高清修复。')
    if (body.imageUrl.length > Math.ceil(maxInputBytes * 4 / 3) + 50) throw new UpscaleError('原图 PNG 不能超过 25 MB。', 413)
    const input = upscalePngDimensions(Buffer.from(body.imageUrl.split(',')[1], 'base64'))
    let output: { width: number; height: number }
    try { output = upscaleDimensions(input.width, input.height, Number(body.factor)) } catch (error) { throw new UpscaleError((error as Error).message) }
    if (body.factor !== 2 && body.factor !== 4) throw new UpscaleError('请选择 2× 或 4×。')
    const controls: Record<string, number> = {}
    for (const name of ['sharpen', 'denoise', 'strength'] as const) {
      if (body[name] === undefined) continue
      const value = body[name]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < (name === 'strength' ? 0.01 : 0) || value > 1) throw new UpscaleError('修复强度参数无效。')
      if (name !== 'strength' || mode.id === 'text') controls[name] = value
    }
    const result = await queue('/image/precision', key, {
      image_url: body.imageUrl, model: mode.model, upscale_factor: body.factor,
      output_format: 'png', crop_to_fill: false, subject_detection: 'All', face_enhancement: false,
      enable_safety_checker: true, ...controls,
    })
    return { requestId: taskId(result.request_id), width: input.width, height: input.height, outputWidth: output.width, outputHeight: output.height }
  }
  async function status(body: Json) {
    const data = await queue(`/requests/${taskId(body.requestId)}/status`, keyFor(body.apiKey))
    if (!['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(String(data.status))) throw new UpscaleError('无法识别任务状态，可继续获取原任务结果。', 502)
    return { status: data.status, queuePosition: data.queue_position }
  }
  async function result(body: Json) {
    const id = taskId(body.requestId)
    let expected: { width: number; height: number }
    try { expected = upscaleDimensions(Number(body.width), Number(body.height), Number(body.factor)) } catch (error) { throw new UpscaleError((error as Error).message) }
    const data = await queue(`/requests/${id}`, keyFor(body.apiKey))
    if (Array.isArray(data.has_nsfw_concepts) && data.has_nsfw_concepts.some(Boolean)) throw new UpscaleError('高清修复结果未通过内容检查。', 422)
    const url = record(data.image).url
    if (typeof url !== 'string') throw new UpscaleError('高清修复没有返回图像。', 502)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !(parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media'))) throw new UpscaleError('高清结果下载地址不受支持。', 502)
    const response = await deps.fetchUpstream(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) })
    if (!response.ok || !response.body) throw new UpscaleError('高清图下载失败，可继续获取原任务结果。', 502)
    if (Number(response.headers.get('content-length')) > maxOutputBytes) { await response.body.cancel(); throw new UpscaleError('高清结果超过 160 MB。', 502) }
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > maxOutputBytes) throw new UpscaleError('高清结果超过 160 MB。', 502)
        parts.push(value)
      }
    } catch (error) { await reader.cancel(); throw error }
    const buffer = Buffer.concat(parts, length)
    const actual = upscalePngDimensions(buffer)
    if (actual.width !== expected.width || actual.height !== expected.height) throw new UpscaleError(`返回尺寸为 ${actual.width} × ${actual.height}，与目标 ${expected.width} × ${expected.height} 不一致，已保留任务编号。`, 502)
    const directory = deps.cacheDir || path.resolve(process.cwd(), '.project-cache', assetSession, 'images')
    const filename = `upscale-${createHash('sha256').update(id).digest('hex').slice(0, 24)}.png`
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, filename), buffer)
    return { imageUrl: `/api/projects/assets/${assetSession}/images/${filename}`, ...actual }
  }
  return { submit, status, result }
}

export function upscalePlugin(deps: Dependencies): Plugin {
  const service = createUpscaleService(deps)
  function configure(server: Pick<ViteDevServer, 'middlewares'>) {
    server.middlewares.use('/api/upscale', async (req, res, next) => {
      const route = (req.url || '').split('?')[0]
      res.setHeader('Cache-Control', 'no-store')
      if (route === '/config' && req.method === 'GET') { deps.sendJson(res, 200, { configured: Boolean(process.env.FAL_KEY?.trim()) }); return }
      const operation = route.slice(1)
      if (operation !== 'submit' && operation !== 'status' && operation !== 'result') { next(); return }
      if (req.method !== 'POST') { deps.sendJson(res, 405, { error: '仅支持 POST 请求。' }); return }
      try {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new UpscaleError('请从本站打开高清修复。', 403)
        if (operation === 'submit' && !deps.consumeGenerationQuota(req)) throw new UpscaleError('请求过于频繁，请稍后重试。', 429)
        deps.sendJson(res, 200, await service[operation](record(JSON.parse(await deps.readBody(req)))))
      } catch (error) {
        deps.sendJson(res, error instanceof UpscaleError ? error.statusCode : 500, { error: error instanceof UpscaleError ? error.message : '高清修复连接失败。已有任务请继续获取结果；提交中断请先检查 fal 任务记录。' })
      }
    })
  }
  return { name: 'image-upscale', configureServer: configure, configurePreviewServer: configure }
}
