// UI test harness: production editor, deterministic local layers, no paid API calls.
// Prepare the fixture with: node tests/create-layer-fixture.mjs
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import LayerSplitStudio from '../src/LayerSplitStudio'
import '../src/index.css'
import '../src/App.css'
import '../src/ControlTheme.css'
import project from '../.tmp-exports/layer-qa.json'
import type { LayerDocument } from '../src/layerDocument'
import type { FineLayerDraft } from '../src/fineLayerDocument'

export default function Preview() {
  const [doc, setDoc] = useState<LayerDocument | undefined>(project.nodes[1].data.layerDocument as LayerDocument)
  const [draft, setDraft] = useState<FineLayerDraft>()
  const [session, setSession] = useState(0)
  const [open, setOpen] = useState(true)
  return <main className="canvas-app"><button onClick={() => setOpen(true)}>打开本地测试样例</button><button onClick={() => { setDoc(undefined); setDraft(undefined); setSession(value => value + 1); setOpen(true) }}>新建精细分层测试</button>{open && <LayerSplitStudio key={session}
    sourceImageUrl={project.nodes[0].data.imageUrl}
    sourceName="本地绘制样例 · 界面与导出验证"
    document={doc} running={false}
    fineDraft={draft} onFineDraft={setDraft}
    onCreateFine={async next => { setDoc(next); setDraft(undefined); setSession(value => value + 1) }}
    onRun={async () => { throw new Error('此页面为本地测试样例，不提交付费任务。') }}
    onResume={() => {}}
    onSave={async next => setDoc(next)}
    onExtract={async () => {}}
    onClose={() => setOpen(false)}
    onOpenApiSettings={() => {}}
  />}</main>
}
const previewRoot = createRoot(document.getElementById('root')!)
previewRoot.render(<Preview />)
import.meta.hot?.dispose(() => previewRoot.unmount())
