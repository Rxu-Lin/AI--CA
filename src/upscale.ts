export const upscaleModes = [
  { id: 'fidelity', label: '保真修复', model: 'High Fidelity V3', description: '保留产品造型、材质与原有细节，适合产品摄影和生成图。' },
  { id: 'text', label: '文字与海报', model: 'Text Refine', description: '强化文字与图形边缘，适合包装、Logo 和海报；请检查小字。' },
  { id: 'cgi', label: '3D 与插画', model: 'CGI', description: '适合 3D 渲染、模型效果图与插画。' },
] as const

export type UpscaleMode = typeof upscaleModes[number]['id']
export type UpscaleSettings = { mode: UpscaleMode; factor: 2 | 4; sharpen?: number; denoise?: number; strength?: number }
export type UpscaleJob = UpscaleSettings & { requestId: string; width: number; height: number }
export type UpscaleInput = UpscaleSettings & { imageUrl: string; width: number; height: number }
export type UpscaleImage = { imageUrl: string; width: number; height: number }
// Keep very large results within the canvas viewer's memory budget.
export const upscaleMaxPixels = 64_000_000
export const upscaleMaxSide = 16_384

export function upscaleDimensions(width: number, height: number, factor: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || ![2, 4].includes(factor)) throw new Error('原图尺寸或放大倍数无效。')
  const output = { width: width * factor, height: height * factor }
  if (output.width * output.height > upscaleMaxPixels || Math.max(output.width, output.height) > upscaleMaxSide) throw new Error('输出不能超过 6400 万像素或单边 16384px，请降低倍数或使用较小原图。')
  return output
}

export function upscaleCost(width: number, height: number) {
  return Math.ceil(width * height / 24_000_000) * 0.08
}
