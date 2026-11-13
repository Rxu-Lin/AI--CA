// Keep the legacy session key so existing layer/upscale credentials remain available.
const storageKey = 'ai-canvas-fal-layer-key'
type FalConfig = { apiKey: string; serverConfigured: boolean; loading: boolean; serverError: boolean; authError: string; revision: number }
let snapshot: FalConfig = { apiKey: '', serverConfigured: false, loading: false, serverError: false, authError: '', revision: 0 }
let initialized = false
let serverChecked = false
let configRequest: Promise<void> | undefined
const listeners = new Set<() => void>()

export function normalizeFalApiKey(value: string) { return value.trim().replace(/^(?:Authorization\s*:\s*)?Key\s+/i, '').trim() }
function publish(patch: Partial<FalConfig>) {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach(listener => listener())
}
export function getFalConfig() {
  if (!initialized) {
    initialized = true
    try { snapshot = { ...snapshot, apiKey: normalizeFalApiKey(window.sessionStorage.getItem(storageKey) || '') } } catch { /* Use memory if storage is unavailable. */ }
  }
  return snapshot
}
export function subscribeFalConfig(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function readFalApiKey() { return getFalConfig().apiKey }
export function saveFalApiKey(value: string) {
  const apiKey = normalizeFalApiKey(value)
  if (apiKey.length > 512 || /[\r\n]/.test(apiKey)) throw new Error('fal API Key 格式不正确，请粘贴完整密钥。')
  const current = getFalConfig()
  try {
    if (apiKey) window.sessionStorage.setItem(storageKey, apiKey)
    else window.sessionStorage.removeItem(storageKey)
  } catch { /* Keep the current page usable when sessionStorage is blocked. */ }
  publish({ apiKey, authError: '', revision: current.revision + 1 })
}
export function falConfigReady(config = getFalConfig()) { return Boolean(config.apiKey || config.serverConfigured) && !config.authError }
export function falConfigLabel(config = getFalConfig()) {
  return config.authError ? '认证 / 权限异常' : config.apiKey ? '已填写' : config.serverConfigured ? '服务器已配置' : config.loading ? '读取中' : '未配置'
}
export function reportFalAuthError(status: number, revision: number) {
  // A late response from an older key must not invalidate newly saved credentials.
  if (getFalConfig().revision !== revision || (status !== 401 && status !== 403)) return
  publish({ authError: status === 401 ? 'fal 身份验证失败，请到顶部 API 设置 → fal 专项服务更新密钥。' : 'fal 拒绝访问，请到顶部 API 设置 → fal 专项服务检查密钥权限和账户状态。' })
}
export function loadFalServerConfig(force = false): Promise<void> {
  if (configRequest) return configRequest
  if (serverChecked && !force) return Promise.resolve()
  getFalConfig()
  publish({ loading: true })
  // Both services use the same server FAL_KEY; reuse the existing read-only endpoint.
  configRequest = (async () => {
    try {
      const response = await fetch('/api/layers/config', { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
      if (!response.ok) throw new Error('无法读取服务器配置')
      const data = await response.json()
      if (typeof data?.configured !== 'boolean') throw new Error('服务器配置无效')
      serverChecked = true
      publish({ serverConfigured: data.configured, serverError: false })
    } catch { publish({ serverError: true }) }
    finally { publish({ loading: false }); configRequest = undefined }
  })()
  return configRequest
}
