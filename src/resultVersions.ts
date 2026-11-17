export type GenerationRecord = {
  id: string
  prompt: string
  model: string
  size: string
  createdAt: string
  mediaType?: 'image' | 'video'
  imageUrl?: string
  videoUrl?: string
  videoDurationSeconds?: number
  status: '成功' | '失败'
}

export type ResultVersion = Pick<GenerationRecord, 'prompt' | 'model' | 'size' | 'createdAt' | 'videoDurationSeconds'> & {
  type: 'image' | 'video'
  url: string
}

export type NodeResultVersions = { items: ResultVersion[]; outputIndex: number; viewedIndex: number }
export type VersionChoice = { index: number; count: number }

type ResultNode = {
  id: string
  data: {
    kind: string; status?: string; imageUrl?: string; videoUrl?: string; outputVersion?: number
    prompt?: string; generationPrompt?: string; model?: string; size?: string; createdAt?: string
    videoDurationSeconds?: number; videoDuration?: number
  }
}

function resultType(kind: string) {
  if (kind === 'video') return 'video'
  if (kind === 'image' || kind === 'outpaint' || kind === 'repaint') return 'image'
}

function versionFromRecord(record: GenerationRecord): ResultVersion | undefined {
  if (record?.status !== '成功') return
  const type = record.mediaType ?? (record.videoUrl ? 'video' : 'image')
  const url = type === 'video' ? record.videoUrl : record.imageUrl
  if (typeof url !== 'string' || !url) return
  const { prompt, model, size, createdAt, videoDurationSeconds } = record
  return { type, url, prompt, model, size, createdAt, videoDurationSeconds }
}

function recordFromNode({ id, data }: ResultNode): GenerationRecord | undefined {
  const type = resultType(data.kind)
  if (!type || !(type === 'video' ? data.videoUrl : data.imageUrl)) return
  return {
    id, status: '成功', mediaType: type, prompt: data.generationPrompt ?? data.prompt ?? '',
    model: data.model ?? '', size: data.size ?? '', createdAt: data.createdAt ?? '',
    ...(type === 'video'
      ? { videoUrl: data.videoUrl, videoDurationSeconds: data.videoDurationSeconds ?? data.videoDuration }
      : { imageUrl: data.imageUrl }),
  }
}

/** Old projects and some tools can have a valid node output without a history entry. */
export function includeCurrentResults(history: GenerationRecord[], nodes: ResultNode[]) {
  const missing = new Map<string, GenerationRecord>()
  for (const node of nodes) {
    const record = recordFromNode(node)
    if (record) missing.set(node.id, record)
  }
  for (const record of history) {
    if (!missing.size) break
    const candidate = missing.get(record?.id)
    if (candidate && record.status === '成功' && (candidate.videoUrl
      ? candidate.videoUrl === record.videoUrl
      : candidate.imageUrl === record.imageUrl)) missing.delete(record.id)
  }
  return missing.size ? [...missing.values(), ...history] : history
}

export function indexResultVersions(history: GenerationRecord[]) {
  const groups = new Map<string, ResultVersion[]>()
  // History is newest first. Number each node's successful runs in creation order.
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i]
    const version = versionFromRecord(record)
    if (!version) continue
    const key = version.type + ':' + record.id
    const group = groups.get(key)
    if (group) group.push(version)
    else groups.set(key, [version])
  }
  return groups
}

export function nodeResultVersions(node: ResultNode, groups: Map<string, ResultVersion[]>, choice?: VersionChoice): NodeResultVersions | undefined {
  const type = resultType(node.data.kind)
  if (!type) return
  let items = groups.get(type + ':' + node.id)
  if (!items?.length) return
  const url = type === 'video' ? node.data.videoUrl : node.data.imageUrl
  // Editing the outpaint region clears its committed result until the next run.
  const clearedOutpaint = node.data.kind === 'outpaint' && node.data.status === 'idle' && !url
  const saved = (node.data.outputVersion ?? 0) - 1
  let outputIndex = items[saved] && (!url || items[saved].url === url) ? saved : items.length - 1
  if (url && items[outputIndex].url !== url) {
    outputIndex = items.findLastIndex(item => item.url === url)
    if (outputIndex < 0) {
      const record = recordFromNode(node)
      const current = record && versionFromRecord(record)
      if (!current) return
      outputIndex = items.length
      items = [...items, current]
    }
  }
  const viewedIndex = choice?.count === items.length && items[choice.index] ? choice.index : outputIndex
  if (clearedOutpaint) outputIndex = -1
  return { items, outputIndex, viewedIndex }
}

export function versionMedia(version: ResultVersion) {
  return version.type === 'video'
    ? { videoUrl: version.url, videoDurationSeconds: version.videoDurationSeconds }
    : { imageUrl: version.url }
}

export function versionCopyFields(version: ResultVersion) {
  return {
    ...versionMedia(version), model: version.model, size: version.size,
    prompt: version.prompt, generationPrompt: version.prompt,
    ...(version.type === 'video' ? { videoDuration: version.videoDurationSeconds } : {}),
  }
}
