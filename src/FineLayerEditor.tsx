import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { BoxSelect, Brush, Check, Eraser, Loader2, MousePointer2, Plus, RotateCcw, Trash2, WandSparkles } from 'lucide-react'
import UnifiedRange from './UnifiedRange'
import GenerationSelect from './GenerationSelect'
import { loadLayerImage, type LayerDocument } from './layerDocument'
import { cacheLayerImage, collectFineTask, layerRequest } from './layerSplitClient'
import { canvasPixels, createFineDocument, emptyFineDraft, extractFineElement, imageCanvas, maskCanvas, patchRasterLayer, rasterLayerCanvas, readMask, unionElementMasks, type FillModel, type FineLayerDraft, type FineTask } from './fineLayerDocument'

type Tool = 'include' | 'exclude' | 'box' | 'brush' | 'erase'
type Props = {
  sourceImageUrl: string
  document?: LayerDocument
  draft?: FineLayerDraft
  credentials: ReactNode
  ready: boolean
  onDraft: (draft: FineLayerDraft) => void
  onComplete: (doc: LayerDocument) => Promise<void>
  onLockChange: (locked: boolean) => void
  onWorkingChange: (working: boolean) => void
  onPrepare: () => void
}
const fillModels = [
  { value: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
  { value: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' },
]

export default function FineLayerEditor(props: Props) {
  const [draft, setDraftState] = useState(() => props.draft || emptyFineDraft())
  const draftRef = useRef(draft)
  const [tool, setTool] = useState<Tool>(draft.targetLayerId ? 'brush' : 'include')
  const [brushSize, setBrushSize] = useState(32)
  const [source, setSource] = useState<{ url: string; width: number; height: number }>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState('')
  const [showMask, setShowMask] = useState(true)
  const [cursor, setCursor] = useState<{ x: number; y: number }>()
  const [stageSize, setStageSize] = useState({ width: 500, height: 500 })
  const [dragBox, setDragBox] = useState<{ x: number; y: number; width: number; height: number }>()
  const [maskReady, setMaskReady] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const gesture = useRef<{ x: number; y: number; lastX: number; lastY: number; pointerId: number } | null>(null)
  const selectionUndo = useRef<Array<Pick<FineLayerDraft, 'maskUrl' | 'points' | 'box'>>>([])
  const busyRef = useRef(false)
  const aliveRef = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const callbacks = useRef(props); callbacks.current = props
  const blocked = working || Boolean(draft.pending || draft.resultDocument)
  const repair = Boolean(draft.targetLayerId)
  const selectedLayer = props.document?.layers.find(layer => layer.id === draft.targetLayerId)

  function change(next: FineLayerDraft) {
    draftRef.current = next
    setDraftState(next)
    callbacks.current.onDraft(next)
  }
  function rememberSelection() {
    const { maskUrl, points, box } = draftRef.current
    selectionUndo.current = [...selectionUndo.current.slice(-9), { maskUrl, points, box }]
  }
  function drawOverlay() {
    const mask = maskRef.current, overlay = overlayRef.current
    if (!mask || !overlay) return
    overlay.width = mask.width; overlay.height = mask.height
    const pixels = canvasPixels(mask), ctx = overlay.getContext('2d')!
    for (let i = 0; i < pixels.data.length; i += 4) {
      const selected = pixels.data[i] >= 128
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255
      pixels.data[i + 3] = selected ? 100 : 0
    }
    ctx.putImageData(pixels, 0, 0)
  }
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false; controllerRef.current?.abort(); callbacks.current.onLockChange(false); callbacks.current.onWorkingChange(false) }
  }, [])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const img = await loadLayerImage(props.sourceImageUrl)
      const width = props.document?.width || img.naturalWidth, height = props.document?.height || img.naturalHeight
      const canvas = draft.targetLayerId && props.document ? await rasterLayerCanvas(props.document, draft.targetLayerId) : await imageCanvas(props.sourceImageUrl, width, height)
      if (!cancelled) setSource({ url: canvas.toDataURL('image/png'), width, height })
    })().catch(reason => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [props.sourceImageUrl, props.document, draft.targetLayerId])
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; setStageSize({ width, height }) })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!source) return
    let cancelled = false
    setMaskReady(false)
    void (async () => {
      const mask = draft.maskUrl ? await readMask(draft.maskUrl, source.width, source.height) : new Uint8Array(source.width * source.height)
      if (!cancelled) { maskRef.current = maskCanvas(mask, source.width, source.height); drawOverlay(); setMaskReady(true) }
    })().catch(reason => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [source, draft.maskUrl])

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(source!.width - 1, Math.round((event.clientX - rect.left) / rect.width * source!.width))), y: Math.max(0, Math.min(source!.height - 1, Math.round((event.clientY - rect.top) / rect.height * source!.height))) }
  }
  function paint(x: number, y: number, fromX = x, fromY = y) {
    const ctx = maskRef.current!.getContext('2d')!
    ctx.strokeStyle = ctx.fillStyle = tool === 'erase' ? '#000' : '#fff'
    ctx.lineWidth = brushSize; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(x, y); ctx.stroke()
    ctx.beginPath(); ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2); ctx.fill()
    drawOverlay()
  }
  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!source || blocked || !maskReady || event.button !== 0) return
    event.preventDefault(); setShowMask(true); setError(''); setNotice('')
    const p = point(event)
    if (tool === 'include' || tool === 'exclude') {
      if (draft.points.length >= 32) { setError('最多添加 32 个标记。'); return }
      rememberSelection()
      change({ ...draftRef.current, points: [...draftRef.current.points, { ...p, label: tool === 'include' ? 1 : 0 }] })
      return
    }
    rememberSelection()
    gesture.current = { ...p, lastX: p.x, lastY: p.y, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'brush' || tool === 'erase') paint(p.x, p.y)
  }
  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!source) return
    const p = point(event); setCursor(p)
    const g = gesture.current
    if (!g || blocked) return
    if (tool === 'box') setDragBox({ x: Math.min(p.x, g.x), y: Math.min(p.y, g.y), width: Math.abs(p.x - g.x) + 1, height: Math.abs(p.y - g.y) + 1 })
    else { paint(p.x, p.y, g.lastX, g.lastY); g.lastX = p.x; g.lastY = p.y }
  }
  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    const g = gesture.current
    if (!g || !source) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    let box = draftRef.current.box
    if (tool === 'box') {
      const p = point(event)
      box = { x: Math.min(p.x, g.x), y: Math.min(p.y, g.y), width: Math.abs(p.x - g.x) + 1, height: Math.abs(p.y - g.y) + 1 }
      if (box.width < 2 || box.height < 2) { setDragBox(undefined); return }
      const ctx = maskRef.current!.getContext('2d')!
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, source.width, source.height)
      ctx.fillStyle = '#fff'; ctx.fillRect(box.x, box.y, box.width, box.height)
      drawOverlay()
    }
    setDragBox(undefined)
    change({ ...draftRef.current, maskUrl: maskRef.current!.toDataURL('image/png'), box })
  }
  async function work(label: string, fn: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    const controller = new AbortController(); controllerRef.current = controller
    setWorking(true); setProgress(label); setError(''); setNotice('')
    props.onWorkingChange(true); props.onLockChange(true)
    try { await fn(controller.signal) }
    catch (reason) { if (!controller.signal.aborted && aliveRef.current) setError(reason instanceof Error ? reason.message : '操作失败，可继续获取原任务结果。') }
    finally {
      busyRef.current = false
      if (aliveRef.current) { setWorking(false); setProgress(''); props.onLockChange(false); props.onWorkingChange(false) }
    }
  }
  async function cacheDocument(doc: LayerDocument) {
    return { ...doc, layers: await Promise.all(doc.layers.map(async layer => ({ ...layer, imageUrl: await cacheLayerImage(layer.imageUrl) }))) }
  }
  async function finish(task: FineTask, signal: AbortSignal) {
    props.onLockChange(false)
    const imageUrl = task.resultImageUrl || (await collectFineTask({ requestId: task.requestId, model: task.model }, text => { if (aliveRef.current) setProgress(text) }, signal)).imageUrl
    signal.throwIfAborted()
    const completed = { ...task, resultImageUrl: imageUrl }
    change({ ...draftRef.current, pending: completed })
    if (task.kind === 'segment') {
      const mask = await readMask(imageUrl, source!.width, source!.height)
      if (!mask.some(Boolean)) throw new Error('没有识别到有效选区，请调整标记或描述后重试。')
      const maskUrl = await cacheLayerImage(maskCanvas(mask, source!.width, source!.height).toDataURL('image/png'))
      signal.throwIfAborted()
      change({ ...draftRef.current, maskUrl, pending: undefined })
      setShowMask(true); setNotice('选区已识别，可用画笔补选、橡皮擦减选。')
      return
    }
    setProgress('正在合成原尺寸图层…')
    const currentDocument = props.document || task.document
    if (task.kind === 'layer' && (currentDocument?.width !== task.document?.width || currentDocument?.height !== task.document?.height)) throw new Error('画布尺寸已经改变，未覆盖当前图层。')
    const result = task.kind === 'layer'
      ? await patchRasterLayer(currentDocument!, task.targetLayerId!, task.maskUrl!, imageUrl)
      : await createFineDocument(task.imageUrl, draftRef.current.elements, source!.width, source!.height, imageUrl)
    const document = await cacheDocument(result)
    signal.throwIfAborted()
    change({ ...draftRef.current, pending: undefined, resultDocument: document })
    props.onLockChange(true)
    await props.onComplete(document)
  }
  async function recognize() {
    if (!source || blocked || !props.ready) return
    await work('正在提交选区识别…', async signal => {
      props.onPrepare()
      const imageUrl = await cacheLayerImage(source.url)
      const snapshot = draftRef.current
      const response = await layerRequest<{ requestId: string; model: 'sam3' }>('segment-submit', { imageUrl: source.url, prompt: snapshot.prompt, points: snapshot.points, box: snapshot.box })
      const task: FineTask = { ...response, kind: 'segment', imageUrl }
      change({ ...snapshot, pending: task })
      await finish(task, signal)
    })
  }
  async function extract() {
    if (!source || blocked || !draft.maskUrl) return
    await work('正在提取原图像素…', async () => {
      const element = await extractFineElement(source.url, draft.maskUrl!, source.width, source.height, draft.elements, draft.name)
      element.imageUrl = await cacheLayerImage(element.imageUrl); element.maskUrl = await cacheLayerImage(element.maskUrl)
      const next = { ...draftRef.current, elements: [...draftRef.current.elements, element], maskUrl: undefined, points: [], box: undefined, name: `元素 ${draft.elements.length + 2}`, prompt: '' }
      change(next); selectionUndo.current = []; setNotice(`已提取“${element.name}”，可以继续选择其他元素。`)
    })
  }
  async function submitFill() {
    if (!source || blocked || !props.ready) return
    await work('正在提交 GPT 补全…', async signal => {
      props.onPrepare()
      const snapshot = draftRef.current
      const mask = repair ? await readMask(snapshot.maskUrl!, source.width, source.height) : await unionElementMasks(snapshot.elements, source.width, source.height)
      if (!mask.some(Boolean)) throw new Error('请先选择要补全的区域。')
      const maskData = maskCanvas(mask, source.width, source.height).toDataURL('image/png')
      const maskUrl = await cacheLayerImage(maskData), imageUrl = await cacheLayerImage(source.url)
      const response = await layerRequest<{ requestId: string; model: FillModel }>('edit-submit', {
        imageUrl: source.url, maskUrl: maskData, model: snapshot.model, task: repair ? 'layer' : 'background', prompt: snapshot.fillPrompt,
      })
      const task: FineTask = { ...response, kind: repair ? 'layer' : 'background', imageUrl, maskUrl,
        ...(repair ? { document: props.document, targetLayerId: snapshot.targetLayerId } : {}),
      }
      change({ ...snapshot, pending: task })
      await finish(task, signal)
    })
  }
  async function onlyExtract() {
    if (!source || blocked || !draft.elements.length) return
    await work('正在保存图层…', async () => {
      const doc = await cacheDocument(await createFineDocument(source.url, draft.elements, source.width, source.height))
      change({ ...draftRef.current, resultDocument: doc })
      await props.onComplete(doc)
    })
  }
  const displayWidth = source ? Math.max(1, Math.min(stageSize.width, stageSize.height * source.width / source.height)) : 1
  const box = dragBox || draft.box
  return <>
    <div className="layer-split-body fine-layer-body">
      <div className="layer-split-workspace">
        <div className="layer-split-preview-toolbar">
          <div className="layer-split-tabs"><button type="button" aria-pressed={showMask} onClick={() => setShowMask(true)}>选区预览</button><button type="button" aria-pressed={!showMask} onClick={() => setShowMask(false)}>查看原像素</button></div>
          <span>{source ? `${source.width} × ${source.height}` : '正在读取…'}</span>
        </div>
        <div className="fine-layer-tools" role="toolbar" aria-label="精细分层选区工具">
          {([['include', '包含标记', MousePointer2], ['exclude', '排除标记', MousePointer2], ['box', '框选', BoxSelect], ['brush', '补选', Brush], ['erase', '减选', Eraser]] as const).map(([value, label, Icon]) => <button key={value} type="button" aria-pressed={tool === value} disabled={blocked} onClick={() => setTool(value)}><Icon size={14} />{label}</button>)}
          <button type="button" aria-label="撤销选区" disabled={blocked || !selectionUndo.current.length} onClick={() => { const previous = selectionUndo.current.pop(); if (previous) change({ ...draftRef.current, ...previous }) }}><RotateCcw size={14} /></button>
          <button type="button" aria-label="清空选区" disabled={blocked} onClick={() => { rememberSelection(); change({ ...draftRef.current, maskUrl: undefined, points: [], box: undefined }) }}><Trash2 size={14} /></button>
        </div>
        <div className="layer-split-stage fine-layer-stage" ref={stageRef}>
          {source && <div className="layer-split-image fine-layer-image" style={{ aspectRatio: `${source.width}/${source.height}`, width: displayWidth }}>
            <img src={source.url} alt={repair ? `待补全图层：${selectedLayer?.name || '图层'}` : '精细分层原图'} draggable={false} />
            <canvas ref={overlayRef} className={`fine-layer-mask ${tool === 'brush' || tool === 'erase' ? 'brush-cursor' : ''}`} style={{ opacity: showMask ? 1 : 0 }} aria-label="在图像上标记或绘制选区" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onPointerLeave={() => { if (!gesture.current) setCursor(undefined) }} />
            {showMask && <svg className="fine-layer-hints" viewBox={`0 0 ${source.width} ${source.height}`}>
              {box && <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="none" stroke="#fff" strokeWidth={2 * source.width / displayWidth} strokeDasharray={`${5 * source.width / displayWidth}`} />}
              {draft.points.map((p, index) => <g key={index} transform={`translate(${p.x} ${p.y}) scale(${source.width / displayWidth})`}><circle r="9" fill={p.label ? '#eee' : '#252525'} stroke={p.label ? '#111' : '#fff'} strokeWidth="1.5" /><path d={p.label ? 'M -4 0 H 4 M 0 -4 V 4' : 'M -4 0 H 4'} stroke={p.label ? '#111' : '#fff'} strokeWidth="1.5" /></g>)}
            </svg>}
            {cursor && (tool === 'brush' || tool === 'erase') && !blocked && <i className="fine-layer-cursor" style={{ left: `${cursor.x / source.width * 100}%`, top: `${cursor.y / source.height * 100}%`, width: brushSize / source.width * displayWidth, height: brushSize / source.width * displayWidth }} />}
          </div>}
        </div>
        <div className="layer-split-caption"><span>{repair ? `正在补全：${selectedLayer?.name || '当前图层'}` : '浅色覆盖区域为当前选区'}</span><span>{repair ? '仅修改选区，保留区域外像素' : '框选 / 手绘可直接提取'}</span></div>
      </div>
      <aside className="layer-split-inspector">
        <section>
          <div className="layer-split-section-title"><strong>{repair ? '单层补全' : '① 选择元素'}</strong><span>SAM 3</span></div>
          {props.credentials}
          <label className="layer-split-description">元素描述<textarea placeholder="例如：黑色气垫盒，包含盒盖与底座" maxLength={500} value={draft.prompt} disabled={blocked} onChange={event => change({ ...draft, prompt: event.target.value })} /></label>
          <button type="button" className="fine-layer-wide" disabled={blocked || !props.ready || !source || (!draft.prompt.trim() && !draft.points.some(p => p.label === 1) && !draft.box)} onClick={() => void recognize()}><WandSparkles size={14} />识别元素</button>
          <p className="layer-split-help">用包含 / 排除标记或框选引导识别，再用补选、减选修正边缘。手绘选区无需调用识别接口。</p>
          <label className="layer-split-range-label">画笔直径<output>{brushSize}px</output></label>
          <UnifiedRange aria-label="选区画笔直径" min={2} max={Math.max(100, Math.min(400, Math.round((source?.width || 1000) / 3)))} value={brushSize} disabled={blocked} onValueChange={setBrushSize} />
          {!repair && <><label className="fine-layer-name">图层名称<input value={draft.name} maxLength={80} disabled={blocked} onChange={event => change({ ...draft, name: event.target.value })} /></label><button type="button" className="fine-layer-wide" disabled={blocked || !draft.maskUrl || draft.elements.length >= 8 || !maskReady} onClick={() => void extract()}><Plus size={14} />提取为图层</button></>}
        </section>
        {!repair && <section>
          <div className="layer-split-section-title"><strong>② 已提取元素</strong><span>{draft.elements.length} / 8</span></div>
          {draft.elements.length ? <div className="fine-layer-elements">{draft.elements.map(element => <div key={element.id}><img src={element.imageUrl} alt="" /><span>{element.name}</span><button type="button" aria-label={`移除${element.name}`} disabled={blocked} onClick={() => change({ ...draft, elements: draft.elements.filter(item => item.id !== element.id) })}><Trash2 size={13} /></button></div>)}</div> : <p className="layer-split-help">每个元素直接提取原图像素，可连续添加多个元素。已提取区域不会重复分配。</p>}
        </section>}
        <section>
          <div className="layer-split-section-title"><strong>{repair ? 'GPT 补全设置' : '③ 补全背景并分层'}</strong></div>
          <GenerationSelect label="补全模型" menuLabel="GPT 补全模型" value={draft.model} options={fillModels} disabled={blocked} onOpen={() => {}} onChange={value => change({ ...draft, model: value as FillModel })} />
          <label className="layer-split-description">补全描述 <span>可选</span><textarea placeholder={repair ? '例如：补齐左侧瓶身，保持材质、透视和光影一致' : '例如：移除产品后，延续后方建筑与台面的纹理'} maxLength={2000} value={draft.fillPrompt} disabled={blocked} onChange={event => change({ ...draft, fillPrompt: event.target.value })} /></label>
          <p className="layer-split-help">{repair ? '用框选或画笔圈出缺失 / 需修复部分。GPT 只替换选区像素，应用后可撤销本次补全。' : 'Run 将提交一次 GPT 任务，补出移走元素后的背景；补全内容单独成层。只需抠图时可直接保存。'}</p>
        </section>
      </aside>
    </div>
    {error && <div className="layer-split-error" role="alert">{error}</div>}
    <footer className="layer-split-foot fine-layer-foot">
      <span className="layer-split-foot-note" role="status">{working ? <><Loader2 size={13} className="export-spinner" />{progress}</> : draft.pending ? '任务已保存，可继续获取结果；不会重复提交' : notice || (props.ready ? repair ? '画出补全范围，再点击 Run' : '选取元素 → 提取图层 → Run 补全背景' : '手绘提取无需密钥；智能识别和补全需配置 fal')}</span>
      <div>
        {draft.resultDocument ? <button type="button" disabled={working} onClick={() => void work('正在保存…', async () => { await props.onComplete(draft.resultDocument!) })}><Check size={14} />应用已生成结果</button> : draft.pending ? <>
          <button type="button" disabled={working} onClick={() => { change({ ...draftRef.current, pending: undefined }); setError(''); setNotice('已放弃获取此结果；上游任务可能仍会完成并计费。') }}>放弃本次结果</button>
          <button type="button" disabled={working || !props.ready || !source} onClick={() => void work('正在查询原任务…', async signal => { props.onPrepare(); await finish(draft.pending!, signal) })}>继续获取结果</button>
        </> : <>
          {!repair && <button type="button" disabled={blocked || !draft.elements.length || !source} onClick={() => void onlyExtract()}>仅提取到画布</button>}
          <button type="button" className="layer-split-run" aria-label={repair ? 'GPT 补全当前图层' : 'GPT 补全背景并分层'} title={repair ? '补全当前图层' : '补全背景并创建分层结果'} disabled={blocked || !source || !props.ready || (repair ? !draft.maskUrl : !draft.elements.length)} onClick={() => void submitFill()}>{working ? <Loader2 size={16} className="export-spinner" /> : 'Run'}</button>
        </>}
      </div>
    </footer>
  </>
}
