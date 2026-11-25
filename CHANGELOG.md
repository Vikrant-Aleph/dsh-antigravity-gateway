# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release notes on GitHub are extracted from the matching section below.

## [Unreleased]

### Added

- Settings **Models** tab quota visualization: clear hierarchical cards (`agw-panel-header`, quota cards with bold `5h` / `weekly` labels, prominent percentages, full-width 5px progress bars, and reset countdown + local time; streamlined available model rows showing model display name, status, and efforts without redundant model ID, duplicate quota, or verbose description text, plus collapsible unavailable models).
- Chat composer compact 5-hour quota label (`5h | XX%`) mounted via `conversation.input.right` immediately to the left of the model selector when a model owned by this plugin is selected — borderless, matching the model trigger's UI font and `13px`/`28px` alignment at semibold (`600`) weight, with a body-portaled hover card showing full account, selected-model, and group quota details.
- Multi-account management (`CredentialVault` v2 with automatic backward-compatible single-account v1 persistence and migration): add/import multiple Google accounts, view account list, switch active account, and remove individual accounts from Settings → Account or `/agw accounts` · `/agw switch` · `/agw logout [all]`.
- Per-account isolated memory and disk catalog caches (`catalog-cache.json` v2) and automatic quota-exhaustion failover (`autoSwitchAccount: true` by default): on HTTP `429`, in-stream `RESOURCE_EXHAUSTED`, or pre-flight known `0%` quota, seamlessly switches to an eligible backup account while preserving the user's selected model and reasoning effort.

## [0.1.0] - 2026-11-22

Initial release.

### Added

- LLM adapter registering the `antigravity-gateway` provider route, speaking the
  Antigravity (Cloud Code Assist) client wire protocol: CLI-shaped headers,
  `v1internal:streamGenerateContent?alt=sse` streaming, agent request metadata
  (cascade/trajectory labels, `model_enum`, FNV-1a session id), and endpoint
  fallback from daily to production.
- Per-account live model catalog via `v1internal:fetchAvailableModels`, with a
  pinned fallback snapshot and configurable `extraModels`. **No client-side
  retirement gate**: the offering follows the account's own live catalog,
  and requests for any pinned model are attempted regardless of listing.
- Availability detection from the same upstream response: plan-locked models
  (`disabled: true`, e.g. `gemini-4-*-disabled`) are excluded from the
  picker and reported with the upstream reason (`tagTitle` /
  `tagDescription`); per-model `quotaInfo` (`remainingFraction`, `resetTime`)
  marks exhausted models with a warning badge in the picker; upstream
  `agentModelSorts` order the offering.
- Account tier and quota summary from `v1internal:loadCodeAssist`
  (`currentTier` / `paidTier`) and `v1internal:retrieveUserQuotaSummary`
  (5-hour and weekly groups), surfaced in the settings Models tab and
  `/agw models`.
- Account-scoped disk cache (`catalog-cache.json`, non-secret): a failed
  live probe falls back to the account's last verified offering instead of
  the full snapshot, so disabled models never reappear after an offline
  boot; the pinned snapshot is used only before the first successful probe.
- Pinned routes for the Claude Opus/Sonnet 4.6 and 5.5 series (thinking
  tiers), Gemini 3.8 Flash, Gemini 4 Neon/Hydrogen/Carbon/Argon (including
  XHigh), and GPT-OSS 120B Medium, with per-tier wire enums and thinking
  budgets.
- Tool-parameter schema sanitization: a whitelist projection onto the
  endpoint's Schema subset (`const` → single-value `enum`, unsupported
  JSON Schema keywords dropped), fixing HTTP 400 INVALID_ARGUMENT on tools
  whose schemas use `oneOf`/`const`.
- Self-contained Google OAuth sign-in (PKCE S256, loopback callback on
  `127.0.0.1:51121`), single-flight token refresh, `loadCodeAssist` project
  discovery, and credential storage in the DSH credential store with an
  owner-only file fallback.
- Credential durability across Host restarts: the grant always mirrors to
  the owner-only file, the credentials service resolves lazily per
  operation, and an empty service record adopts and migrates the file
  mirror — sign-in survives boots where the credentials service mounts
  late or not at all. The settings page states that sign-in persists until
  sign-out while the ~hourly access token refreshes automatically.
- `/antigravity-gateway` (alias `/agw`) commands: `status`, `login`, `cancel`,
  `logout`, `import`, `models`, `refresh`. `import` explicitly reuses the
  active account cached by `dsh-antigravity-auth` without modifying it.
- Settings page (**Settings → Antigravity Gateway**, English/Chinese): an
  Account tab with one-click Google sign-in, pending-login polling with an
  authorization-link fallback, import from dsh-antigravity-auth, and sign-out;
  a Models tab listing the account's live catalog; a
  Diagnostic-log tab (level filter / refresh / copy / clear). Backed by
  `/api/antigravity-gateway-account/*` RPC behind the same loopback guard as
  dsh-antigravity-auth: account controls fail closed unless the Host has no
  WebServer or it is bound to 127.0.0.1. Commands and UI share one
  AccountService implementation.
- Claude route transforms: VALIDATED tool-calling mode, per-tool
  `functionDeclarations`, empty-schema placeholders, tool-name sanitization,
  STRICT PARAMETERS description hardening, interleaved-thinking hint, and
  consecutive `functionResponse` grouping.
- Parallel same-name tool calls stay separate blocks: a tool-call block that
  already holds argument text never concatenates another call's JSON;
  upstream call `id`s are preserved and reused for correlation.
- Thinking-signature replay: signatures ride in `replayState` and return on
  the next turn; the `skip_thought_signature_validator` sentinel covers
  missing signatures after restarts or cross-model history.
- Image input: durable image attachments project to `inlineData` with a
  per-image byte cap; unavailable images degrade to placeholder text.
- Prompt compatibility (default on): rewrites the harness identity sentences
  behind the reproduced HTTP 429 refusals (dsh-antigravity-auth issue #47),
  preserving quoted paths and URLs.
- Bounded, redacted diagnostic logging: level filtering, rotation with
  oldest-first cleanup, memory fallback, secret/Bearer/Google-token scrubbing;
  `antigravity_gateway_log` agent tool and `/api/antigravity-gateway-logs/*` RPC
  routes (read/stat/clear/level).
- Failure classification into the DSH taxonomy: one credential-refresh replay
  on 401/403, `RATE_LIMIT` with `Retry-After`, `CONTEXT_WINDOW_EXCEEDED` on
  overflow wording, bounded capacity retries on 503, transport fallback,
  and `MODEL_UNSUPPORTED` with the upstream disabled/not-offered reason when
  a plan-locked model answers 404.
- Windows system-proxy auto-detection for every outbound call (config → env
  → registry ProxyServer, cached 5 minutes, `useSystemProxy: false` to
  disable): GUI-started Hosts inherit no shell proxy env vars, so the
  gateway follows the same route as the browser/IDE instead of timing out
  on direct connects. Transport-failure logs carry the undici cause code.
- Offline test suite (106 tests, `node --test`): model resolution, tool-schema
  sanitization, envelope and label shape, SSE parsing, OAuth flow (including
  the full login round trip against a local callback), account RPC loopback
  policy, credential durability across service activation order, logger
  bounds/redaction, availability & quota parsing (disabled-model exclusion,
  cache fallback), parallel same-name tool calls, Windows system-proxy
  parsing and fallback, and end-to-end adapter streams against a local fake
  endpoint.
- GitHub Actions: CI (Node 22/24 × Ubuntu/Windows, typecheck + build + tests)
  and tag-triggered releases (`v*`) with identity checks, packed-archive
  validation, SHA256 checksums, and changelog-derived release notes.
- Documentation: README (中文/English), TECHNICAL (中文/English), and the
  plugin detail page.

### Known limitations

- Account controls (settings page and commands) require a local Host: no
  WebServer, or a WebServer bound to 127.0.0.1.
- Text output only; image generation, search grounding, and video understand-
  ing remain with other plugins (e.g. `dsh-antigravity-auth`).
- TLS is Node's stack, not the CLI's Electron fingerprint; the endpoint does
  not currently gate on it (dated observation, see TECHNICAL §2.4).
- Model availability and limits follow the account's backend; pinned limits
  are community-capture observations, not official publications.
