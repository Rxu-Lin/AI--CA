import { createLayerDocument, type LayerSplitJob, type LayerImage } from './layerDocument.ts'

const keyStorage = 'ai-canvas-fal-layer-key'
let currentKey = ''
export function readLayerApiKey() {
  try { return window.sessionStorage.getItem(keyStorage) || currentKey } catch { return currentKey }
}
export function saveLayerApiKey(key: string) {
  currentKey = key.trim()
  try {
    if (currentKey) window.sessionStorage.setItem(keyStorage, currentKey)
    else window.sessionStorage.removeItem(keyStorage)
  } catch { /* Memory still supports the current page if sessionStorage is blocked. */ }
}
export async function layerRequest<T>(operation: string, values: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/layers/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...values, apiKey: readLayerApiKey() || undefined }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.error || `分层请求失败（${response.status}）。可继续获取原任务结果。`)
  return data as T
}
export async function collectLayerSplit(job: LayerSplitJob, onProgress: (text: string) => void, signal?: AbortSignal) {
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const status = await layerRequest<{ status: string; queuePosition?: number }>('status', { requestId: job.requestId }, signal)
    if (status.status === 'COMPLETED') {
      onProgress('正在保存透明图层…')
      const result = await layerRequest<{ images: LayerImage[] }>('result', { requestId: job.requestId }, signal)
      return createLayerDocument(job, result.images)
    }
    onProgress(status.status === 'IN_QUEUE' ? `排队中${typeof status.queuePosition === 'number' ? ` · 前方 ${status.queuePosition} 个任务` : ''}` : '正在拆分图层…')
    await new Promise(resolve => window.setTimeout(resolve, 2500))
  }
  throw new Error('等待时间较长，任务编号已保留。点击“继续获取结果”即可查询，无需重新付费提交。')
}

export async function collectFineTask(job: { requestId: string; model: string }, onProgress: (text: string) => void, signal?: AbortSignal) {
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const status = await layerRequest<{ status: string; queuePosition?: number }>('status', job, signal)
    if (status.status === 'COMPLETED') {
      onProgress('正在获取结果…')
      const result = await layerRequest<{ images: LayerImage[] }>('result', job, signal)
      if (result.images.length !== 1) throw new Error('没有收到有效的选区或补全图片。')
      return result.images[0]
    }
    onProgress(status.status === 'IN_QUEUE' ? `排队中${typeof status.queuePosition === 'number' ? ` · 前方 ${status.queuePosition} 个任务` : ''}` : job.model === 'sam3' ? '正在识别元素…' : 'GPT 正在补全…')
    await new Promise<void>((resolve, reject) => {
      const abort = () => { window.clearTimeout(timer); reject(signal?.reason) }
      const timer = window.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 2500)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  throw new Error('等待时间较长，任务编号已保存。可继续获取原任务结果，不会重复提交。')
}
export async function cacheLayerImage(imageUrl: string) {
  if (!imageUrl.startsWith('data:')) return imageUrl
  const response = await fetch('/api/images/cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl }) })
  const data = await response.json()
  if (!response.ok || !data.imageUrl) throw new Error(data.error || '图层素材保存失败。')
  return data.imageUrl as string
}
