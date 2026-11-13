import { KeyRound } from 'lucide-react'
import { falConfigLabel } from './falConfig'
import { useFalConfig } from './useFalConfig'
import './FalSettings.css'

export default function FalServiceStatus({ onOpenSettings }: { onOpenSettings: () => void }) {
  const config = useFalConfig()
  return <div className="fal-service-status" aria-label="fal 服务配置">
    <div><KeyRound size={14} /><strong>fal 专项服务</strong><span role="status">{falConfigLabel(config)}</span></div>
    {config.authError && <p>{config.authError}</p>}
    <button type="button" onClick={onOpenSettings}>前往 API 设置</button>
  </div>
}
