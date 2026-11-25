## Summary

<!-- Briefly describe what this PR changes and why. -->

## Related Layer(s)

- [ ] `src/shared/` (zero internal/host deps)
- [ ] `src/protocol/` (pure Antigravity wire protocol; zero `@deepseek-ai/*`, `undici`, `fs`, `http`, `child_process`)
- [ ] `src/core/` (runtime transport, OAuth, credentials, catalog, logger; zero `@deepseek-ai/*`)
- [ ] `src/dsh/` (DSH host adapter, RPC, commands, prompt-compat)
- [ ] `client.js` (zero-bundler settings UI; strict `// @ts-check`)
- [ ] Docs / CI / Tests

## Checklist

- [ ] `npm run verify` passes (`typecheck:ts`, `typecheck:client`, `build`, and all offline tests including `architecture.test.mjs` and `client-contract.test.mjs`)
- [ ] No live Google/network calls added in tests
- [ ] Bug fixes include dedicated regression tests
- [ ] Wire semantics or DSH contracts unchanged (or documented in `TECHNICAL*.md` / `CHANGELOG.md`)
- [ ] No secrets, tokens, or personal paths committed
