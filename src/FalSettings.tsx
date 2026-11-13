import { useEffect, useState } from 'react'
import { Eye, EyeOff, Layers, ScanSearch } from 'lucide-react'
import { falConfigLabel, loadFalServerConfig, saveFalApiKey } from './falConfig'
import { useFalConfig } from './useFalConfig'
import './FalSettings.css'

export default function FalSettings({ onSaved }: { onSaved: () => void }) {
  const config = useFalConfig()
  const [draft, setDraft] = useState(config.apiKey)
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { void loadFalServerConfig(true) }, [])
  return <form onSubmit={event => { event.preventDefault(); try { saveFalApiKey(draft); onSaved() } catch (reason) { setError((reason as Error).message) } }}>
    <div className="fal-settings-content">
      <div className="fal-settings-intro"><div><strong>fal 专项服务</strong><p>填写一次，图层拆分、PSD 补全和高清修复统一使用。</p></div><span role="status">{falConfigLabel(config)}</span></div>
      <label className="field"><span>fal API Key</span><div className="fal-key-input"><input aria-label="fal API Key" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={config.serverConfigured ? '服务器已配置，可留空' : '粘贴完整的 fal API Key'} value={draft} onChange={event => { setDraft(event.target.value); setError(''); setNotice('') }} /><button type="button" aria-label={visible ? '隐藏 fal API Key' : '显示 fal API Key'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
      <div className="fal-key-links"><a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">获取 fal API Key ↗</a><button type="button" onClick={() => { saveFalApiKey(''); setDraft(''); setError(''); setNotice(config.serverConfigured ? '浏览器密钥已清除，当前使用服务器配置。' : '浏览器密钥已清除。') }}>清除浏览器密钥</button></div>
      <div className="fal-service-cards"><div><Layers size={19} /><strong>图层拆分 / PSD</strong><p>千问分层 · SAM 3 识别 · GPT 补全</p></div><div><ScanSearch size={19} /><strong>高清修复</strong><p>Topaz 保真放大 · 文字与插画修复</p></div></div>
      {config.serverConfigured && <p className="fal-settings-note">服务器已配置 fal 服务；填写浏览器密钥后优先使用该密钥。</p>}
      {config.serverError && <p className="fal-settings-note">暂时无法读取服务器配置。<button type="button" disabled={config.loading} onClick={() => void loadFalServerConfig(true)}>重新读取</button></p>}
      {(error || config.authError) && <p className="fal-settings-error" role="alert">{error || config.authError}</p>}
      {notice && <p className="fal-settings-note" role="status">{notice}</p>}
    </div>
    <div className="modal-foot"><p>密钥仅保留在当前浏览器会话，不写入画布项目。已填写不代表认证成功，实际调用按 fal 账户计费。</p><button type="submit">保存并返回</button></div>
  </form>
}
