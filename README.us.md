# dsh-antigravity-gateway

[中文](README.md) | English

Use Google Antigravity models — Claude, Gemini, GPT-OSS — in
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).
Self-contained Google OAuth sign-in; no Antigravity IDE or CLI installation
required.

**Design note**: the model offering follows **each account's own live
catalog** (the server returns different lists per plan/region), with no
client-side retirement gate: whatever your account can use in Antigravity
is offered here. Coexists with `dsh-antigravity-auth`; one-click sign-in or
import from the settings page.

> **Unofficial, experimental, personal use only.** Google does not support
> third-party Antigravity login tools; your account may be suspended or
> terminated. Read the [Google FAQ](https://antigravity.google/docs/faq/) and
> [Additional Terms](https://antigravity.google/terms) before signing in.
> Private endpoints can change or stop working without notice. Do not rely on
> this plugin for production workloads.

## What it provides

| Capability | DSH entry point |
|---|---|
| Language models | `Antigravity Gateway` provider in the model selector (route `antigravity-gateway`), hiding models disabled on the account plan |
| Claude Opus / Sonnet | 4.6 and 5.5 series per account catalog, low/medium/high thinking efforts |
| Gemini 3.8 Flash / 4 Neon / Hydrogen / Carbon / Argon | Including XHigh (Neon/Hydrogen); plan-locked models show upstream reasons in Settings |
| GPT-OSS 120B Medium | `gpt-oss-120b-medium` |
| Account & availability check | Settings → Antigravity Gateway (Account / Models / Logs tabs with tier, quota remaining, and disabled reasons), or `/agw status · login · cancel · logout · import · models · refresh` |
| Diagnostic log | `antigravity_gateway_log` tool (read/stat/level/clear); bounded, redacted, rotated |
| Image input | Session image attachments sent as `inlineData` (configurable cap) |

Coexists with `dsh-antigravity-auth`: distinct provider routes, no conflicts.
`/agw import` explicitly reuses its signed-in account (read-only; its store is
never modified).

## Quick start

### 1. Requirements

- A working DSH installation (development baseline: DSH `0.2.2-rc.5`, Desktop
  profile).
- Node.js `>=20.18.1`.
- A Google account with Antigravity access (available models vary by plan).
- Sign-in needs a browser on the Host machine; the OAuth callback binds
  `127.0.0.1:51121` (the redirect registered for the Antigravity CLI client;
  configurable via `oauthPort`).

### 2. Install

From a GitHub Release tarball:

```sh
dsh plugin --profile desktop add ./dsh-antigravity-gateway-0.1.0.tgz
```

Or pick the local directory/archive under **Plugins → Add plugin** in DSH.
From source:

```sh
git clone https://github.com/Vikrant-Aleph/dsh-antigravity-gateway.git
cd dsh-antigravity-gateway
npm ci
npm run build
dsh plugin --profile desktop add .
```

Restart the Host and refresh the client afterwards. The plugin row
「Antigravity Gateway」 should appear in Plugins.

### 3. Sign in

**Settings page (recommended)**: open **Settings → Antigravity Gateway** and
click **Sign in with Google** on the Account tab. After browser authorization
the card flips to signed-in automatically. The same page imports an existing
antigravity-auth account, signs out, lists the account's live catalog on the
Models tab, and reads/clears the diagnostic log on the Logs tab.

If `dsh-antigravity-auth` is already installed and signed in, click
**Import from antigravity-auth** (reads its auth.json read-only, then
refreshes tokens on its own).

When no browser opens, the card shows the authorization link to open
manually. The URL carries no secret; the PKCE verifier stays in Host memory.

Command alternative:

```text
/agw login     # opens the browser for Google authorization; then /agw status
/agw import    # explicitly import dsh-antigravity-auth's active account
```

### 4. Pick a model

Select a model under `Antigravity Gateway` in the DSH model picker, e.g.
`claude-sonnet-5-5`. `/agw models` lists what your account's live
catalog actually offers.

## Commands

```text
/agw status    # login state, credential backend, project id, token expiry (default)
/agw login     # start Google OAuth (PKCE S256 + loopback callback)
/agw cancel    # cancel a pending sign-in
/agw logout    # remove the local credential (does not revoke the Google grant)
/agw import    # import the active account from dsh-antigravity-auth
/agw models    # check and list available/unavailable models, tier, and quota
/agw refresh   # force a fresh upstream probe of catalog and quota
```

`/antigravity-gateway` is the full-name alias of `/agw`.

## Configuration

The plugin row id is `dsh-antigravity-gateway`. Common fields (full schema in
[TECHNICAL.us.md](TECHNICAL.us.md) §6):

```yaml
- id: dsh-antigravity-gateway
  config:
    providers: [antigravity-gateway]   # route names; keep distinct from other plugins
    extraModels: []                   # pinned model ids always advertised
    promptCompatibility: true         # rewrite the harness sentences behind 429 refusals
    imageInput: true                  # inlineData image input
    proxyUrl: ''                      # explicit HTTP proxy; empty reads HTTPS_PROXY etc.
    useSystemProxy: true              # fall back to the Windows system proxy when no env
    logLevel: info                    # debug|info|warn|error|off
    oauthPort: 51121
```

Proxy resolution for both private requests and OAuth token exchange, in
order: the `proxyUrl` config → `HTTPS_PROXY → https_proxy → ALL_PROXY →
all_proxy` → **the Windows per-user proxy settings** (registry
ProxyServer, cached 5 minutes, disable with `useSystemProxy: false`), with
`NO_PROXY` taking precedence; only `http://` proxy URLs are supported
(HTTPS targets tunnel through CONNECT). A GUI-started Host does not inherit
shell proxy env vars; system-proxy auto-detection keeps the gateway on the
same route as the user's browser and IDE. The proxy notes in the
dsh-antigravity-auth README apply as well.

## Diagnostic log

- Location: `~/.dsh/logs/dsh-antigravity-gateway/` by default; under
  `<profile>/logs/dsh-antigravity-gateway/` when the Host process has
  `DSH_PROFILE_DIR` set (or the `logDir` config).
- Bounded: each file ≤ `logMaxBytes` (default 512 KiB), at most `logMaxFiles`
  rotated files; the oldest is deleted first.
- Redacted: configured secrets, `Bearer …`, and Google access/refresh token
  shapes are replaced. Only metadata is logged (model, status, duration,
  token counts) — **never message content**.
- Read it with the `antigravity_gateway_log` agent tool (read/stat/level/clear)
  or the `/api/antigravity-gateway-logs/*` RPC routes.
- Per-request detail at `debug`; success summaries at `info`; failures at
  `warn`.
- `dumpRequestsTo` writes full request envelopes for protocol debugging —
  off by default; the dump contains conversation text, so delete it after use.

## Development

```sh
npm ci
npm run typecheck   # covers both src/**/*.ts and client.js
npm run build
npm test            # builds then runs 145 offline tests; no Google calls
npm run verify      # typecheck + build + full offline suite
```

Coverage: model resolution (wire enums and tier budgets), tool-schema
sanitization, envelope and label shape, SSE parsing, OAuth flow, logger
bounds/redaction, concurrent atomic writes, availability & quota parsing
(disabled-model exclusion and ordered cache fallback), parallel same-name
tool calls, four-layer architecture dependency guards, `client.js` safety &
RPC contract parity, and end-to-end adapter streams against a local fake
endpoint (text / tool calls / 401 refresh replay / 404 diagnosis / 429 / 503
capacity backoff / context overflow / history signature replay). See
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for
contribution guidelines and security invariants.

### Release process

Pushing a version tag publishes a release automatically:

```sh
# 1. bump package.json version and add the CHANGELOG.md section
# 2. commit and tag
git tag v0.1.1
git push origin main v0.1.1
```

`release.yml` validates tag/version/CHANGELOG identity → `npm ci` → build +
offline tests → pack and validate the archive → SHA256 checksums → create the
GitHub Release (notes extracted from the matching CHANGELOG section; tgz and
SHA256SUMS attached). Existing releases are never overwritten. CI (`ci.yml`)
runs a Node 22/24 × Ubuntu/Windows matrix on every push/PR.

## Known limitations

- The settings page requires the Host's WebServer bound to `127.0.0.1`
  (the Desktop default); on any other bind, account controls fail closed
  (same policy as dsh-antigravity-auth).
- Text output only. Image generation, search grounding, and video
  understanding stay with other plugins (e.g. dsh-antigravity-auth).
- TLS is Node's stack, not the CLI's Electron fingerprint; the endpoint does
  not currently gate on it (dated observation, TECHNICAL §2.4).
- Model availability and limits follow the account's backend; pinned limits
  are community-capture observations, not official publications.

## Documentation

- [Technical design (中文)](TECHNICAL.md) · [Technical design (English)](TECHNICAL.us.md)
- [Changelog](CHANGELOG.md) · [GitHub Releases](https://github.com/Vikrant-Aleph/dsh-antigravity-gateway/releases)
- [Report an issue](https://github.com/Vikrant-Aleph/dsh-antigravity-gateway/issues)
  (include plugin/DSH versions, platform, and the error code or HTTP status;
  **never** attach credentials, authorization URLs, tokens, or full traffic
  captures)

## License

[MIT](LICENSE)
