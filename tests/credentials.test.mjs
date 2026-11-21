/**
 * Credential durability across Host boots with different service activation
 * order: the grant must survive whether or not the DSH credentials service
 * is mounted when the plugin activates.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CredentialStore, credentialRecordKey } from '../lib/credentials.js'
import { noopLogger } from '../lib/logger.js'

const GRANT = { refreshToken: '1//test', accessToken: 'ya29.test', expiresAt: Date.now() + 3_600_000, email: 'u@example.com' }

function fakeService() {
  const records = new Map()
  const calls = []
  return {
    calls,
    records,
    async readRecord(key) { calls.push(['read', key]); return records.get(key) },
    async modifyRecord(key, mutate) {
      calls.push(['modify', key])
      const next = await mutate(records.get(key))
      if (next === undefined) return records.get(key)
      records.set(key, next)
      return next
    },
    async deleteRecord(key) { calls.push(['delete', key]); records.delete(key) },
  }
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-cred-'))
  return { dir, file: path.join(dir, 'credential.json') }
}

test('no service: write and read use the owner-only file', async () => {
  const { dir, file } = tempFile()
  try {
    const store = new CredentialStore({ file, logger: noopLogger })
    assert.equal(store.backend, 'file')
    await store.write(GRANT)
    assert.deepEqual(await store.read(), GRANT)
    // POSIX mode bits are meaningful only off Windows; there the file stays
    // inside the user profile with user-data ACLs instead.
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('service present: write mirrors to BOTH backends', async () => {
  const { dir, file } = tempFile()
  try {
    const service = fakeService()
    const store = new CredentialStore({ getService: () => service, file, logger: noopLogger })
    assert.equal(store.backend, 'credentials-service')
    await store.write(GRANT)
    assert.deepEqual(service.records.get(credentialRecordKey()).payload, GRANT)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), GRANT)
    assert.deepEqual(await store.read(), GRANT)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('service mounts late: file mirror is adopted and migrated', async () => {
  const { dir, file } = tempFile()
  try {
    // Boot 1: service absent → grant lands in the file only.
    const early = new CredentialStore({ getService: () => undefined, file, logger: noopLogger })
    await early.write(GRANT)
    assert.equal(fs.existsSync(file), true)

    // Boot 2: service present but empty → read must NOT report "signed out".
    const service = fakeService()
    const late = new CredentialStore({ getService: () => service, file, logger: noopLogger })
    const read = await late.read()
    assert.deepEqual(read, GRANT)
    assert.deepEqual(service.records.get(credentialRecordKey()).payload, GRANT)
    assert.ok(service.calls.some(([op]) => op === 'modify'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('service record wins over an older file mirror', async () => {
  const { dir, file } = tempFile()
  try {
    const service = fakeService()
    const newer = { ...GRANT, accessToken: 'ya29.newer' }
    service.records.set(credentialRecordKey(), { kind: 'grant', payload: newer })
    fs.writeFileSync(file, JSON.stringify(GRANT))
    const store = new CredentialStore({ getService: () => service, file, logger: noopLogger })
    assert.deepEqual(await store.read(), newer)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('lazy getService: service appearing after construction is picked up', async () => {
  const { dir, file } = tempFile()
  try {
    let service
    const store = new CredentialStore({ getService: () => service, file, logger: noopLogger })
    await store.write(GRANT)
    assert.equal(store.backend, 'file')
    service = fakeService()
    assert.equal(store.backend, 'credentials-service')
    assert.deepEqual(await store.read(), GRANT)
    assert.deepEqual(service.records.get(credentialRecordKey()).payload, GRANT)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('delete removes both backends', async () => {
  const { dir, file } = tempFile()
  try {
    const service = fakeService()
    const store = new CredentialStore({ getService: () => service, file, logger: noopLogger })
    await store.write(GRANT)
    await store.delete()
    assert.equal(fs.existsSync(file), false)
    assert.equal(service.records.size, 0)
    assert.equal(await store.read(), undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('service read failure falls back to the file mirror', async () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, JSON.stringify(GRANT))
    const service = {
      async readRecord() { throw new Error('store unavailable') },
      async modifyRecord() { throw new Error('store unavailable') },
      async deleteRecord() {},
    }
    const store = new CredentialStore({ getService: () => service, file, logger: noopLogger })
    assert.deepEqual(await store.read(), GRANT)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
