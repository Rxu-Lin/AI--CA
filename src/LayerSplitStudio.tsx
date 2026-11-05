import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, Download, Eye, EyeOff, KeyRound, Layers, Loader2, Plus, RotateCcw, WandSparkles, X } from 'lucide-react'
import UnifiedRange from './UnifiedRange'
import { exportLayerPngs, exportLayerPsd, loadLayerImage, moveRasterLayer, type LayerDocument, type LayerSplitJob, type RasterLayer } from './layerDocument'
import { readLayerApiKey, saveLayerApiKey } from './layerSplitClient'
import FineLayerEditor from './FineLayerEditor'
import { emptyFineDraft, undoLayerFill, type FineLayerDraft } from './fineLayerDocument'
import './LayerSplitStudio.css'

export type LayerSplitInput = { imageUrl: string; width: number; height: number; numLayers: number; caption: string }
type Props = {
  sourceImageUrl: string
  sourceName: string
  document?: LayerDocument
  job?: LayerSplitJob
  running: boolean
  progress?: string
  error?: string
  fineDraft?: FineLayerDraft
  onFineDraft?: (draft?: FineLayerDraft) => void
  onCreateFine?: (doc: LayerDocument) => Promise<void>
  onRun: (input: LayerSplitInput) => Promise<void>
  onResume: () => void
  onSave: (doc: LayerDocument) => Promise<void>
  onExtract: (layer: RasterLayer, doc: LayerDocument) => Promise<void>
  onClose: () => void
}

export default function LayerSplitStudio(props: Props) {
  const [doc, setDoc] = useState(props.document)
  const [view, setView] = useState<'layers' | 'fine'>(props.fineDraft || !props.document && !props.job ? 'fine' : 'layers')
  const [fineDraft, setFineDraft] = useState(props.fineDraft)
  const [fineLocked, setFineLocked] = useState(false)
  const [fineWorking, setFineWorking] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState(props.document?.layers.at(-1)?.id || '')
  const [numLayers, setNumLayers] = useState(props.job?.numLayers || 4)
  const [caption, setCaption] = useState(props.job?.caption || '')
  const [apiKey, setApiKey] = useState(readLayerApiKey)
  const [serverConfigured, setServerConfigured] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(!readLayerApiKey())
  const [splitSettingsOpen, setSplitSettingsOpen] = useState(!props.document)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [action, setAction] = useState('')
  const [compareOriginal, setCompareOriginal] = useState(false)
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null)
  const [sourceError, setSourceError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ width: 600, height: 500 })
  const closingRef = useRef(false)
  const busy = props.running || Boolean(action)
  const selected = doc?.layers.find(layer => layer.id === selectedId)
  const ready = Boolean(apiKey.trim() || serverConfigured)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/layers/config').then(response => response.json()).then(data => {
      if (!cancelled) setServerConfigured(Boolean(data.configured))
    }).catch(() => {})
    void loadLayerImage(props.sourceImageUrl).then(image => {
      if (!cancelled) setSourceSize({ width: image.naturalWidth, height: image.naturalHeight })
    }).catch(reason => { if (!cancelled) setSourceError(reason.message) })
    return () => { cancelled = true }
  }, [props.sourceImageUrl])
  useEffect(() => {
    setDoc(props.document)
    setSelectedId(current => props.document?.layers.some(layer => layer.id === current) ? current : props.document?.layers.at(-1)?.id || '')
    setDirty(false)
    if (props.document) setSplitSettingsOpen(false)
  }, [props.document])
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setStageSize({ width, height })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [view])

  function change(next: LayerDocument) { setDoc(next); setDirty(true) }
  function updateLayer(patch: Partial<RasterLayer>) {
    if (doc) change({ ...doc, layers: doc.layers.map(layer => layer.id === selectedId ? { ...layer, ...patch } : layer) })
  }
  async function perform(label: string, work: () => Promise<void>) {
    if (action) return
    setAction(label); setError(''); setNotice('')
    try { await work() } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试。') }
    finally { setAction('') }
  }
  async function close() {
    if (closingRef.current || action || fineLocked) return
    closingRef.current = true
    try {
      if (doc && dirty) {
        setAction('保存'); await props.onSave(doc)
      }
      props.onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，图层调整仍保留在当前窗口。') }
    finally { closingRef.current = false; setAction('') }
  }
  function updateFineDraft(next?: FineLayerDraft) { setFineDraft(next); props.onFineDraft?.(next) }
  async function completeFine(next: LayerDocument) {
    if (fineDraft?.targetLayerId && doc) {
      await props.onSave(next)
      setDoc(next); setDirty(false)
      updateFineDraft(undefined); setView('layers'); setNotice('补全已应用，可撤销本次补全。')
    } else {
      if (!props.onCreateFine) throw new Error('无法保存精细分层结果，请重新打开编辑器。')
      await props.onCreateFine(next)
      updateFineDraft(undefined); setView('layers')
    }
  }
  const credentials = <details className="fine-layer-credentials" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
    <summary><KeyRound size={13} />fal 接口配置{ready && <Check size={12} />}</summary>
    <div className="layer-split-credentials">
      <label>fal API Key<input type="password" autoComplete="off" placeholder={serverConfigured ? '服务器已配置，可留空' : '输入 fal API Key'} value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={fineWorking} /></label>
      <button type="button" disabled={fineWorking} onClick={() => { saveLayerApiKey(apiKey); setSettingsOpen(false); setNotice('配置已保存到当前浏览器会话。') }}>保存配置</button>
      <p>SAM 3 和 GPT 共用 fal 密钥，按实际调用计费。密钥不写入项目。</p>
      <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">获取 fal 密钥 ↗</a>
    </div>
  </details>
  async function run() {
    await perform('提交', async () => {
      if (!ready) throw new Error('请先配置 fal API Key。')
      saveLayerApiKey(apiKey)
      if (doc && dirty) await props.onSave(doc)
      const source = await loadLayerImage(props.sourceImageUrl)
      if (source.naturalWidth * source.naturalHeight > 16_777_216) throw new Error('请使用不超过 1600 万像素的图片。')
      const canvas = window.document.createElement('canvas')
      canvas.width = source.naturalWidth; canvas.height = source.naturalHeight
      canvas.getContext('2d')!.drawImage(source, 0, 0)
      await props.onRun({ imageUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, numLayers, caption })
    })
  }
  const size = doc || sourceSize
  return (
    <div className="layer-split-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) void close() }}>
      <section className="layer-split-studio" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="layer-split-title" tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close() }
          if (event.key === 'Tab') {
            const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []).filter(item => item.getClientRects().length)
            const first = items[0], last = items.at(-1)
            if (event.shiftKey && (window.document.activeElement === first || window.document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus() }
          }
        }}>
        <header className="layer-split-head">
          <div><Layers size={20} /><div><h2 id="layer-split-title">图层拆分</h2><p>将一张画面，变成可独立编辑的透明图层</p></div></div>
          <button type="button" aria-label="关闭图层拆分" onClick={() => void close()} disabled={Boolean(action) || fineLocked}><X size={20} /></button>
        </header>
        <nav className="layer-split-mode" aria-label="分层方式">
          <button type="button" aria-pressed={view === 'fine'} disabled={busy || fineWorking} onClick={() => { if (!fineDraft) updateFineDraft(emptyFineDraft()); setView('fine') }}>精细分层 <span>SAM 3 + GPT</span></button>
          <button type="button" aria-pressed={view === 'layers'} disabled={fineWorking} onClick={() => setView('layers')}>{doc ? '图层管理 / PSD' : '千问快速分层'}</button>
          {view === 'fine' && fineDraft?.targetLayerId && !fineWorking && <button type="button" disabled={Boolean(fineDraft.pending || fineDraft.resultDocument)} onClick={() => updateFineDraft(emptyFineDraft())}>重新从原图分层</button>}
        </nav>
        {view === 'fine' ? <FineLayerEditor
          key={fineDraft?.targetLayerId || 'source'}
          sourceImageUrl={props.sourceImageUrl} document={doc} draft={fineDraft} credentials={credentials} ready={ready}
          onDraft={updateFineDraft} onComplete={completeFine} onLockChange={setFineLocked} onWorkingChange={setFineWorking}
          onPrepare={() => saveLayerApiKey(apiKey)}
        /> : <>
        <div className="layer-split-body">
          <div className="layer-split-workspace">
            <div className="layer-split-preview-toolbar">
              <div className="layer-split-tabs" aria-label="预览方式">
                <button type="button" aria-pressed={!compareOriginal} onClick={() => setCompareOriginal(false)}>{doc ? '图层合成' : '待拆分原图'}</button>
                {doc && <button type="button" aria-pressed={compareOriginal} onClick={() => setCompareOriginal(true)}>原图对比</button>}
              </div>
              <span>{size ? `${size.width} × ${size.height}` : '正在读取…'}</span>
            </div>
            <div className="layer-split-stage" ref={stageRef}>
              <div className="layer-split-image" style={{ aspectRatio: size ? `${size.width}/${size.height}` : '1', width: Math.max(1, Math.min(stageSize.width, stageSize.height * (size ? size.width / size.height : 1))) }}>
                {doc && !compareOriginal ? doc.layers.filter(layer => layer.visible).map(layer => (
                  <img key={layer.id} src={layer.imageUrl} alt={layer.name} draggable={false} style={{
                    opacity: layer.opacity, left: `${100 * layer.x / doc.width}%`, top: `${100 * layer.y / doc.height}%`,
                    width: `${100 * layer.width / doc.width}%`, height: `${100 * layer.height / doc.height}%`,
                  }} />
                )) : <img src={props.sourceImageUrl} alt="拆分原图" draggable={false} />}
              </div>
              {props.running && <div className="layer-split-progress" role="status"><Loader2 size={20} className="export-spinner" /><strong>{props.progress || '正在拆分图层…'}</strong><span>可以关闭窗口，结果会保留在画布中</span></div>}
            </div>
            <div className="layer-split-caption"><span>{props.sourceName}</span><span>{doc ? `${doc.layers.length} 个透明图层 · 原图尺寸画布` : '透明区域以棋盘格显示'}</span></div>
          </div>
          <aside className="layer-split-inspector">
            <section className="layer-split-settings">
              <div className="layer-split-section-title"><button type="button" className="layer-split-settings-toggle" aria-expanded={splitSettingsOpen} onClick={() => setSplitSettingsOpen(!splitSettingsOpen)}><strong>拆分设置</strong><ChevronDown size={13} /></button><button type="button" onClick={() => { setSplitSettingsOpen(true); setSettingsOpen(!settingsOpen) }} aria-expanded={splitSettingsOpen && settingsOpen}><KeyRound size={13} />接口配置</button></div>
              {splitSettingsOpen && <>
              <p className="layer-split-model">Qwen-Image-Layered <span>via fal</span></p>
              {settingsOpen && <div className="layer-split-credentials">
                <label>fal API Key<input type="password" autoComplete="off" placeholder={serverConfigured ? '服务器已配置，可留空' : '输入 fal API Key'} value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={busy} /></label>
                <button type="button" disabled={busy} onClick={() => { saveLayerApiKey(apiKey); setNotice(apiKey.trim() ? '密钥已保存到当前浏览器会话。' : '已清除会话密钥。') }}><Check size={13} />保存配置</button>
                <p>使用独立的 fal 密钥，仅在当前浏览器会话保存，不写入画布项目。</p>
                <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">获取 fal 密钥 ↗</a>
              </div>}
              <label className="layer-split-range-label">目标图层数<output>{numLayers}</output></label>
              <UnifiedRange aria-label="目标图层数" min={2} max={8} step={1} value={numLayers} disabled={busy} onValueChange={setNumLayers} />
              <label className="layer-split-description">画面描述 <span>可选</span><textarea placeholder="描述主体、背景及被遮挡内容，帮助模型理解画面" maxLength={2000} value={caption} disabled={busy} onChange={event => setCaption(event.target.value)} /></label>
              <p className="layer-split-help">按画面结构自动拆分，实际图层数量以模型返回为准。文字会保留为像素图层。</p>
              </>}
            </section>
            {doc ? <section className="layer-split-layers">
              <div className="layer-split-section-title"><strong>图层 <span>{doc.layers.length}</span></strong><span>由上到下</span></div>
              <div className="layer-split-layer-list">
                {[...doc.layers].reverse().map(layer => <div className={`layer-split-layer ${layer.id === selectedId ? 'active' : ''}`} key={layer.id}>
                  <button type="button" className="layer-split-visibility" disabled={busy} aria-label={`${layer.visible ? '隐藏' : '显示'}${layer.name}`} aria-pressed={layer.visible} onClick={() => change({ ...doc, layers: doc.layers.map(item => item.id === layer.id ? { ...item, visible: !item.visible } : item) })}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                  <button type="button" className="layer-split-layer-pick" disabled={busy} aria-pressed={layer.id === selectedId} onClick={() => setSelectedId(layer.id)}><img src={layer.imageUrl} alt="" /><span>{layer.name}</span></button>
                </div>)}
              </div>
              {selected && <div className="layer-split-layer-controls">
                <label>图层名称<input value={selected.name} maxLength={80} disabled={busy} onChange={event => updateLayer({ name: event.target.value || '未命名图层' })} /></label>
                <div className="layer-split-order">
                  <button type="button" aria-label="上移图层" disabled={busy || doc.layers.at(-1)?.id === selectedId} onClick={() => change(moveRasterLayer(doc, selectedId, 1))}><ArrowUp size={15} />上移</button>
                  <button type="button" aria-label="下移图层" disabled={busy || doc.layers[0]?.id === selectedId} onClick={() => change(moveRasterLayer(doc, selectedId, -1))}><ArrowDown size={15} />下移</button>
                </div>
                <label className="layer-split-range-label">不透明度<output>{Math.round(selected.opacity * 100)}%</output></label>
                <UnifiedRange aria-label="图层不透明度" min={0} max={100} value={Math.round(selected.opacity * 100)} disabled={busy} onValueChange={value => updateLayer({ opacity: value / 100 })} />
                <button type="button" className="layer-split-extract" disabled={busy} onClick={() => void perform('提取', async () => { await props.onExtract(selected, doc); setNotice(`已将“${selected.name}”添加到画布。`) })}><Plus size={14} />提取此图层到画布</button>
                <button type="button" className="fine-layer-wide" disabled={busy || Boolean(fineDraft?.pending || fineDraft?.resultDocument)} onClick={() => { updateFineDraft(emptyFineDraft(selected.id)); setView('fine') }}><WandSparkles size={14} />GPT 补全此图层</button>
                {doc.fillUndo && <button type="button" className="fine-layer-wide" disabled={busy} onClick={() => void perform('撤销补全', async () => { const restored = undoLayerFill(doc); await props.onSave(restored); setDoc(restored); setDirty(false); setNotice('已恢复补全前的图层像素。') })}><RotateCcw size={14} />撤销上次补全</button>}
              </div>}
              {doc.nativeWidth && (doc.nativeWidth !== doc.width || doc.nativeHeight !== doc.height) && <p className="layer-split-help">模型输出 {doc.nativeWidth} × {doc.nativeHeight}，已映射至原图尺寸。PSD 保留画布尺寸，细节取决于模型输出。</p>}
            </section> : <div className="layer-split-empty"><Layers size={28} /><strong>图层将在这里出现</strong><p>从 4 层开始，拆分后可调整图层顺序、可见性和透明度。</p></div>}
          </aside>
        </div>
        {(error || props.error || sourceError) && <div className="layer-split-error" role="alert">{error || props.error || sourceError}</div>}
        <footer className="layer-split-foot">
          <span className="layer-split-foot-note" role="status">{action ? `正在${action}…` : notice || (dirty ? '图层已调整，关闭窗口时自动保存' : doc ? '透明图层可导出为 PSD 或 PNG 图层包' : !ready ? '请先配置 fal 接口' : 'Run 将提交一次图层拆分任务')}</span>
          <div>
            {doc && <>
              <button type="button" disabled={busy || !dirty} onClick={() => void perform('保存', async () => { await props.onSave(doc); setDirty(false); setNotice('图层调整已保存。') })}>保存到画布</button>
              <button type="button" disabled={busy} onClick={() => void perform('导出 PNG', () => exportLayerPngs(doc, props.sourceName))}>PNG 图层</button>
              <button type="button" className="layer-split-export" disabled={busy} onClick={() => void perform('导出 PSD', () => exportLayerPsd(doc, props.sourceName))}><Download size={14} />导出 PSD</button>
            </>}
            {props.job && !doc && !props.running ? <button type="button" disabled={Boolean(action) || !ready} onClick={() => { saveLayerApiKey(apiKey); setError(''); props.onResume() }}>继续获取结果</button> : <button className="layer-split-run" type="button" disabled={busy || !sourceSize || !ready || Boolean(sourceError)} title={doc ? '基于原图重新拆分，将创建新的结果节点' : '运行图层拆分'} aria-label={doc ? '重新拆分图层' : '运行图层拆分'} onClick={() => void run()}>{busy ? <Loader2 size={16} className="export-spinner" /> : 'Run'}</button>}
          </div>
        </footer>
        </>}
      </section>
    </div>
  )
}
