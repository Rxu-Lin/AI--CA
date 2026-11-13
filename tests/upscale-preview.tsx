// Exercise the production editor and a real render failure without submitting paid tasks.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import UpscaleStudio from '../src/UpscaleStudio'
import UpscaleStudioBoundary from '../src/UpscaleStudioBoundary'
import '../src/index.css'
import '../src/App.css'
import '../src/ControlTheme.css'

const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#aaa"/><rect x="245" y="80" width="110" height="240" rx="24" fill="#ddd"/><text x="300" y="210" text-anchor="middle" fill="#333" font-family="sans-serif" font-size="22">FORM</text></svg>')}`

function Editor({ fail, onClose }: { fail: boolean; onClose: () => void }) {
  if (fail) throw new Error('Intentional upscale render failure for boundary regression')
  return <UpscaleStudio sourceImageUrl={image} sourceName="本地测试图.svg" running={false}
    onRun={async () => { throw new Error('本地回归测试不提交付费任务。') }} onResume={() => {}} onClose={onClose} onOpenApiSettings={() => {}} />
}

export default function Preview() {
  const [open, setOpen] = useState(false)
  const [fail, setFail] = useState(false)
  const [canvasValue, setCanvasValue] = useState('保留的画布节点')
  return <main className="canvas-app" style={{ padding: 36, display: 'block' }}>
    <label>画布保留内容<input aria-label="画布保留内容" value={canvasValue} onChange={event => setCanvasValue(event.target.value)} /></label>
    <button onClick={() => { setFail(false); setOpen(true) }}>打开高清修复测试</button>
    <button onClick={() => { setFail(true); setOpen(true) }}>模拟弹窗渲染异常</button>
    {open && <UpscaleStudioBoundary onClose={() => setOpen(false)}><Editor fail={fail} onClose={() => setOpen(false)} /></UpscaleStudioBoundary>}
  </main>
}

const root = createRoot(document.getElementById('root')!)
root.render(<Preview />)
import.meta.hot?.dispose(() => root.unmount())
