import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import './FalSettings.css'

export type ApiSettingsTab = 'generation' | 'fal'
type Props = { tab: ApiSettingsTab; onTabChange: (tab: ApiSettingsTab) => void; onClose: () => void; children: ReactNode }
export default function ApiSettingsDialog({ tab, onTabChange, onClose, children }: Props) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  return <div className="modal-backdrop api-settings-backdrop" role="presentation" onPointerDown={event => event.stopPropagation()}>
    <section className="settings-modal" ref={dialog} role="dialog" aria-modal="true" aria-label="API 设置" tabIndex={-1} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(item => item.getClientRects().length)
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <div className="modal-head"><div><h2>API 设置</h2><p>管理生图、视频和 fal 专项服务。</p></div><button type="button" aria-label="关闭 API 设置" onClick={onClose}><X size={18} /></button></div>
      <div className="api-settings-tabs" role="tablist" aria-label="API 配置分类">
        {(['generation', 'fal'] as const).map(value => <button key={value} id={`api-settings-tab-${value}`} role="tab" type="button" aria-selected={tab === value} aria-controls="api-settings-panel" tabIndex={tab === value ? 0 : -1} onClick={() => onTabChange(value)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'generation' : event.key === 'End' ? 'fal' : value === 'generation' ? 'fal' : 'generation'
          onTabChange(next)
          dialog.current?.querySelector<HTMLElement>(`#api-settings-tab-${next}`)?.focus()
        }}>{value === 'generation' ? '生图 / 视频 API' : 'fal 专项服务'}</button>)}
      </div>
      <div id="api-settings-panel" role="tabpanel" aria-labelledby={`api-settings-tab-${tab}`}>{children}</div>
    </section>
  </div>
}
