# Contributing to dsh-antigravity-gateway

Thank you for contributing! Keep changes focused, minimal, and faithful to the plugin's architecture and non-goals.

## Prerequisites

- Node.js `>=20.18.1` (CI runs Node 22 and 24 on Ubuntu and Windows)
- `npm ci`

## Development Workflow

1. Read [AGENTS.md](AGENTS.md) and [TECHNICAL.us.md](TECHNICAL.us.md) (or [TECHNICAL.md](TECHNICAL.md)) for the four-layer dependency rules:
   - `src/shared/` → zero internal/host dependencies
   - `src/protocol/` → pure protocol logic only (`shared` + `node:crypto`/`node:buffer`; no `@deepseek-ai/*`, `undici`, `fs`, `http`, `child_process`)
   - `src/core/` → runtime I/O and state (`shared`, `protocol`, `undici`, Node stdlib; no `@deepseek-ai/*`)
   - `src/dsh/` → DSH host adaptation (only directory allowed to import `@deepseek-ai/*`)
   - `client.js` → zero-bundler browser module checked via `tsconfig.client.json`
2. Create a feature or fix branch off `main` and use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
3. Every bug fix must include a deterministic **offline** regression test using `node:test` (never call real Google endpoints in tests).
4. Before opening a PR, verify everything passes cleanly:

```sh
npm run verify
```

5. If your change affects model definitions, protocol handling, or DSH host integration, update [TECHNICAL.md](TECHNICAL.md) / [TECHNICAL.us.md](TECHNICAL.us.md) and [CHANGELOG.md](CHANGELOG.md) accordingly.
