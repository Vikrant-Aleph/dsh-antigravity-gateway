/**
 * Slash commands: /antigravity-gateway (alias /agw).
 *
 * status | login | cancel | logout | import | models | refresh
 * Commands run directly against the agent without creating a model message.
 * All actions share the AccountService with the settings UI; account
 * controls fail closed when the Host's WebServer is not loopback-bound.
 */
import type { GatewayLogger } from '../core/logger.js'
import { noopLogger } from '../core/logger.js'
import type { AccountService } from './account-service.js'
import { LOOPBACK_REQUIRED_MESSAGE } from './rpc.js'
import type { CommandContext, CommandDefinitionLike } from './types.js'

export type { CommandContext }

export interface CommandDeps {
  account: AccountService
  accountMode: 'enabled' | 'blocked'
  loginTimeoutMs: number
  logger?: GatewayLogger
}

const USAGE = [
  'Usage: /agw <action>',
  '  status   Show login and catalog status (default)',
  '  login    Start Google OAuth sign-in (opens the browser)',
  '  cancel   Cancel a pending sign-in',
  '  logout   Remove the locally stored credential',
  '  import   Import the active account from dsh-antigravity-auth',
  '  models   List the models offered to this account',
  '  refresh  Force a live catalog refresh',
].join('\n')

async function run(deps: CommandDeps, rawInput: string): Promise<{ kind: 'success' | 'error'; text: string }> {
  const logger = deps.logger ?? noopLogger
  const action = rawInput.trim().split(/\s+/)[0]?.toLowerCase() || 'status'
  if (deps.accountMode === 'blocked') {
    return { kind: 'error', text: LOOPBACK_REQUIRED_MESSAGE }
  }
  try {
    switch (action) {
      case 'status': {
        const status = await deps.account.status()
        const tierParts = [
          status.tier?.current ? `${status.tier.current.name ?? status.tier.current.id} (${status.tier.current.id})` : undefined,
          status.tier?.paid ? `paid: ${status.tier.paid.name ?? status.tier.paid.id}` : undefined,
        ].filter((item): item is string => item !== undefined)
        const lines = [
          `Antigravity Gateway: ${status.loggedIn ? 'signed in' : 'not signed in'}`,
          `credential backend: ${status.backend}`,
          ...(status.email ? [`account: ${status.email}`] : []),
          ...(status.projectId ? [`project: ${status.projectId}`] : []),
          ...(tierParts.length > 0 ? [`plan tier: ${tierParts.join(', ')}`] : []),
          ...(status.expiresAt !== undefined ? [`access token expires: ${new Date(status.expiresAt).toISOString()}`] : []),
          ...(status.loginPending ? ['a sign-in is pending; complete it in the browser or /agw cancel'] : []),
          ...(status.loginError ? [`last sign-in error: ${status.loginError}`] : []),
          ...(!status.loggedIn && !status.loginPending ? ['run /agw login, or /agw import to reuse a dsh-antigravity-auth account'] : []),
        ]
        return { kind: 'success', text: lines.join('\n') }
      }
      case 'login': {
        const { url } = await deps.account.login()
        return {
          kind: 'success',
          text: [
            'Sign-in started. Complete Google authorization in the browser.',
            'If no browser opened, visit this URL manually:',
            url,
            'Then run /agw status. The flow times out after ' + Math.round(deps.loginTimeoutMs / 1000) + 's; /agw cancel aborts it.',
          ].join('\n'),
        }
      }
      case 'cancel': {
        const { cancelled } = deps.account.cancel()
        return { kind: 'success', text: cancelled ? 'Pending sign-in cancelled.' : 'No sign-in is pending.' }
      }
      case 'logout': {
        await deps.account.logout()
        return { kind: 'success', text: 'Signed out. The local credential was removed (the Google grant itself is not revoked).' }
      }
      case 'import': {
        const result = await deps.account.import()
        return {
          kind: 'success',
          text: `Imported the active dsh-antigravity-auth account${result.email ? ` (${result.email})` : ''}. Run /agw models to see its catalog.`,
        }
      }
      case 'models':
      case 'refresh': {
        const result = await deps.account.models({ force: action === 'refresh' })
        if ('available' in result) {
          const lines: string[] = []
          const tierLabel = [
            result.tier?.current ? `${result.tier.current.name ?? result.tier.current.id} (${result.tier.current.id})` : undefined,
            result.tier?.paid ? `paid: ${result.tier.paid.name ?? result.tier.paid.id}` : undefined,
          ].filter(Boolean).join(', ')
          lines.push(`Catalog source: ${result.source} (checked ${result.checkedAt})${tierLabel ? ` · tier: ${tierLabel}` : ''}`)
          if (result.error) lines.push(`Note: ${result.error}`)
          if (result.quotaGroups.length > 0) {
            lines.push('', 'Quota:')
            for (const group of result.quotaGroups) {
              const bucketText = group.buckets
                .map((b) => `${b.window ?? b.displayName}: ${Math.round(b.remainingFraction * 100)}%${b.resetTime ? ` (resets ${b.resetTime})` : ''}`)
                .join(' · ')
              lines.push(`  ${group.displayName}: ${bucketText}`)
            }
          }
          lines.push('', `Available models (${result.available.length}):`)
          for (const model of result.available) {
            const efforts = model.efforts.join('/')
            const quota = model.remainingFraction !== undefined ? `  quota: ${Math.round(model.remainingFraction * 100)}%` : ''
            const tag = model.tagTitle ? `  [${model.tagTitle}]` : ''
            lines.push(`  ${model.id}${efforts ? `  (efforts: ${efforts})` : ''}${quota}${tag}`)
          }
          if (result.unavailable.length > 0) {
            lines.push('', `Unavailable on this account (${result.unavailable.length}):`)
            for (const model of result.unavailable) {
              const reason = [model.reasonTitle, model.reasonDetail].filter(Boolean).join(' — ')
              lines.push(`  ${model.id}  [${model.status}]${reason ? `  ${reason}` : ''}`)
            }
          }
          lines.push('', 'Select an available model in the DSH model picker under the "Antigravity Gateway" provider.')
          return { kind: 'success', text: lines.join('\n') }
        }
        const lines = result.models.map((model) => {
          const efforts = model.efforts.join('/')
          return `  ${model.id}${efforts ? `  (efforts: ${efforts})` : ''}`
        })
        return {
          kind: 'success',
          text: [`Models offered to this account (${result.models.length}):`, ...lines, '', 'Select one in the DSH model picker under the "Antigravity Gateway" provider.'].join('\n'),
        }
      }
      default:
        return { kind: 'error', text: `Unknown action "${action}".\n${USAGE}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('command', `action ${action} failed`, { error: message.slice(0, 200) })
    return { kind: 'error', text: `Antigravity Gateway: ${message}` }
  }
}

/** Register the command and its short alias. Returns one disposer. */
export function registerCommands(ctx: CommandContext, deps: CommandDeps): () => void {
  const commands = ctx.get?.('commands') as { register(definition: CommandDefinitionLike): () => void } | undefined
  if (!commands?.register) return () => {}
  const disposers: (() => void)[] = []
  const definition = (name: string): CommandDefinitionLike => ({
    name,
    description: 'Antigravity Gateway account and model catalog controls (status|login|cancel|logout|import|models|refresh)',
    input: { hint: '[status|login|cancel|logout|import|models|refresh]' },
    handler: async ({ rawInput }) => run(deps, rawInput),
  })
  for (const name of ['antigravity-gateway', 'agw']) {
    try {
      disposers.push(commands.register(definition(name)))
    } catch {
      // Name collision with another plugin; the other registration still works.
    }
  }
  return () => {
    for (const dispose of disposers) void dispose()
  }
}
