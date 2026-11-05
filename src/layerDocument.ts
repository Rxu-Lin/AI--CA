import type { SketchLayer } from './sketchDocument'
import type { Psd } from 'ag-psd'

export type RasterLayer = Pick<SketchLayer, 'id' | 'name' | 'visible' | 'opacity' | 'x' | 'y' | 'width' | 'height'> & { imageUrl: string }
export type LayerDocument = {
  version: 1
  method?: 'precision'
  fillUndo?: RasterLayer
  width: number
  height: number
  nativeWidth: number
  nativeHeight: number
  layers: RasterLayer[] // Bottom to top, like SketchDocument and Qwen's official export demo.
}
export type LayerSplitJob = { requestId: string; numLayers: number; width: number; height: number; caption: string }
export type LayerImage = { imageUrl: string; width: number; height: number }

export function validateLayerDocument(doc: LayerDocument) {
  if (!Number.isInteger(doc.width) || !Number.isInteger(doc.height) || doc.width < 1 || doc.height < 1 || doc.width * doc.height > 16_777_216) {
    throw new Error('画布尺寸无效，图层拆分支持最多 1600 万像素的原图。')
  }
  if (!Array.isArray(doc.layers) || !doc.layers.length || doc.layers.length > 16) throw new Error('图层数据不完整。')
  for (const layer of doc.layers) {
    if (!layer.imageUrl || !layer.name || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
      ![layer.x, layer.y, layer.width, layer.height].every(Number.isFinite) || layer.width < 1 || layer.height < 1 || layer.width * layer.height > 16_777_216) {
      throw new Error('图层属性无效，请重新获取分层结果。')
    }
  }
}
export function createLayerDocument(job: LayerSplitJob, images: LayerImage[]): LayerDocument {
  if (!images.length) throw new Error('没有可用的分层图像。')
  if (images.some(image => image.width !== images[0].width || image.height !== images[0].height)) throw new Error('图层尺寸不一致。')
  const doc: LayerDocument = {
    version: 1, width: job.width, height: job.height, nativeWidth: images[0].width, nativeHeight: images[0].height,
    layers: images.map((image, index) => ({
      id: crypto.randomUUID(), name: `图层 ${index + 1}`, imageUrl: image.imageUrl,
      visible: true, opacity: 1, x: 0, y: 0, width: job.width, height: job.height,
    })),
  }
  validateLayerDocument(doc)
  return doc
}
export function moveRasterLayer(doc: LayerDocument, id: string, offset: number): LayerDocument {
  const from = doc.layers.findIndex(layer => layer.id === id)
  if (from < 0) return doc
  const to = Math.max(0, Math.min(doc.layers.length - 1, from + offset))
  const layers = [...doc.layers]
  layers.splice(to, 0, layers.splice(from, 1)[0])
  return { ...doc, layers }
}
export function loadLayerImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图层图片读取失败，请检查项目素材是否完整。'))
    image.src = url
  })
}
function newCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width); canvas.height = Math.round(height)
  return canvas
}
export async function renderLayerDocument(doc: LayerDocument) {
  validateLayerDocument(doc)
  const canvas = newCanvas(doc.width, doc.height)
  const context = canvas.getContext('2d')!
  for (const layer of doc.layers) {
    if (!layer.visible || !layer.opacity) continue
    const image = await loadLayerImage(layer.imageUrl)
    context.globalAlpha = layer.opacity
    context.drawImage(image, layer.x, layer.y, layer.width, layer.height)
  }
  return canvas
}
export function buildLayerPsd(doc: LayerDocument, composite: HTMLCanvasElement, bitmaps: Map<string, HTMLCanvasElement>): Psd {
  validateLayerDocument(doc)
  return {
    width: doc.width, height: doc.height, bitsPerChannel: 8, canvas: composite,
    children: [...doc.layers].reverse().map(layer => {
      const canvas = bitmaps.get(layer.id)
      if (!canvas) throw new Error(`缺少图层：${layer.name}`)
      return { name: layer.name, left: Math.round(layer.x), top: Math.round(layer.y), hidden: !layer.visible, opacity: layer.opacity, blendMode: 'normal', canvas }
    }),
  }
}
function filename(value: string) { return [...value].map(char => char.charCodeAt(0) < 32 ? '-' : char).join('').replace(/[<>:"/\\|?*]/g, '-').slice(0, 80).trim() || '分层图像' }
export function saveLayerBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
async function layerBitmap(layer: RasterLayer) {
  const canvas = newCanvas(layer.width, layer.height)
  const context = canvas.getContext('2d')!
  context.drawImage(await loadLayerImage(layer.imageUrl), 0, 0, canvas.width, canvas.height)
  return canvas
}
export async function exportLayerPsd(doc: LayerDocument, name: string) {
  validateLayerDocument(doc)
  // Bound the simultaneous buffers needed by ag-psd (layers, composite, encoded file).
  if (doc.layers.reduce((total, layer) => total + layer.width * layer.height, 0) > 100_000_000) throw new Error('当前图层总像素过大，请先导出 PNG 图层包，或减少图层后导出 PSD。')
  const { writePsd } = await import('ag-psd')
  const bitmaps = new Map<string, HTMLCanvasElement>()
  try {
    for (const layer of doc.layers) bitmaps.set(layer.id, await layerBitmap(layer))
    const composite = await renderLayerDocument(doc)
    const buffer = writePsd(buildLayerPsd(doc, composite, bitmaps))
    saveLayerBlob(new Blob([buffer], { type: 'image/vnd.adobe.photoshop' }), `${filename(name)}.psd`)
    composite.width = composite.height = 1
  } finally { for (const bitmap of bitmaps.values()) bitmap.width = bitmap.height = 1 }
}
export async function exportLayerPngs(doc: LayerDocument, name: string) {
  validateLayerDocument(doc)
  const { zipSync, strToU8 } = await import('fflate')
  const files: Record<string, Uint8Array> = {}
  const { fillUndo: _fillUndo, ...metadata } = doc
  const manifest = { ...metadata, layers: [] as Array<Omit<RasterLayer, 'imageUrl'> & { file: string }> }
  for (const [index, layer] of doc.layers.entries()) {
    const bitmap = await layerBitmap(layer)
    const blob = await new Promise<Blob>((resolve, reject) => bitmap.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 导出失败。')), 'image/png'))
    bitmap.width = bitmap.height = 1
    const file = `${String(index + 1).padStart(2, '0')}-${filename(layer.name)}.png`
    files[file] = new Uint8Array(await blob.arrayBuffer())
    const { imageUrl: _imageUrl, ...metadata } = layer
    manifest.layers.push({ ...metadata, file })
  }
  files['layers.json'] = strToU8(JSON.stringify(manifest, null, 2))
  files['说明.txt'] = strToU8('图层按文件序号从底到顶排列。PNG 保留原始透明度，显示开关、位置与图层透明度记录在 layers.json 中。\n文字为像素图层。\n')
  const zipped = zipSync(files, { level: 0 })
  saveLayerBlob(new Blob([new Uint8Array(zipped)], { type: 'application/zip' }), `${filename(name)}-PNG图层.zip`)
}
