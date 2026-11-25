import test from 'node:test'
import assert from 'node:assert/strict'
import {
  replaceContextProse,
  compatibleSectionText,
  compatiblePromptAssembly,
  mountPromptCompatibility,
} from '../lib/dsh/prompt-compat.js'

test('replaceContextProse rewrites harness prose while preserving quoted paths and URLs', () => {
  const input =
    'Using DeepSeek Harness in "C:\\Program Files\\DeepSeek Harness\\app" and "/opt/DeepSeek Harness" and "https://example.com/DeepSeek Harness".'
  const out = replaceContextProse(input, false)
  assert.ok(out.startsWith('Using host application in '))
  assert.ok(out.includes('"C:\\Program Files\\DeepSeek Harness\\app"'))
  assert.ok(out.includes('"/opt/DeepSeek Harness"'))
  assert.ok(out.includes('"https://example.com/DeepSeek Harness"'))
})

test('replaceContextProse rewrites browser-surface sentence only when browserSurface is true', () => {
  const sentence = 'The browser provides no implicit DOM, route, or screenshot context.'
  assert.equal(replaceContextProse(sentence, false), sentence)
  assert.equal(
    replaceContextProse(sentence, true),
    'The page provides no implicit markup, route, or capture context.',
  )
})

test('compatibleSectionText targets only named identity/source/web-surface sections', () => {
  assert.equal(
    compatibleSectionText('harness:identity', 'You are an AI agent powered by DeepSeek Harness.'),
    'You are an AI coding assistant.',
  )
  assert.equal(
    compatibleSectionText('harness:source', 'Checkout: DeepSeek Harness'),
    'Checkout: host application',
  )
  assert.equal(
    compatibleSectionText('other:section', 'You are an AI agent powered by DeepSeek Harness.'),
    'You are an AI agent powered by DeepSeek Harness.',
  )
})

test('compatiblePromptAssembly transforms only owned routes and avoids double-tagging', () => {
  const base = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'instructions', text: 'Stay concise.' },
    ],
    contexts: [
      { name: 'harness:source', text: 'Running inside DeepSeek Harness.' },
      { name: 'app:web-surface', text: 'The browser provides no implicit DOM, route, or screenshot context.' },
    ],
    variables: { provider: 'antigravity-gateway' },
  }

  const untouched = compatiblePromptAssembly(base, { provider: 'other-provider' }, (p) => p === 'antigravity-gateway')
  assert.equal(untouched, base)

  const transformed = compatiblePromptAssembly(base, undefined, (p) => p === 'antigravity-gateway')
  assert.notEqual(transformed, base)
  assert.equal(transformed.sections[0].text, 'You are an AI coding assistant.')
  assert.equal(transformed.sections[1].text, 'Stay concise.')
  assert.equal(transformed.contexts[0].name, 'antigravity-gateway-compat:harness:source')
  assert.equal(transformed.contexts[0].text, 'Running inside host application.')
  assert.equal(transformed.contexts[1].name, 'antigravity-gateway-compat:app:web-surface')
  assert.equal(transformed.contexts[1].text, 'The page provides no implicit markup, route, or capture context.')

  const withExistingCompat = {
    sections: [],
    contexts: [
      { name: 'harness:source', text: 'DeepSeek Harness' },
      { name: 'antigravity-gateway-compat:harness:source', text: 'already' },
    ],
  }
  const skipped = compatiblePromptAssembly(withExistingCompat, { provider: 'antigravity-gateway' }, () => true)
  assert.equal(skipped, withExistingCompat)
})

test('mountPromptCompatibility hooks system-prompt/assemble and disposes listener + fiber', async () => {
  let handler
  let listenerOff = 0
  let fiberDisposed = 0
  const ctx = {
    inject(names, cb) {
      assert.deepEqual(names, ['systemPrompt'])
      cb({
        inject: ctx.inject,
        on(event, fn) {
          assert.equal(event, 'system-prompt/assemble')
          handler = fn
          return () => {
            listenerOff += 1
          }
        },
      })
      return {
        dispose() {
          fiberDisposed += 1
        },
      }
    },
    on() {
      return () => {}
    },
  }

  const dispose = mountPromptCompatibility(ctx, (p) => p === 'antigravity-gateway')
  assert.equal(typeof handler, 'function')

  const result = await handler(
    {},
    { provider: 'antigravity-gateway' },
    async () => ({
      sections: [{ name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' }],
      contexts: [],
    }),
  )
  assert.equal(result.sections[0].text, 'You are an AI coding assistant.')

  dispose()
  assert.equal(listenerOff, 1)
  assert.equal(fiberDisposed, 1)
})
