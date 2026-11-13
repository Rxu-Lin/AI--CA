import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as THREE from 'three'
import { createPrimitiveGeometry, normalizePrimitiveSettings, primitiveDefaults } from '../src/model3dPrimitives.ts'

const component = readFileSync(new URL('../src/Model3DStudio.tsx', import.meta.url), 'utf8')
function componentFunctions(names, dependencies) {
  const ast = ts.createSourceFile('Model3DStudio.tsx', component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functions = []
  function visit(node) { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast)); ts.forEachChild(node, visit) }
  visit(ast); assert.equal(functions.length, names.length)
  const context = vm.createContext({ THREE, createPrimitiveGeometry, normalizePrimitiveSettings, ...dependencies })
  vm.runInContext(ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  return context
}
function dimensions(geometry) {
  geometry.computeBoundingBox()
  return geometry.boundingBox.getSize(new THREE.Vector3()).toArray().map(value => Math.round(value * 1000) / 1000)
}

test('sphere geometry follows radius and segments, while cylinder/cuboid dimensions remain compatible', () => {
  for (const [settings, size] of [[primitiveDefaults.sphere, [2, 2, 2]], [primitiveDefaults.cylinder, [2, 2.2, 2]], [primitiveDefaults.cuboid, [2.6, 1.8, 2]]]) {
    const geometry = createPrimitiveGeometry(settings)
    assert.deepEqual(dimensions(geometry), size)
    geometry.dispose()
  }
  const low = createPrimitiveGeometry({ ...primitiveDefaults.sphere, radius: 150, widthSegments: 8, heightSegments: 4 })
  const detailed = createPrimitiveGeometry({ ...primitiveDefaults.sphere, widthSegments: 48, heightSegments: 32 })
  assert.deepEqual(dimensions(low), [3, 3, 3])
  assert.equal(low.index.count / 3, 48)
  assert.equal(detailed.index.count / 3, 48 * 31 * 2)
  low.dispose(); detailed.dispose()
})

test('sphere segmentation and radius are bounded, finite and compatible with saved primitives lacking segment fields', () => {
  const settings = normalizePrimitiveSettings({ ...primitiveDefaults.sphere, radius: Infinity, widthSegments: 1000, heightSegments: 0 })
  assert.equal(settings.radius, 100); assert.equal(settings.widthSegments, 128); assert.equal(settings.heightSegments, 4)
  assert.equal(normalizePrimitiveSettings({ ...primitiveDefaults.sphere, widthSegments: 17.6 }).widthSegments, 18)
  const { widthSegments: _width, heightSegments: _height, ...legacy } = primitiveDefaults.cylinder
  assert.equal(normalizePrimitiveSettings(legacy).widthSegments, 32)
  assert.throws(() => normalizePrimitiveSettings({ ...legacy, kind: 'unsupported' }), /不支持/)
})

test('editing a sphere disposes the previous geometry, keeps the material and rests the mesh on the ground', () => {
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial({ color: '#ffffff' })
  const previous = new THREE.SphereGeometry(1)
  root.add(new THREE.Mesh(previous, material))
  let geometryDisposals = 0, materialDisposals = 0
  previous.addEventListener('dispose', () => geometryDisposals++)
  material.addEventListener('dispose', () => materialDisposals++)
  const item = { object: root, material, parametricPrimitive: { settings: { ...primitiveDefaults.sphere } } }
  const context = componentFunctions(['rebuildParametricPrimitive', 'disposeObjectGeometries', 'collectModelStats'], {})
  context.rebuildParametricPrimitive(item)
  const first = root.children[0].geometry
  first.addEventListener('dispose', () => geometryDisposals++)
  item.parametricPrimitive.settings.radius = 200
  context.rebuildParametricPrimitive(item)
  assert.equal(geometryDisposals, 2)
  assert.equal(materialDisposals, 0)
  assert.equal(root.children.length, 1)
  assert.equal(root.children[0].material, material)
  assert.deepEqual(dimensions(root.children[0].geometry), [4, 4, 4])
  const bounds = new THREE.Box3().setFromObject(root)
  assert.equal(bounds.min.y, 0)
  assert.equal(bounds.max.y, 4)
  assert.equal(item.stats.triangles, 1472)
  root.children[0].geometry.dispose(); material.dispose()
})

test('expired undo objects release GPU resources while active and reachable undo objects remain available', () => {
  const active = {}, undo = {}, parameter = {}, transform = {}, expired = {}
  const all = new Set([active, undo, parameter, transform, expired]), disposed = []
  const context = componentFunctions(['releaseUnusedSceneItems'], {
    sceneItemsRef: { current: [active] }, sceneHistoryRef: { current: [{ items: [{ item: undo }] }] },
    transformStartSnapshotRef: { current: { items: [{ item: transform }] } }, parameterEditSnapshotRef: { current: { items: [{ item: parameter }] } },
    allSceneItemsRef: { current: all }, disposeModel: (object, material) => disposed.push([object, material]),
  })
  context.releaseUnusedSceneItems()
  assert.equal(disposed.length, 1); assert.equal(all.has(expired), false); assert.equal(all.size, 4)
  context.sceneHistoryRef.current = []
  context.releaseUnusedSceneItems()
  assert.equal(disposed.length, 2); assert.equal(all.has(undo), false); assert.equal(all.has(active), true)
})
