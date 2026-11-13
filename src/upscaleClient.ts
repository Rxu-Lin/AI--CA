import { falRequest } from './falClient.ts'
import type { UpscaleImage, UpscaleJob } from './upscale.ts'

export async function upscaleRequest<T>(operation: 'submit' | 'status' | 'result', values: object, signal?: AbortSignal): Promise<T> {
  return falRequest<T>(`/api/upscale/${operation}`, values, 240_000, '高清修复请求失败，已有任务可继续获取结果', signal)
}
export async function collectUpscale(job: UpscaleJob, onProgress: (text: string) => void, signal: AbortSignal) {
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const status = await upscaleRequest<{ status: string; queuePosition?: number }>('status', { requestId: job.requestId }, signal)
    if (status.status === 'COMPLETED') {
      onProgress('正在保存高清图…')
      return upscaleRequest<UpscaleImage>('result', job, signal)
    }
    onProgress(status.status === 'IN_QUEUE' ? `排队中${typeof status.queuePosition === 'number' ? ` · 前方 ${status.queuePosition} 个任务` : ''}` : '正在高清修复…')
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 2500)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  throw new Error('等待时间较长，任务编号已保存。可继续获取原任务结果，不会重复提交。')
}
