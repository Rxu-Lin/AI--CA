import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { NodeResultVersions } from './resultVersions'

export type ResultMedia = {
  nodeId: string
  type: 'image' | 'video'
  url: string
  initialRatio: number
  playback?: Pick<HTMLVideoElement, 'currentTime' | 'paused' | 'muted' | 'volume' | 'playbackRate'>
}

type Props = {
  media: ResultMedia
  versions?: NodeResultVersions
  onViewVersion: (index: number) => void
  onDismiss: () => void
}

export default function ResultMediaPreview({ media, versions, onViewVersion, onDismiss }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [measured, setMeasured] = useState<{ url: string; ratio: number }>()
  const [failedUrl, setFailedUrl] = useState<string>()
  const ratio = measured?.url === media.url ? measured.ratio : media.initialRatio
  const multiple = versions && versions.items.length > 1
  const label = media.type === 'video' ? '视频' : '图片'

  useLayoutEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])

  function fitMedia(width: number, height: number) {
    if (width > 0 && height > 0) setMeasured({ url: media.url, ratio: width / height })
  }

  function changeVersion(index: number) {
    if (!versions?.items[index]) return
    setFailedUrl(undefined)
    onViewVersion(index)
  }

  return (
    <dialog
      ref={dialogRef}
      className="result-media-preview"
      aria-label={`${label}预览`}
      style={{ '--media-ratio': ratio } as CSSProperties}
      onCancel={(event) => { event.preventDefault(); onDismiss() }}
      onClick={(event) => { if (event.target === event.currentTarget) onDismiss() }}
      onKeyDown={event => {
        if (!multiple || event.target instanceof HTMLVideoElement || event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          changeVersion(versions.viewedIndex + (event.key === 'ArrowLeft' ? -1 : 1))
        }
      }}
    >
      <div className="result-preview-toolbar">
        <button className="result-preview-close" type="button" title="关闭预览（Esc）" aria-label="关闭预览" onClick={onDismiss}>
          <X size={18} />
        </button>
        {multiple && (
          <nav className="result-preview-versions" aria-label="切换生成版本">
            <button type="button" aria-label="上一版本" title="上一版本（←）" disabled={versions.viewedIndex === 0}
              onClick={() => changeVersion(versions.viewedIndex - 1)}><ChevronLeft size={17} /></button>
            <span aria-live="polite">版本 {versions.viewedIndex + 1}/{versions.items.length}</span>
            <button type="button" aria-label="下一版本" title="下一版本（→）" disabled={versions.viewedIndex === versions.items.length - 1}
              onClick={() => changeVersion(versions.viewedIndex + 1)}><ChevronRight size={17} /></button>
          </nav>
        )}
      </div>
      {failedUrl === media.url ? (
        <p className="result-preview-error" role="alert">{label}加载失败，请关闭后重试。</p>
      ) : media.type === 'video' ? (
        <video
          key={media.url}
          src={media.url}
          controls
          playsInline
          preload="metadata"
          aria-label="生成视频"
          autoPlay={media.playback?.paused === false}
          muted={media.playback?.muted}
          onLoadedMetadata={({ currentTarget: video }) => {
            fitMedia(video.videoWidth, video.videoHeight)
            if (media.playback) {
              video.volume = media.playback.volume
              video.playbackRate = media.playback.playbackRate
              if (media.playback.currentTime > 0) video.currentTime = media.playback.currentTime
            }
          }}
          onResize={({ currentTarget: video }) => fitMedia(video.videoWidth, video.videoHeight)}
          onError={() => setFailedUrl(media.url)}
        />
      ) : (
        <img
          key={media.url}
          src={media.url}
          alt="生成图片"
          draggable={false}
          onLoad={({ currentTarget: image }) => fitMedia(image.naturalWidth, image.naturalHeight)}
          onError={() => setFailedUrl(media.url)}
        />
      )}
    </dialog>
  )
}
