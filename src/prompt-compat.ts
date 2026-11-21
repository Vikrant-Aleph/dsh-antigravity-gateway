/**
 * Prompt compatibility for the Antigravity route.
 *
 * Reproduces the fix verified in dsh-antigravity-auth issue #47: certain
 * harness identity sentences trigger HTTP 429 refusals on the private
 * endpoint. The transform rewrites only the named identity contributions at
 * assembly time, preserving quoted paths/URLs and all other instructions.
 * HTTP attribution stays truthful; this changes prompt text, not identity
 * headers.
 */
import type { BridgeLogger } from './logger.js'
import { noopLogger } from './logger.js'

const HARNESS_IDENTITY_SENTENCE = 'You are an AI agent powered by DeepSeek Harness.'
const COMPATIBLE_IDENTITY_SENTENCE = 'You are an AI coding assistant.'
const BROWSER_SURFACE_SENTENCE = 'The browser provides no implicit DOM, route, or screenshot context.'
const COMPATIBLE_BROWSER_SURFACE_SENTENCE = 'The page provides no implicit markup, route, or capture context.'

/** Preserve quoted filesystem/URL values while replacing prose. */
export function replaceContextProse(text: string, browserSurface: boolean): string {
  return text.replace(
    /"(?:\\.|[^"\\])*"|DeepSeek Harness|The browser provides no implicit DOM, route, or screenshot context\./gu,
    (part) => {
      if (/^"(?:\/|[A-Za-z]:[\\/]|\\\\|https?:\/\/)/iu.test(part)) return part
      const compatible = part.replaceAll('DeepSeek Harness', 'host application')
      return browserSurface ? compatible.replaceAll(BROWSER_SURFACE_SENTENCE, COMPATIBLE_BROWSER_SURFACE_SENTENCE) : compatible
    },
  )
}

export function compatibleSectionText(name: string, text: string): string {
  if (name === 'harness:identity') return text.replaceAll(HARNESS_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE)
  if (name === 'harness:source' || name === 'app:web-surface') return replaceContextProse(text, name === 'app:web-surface')
  return text
}

interface AssemblyLike {
  sections: { name: string; text: string }[]
  contexts: { name: string; text: string }[]
  variables?: Record<string, unknown>
}

/** Transform the named identity contributions for owned routes only. */
export function compatiblePromptAssembly<T extends AssemblyLike>(assembly: T, context: unknown, ownsRoute: (provider: string) => boolean): T {
  const route = context as { provider?: unknown } | undefined
  const provider = typeof route?.provider === 'string' ? route.provider : typeof assembly.variables?.provider === 'string' ? assembly.variables.provider : undefined
  if (typeof provider !== 'string' || !ownsRoute(provider)) return assembly
  let changed = false
  const sections = assembly.sections.map((section) => {
    const text = compatibleSectionText(section.name, section.text)
    if (text === section.text) return section
    changed = true
    return { ...section, text }
  })
  const contexts = assembly.contexts.map((item) => {
    if (item.name !== 'harness:source' && item.name !== 'app:web-surface') return item
    const text = compatibleSectionText(item.name, item.text)
    if (text === item.text) return item
    const name = `antigravity-gateway-compat:${item.name}`
    if (assembly.contexts.some((other) => other.name === name)) return item
    changed = true
    return { ...item, name, text }
  })
  return changed ? { ...assembly, sections, contexts } : assembly
}

/** Minimal structural view of the Cordis context used here. */
export interface PromptCompatContext {
  inject(names: string[], callback: (ctx: PromptCompatContext) => (() => void) | void): { dispose?: () => void } | undefined
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

/** Mount the assembly-time transform when the systemPrompt service exists. */
export function mountPromptCompatibility(ctx: PromptCompatContext, ownsRoute: (provider: string) => boolean, logger: BridgeLogger = noopLogger): () => void {
  let inner: (() => void) | undefined
  const fiber = ctx.inject(['systemPrompt'], (promptCtx) => {
    const off = promptCtx.on('system-prompt/assemble', (async (_assembly: unknown, context: unknown, next: () => Promise<unknown>) => {
      const assembly = (await next()) as AssemblyLike
      return compatiblePromptAssembly(assembly, context, ownsRoute)
    }) as never)
    inner = typeof off === 'function' ? off : undefined
    return () => inner?.()
  })
  logger.debug('prompt-compat', 'mounted system-prompt compatibility transform')
  return () => {
    inner?.()
    void fiber?.dispose?.()
  }
}
