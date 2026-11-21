/**
 * Write or verify SHA256SUMS for the release archives in a directory.
 * Usage: node scripts/release-checksum.mjs <dir> [--verify]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const dir = process.argv[2]
const verify = process.argv.includes('--verify')
if (!dir || !fs.existsSync(dir)) {
  console.error('release-checksum: directory argument required')
  process.exit(1)
}

const archives = fs.readdirSync(dir).filter((name) => name.endsWith('.tgz')).sort()
if (archives.length === 0) {
  console.error('release-checksum: no .tgz archives found')
  process.exit(1)
}

const sumsFile = path.join(dir, 'SHA256SUMS')
if (!verify) {
  const lines = archives.map((name) => {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
    return `${hash}  ${name}`
  })
  fs.writeFileSync(sumsFile, `${lines.join('\n')}\n`, 'utf8')
  console.log(`release-checksum: wrote ${sumsFile} (${archives.length} archive(s))`)
} else {
  if (!fs.existsSync(sumsFile)) {
    console.error('release-checksum: SHA256SUMS missing')
    process.exit(1)
  }
  const expected = new Map(
    fs.readFileSync(sumsFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [hash, name] = line.split(/\s+/)
        return [name, hash]
      }),
  )
  let failed = false
  for (const name of archives) {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
    if (expected.get(name) !== hash) {
      console.error(`release-checksum: MISMATCH for ${name}`)
      failed = true
    }
  }
  if (failed) process.exit(1)
  console.log(`release-checksum: ${archives.length} archive(s) verified`)
}
