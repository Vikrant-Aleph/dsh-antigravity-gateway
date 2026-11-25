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
import { CredentialStore, credentialRecordKey } from '../lib/core/credentials.js'
import { writeFileAtomicSync } from '../lib/shared/fs-atomic.js'
import { noopLogger } from '../lib/core/logger.js'

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

test('concurrent atomic writes leave valid JSON and zero orphaned temp files', async () => {
  const { dir, file } = tempFile()
  try {
    const store = new CredentialStore({ file, logger: noopLogger })
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.write({ ...GRANT, accessToken: `ya29.concurrent-${i}` }),
      ),
    )
    const saved = await store.read()
    assert.match(saved.accessToken, /^ya29\.concurrent-\d+$/)
    const entries = fs.readdirSync(dir)
    assert.deepEqual(entries, ['credential.json'])

    // Failed write (target path is an existing directory) cleans up its temp file.
    const dirTarget = path.join(dir, 'occupied-dir')
    fs.mkdirSync(dirTarget)
    assert.throws(() => writeFileAtomicSync(dirTarget, '{}'))
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('multi-account vault upgrades from v1, deduplicates identities, switches with CAS, and removes cleanly', async () => {
  const { dir, file } = tempFile()
  try {
    const service = fakeService()
    const store = new CredentialStore({ getService: () => service, file, logger: noopLogger })

    // 1. Legacy v1 single-account write remains v1 shape on disk/service.
    await store.write({ refreshToken: '1//a', accessToken: 'ya29.a', expiresAt: 10_000, email: 'a@example.com', projectId: 'proj-a' })
    const rawV1 = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(rawV1.version, undefined)
    assert.equal(rawV1.email, 'a@example.com')

    // 2. Adding second account upgrades to v2 vault and activates account B.
    const accB = await store.addAccount({ refreshToken: '1//b', accessToken: 'ya29.b', expiresAt: 20_000, email: 'b@example.com', projectId: 'proj-b' })
    const listed = await store.listAccounts()
    assert.equal(listed.accounts.length, 2)
    assert.equal(listed.activeAccountId, accB.id)
    assert.equal((await store.read()).email, 'b@example.com')

    const accA = listed.accounts.find((a) => a.email === 'a@example.com')
    assert.ok(accA)

    // 3. Updating non-active account A preserves active B.
    await store.updateAccount(accA.id, { refreshToken: '1//a', accessToken: 'ya29.a2', expiresAt: 30_000, email: 'a@example.com', projectId: 'proj-a' })
    assert.equal((await store.read()).email, 'b@example.com')

    // 4. Duplicate email updates in place without creating a 3rd entry.
    await store.addAccount({ refreshToken: '1//a-new', accessToken: 'ya29.a3', expiresAt: 40_000, email: 'A@example.com', projectId: 'proj-a' }, { activate: false })
    assert.equal((await store.listAccounts()).accounts.length, 2)
    assert.equal((await store.read()).email, 'b@example.com')

    // 5. CAS switchAccountIfCurrent prevents double-skipping.
    assert.equal(await store.switchAccountIfCurrent('wrong-id', accA.id), false)
    assert.equal(await store.switchAccountIfCurrent(accB.id, accA.id), true)
    assert.equal((await store.read()).email, 'A@example.com')

    // 6. Removing active account A promotes B back to active; removing B clears storage.
    const rem1 = await store.removeAccount(accA.id)
    assert.equal(rem1.removed, true)
    assert.equal(rem1.nextActiveId, accB.id)
    assert.equal((await store.read()).email, 'b@example.com')

    const rem2 = await store.removeAccount()
    assert.equal(rem2.removed, true)
    assert.equal(rem2.nextActiveId, undefined)
    assert.equal(await store.read(), undefined)
    assert.equal(fs.existsSync(file), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('accounts sharing aicode-consumers projectId do not overwrite each other', async () => {
  const { dir, file } = tempFile()
  try {
    const store = new CredentialStore({ file, logger: noopLogger })
    await store.addAccount({
      refreshToken: '1//alice',
      accessToken: 'ya29.alice',
      expiresAt: 10_000,
      email: 'alice@gmail.com',
      projectId: 'aicode-consumers',
    })
    await store.addAccount({
      refreshToken: '1//bob',
      accessToken: 'ya29.bob',
      expiresAt: 20_000,
      email: 'bob@gmail.com',
      projectId: 'aicode-consumers',
    })
    // Even without email, shared projectId aicode-consumers must not merge distinct refreshTokens.
    await store.addAccount({
      refreshToken: '1//charlie',
      accessToken: 'ya29.charlie',
      expiresAt: 30_000,
      projectId: 'aicode-consumers',
    })

    const listed = await store.listAccounts()
    assert.equal(listed.accounts.length, 3)
    assert.ok(listed.accounts.some((a) => a.email === 'alice@gmail.com'))
    assert.ok(listed.accounts.some((a) => a.email === 'bob@gmail.com'))
    assert.ok(listed.accounts.some((a) => a.refreshToken === '1//charlie'))

    // No-email accounts with shared projectId derive unique token-hashed IDs (never proj:aicode-consumers).
    const noEmailA = await store.addAccount({ refreshToken: '1//noemail-a', accessToken: 'ya29.na', expiresAt: 10_000, projectId: 'aicode-consumers' })
    const noEmailB = await store.addAccount({ refreshToken: '1//noemail-b', accessToken: 'ya29.nb', expiresAt: 10_000, projectId: 'aicode-consumers' })
    assert.ok(noEmailA.id.startsWith('acct:'))
    assert.ok(noEmailB.id.startsWith('acct:'))
    assert.notEqual(noEmailA.id, noEmailB.id)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
