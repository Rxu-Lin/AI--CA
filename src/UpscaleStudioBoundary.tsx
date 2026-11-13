import { Component, type ReactNode } from 'react'

type Props = { children: ReactNode; onClose: () => void }

/** Keep a failed editor render from unmounting the canvas and its in-memory jobs. */
export default class UpscaleStudioBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (!this.state.failed) return this.props.children
    return <div className="upscale-backdrop" onPointerDown={event => event.stopPropagation()}>
      <section className="upscale-studio" role="alertdialog" aria-modal="true" aria-label="高清修复打开失败" aria-describedby="upscale-load-error">
        <header className="upscale-head"><strong>高清修复暂时无法打开</strong></header>
        <div className="upscale-foot">
          <p id="upscale-load-error">请关闭后重试，画布内容和修复任务已保留。</p>
          <button type="button" className="upscale-return" autoFocus onClick={this.props.onClose}>返回画布</button>
        </div>
      </section>
    </div>
  }
}
