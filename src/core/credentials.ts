/**
 * Credential persistence for the gateway's Google OAuth grants.
 *
 * Preferred backend: an injected credential store (`CredentialsServiceLike`),
 * which keeps secrets out of configuration and survives restarts. Fallback:
 * a plugin-owned JSON file with owner-only permissions.
 *
 * Supports both legacy single-account payloads (v0.1.0) and multi-account
 * vaults (`version: 2`) seamlessly, keeping single-account serialization in the
 * v1 shape for full backward compatibility.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { CREDENTIAL_ID, CREDENTIAL_OWNER } from '../protocol/constants.js'
import { GatewayError } from '../shared/errors.js'
import { writeFileAtomicSync } from '../shared/fs-atomic.js'
import { isRecord } from '../shared/guards.js'
import type { GatewayLogger } from './logger.js'
import { noopLogger } from './logger.js'

export interface GatewayCredential {
  refreshToken: string
  accessToken?: string
  /** Epoch milliseconds when the access token expires. */
  expiresAt?: number
  projectId?: string
  email?: string
}

/** @deprecated Use {@link GatewayCredential}. Kept during 0.x for compatibility. */
export type BridgeCredential = GatewayCredential

export interface GatewayAccountRecord extends GatewayCredential {
  id: string
  addedAt?: number
}

export interface CredentialVault {
  version: 2
  activeAccountId: string
  accounts: GatewayAccountRecord[]
}

/** Minimal structural view of the DSH credentials service. */
export interface CredentialsServiceLike {
  readRecord(key: string): Promise<{ kind?: string; payload?: unknown } | undefined>
  modifyRecord(
    key: string,
    mutate: (current: { kind?: string; payload?: unknown } | undefined) => Promise<{ kind: string; payload: unknown } | undefined>,
  ): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}

export function credentialRecordKey(): string {
  return `${CREDENTIAL_OWNER}/${CREDENTIAL_ID}`
}

/** Default fallback file: <profile or ~/.dsh>/dsh-antigravity-gateway/credential.json */
export function defaultCredentialFile(): string {
  const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-antigravity-gateway', 'credential.json')
}

function isCredential(value: unknown): value is GatewayCredential {
  if (!isRecord(value)) return false
  return typeof value.refreshToken === 'string' && value.refreshToken.length > 0
}

const SHARED_PROJECT_IDS = new Set(['aicode-consumers', 'inductive-dreamer-qrkws'])

export function deriveAccountId(credential: Pick<GatewayCredential, 'refreshToken' | 'projectId' | 'email'>): string {
  if (typeof credential.email === 'string' && credential.email.trim().length > 0) {
    const hash = createHash('sha256').update(credential.email.trim().toLowerCase()).digest('hex').slice(0, 12)
    return `acct:${hash}`
  }
  if (
    typeof credential.projectId === 'string' &&
    credential.projectId.length > 0 &&
    !SHARED_PROJECT_IDS.has(credential.projectId)
  ) {
    return `proj:${credential.projectId}`
  }
  const hash = createHash('sha256').update(credential.refreshToken).digest('hex').slice(0, 12)
  return `acct:${hash}`
}

function toPlainCredential(credential: GatewayCredential): GatewayCredential {
  return {
    refreshToken: credential.refreshToken,
    ...(typeof credential.accessToken === 'string' && credential.accessToken.length > 0 ? { accessToken: credential.accessToken } : {}),
    ...(typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt) ? { expiresAt: credential.expiresAt } : {}),
    ...(typeof credential.projectId === 'string' && credential.projectId.length > 0 ? { projectId: credential.projectId } : {}),
    ...(typeof credential.email === 'string' && credential.email.length > 0 ? { email: credential.email } : {}),
  }
}

function parseVault(raw: unknown): CredentialVault | undefined {
  if (isRecord(raw) && raw.version === 2 && Array.isArray(raw.accounts)) {
    const accounts: GatewayAccountRecord[] = []
    for (const item of raw.accounts) {
      if (!isCredential(item)) continue
      const recordItem = item as unknown as Record<string, unknown>
      const id = typeof recordItem.id === 'string' && recordItem.id.length > 0 ? recordItem.id : deriveAccountId(item)
      const addedAt = typeof recordItem.addedAt === 'number' && Number.isFinite(recordItem.addedAt) ? recordItem.addedAt : undefined
      accounts.push({
        ...toPlainCredential(item),
        id,
        ...(addedAt !== undefined ? { addedAt } : {}),
      })
    }
    if (accounts.length === 0) return undefined
    const requestedActive = typeof raw.activeAccountId === 'string' ? raw.activeAccountId : ''
    const active = accounts.some((a) => a.id === requestedActive) ? requestedActive : accounts[0]!.id
    return { version: 2, activeAccountId: active, accounts }
  }
  if (isCredential(raw)) {
    const plain = toPlainCredential(raw)
    const id = deriveAccountId(plain)
    return {
      version: 2,
      activeAccountId: id,
      accounts: [{ ...plain, id }],
    }
  }
  return undefined
}

function serializeVault(vault: CredentialVault): unknown {
  if (vault.accounts.length === 1) {
    return toPlainCredential(vault.accounts[0]!)
  }
  return vault
}

function sameAccountIdentity(existing: GatewayAccountRecord, incoming: GatewayCredential): boolean {
  const existingEmail = existing.email?.trim().toLowerCase()
  const incomingEmail = incoming.email?.trim().toLowerCase()
  if (existingEmail && incomingEmail) {
    return existingEmail === incomingEmail
  }
  if (
    existing.projectId &&
    incoming.projectId &&
    !SHARED_PROJECT_IDS.has(existing.projectId) &&
    !SHARED_PROJECT_IDS.has(incoming.projectId) &&
    existing.projectId === incoming.projectId
  ) {
    return true
  }
  return existing.refreshToken === incoming.refreshToken
}

export class CredentialStore {
  private readonly getService: (() => CredentialsServiceLike | undefined) | undefined
  private readonly file: string
  private readonly logger: GatewayLogger
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: {
    service?: CredentialsServiceLike
    /** Lazy resolution: the credentials service may mount after this plugin. */
    getService?: () => CredentialsServiceLike | undefined
    file?: string
    logger?: GatewayLogger
  }) {
    this.getService = options.getService ?? (options.service ? () => options.service : undefined)
    this.file = options.file || defaultCredentialFile()
    this.logger = options.logger ?? noopLogger
  }

  /** Resolve the service per operation; activation order must not matter. */
  private service(): CredentialsServiceLike | undefined {
    try {
      return this.getService?.()
    } catch {
      return undefined
    }
  }

  get backend(): 'credentials-service' | 'file' {
    return this.service() ? 'credentials-service' : 'file'
  }

  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn)
    this.writeQueue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  async readVault(): Promise<CredentialVault | undefined> {
    const service = this.service()
    if (service) {
      try {
        const record = await service.readRecord(credentialRecordKey())
        const parsed = parseVault(record?.payload)
        if (parsed) return parsed
      } catch (error) {
        this.logger.warn('credentials', 'credential record read failed; trying file mirror', {
          error: String(error).slice(0, 200),
        })
      }
      // Adopt file mirror when service holds no valid record (e.g. late service mount).
      const mirrored = this.readFileVault()
      if (mirrored) {
        try {
          await service.modifyRecord(credentialRecordKey(), async () => ({
            kind: 'grant',
            payload: serializeVault(mirrored),
          }))
          this.logger.info('credentials', 'migrated file mirror into the credential store')
        } catch (error) {
          this.logger.warn('credentials', 'mirror migration failed; keeping file mirror', {
            error: String(error).slice(0, 200),
          })
        }
        return mirrored
      }
      return undefined
    }
    return this.readFileVault()
  }

  async readActiveAccount(): Promise<GatewayAccountRecord | undefined> {
    const vault = await this.readVault()
    if (!vault) return undefined
    return vault.accounts.find((a) => a.id === vault.activeAccountId) ?? vault.accounts[0]
  }

  async listAccounts(): Promise<{ activeAccountId?: string; accounts: GatewayAccountRecord[] }> {
    const vault = await this.readVault()
    if (!vault) return { accounts: [] }
    return { activeAccountId: vault.activeAccountId, accounts: [...vault.accounts] }
  }

  async read(): Promise<GatewayCredential | undefined> {
    const active = await this.readActiveAccount()
    return active ? toPlainCredential(active) : undefined
  }

  async write(credential: GatewayCredential): Promise<void> {
    if (!isCredential(credential)) throw new Error('refusing to store a credential without a refresh token')
    await this.withWriteLock(async () => {
      const existing = await this.readVault()
      const plain = toPlainCredential(credential)
      if (!existing) {
        const id = deriveAccountId(plain)
        await this.persistVault({ version: 2, activeAccountId: id, accounts: [{ ...plain, id }] })
        return
      }
      const idx = existing.accounts.findIndex((a) => a.id === existing.activeAccountId)
      const targetIndex = idx >= 0 ? idx : 0
      const current = existing.accounts[targetIndex]!
      existing.accounts[targetIndex] = {
        ...plain,
        id: current.id,
        ...(current.addedAt !== undefined ? { addedAt: current.addedAt } : {}),
      }
      await this.persistVault(existing)
    })
  }

  async updateAccount(accountId: string, credential: GatewayCredential): Promise<void> {
    if (!isCredential(credential)) throw new Error('refusing to store a credential without a refresh token')
    await this.withWriteLock(async () => {
      const existing = await this.readVault()
      if (!existing) return
      const idx = existing.accounts.findIndex((a) => a.id === accountId)
      if (idx === -1) return
      const current = existing.accounts[idx]!
      existing.accounts[idx] = {
        ...toPlainCredential(credential),
        id: current.id,
        ...(current.addedAt !== undefined ? { addedAt: current.addedAt } : {}),
      }
      await this.persistVault(existing)
    })
  }

  async addAccount(credential: GatewayCredential, options: { activate?: boolean } = {}): Promise<GatewayAccountRecord> {
    if (!isCredential(credential)) throw new Error('refusing to store a credential without a refresh token')
    return this.withWriteLock(async () => {
      const plain = toPlainCredential(credential)
      const existing = await this.readVault()
      const activate = options.activate !== false
      if (!existing) {
        const id = deriveAccountId(plain)
        const record: GatewayAccountRecord = { ...plain, id, addedAt: Date.now() }
        await this.persistVault({ version: 2, activeAccountId: id, accounts: [record] })
        return record
      }
      const matchIndex = existing.accounts.findIndex((a) => sameAccountIdentity(a, plain))
      if (matchIndex !== -1) {
        const prev = existing.accounts[matchIndex]!
        const updated: GatewayAccountRecord = {
          ...plain,
          id: prev.id,
          addedAt: prev.addedAt ?? Date.now(),
        }
        existing.accounts[matchIndex] = updated
        if (activate) existing.activeAccountId = updated.id
        await this.persistVault(existing)
        return updated
      }
      const baseId = deriveAccountId(plain)
      let id = baseId
      let suffix = 2
      while (existing.accounts.some((a) => a.id === id)) {
        id = `${baseId}-${suffix}`
        suffix += 1
      }
      const added: GatewayAccountRecord = { ...plain, id, addedAt: Date.now() }
      existing.accounts.push(added)
      if (activate) existing.activeAccountId = added.id
      await this.persistVault(existing)
      return added
    })
  }

  async setActiveAccount(accountId: string): Promise<GatewayAccountRecord> {
    return this.withWriteLock(async () => {
      const existing = await this.readVault()
      const target = existing?.accounts.find((a) => a.id === accountId)
      if (!existing || !target) {
        throw new GatewayError(`Account "${accountId}" is not signed in`, 'MISSING_CREDENTIAL')
      }
      if (existing.activeAccountId !== accountId) {
        existing.activeAccountId = accountId
        await this.persistVault(existing)
      }
      return target
    })
  }

  async switchAccountIfCurrent(expectedActiveId: string, nextAccountId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const existing = await this.readVault()
      if (!existing || existing.activeAccountId !== expectedActiveId) return false
      if (!existing.accounts.some((a) => a.id === nextAccountId)) return false
      existing.activeAccountId = nextAccountId
      await this.persistVault(existing)
      return true
    })
  }

  async removeAccount(accountId?: string): Promise<{ removed: boolean; removedId?: string; nextActiveId?: string }> {
    return this.withWriteLock(async () => {
      const existing = await this.readVault()
      if (!existing) return { removed: false }
      const targetId = accountId ?? existing.activeAccountId
      const remaining = existing.accounts.filter((a) => a.id !== targetId)
      if (remaining.length === existing.accounts.length) {
        return { removed: false }
      }
      if (remaining.length === 0) {
        await this.deleteUnchecked()
        return { removed: true, removedId: targetId }
      }
      const nextActiveId =
        existing.activeAccountId === targetId
          ? remaining[0]!.id
          : remaining.some((a) => a.id === existing.activeAccountId)
            ? existing.activeAccountId
            : remaining[0]!.id
      await this.persistVault({ version: 2, activeAccountId: nextActiveId, accounts: remaining })
      return { removed: true, removedId: targetId, nextActiveId }
    })
  }

  async delete(): Promise<void> {
    await this.withWriteLock(() => this.deleteUnchecked())
  }

  private async deleteUnchecked(): Promise<void> {
    const service = this.service()
    if (service) {
      try {
        await service.deleteRecord(credentialRecordKey())
      } catch (error) {
        this.logger.warn('credentials', 'credential record delete failed', { error: String(error).slice(0, 200) })
      }
    }
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file)
    } catch {
      // Best effort.
    }
  }

  private async persistVault(vault: CredentialVault): Promise<void> {
    const payload = serializeVault(vault)
    const service = this.service()
    if (service) {
      try {
        await service.modifyRecord(credentialRecordKey(), async () => ({
          kind: 'grant',
          payload,
        }))
      } catch (error) {
        this.logger.warn('credentials', 'credential record write failed; file mirror still holds the grant', {
          error: String(error).slice(0, 200),
        })
      }
    }
    writeFileAtomicSync(this.file, JSON.stringify(payload, null, 2), { mode: 0o600 })
  }

  private readFileVault(): CredentialVault | undefined {
    try {
      if (!fs.existsSync(this.file)) return undefined
      const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return parseVault(value)
    } catch {
      return undefined
    }
  }
}
