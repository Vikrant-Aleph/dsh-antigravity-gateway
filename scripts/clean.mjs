import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const lib = path.join(root, 'lib')
// Windows: a watcher or indexer may briefly hold a handle on the directory;
// rmSync's built-in retry rides out those transient locks.
fs.rmSync(lib, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
console.log(`cleaned ${lib}`)
