import { getFalConfig, reportFalAuthError } from './falConfig.ts'

export async function falRequest<T>(path: string, values: object, timeout: number, fallbackError: string, signal?: AbortSignal): Promise<T> {
  const config = getFalConfig()
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...values, apiKey: config.apiKey || undefined }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) {
    reportFalAuthError(response.status, config.revision)
    const authError = response.status === 401 ? 'fal 身份验证失败，请到顶部 API 设置 → fal 专项服务填写有效密钥。' : response.status === 403 ? 'fal 拒绝访问，请到顶部 API 设置 → fal 专项服务检查调用权限。' : ''
    throw new Error(authError || data?.error || `${fallbackError}（${response.status}）`)
  }
  return data as T
}
