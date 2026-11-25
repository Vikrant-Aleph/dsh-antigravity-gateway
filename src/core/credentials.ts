/**
 * Credential persistence for the gateway's Google OAuth grant.
 *
 * Preferred backend: an injected credential store (`CredentialsServiceLike`),
 * which keeps secrets out of configuration and survives restarts. Fallback:
 * a plugin-owned JSON file with owner-only permissions.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CREDENTIAL_ID, CREDENTIAL_OWNER } from '../protocol/constants.js'
import { writeFileAtomicSync } from '../shared/fs-atomic.js'
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
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.refreshToken === 'string' && record.refreshToken.length > 0
}

export class CredentialStore {
  private readonly getService: (() => CredentialsServiceLike | undefined) | undefined
  private readonly file: string
  private readonly logger: GatewayLogger

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

  async read(): Promise<GatewayCredential | undefined> {
    const service = this.service()
    if (service) {
      try {
        const record = await service.readRecord(credentialRecordKey())
        if (record && isCredential(record.payload)) return record.payload
      } catch (error) {
        this.logger.warn('credentials', 'credential record read failed; trying file mirror', {
          error: String(error).slice(0, 200),
        })
      }
      // The service has no record (e.g. an earlier boot wrote only the file
      // mirror because the service mounted late). Adopt the mirror and
      // migrate it into the service so both backends agree from now on.
      const mirrored = this.readFile()
      if (mirrored) {
        try {
          await service.modifyRecord(credentialRecordKey(), async () => ({ kind: 'grant', payload: mirrored }))
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
    return this.readFile()
  }

  async write(credential: GatewayCredential): Promise<void> {
    if (!isCredential(credential)) throw new Error('refusing to store a credential without a refresh token')
    const service = this.service()
    if (service) {
      try {
        await service.modifyRecord(credentialRecordKey(), async () => ({
          kind: 'grant',
          payload: credential,
        }))
      } catch (error) {
        this.logger.warn('credentials', 'credential record write failed; file mirror still holds the grant', {
          error: String(error).slice(0, 200),
        })
      }
    }
    // Always mirror to the owner-only file: a later boot whose credentials
    // service mounts late (or not at all) must still find the grant.
    this.writeFile(credential)
  }

  async delete(): Promise<void> {
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

  private readFile(): GatewayCredential | undefined {
    try {
      if (!fs.existsSync(this.file)) return undefined
      const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return isCredential(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  private writeFile(credential: GatewayCredential): void {
    writeFileAtomicSync(this.file, JSON.stringify(credential, null, 2), { mode: 0o600 })
  }
}
