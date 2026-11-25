/**
 * Release identity checks.
 *
 * --tag v<X.Y.Z>            verify package.json version, CHANGELOG section,
 *                           and README version references match the tag.
 * --archive-dir <dir>       additionally verify exactly one packed archive
 *                           named dsh-antigravity-gateway-<version>.tgz exists
 *                           and contains the required runtime files.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function arg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}

const tag = arg('--tag')
const archiveDir = arg('--archive-dir')
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error('release-check: --tag must look like v0.1.0 or v0.2.0-rc.1')
  process.exit(1)
}
const version = tag.slice(1)
const failures = []

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (pkg.version !== version) failures.push(`package.json version ${pkg.version} != tag ${version}`)
if (pkg.name !== 'dsh-antigravity-gateway') failures.push(`unexpected package name ${pkg.name}`)

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const sectionPattern = new RegExp(`^## \\[?${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?`, 'm')
if (!sectionPattern.test(changelog)) failures.push(`CHANGELOG.md has no section for ${version}`)

for (const readme of ['README.md', 'README.us.md']) {
  const file = path.join(root, readme)
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  const mentions = [...text.matchAll(/dsh-antigravity-gateway@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)].map((m) => m[1])
  for (const mention of mentions) {
    if (mention !== version) failures.push(`${readme} references @${mention}, expected @${version}`)
  }
}

if (archiveDir) {
  const entries = fs.readdirSync(archiveDir).filter((name) => name.endsWith('.tgz'))
  const expected = `dsh-antigravity-gateway-${version}.tgz`
  if (entries.length !== 1 || entries[0] !== expected) {
    failures.push(`expected exactly one archive ${expected}, found: ${entries.join(', ') || '(none)'}`)
  } else {
    const listing = execFileSync('tar', ['-tzf', path.join(archiveDir, expected)], { encoding: 'utf8' })
    const required = [
      'package/package.json',
      'package/lib/index.js',
      'package/client.js',
      'package/cordis.patch.yml',
      'package/locale/en.json',
      'package/locale/zh.json',
      'package/icon.svg',
      'package/README.md',
      'package/CHANGELOG.md',
      'package/LICENSE',
    ]
    const entries = new Set(listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    for (const file of required) {
      if (!entries.has(file)) failures.push(`archive is missing ${file}`)
    }
    if (
      listing.includes('package/.npm-cache/') ||
      listing.includes('package/node_modules/') ||
      listing.includes('package/docs/refactoring/') ||
      listing.includes('package/docs/features/')
    ) {
      failures.push('archive contains development-only directories')
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`release-check: ${failure}`)
  process.exit(1)
}
console.log(`release-check: ${tag} identity verified`)
