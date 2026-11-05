import { loadLayerImage, validateLayerDocument, type LayerDocument, type RasterLayer } from './layerDocument.ts'

export type FillModel = 'gpt-image-2.5-flare' | 'gpt-image-2.5-sunburst'
export type MaskPoint = { x: number; y: number; label: 0 | 1 }
export type MaskBox = { x: number; y: number; width: number; height: number }
export type FineElement = { id: string; name: string; imageUrl: string; maskUrl: string }
export type FineTask = {
  requestId: string
  model: 'sam3' | FillModel
  kind: 'segment' | 'background' | 'layer'
  imageUrl: string
  maskUrl?: string
  resultImageUrl?: string
  document?: LayerDocument
  targetLayerId?: string
}
export type FineLayerDraft = {
  version: 1
  targetLayerId?: string
  name: string
  prompt: string
  fillPrompt: string
  model: FillModel
  points: MaskPoint[]
  box?: MaskBox
  maskUrl?: string
  elements: FineElement[]
  pending?: FineTask
  resultDocument?: LayerDocument
}
export function emptyFineDraft(targetLayerId?: string): FineLayerDraft {
  return { version: 1, targetLayerId, name: '主体', prompt: '', fillPrompt: '', model: 'gpt-image-2.5-flare', points: [], elements: [] }
}
export function layerCanvas(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_777_216) throw new Error('原图最多支持 1600 万像素。')
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  return canvas
}
export async function imageCanvas(url: string, width: number, height: number, mask = false) {
  const canvas = layerCanvas(width, height)
  const image = await loadLayerImage(url)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = !mask
  ctx.drawImage(image, 0, 0, width, height)
  return canvas
}
export function canvasPixels(canvas: HTMLCanvasElement) { return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height) }

// Masks are opaque black/white PNGs. Binarization makes complementary cutouts
// recompose to the exact source pixels, avoiding double-alpha edge darkening.
export async function readMask(url: string, width: number, height: number) {
  const pixels = canvasPixels(await imageCanvas(url, width, height, true)).data
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) * pixels[i * 4 + 3] >= 128 * 3 * 255 ? 255 : 0
  return mask
}
export function maskCanvas(mask: Uint8Array, width: number, height: number) {
  const canvas = layerCanvas(width, height), ctx = canvas.getContext('2d')!, pixels = ctx.createImageData(width, height)
  for (let i = 0; i < mask.length; i++) {
    pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = mask[i]
    pixels.data[i * 4 + 3] = 255
  }
  ctx.putImageData(pixels, 0, 0)
  return canvas
}
export async function unionElementMasks(elements: FineElement[], width: number, height: number) {
  const union = new Uint8Array(width * height)
  for (const element of elements) {
    const mask = await readMask(element.maskUrl, width, height)
    for (let i = 0; i < union.length; i++) if (mask[i]) union[i] = 255
  }
  return union
}
export async function extractFineElement(sourceUrl: string, maskUrl: string, width: number, height: number, elements: FineElement[], name: string): Promise<FineElement> {
  if (elements.length >= 8) throw new Error('一次最多提取 8 个元素。')
  const mask = await readMask(maskUrl, width, height), used = await unionElementMasks(elements, width, height)
  let count = 0
  for (let i = 0; i < mask.length; i++) { if (used[i]) mask[i] = 0; if (mask[i]) count++ }
  if (!count) throw new Error('选区为空或已提取，请选择新的区域。')
  const canvas = await imageCanvas(sourceUrl, width, height), ctx = canvas.getContext('2d')!, pixels = canvasPixels(canvas)
  for (let i = 0; i < mask.length; i++) if (!mask[i]) pixels.data[i * 4 + 3] = 0
  ctx.putImageData(pixels, 0, 0)
  return { id: crypto.randomUUID(), name: name.trim().slice(0, 80) || `元素 ${elements.length + 1}`, imageUrl: canvas.toDataURL('image/png'), maskUrl: maskCanvas(mask, width, height).toDataURL('image/png') }
}
async function generatedCanvas(url: string, width: number, height: number) {
  const image = await loadLayerImage(url)
  if (Math.abs((image.naturalWidth / image.naturalHeight) / (width / height) - 1) > 0.05) throw new Error('模型输出比例与原图不同，未拉伸或覆盖原图。请重新补全。')
  return imageCanvas(url, width, height)
}
export async function createFineDocument(sourceUrl: string, elements: FineElement[], width: number, height: number, filledUrl?: string): Promise<LayerDocument> {
  if (!elements.length) throw new Error('请先提取至少一个元素。')
  const mask = await unionElementMasks(elements, width, height)
  const background = await imageCanvas(sourceUrl, width, height), bgCtx = background.getContext('2d')!, bgPixels = canvasPixels(background)
  for (let i = 0; i < mask.length; i++) if (mask[i]) bgPixels.data[i * 4 + 3] = 0
  bgCtx.putImageData(bgPixels, 0, 0)
  const asLayer = (name: string, imageUrl: string, id: string = crypto.randomUUID()): RasterLayer => ({ id, name, imageUrl, visible: true, opacity: 1, x: 0, y: 0, width, height })
  const layers: RasterLayer[] = []
  if (filledUrl) {
    const patch = await generatedCanvas(filledUrl, width, height), ctx = patch.getContext('2d')!, pixels = canvasPixels(patch)
    for (let i = 0; i < mask.length; i++) if (!mask[i]) pixels.data[i * 4 + 3] = 0
    ctx.putImageData(pixels, 0, 0)
    layers.push(asLayer('背景补全 · GPT', patch.toDataURL('image/png')))
  }
  layers.push(asLayer('背景 · 原图像素', background.toDataURL('image/png')))
  for (const element of elements) layers.push(asLayer(element.name, element.imageUrl, element.id))
  const doc: LayerDocument = { version: 1, method: 'precision', width, height, nativeWidth: width, nativeHeight: height, layers }
  validateLayerDocument(doc)
  return doc
}
export async function rasterLayerCanvas(doc: LayerDocument, layerId: string) {
  validateLayerDocument(doc)
  const layer = doc.layers.find(item => item.id === layerId)
  if (!layer) throw new Error('图层已不存在。')
  const canvas = layerCanvas(doc.width, doc.height)
  canvas.getContext('2d')!.drawImage(await loadLayerImage(layer.imageUrl), layer.x, layer.y, layer.width, layer.height)
  return canvas
}
export async function patchRasterLayer(doc: LayerDocument, layerId: string, maskUrl: string, generatedUrl: string): Promise<LayerDocument> {
  const canvas = await rasterLayerCanvas(doc, layerId), ctx = canvas.getContext('2d')!, pixels = canvasPixels(canvas)
  const generated = canvasPixels(await generatedCanvas(generatedUrl, doc.width, doc.height)).data
  const mask = await readMask(maskUrl, doc.width, doc.height)
  if (!mask.some(Boolean)) throw new Error('补全选区为空。')
  // Copy only selected pixels, regardless of what the model changed elsewhere.
  for (let i = 0; i < mask.length; i++) if (mask[i]) for (let c = 0; c < 4; c++) pixels.data[i * 4 + c] = generated[i * 4 + c]
  ctx.putImageData(pixels, 0, 0)
  return { ...doc, fillUndo: { ...doc.layers.find(layer => layer.id === layerId)! }, layers: doc.layers.map(layer => layer.id === layerId ? { ...layer, imageUrl: canvas.toDataURL('image/png'), x: 0, y: 0, width: doc.width, height: doc.height } : layer) }
}
export function undoLayerFill(doc: LayerDocument): LayerDocument {
  const previous = doc.fillUndo
  if (!previous) return doc
  return { ...doc, fillUndo: undefined, layers: doc.layers.map(layer => layer.id === previous.id ? { ...layer, imageUrl: previous.imageUrl, x: previous.x, y: previous.y, width: previous.width, height: previous.height } : layer) }
}

// Used by project packaging; no task credentials are stored in drafts.
export async function mapFineDraftImages(draft: FineLayerDraft, map: (url: string) => Promise<string>): Promise<FineLayerDraft> {
  const mapDoc = async (doc?: LayerDocument) => doc ? { ...doc, layers: await Promise.all(doc.layers.map(async layer => ({ ...layer, imageUrl: await map(layer.imageUrl) }))), fillUndo: doc.fillUndo ? { ...doc.fillUndo, imageUrl: await map(doc.fillUndo.imageUrl) } : undefined } : undefined
  return {
    ...draft, maskUrl: draft.maskUrl ? await map(draft.maskUrl) : undefined,
    elements: await Promise.all(draft.elements.map(async element => ({ ...element, imageUrl: await map(element.imageUrl), maskUrl: await map(element.maskUrl) }))),
    pending: draft.pending ? { ...draft.pending, imageUrl: await map(draft.pending.imageUrl), maskUrl: draft.pending.maskUrl ? await map(draft.pending.maskUrl) : undefined, resultImageUrl: draft.pending.resultImageUrl ? await map(draft.pending.resultImageUrl) : undefined, document: await mapDoc(draft.pending.document) } : undefined,
    resultDocument: await mapDoc(draft.resultDocument),
  }
}
