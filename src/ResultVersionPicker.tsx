import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Video } from 'lucide-react'
import GenerationSelect from './GenerationSelect'
import type { NodeResultVersions } from './resultVersions'

function VideoThumbnail({ url, duration }: { url: string; duration?: number }) {
  const frame = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [seconds, setSeconds] = useState(duration)

  useEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: element.closest('.node-model-menu'),
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rounded = seconds && Number.isFinite(seconds) ? Math.round(seconds) : 0
  return (
    <span className="version-thumbnail video" ref={frame}>
      <Video size={15} aria-hidden="true" />
      {visible && <video
        src={url} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1}
        onLoadedMetadata={({ currentTarget: video }) => {
          if (Number.isFinite(video.duration) && video.duration > 0) {
            setSeconds(video.duration)
            video.currentTime = Math.min(0.05, video.duration / 2)
          }
        }}
      />}
      {rounded > 0 && <small>{Math.floor(rounded / 60)}:{String(rounded % 60).padStart(2, '0')}</small>}
    </span>
  )
}

type Props = {
  versions: NodeResultVersions
  disabled: boolean
  onView: (index: number) => void
  onCopy: (index: number) => void
  onUse: () => void
}

export default function ResultVersionPicker({ versions, disabled, onView, onCopy, onUse }: Props) {
  const { items, outputIndex, viewedIndex } = versions
  const options = useMemo(() => items.map((item, index) => ({
    value: String(index),
    label: `版本 ${index + 1}/${items.length}`,
    content: <>
      {item.type === 'video'
        ? <VideoThumbnail url={item.url} duration={item.videoDurationSeconds} />
        : <img className="version-thumbnail" src={item.url} alt="" loading="lazy" draggable={false} />}
      <span className="version-details">
        <strong>版本 {index + 1}</strong>
        {item.createdAt && <small>{item.createdAt}</small>}
      </span>
      {index === outputIndex && <span className="version-output-label">当前输出</span>}
    </>,
  })).reverse(), [items, outputIndex])

  return (
    <div className="node-version-controls nodrag nopan nowheel" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <GenerationSelect label="查看生成版本" menuLabel="生成版本" value={String(viewedIndex)}
        options={options} disabled={disabled} onChange={value => onView(Number(value))}
        optionAction={{
          icon: <ArrowRight size={15} aria-hidden="true" />,
          label: value => `复制版本 ${Number(value) + 1} 到画布右侧`,
          onActivate: value => onCopy(Number(value)),
        }} />
      {viewedIndex !== outputIndex && (
        <button type="button" className="version-use" disabled={disabled} onClick={onUse} title="将这个版本用于下游节点">设为输出</button>
      )}
    </div>
  )
}
