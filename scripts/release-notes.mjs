/**
 * Extract one version's CHANGELOG section as GitHub Release notes.
 * Usage: node scripts/release-notes.mjs <version> --out <file>
 *
 * The section starts at `## [X.Y.Z]` (or `## X.Y.Z`) and ends before the next
 * `## ` heading. Keeping release notes identical to the changelog section
 * means the published page never drifts from the committed history.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const version = process.argv[2]
const outIndex = process.argv.indexOf('--out')
const out = outIndex !== -1 ? process.argv[outIndex + 1] : undefined
if (!version || !out) {
  console.error('release-notes: usage <version> --out <file>')
  process.exit(1)
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const startPattern = new RegExp(`^## \\[?${escaped}\\]?[^\\n]*`, 'm')
const match = startPattern.exec(changelog)
if (!match) {
  console.error(`release-notes: no CHANGELOG section for ${version}`)
  process.exit(1)
}
const rest = changelog.slice(match.index + match[0].length)
const nextHeading = rest.search(/^## /m)
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim()
if (body.length === 0) {
  console.error(`release-notes: CHANGELOG section for ${version} is empty`)
  process.exit(1)
}
fs.writeFileSync(out, `${body}\n`, 'utf8')
console.log(`release-notes: wrote ${out} (${body.length} chars)`)
