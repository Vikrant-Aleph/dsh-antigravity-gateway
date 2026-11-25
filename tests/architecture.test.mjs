import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const SRC_ROOT = path.resolve('src')
const LAYERED_DIRS = new Set(['shared', 'protocol', 'core', 'dsh'])

function collectTsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function layerOf(filePath) {
  const rel = path.relative(SRC_ROOT, filePath).replace(/\\/g, '/')
  if (rel === 'index.ts') return 'index'
  const head = rel.split('/')[0]
  if (LAYERED_DIRS.has(head)) return head
  return 'legacy'
}

function extractSpecifiers(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2022, true)
  const specs = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) specs.push(arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs
}

function resolveLocalTs(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const raw = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    raw.replace(/\.js$/, '.ts'),
    `${raw}.ts`,
    path.join(raw, 'index.ts'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

const FORBIDDEN_PROTOCOL_STDLIB = new Set([
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
  'node:os',
  'node:path',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'child_process',
  'os',
  'path',
])

const ALLOWED_LOCAL_LAYERS = {
  shared: new Set(['shared']),
  protocol: new Set(['shared', 'protocol']),
  core: new Set(['shared', 'protocol', 'core']),
  dsh: new Set(['shared', 'protocol', 'core', 'dsh']),
  index: new Set(['shared', 'protocol', 'core', 'dsh', 'index']),
}

test('layered modules obey unidirectional dependency boundaries', () => {
  const allFiles = collectTsFiles(SRC_ROOT)
  const legacyFiles = allFiles.filter((file) => layerOf(file) === 'legacy').map((f) => path.relative(SRC_ROOT, f))
  assert.deepEqual(legacyFiles, [], `Legacy flat files must not remain in src/: ${legacyFiles.join(', ')}`)

  const files = allFiles
  const violations = []
  const graph = new Map()

  for (const file of files) {
    const layer = layerOf(file)
    const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/')
    const specs = extractSpecifiers(file)
    const deps = []

    for (const spec of specs) {
      if (!spec.startsWith('.')) {
        if (spec.startsWith('@deepseek-ai/') && layer !== 'dsh') {
          violations.push(`${rel} (${layer}) must not import ${spec}`)
        }
        if (spec === 'undici' && (layer === 'shared' || layer === 'protocol')) {
          violations.push(`${rel} (${layer}) must not import undici`)
        }
        if (layer === 'protocol' && FORBIDDEN_PROTOCOL_STDLIB.has(spec)) {
          violations.push(`${rel} (protocol) must not import I/O stdlib ${spec}`)
        }
        continue
      }

      const target = resolveLocalTs(file, spec)
      assert.ok(target, `${rel}: cannot resolve relative import ${spec}`)
      const targetLayer = layerOf(target)
      const targetRel = path.relative(SRC_ROOT, target).replace(/\\/g, '/')

      if (targetLayer === 'legacy') {
        violations.push(`${rel} (${layer}) must not import legacy flat module ${targetRel}`)
        continue
      }
      if (!ALLOWED_LOCAL_LAYERS[layer].has(targetLayer)) {
        violations.push(`${rel} (${layer}) -> ${targetRel} (${targetLayer}) violates layer order`)
      }
      if (layer === 'protocol' && targetRel === 'shared/fs-atomic.ts') {
        violations.push(`${rel} (protocol) must not import shared/fs-atomic.ts`)
      }
      deps.push(target)
    }
    graph.set(file, deps)
  }

  assert.deepEqual(violations, [], `Architecture boundary violations:\n${violations.join('\n')}`)

  // Cycle detection across layered modules.
  const visiting = new Set()
  const visited = new Set()
  const cycles = []
  const dfs = (node, trail) => {
    if (visited.has(node)) return
    if (visiting.has(node)) {
      const idx = trail.indexOf(node)
      cycles.push(trail.slice(idx).concat(node).map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, '/')).join(' -> '))
      return
    }
    visiting.add(node)
    for (const dep of graph.get(node) ?? []) dfs(dep, [...trail, node])
    visiting.delete(node)
    visited.add(node)
  }
  for (const file of files) dfs(file, [])
  assert.deepEqual(cycles, [], `Dependency cycles detected:\n${cycles.join('\n')}`)
})
