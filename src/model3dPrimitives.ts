import * as THREE from 'three'
import type { ParametricPrimitiveKind, ParametricPrimitiveSettings } from './model3dSceneStore.ts'

type Settings = Required<ParametricPrimitiveSettings>
const common = { radius: 100, height: 200, length: 200, width: 200, color: '#FFFFFF', widthSegments: 32, heightSegments: 24 }
export const primitiveDefaults: Record<ParametricPrimitiveKind, Settings> = {
  cylinder: { ...common, kind: 'cylinder', height: 220 },
  cuboid: { ...common, kind: 'cuboid', height: 180, length: 260 },
  sphere: { ...common, kind: 'sphere' },
}
export const primitiveLabels: Record<ParametricPrimitiveKind, string> = { cylinder: '圆柱', cuboid: '方形', sphere: '球体' }
type Parameter = readonly ['radius' | 'height' | 'length' | 'width' | 'widthSegments' | 'heightSegments', string, number, number, number]
export const primitiveParameters: Record<ParametricPrimitiveKind, readonly Parameter[]> = {
  cylinder: [['radius', '半径', 10, 300, 5], ['height', '高度', 10, 600, 5]],
  cuboid: [['length', '长度', 10, 600, 5], ['width', '宽度', 10, 600, 5], ['height', '高度', 10, 600, 5]],
  sphere: [['radius', '半径', 10, 300, 5], ['widthSegments', '水平分段', 8, 128, 1], ['heightSegments', '垂直分段', 4, 128, 1]],
}

export function normalizePrimitiveSettings(source: ParametricPrimitiveSettings): Settings {
  const defaults = primitiveDefaults[source.kind]
  if (!defaults) throw new Error('不支持的基础模型类型。')
  const next = { ...defaults, ...source }
  for (const [key, , min, max] of primitiveParameters[source.kind]) {
    const value = Number(next[key])
    next[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaults[key]
    if (key === 'widthSegments' || key === 'heightSegments') next[key] = Math.round(next[key])
  }
  return next
}

export function createPrimitiveGeometry(source: ParametricPrimitiveSettings) {
  const settings = normalizePrimitiveSettings(source)
  const unit = 0.01
  if (settings.kind === 'sphere') return new THREE.SphereGeometry(settings.radius * unit, settings.widthSegments, settings.heightSegments)
  if (settings.kind === 'cylinder') return new THREE.CylinderGeometry(settings.radius * unit, settings.radius * unit, settings.height * unit, 64)
  return new THREE.BoxGeometry(settings.length * unit, settings.height * unit, settings.width * unit)
}
