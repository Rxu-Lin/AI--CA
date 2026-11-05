// Reproducible UI fixture, drawn locally. These layers are not AI decomposition results.
import { createCanvas } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const width = 540, height = 675
const canvasFor = paint => { const canvas = createCanvas(width, height); paint(canvas.getContext('2d')); return canvas }
const background = canvasFor(ctx => {
  const fill = ctx.createLinearGradient(0, 0, width, height); fill.addColorStop(0, '#e1e0da'); fill.addColorStop(1, '#a6a8a1')
  ctx.fillStyle = fill; ctx.fillRect(0, 0, width, height)
})
const pedestal = canvasFor(ctx => {
  ctx.fillStyle = '#343631'; ctx.beginPath(); ctx.ellipse(292, 543, 172, 34, 0, 0, Math.PI * 2); ctx.fill()
  const fill = ctx.createLinearGradient(100, 0, 440, 0); fill.addColorStop(0, '#e4e3dc'); fill.addColorStop(.5, '#f4f3ee'); fill.addColorStop(1, '#c9cac3')
  ctx.fillStyle = fill; ctx.fillRect(100, 486, 340, 189); ctx.beginPath(); ctx.ellipse(270, 486, 170, 39, 0, 0, Math.PI * 2); ctx.fill()
})
const bottle = canvasFor(ctx => {
  ctx.save(); ctx.filter = 'blur(13px)'; ctx.fillStyle = '#00000035'; ctx.beginPath(); ctx.ellipse(286, 490, 90, 20, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore()
  const fill = ctx.createLinearGradient(190, 0, 350, 0); fill.addColorStop(0, '#4e5547'); fill.addColorStop(.2, '#8c967a'); fill.addColorStop(.6, '#737f65'); fill.addColorStop(1, '#424d39')
  ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(191, 266, 158, 225, 24); ctx.fill()
  ctx.fillStyle = '#c0bcad'; ctx.beginPath(); ctx.roundRect(220, 225, 100, 54, 7); ctx.fill()
  ctx.fillStyle = '#d8d5ca'; ctx.fillRect(220, 225, 100, 8)
  ctx.fillStyle = '#eeeae1'; ctx.font = '18px Arial'; ctx.textAlign = 'center'; ctx.fillText('FORM', 270, 361)
  ctx.font = '8px Arial'; ctx.fillText('BOTANICAL ESSENCE', 270, 379); ctx.fillText('50 ML / 1.7 FL OZ', 270, 453)
})
const typography = canvasFor(ctx => {
  ctx.fillStyle = '#2e332b'; ctx.textAlign = 'center'; ctx.font = '11px Arial'; ctx.fillText('S T U D I O   /   0 4', 270, 65)
  ctx.font = '52px Georgia'; ctx.fillText('Quiet by nature.', 270, 137)
  ctx.font = '12px Arial'; ctx.fillText('A daily ritual. An essential form.', 270, 171)
  ctx.textAlign = 'left'; ctx.font = '8px Arial'; ctx.fillText('LAYER EDITOR · LOCAL TEST FIXTURE', 28, 642)
})
const canvases = [background, pedestal, bottle, typography]
const names = ['背景', '台面', '产品瓶身', '标题文字（像素）']
const composite = canvasFor(ctx => canvases.forEach(canvas => ctx.drawImage(canvas, 0, 0)))
const source = createCanvas(1080, 1350); source.getContext('2d').drawImage(composite, 0, 0, 1080, 1350)
const imageUrl = source.toDataURL('image/png')
const layerDocument = { version: 1, width: 1080, height: 1350, nativeWidth: width, nativeHeight: height,
  layers: canvases.map((canvas, index) => ({ id: `fixture-layer-${index}`, name: names[index], imageUrl: canvas.toDataURL('image/png'), visible: true, opacity: 1, x: 0, y: 0, width: 1080, height: 1350 })) }
const project = { version: 3, projectName: '图层拆分验证样例', nodes: [
  { id: 'fixture-source', type: 'workflow', position: { x: 80, y: 80 }, data: { kind: 'reference', title: '拆分测试原图', sourceName: '拆分测试样例', imageUrl, status: 'done', size: '1080x1350' } },
  { id: 'fixture-layers', type: 'workflow', position: { x: 540, y: 80 }, data: { kind: 'image', title: '分层结果', sourceName: '拆分测试样例', model: 'Qwen-Image-Layered', imageUrl, sourceImageUrl: imageUrl, layerDocument, size: '1080x1350', status: 'done' } },
], edges: [{ id: 'fixture-edge', source: 'fixture-source', sourceHandle: 'output', target: 'fixture-layers', targetHandle: 'image-1' }], history: [] }
const output = path.resolve('.tmp-exports/layer-qa.json')
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(project)); console.log(output)
