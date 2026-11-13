import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Loader2, ScanSearch, X, ZoomIn, ZoomOut } from 'lucide-react'
import GenerationSelect from './GenerationSelect'
import UnifiedRange from './UnifiedRange'
import { falConfigReady } from './falConfig'
import { useFalConfig } from './useFalConfig'
import FalServiceStatus from './FalServiceStatus'
import { upscaleCost, upscaleDimensions, upscaleModes, type UpscaleInput, type UpscaleJob, type UpscaleMode } from './upscale'
import './UpscaleStudio.css'

type Props = {
  sourceImageUrl: string
  sourceName: string
  resultImageUrl?: string
  job?: UpscaleJob
  running: boolean
  progress?: string
  error?: string
  onRun: (input: UpscaleInput) => Promise<void>
  onResume: () => void
  onClose: () => void
  onOpenApiSettings: () => void
}

export default function UpscaleStudio(props: Props) {
  const [mode, setMode] = useState<UpscaleMode>(props.job?.mode || 'fidelity')
  const [factor, setFactor] = useState<2 | 4>(props.job?.factor || 2)
  const [size, setSize] = useState({ width: props.job?.width || 0, height: props.job?.height || 0 })
  const [advanced, setAdvanced] = useState(Boolean(props.job?.sharpen !== undefined))
  const [sharpen, setSharpen] = useState(props.job?.sharpen ?? 0.3)
  const [denoise, setDenoise] = useState(props.job?.denoise ?? 0.15)
  const [strength, setStrength] = useState(props.job?.strength ?? 0.3)
  const fal = useFalConfig()
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState('')
  const [sourceLoaded, setSourceLoaded] = useState(false)
  const [resultLoadedUrl, setResultLoadedUrl] = useState('')
  const [split, setSplit] = useState(50)
  const [zoom, setZoom] = useState<number | null>(null)
  const [viewport, setViewport] = useState({ width: 600, height: 500 })
  const sourceRef = useRef<HTMLImageElement | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const busy = submitting || props.running
  const locked = Boolean(props.job) || busy
  const hasResult = Boolean(props.resultImageUrl && resultLoadedUrl === props.resultImageUrl)
  const ready = falConfigReady(fal)
  const modeInfo = upscaleModes.find(item => item.id === mode)!
  let target = { width: 0, height: 0 }, sizeError = ''
  if (size.width && size.height) {
    try { target = upscaleDimensions(size.width, size.height, factor) } catch (reason) { sizeError = (reason as Error).message }
  }
  const fit = target.width ? Math.min((viewport.width - 40) / target.width, (viewport.height - 40) / target.height, 1) : 1
  const scale = zoom ?? Math.max(0.01, fit)
  const display = { width: Math.max(1, target.width * scale), height: Math.max(1, target.height * scale) }

  useEffect(() => {
    let cancelled = false
    const image = new Image()
    setSourceLoaded(false)
    image.onload = () => {
      if (cancelled) return
      sourceRef.current = image
      setSize({ width: image.naturalWidth, height: image.naturalHeight })
      setSourceLoaded(true)
    }
    image.onerror = () => { if (!cancelled) setError('原图加载失败，请关闭后重试。') }
    image.src = props.sourceImageUrl
    return () => { cancelled = true; sourceRef.current = null }
  }, [props.sourceImageUrl])
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(entries => setViewport({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  useEffect(() => { setError('') }, [fal.revision])

  async function run() {
    if (submittingRef.current || !sourceRef.current || !ready || sizeError || locked) return
    submittingRef.current = true; setSubmitting(true); setError('')
    try {
      const canvas = document.createElement('canvas')
      canvas.width = size.width; canvas.height = size.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法读取原图。')
      context.drawImage(sourceRef.current, 0, 0)
      const imageUrl = canvas.toDataURL('image/png')
      canvas.width = 1; canvas.height = 1
      if (imageUrl.length > Math.ceil(25 * 1024 * 1024 * 4 / 3) + 50) throw new Error('原图 PNG 超过 25 MB，请使用较小的原图。')
      await props.onRun({ imageUrl, ...size, mode, factor, ...(advanced ? { sharpen, denoise, ...(mode === 'text' ? { strength } : {}) } : {}) })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '高清修复提交失败。'
      setError(message)
    }
    finally { submittingRef.current = false; setSubmitting(false) }
  }
  function compareAt(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    setSplit(Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)))
  }

  return <div className="upscale-backdrop" onPointerDown={event => event.stopPropagation()}>
    <section className="upscale-studio" ref={dialogRef} role="dialog" aria-modal="true" aria-label="高清修复" tabIndex={-1} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && !submitting) props.onClose()
      if (event.key === 'Tab') {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]')].filter(item => item.getClientRects().length)
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <header className="upscale-head"><div><ScanSearch size={20} /><strong>高清修复</strong><span>TOPAZ · PRECISION</span></div><button type="button" aria-label="关闭高清修复" disabled={submitting} onClick={props.onClose}><X size={20} /></button></header>
      <div className="upscale-body">
        <div className="upscale-preview">
          <div className="upscale-stage" ref={stageRef}>
            {sourceLoaded && target.width > 0 ? <div className="upscale-preview-space" style={{ minWidth: display.width + 40, minHeight: display.height + 40 }}>
              <div className={`upscale-compare ${hasResult ? 'ready' : ''}`} style={display}
                onPointerDown={event => { if (hasResult) { event.currentTarget.setPointerCapture(event.pointerId); compareAt(event) } }}
                onPointerMove={event => { if (hasResult && event.currentTarget.hasPointerCapture(event.pointerId)) compareAt(event) }}>
                <img src={props.sourceImageUrl} alt="修复前原图" draggable={false} />
                {props.resultImageUrl && <img src={props.resultImageUrl} alt="高清修复结果" draggable={false} style={{ clipPath: `inset(0 0 0 ${split}%)`, opacity: hasResult ? 1 : 0 }} onLoad={() => setResultLoadedUrl(props.resultImageUrl!)} onError={() => setError('高清结果预览加载失败，请重新打开查看。')} />}
                {hasResult && <><span className="upscale-compare-label before">原图</span><span className="upscale-compare-label after">修复后</span><span className="upscale-compare-line" style={{ left: `${split}%` }}><i>↔</i></span></>}
              </div>
            </div> : <div className="upscale-empty">{sizeError || (error ? '原图未能加载' : '正在读取原图…')}</div>}
          </div>
          <div className="upscale-preview-foot"><span title={props.sourceName}>{props.sourceName}</span><div><button type="button" aria-label="缩小预览" onClick={() => setZoom(Math.max(0.05, scale / 1.5))}><ZoomOut size={16} /></button><button type="button" onClick={() => setZoom(null)} title="适应窗口">适应</button><button type="button" onClick={() => setZoom(1)} title="以输出像素 100% 检查细节">{Math.round(scale * 100)}%</button><button type="button" aria-label="放大预览" onClick={() => setZoom(Math.min(4, scale * 1.5))}><ZoomIn size={16} /></button></div></div>
          {hasResult && <label className="upscale-compare-control"><span>原图</span><UnifiedRange aria-label="修复前后对比" min={0} max={100} value={split} onValueChange={setSplit} /><span>修复后</span></label>}
        </div>
        <aside className="upscale-settings">
          <div className="upscale-field"><label>修复模式</label><GenerationSelect label="高清修复模式" menuLabel="高清修复模式选项" value={mode} options={upscaleModes.map(item => ({ value: item.id, label: item.label }))} disabled={locked} onChange={value => setMode(value as UpscaleMode)} onOpen={() => {}} /><p>{modeInfo.description}</p></div>
          <div className="upscale-field"><label>放大倍数</label><div className="upscale-factors">{([2, 4] as const).map(value => <button key={value} type="button" aria-pressed={factor === value} disabled={locked} onClick={() => { setFactor(value); setZoom(null) }}>{value}×</button>)}</div></div>
          <div className="upscale-size-card"><div><span>原图尺寸</span><b>{size.width ? `${size.width} × ${size.height}` : '读取中'}</b></div><div><span>输出尺寸</span><b>{target.width ? `${target.width} × ${target.height}` : '—'}</b></div><div><span>预计费用</span><b>{target.width ? `$${upscaleCost(target.width, target.height).toFixed(2)}` : '—'}</b></div><small>保持比例 · PNG · 费用以 fal 实际计费为准</small></div>
          <div className="upscale-advanced"><label><input type="checkbox" checked={advanced} disabled={locked} onChange={event => setAdvanced(event.target.checked)} />手动调整强度</label>{advanced ? <>
            <label>锐化<output>{Math.round(sharpen * 100)}%</output><UnifiedRange aria-label="高清锐化强度" min={0} max={1} step={0.01} value={sharpen} onValueChange={setSharpen} disabled={locked} /></label>
            <label>降噪<output>{Math.round(denoise * 100)}%</output><UnifiedRange aria-label="高清降噪强度" min={0} max={1} step={0.01} value={denoise} onValueChange={setDenoise} disabled={locked} /></label>
            {mode === 'text' && <label>文字增强<output>{Math.round(strength * 100)}%</output><UnifiedRange aria-label="文字增强强度" min={0.01} max={1} step={0.01} value={strength} onValueChange={setStrength} disabled={locked} /></label>}
          </> : <p>使用模型默认参数；保真模式关闭人脸重建。</p>}</div>
          <FalServiceStatus onOpenSettings={props.onOpenApiSettings} />
        </aside>
      </div>
      <footer className="upscale-foot"><div aria-live="polite">{error || props.error || sizeError ? <p role="alert" className="upscale-error">{error || props.error || sizeError}</p> : <p>{busy ? props.progress || '正在提交高清修复…' : hasResult ? '修复完成 · 拖动分隔线对比，点击 100% 检查细节' : props.resultImageUrl ? '修复完成，正在加载高清预览…' : props.job ? '任务已保留，可以继续获取结果' : '生成新图并自动连接到画布，保留原图'}</p>}<small>{props.job ? `任务 ${props.job.requestId}` : 'Topaz 保真超分 · 无需填写提示词'}</small></div>
        {props.job ? props.resultImageUrl ? <button type="button" className="upscale-return" onClick={props.onClose}>返回画布</button> : <button type="button" className="upscale-return" disabled={busy || !ready} onClick={() => { setError(''); props.onResume() }}>{busy && <Loader2 size={16} className="spin" />}{busy ? '处理中' : '继续获取结果'}</button> : <button type="button" className="upscale-run" aria-label="运行高清修复" title={!ready ? '请先配置 fal API Key' : '生成高清图'} disabled={busy || !ready || !sourceLoaded || Boolean(sizeError)} onClick={() => void run()}>{submitting ? <Loader2 size={18} className="spin" /> : 'Run'}</button>}
      </footer>
    </section>
  </div>
}
