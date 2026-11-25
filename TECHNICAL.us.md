# dsh-antigravity-gateway — Technical design

[中文](TECHNICAL.md) | English

For maintainers of this plugin, and DSH plugin authors looking for a reference
`LlmAdapter` implementation against a private endpoint.

> **Dated snapshot.** Upstream facts were established on 2026-11-22: reading
> the shipped code of `dsh-antigravity-auth@0.1.13` /
> `@cortexkit/antigravity-auth-core@3.1.10` on this machine and fetching
> Google's official model docs. Constants are dated observations, not a
> specification; §10 describes how to refresh them when the protocol drifts.

Guiding principle: **reproduce the official-client details the gateway
checks; implement everything else against DSH's public extension contracts.**
Unlike the reference projects (dsh-opencode-bridge, dsh-antigravity-auth),
this plugin applies no client-side model retirement gate — the catalog is
whatever the account's live response says.

## 1. Architecture

The codebase follows a **lightweight four-layer unidirectional dependency architecture** enforced statically by [architecture.test.mjs](tests/architecture.test.mjs):

```
DSH Host / Cordis / WebServer
   │
   ▼
src/index.ts                              Thin entrypoint (Config wiring, ctx.effect, controlled exports)
   ├──▶ src/dsh/                          DSH host adaptation (ONLY directory allowed to import @deepseek-ai/*)
   │       ├──▶ src/core/                 Runtime core (I/O, transport, OAuth, credentials, catalog, logger)
   │       │       ├──▶ src/protocol/     Pure protocol layer (no host/undici/fs/http/child_process imports)
   │       │       └──▶ src/shared/         Shared primitives & contracts (zero internal dependencies)
   │       ├──▶ src/protocol/
   │       └──▶ src/shared/
   └──▶ src/core/

DSH agent loop
   │  GenerateOptions / messages / tools
   ▼
AntigravityGatewayAdapter                 src/dsh/adapter.ts (@deprecated AntigravityBridgeAdapter alias in 0.x)
   ├── resolveRoute                       model id + effort → wire route (src/protocol/models.ts)
   ├── AuthManager.getCredential          single-flight refresh, caller-abort decoupled (src/core/auth.ts)
   ├── buildEnvelope                      message mapping + Claude transforms + metadata (src/protocol/payload.ts)
   ├── AgyTransport.request               undici bounded dispatcher pool + proxy + timeouts (src/core/transport/)
   ├── iterateSse / parseProviderEvent    SSE → neutral parts (src/core/transport/sse.ts + src/protocol/response.ts)
   └── assembleStreamChunks               StreamChunk state machine + replayState (src/dsh/stream-assembler.ts)
   ▼
https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
   (fallback on transport failure: https://cloudcode-pa.googleapis.com)
```

Modules:

| Layer | Module | Role |
|---|---|---|
| **Shared** | [errors.ts](src/shared/errors.ts) | `GatewayError` classification, `Retry-After`, overflow/capacity detection (`BridgeError` alias in 0.x) |
| **Shared** | [guards.ts](src/shared/guards.ts) | Runtime guards (`isRecord`/`boundedString`) and `raceWithAbort` |
| **Shared** | [fs-atomic.ts](src/shared/fs-atomic.ts) | Cross-platform atomic file writes with unique temp filenames & failure cleanup |
| **Shared** | [rpc-contracts.ts](src/shared/rpc-contracts.ts) | Shared `/api` RPC channel, namespaces, endpoints, and DTO contracts |
| **Protocol** | [constants.ts](src/protocol/constants.ts) | OAuth client, endpoints, paths, CLI identity, Claude prompt constants |
| **Protocol** | [models.ts](src/protocol/models.ts) | Pinned catalog, wire enums, tier resolution, alias normalization (§3) |
| **Protocol** | [session-metadata.ts](src/protocol/session-metadata.ts) | FNV-1a 64 session keys, `RequestSessionStore`, and request labels (§4.2) |
| **Protocol** | [schema-sanitizer.ts](src/protocol/schema-sanitizer.ts) | Tool-parameter JSON Schema whitelist projection & empty-schema placeholder (§4.3) |
| **Protocol** | [payload.ts](src/protocol/payload.ts) | Envelope, field order, message/tool mapping, Claude transforms, signature replay (§4) |
| **Protocol** | [response.ts](src/protocol/response.ts) | SSE event parsing, usage, finishReason, signature extraction (§5) |
| **Protocol** | [catalog-parser.ts](src/protocol/catalog-parser.ts) | Pure parsers for `fetchAvailableModels`, quota summary, tier metadata, and reports (§3.2) |
| **Core** | [transport/](src/core/transport/index.ts) | Env/Windows proxy (`proxy.ts`), bounded `Dispatcher` pool (`http-client.ts`), abort-responsive SSE (`sse.ts`) |
| **Core** | [credentials.ts](src/core/credentials.ts) | DSH credential record first, owner-only atomic file mirror & late-mount migration (§8) |
| **Core** | [oauth.ts](src/core/oauth.ts) | PKCE S256, loopback callback server, token exchange/refresh (§8) |
| **Core** | [auth.ts](src/core/auth.ts) | Login orchestration, decoupled single-flight refresh, project discovery, explicit import (§8) |
| **Core** | [catalog.ts](src/core/catalog.ts) | Per-account live catalog: single-flight probe, TTL, order-preserving cache & fallback (§3.2) |
| **Core** | [logger.ts](src/core/logger.ts) | Bounded redacted log + in-memory ring fallback (§9) |
| **DSH** | [types.ts](src/dsh/types.ts), [config.ts](src/dsh/config.ts) | Host structural interfaces; Schemastery `Config` single source of truth deriving `GatewayConfig` |
| **DSH** | [rpc.ts](src/dsh/rpc.ts) | Unified `/api` JSON-RPC registrar, validation, loopback guard & full fiber/route disposal |
| **DSH** | [stream-assembler.ts](src/dsh/stream-assembler.ts), [adapter.ts](src/dsh/adapter.ts) | DSH `LlmAdapter` implementation, chunk state machine, retries & error mapping (§7) |
| **DSH** | [account-service.ts](src/dsh/account-service.ts), [log-service.ts](src/dsh/log-service.ts) | Single-implementation account & log services (UI RPC + `/agw` commands / `antigravity_gateway_log` tool) |
| **DSH** | [commands.ts](src/dsh/commands.ts), [prompt-compat.ts](src/dsh/prompt-compat.ts) | `/agw` command family (§6.2) and 429 identity-sentence rewrite hook (§4.4) |
| **Client/Entry** | [client.js](client.js), [index.ts](src/index.ts) | Zero-bundler settings module (`tsconfig.client.json`-checked, §6.3) & thin wiring entrypoint |

Terms: **wire route** = the model name the endpoint accepts; **enum** = the
`MODEL_PLACEHOLDER_M…` value in `labels.model_enum`; **pinned snapshot** =
the built-in definition table; **live catalog** = the model set the account
receives from fetchAvailableModels.

## 2. Client identity

### 2.1 Request headers

| Header | Value | Notes |
|---|---|---|
| `User-Agent` | `antigravity/cli/1.5.8 (aidev_client; os_type=windows; arch=amd64; cl=1020628950; auth_method=consumer)` | agy CLI 1.5.8 capture shape; platform/arch are truthful |
| `Authorization` | `Bearer <access token>` | OAuth token |
| `Content-Type` | `application/json` | |
| `Accept-Encoding` | `gzip` | undici decompresses automatically |

Difference from the CLI (recorded honestly): CLI content requests use
HTTP/1.1 `Transfer-Encoding: chunked` (core's `buildAgyCliHeaderPairs`); this
plugin sends undici's Content-Length form. As of 2026-11-22 there is no
evidence the endpoint checks this layer; third-party implementations such as
CLIProxyAPI work with ordinary HTTP clients. If a future 400/403 suggests
transport-shape gating, this is the first suspect.

This plugin does **not** send the `X-DeepSeek-Harness-Attribution` secondary
header (dsh-antigravity-auth sends it to keep DSH attribution truthful).
Deliberate tradeoff: one fewer fingerprintable header; DSH attribution
remains traceable through logs. Add it back in the transport layer if parity
with the reference plugin is wanted.

### 2.2 OAuth client

The client id/secret are the public desktop-client credentials embedded in
the Antigravity CLI (`1071006060591-…apps.googleusercontent.com`), not a
confidential secret. Scopes match the CLI: cloud-platform, userinfo.email,
userinfo.profile, cclog, experimentsandconfigs.

### 2.3 Endpoints and proxy

Primary `daily-cloudcode-pa.googleapis.com` (actual CLI traffic), fallback
`cloudcode-pa.googleapis.com`. Fallback triggers only on **transport
failure** (connect/TLS/timeout); HTTP error statuses are classified directly.
Fixed paths: loadCodeAssist / streamGenerateContent / generateContent /
retrieveUserQuotaSummary / fetchAvailableModels (this plugin uses four).

Proxy resolution order: the `proxyUrl` config → `HTTPS_PROXY → https_proxy
→ ALL_PROXY → all_proxy` → the Windows per-user proxy settings (registry
ProxyServer/ProxyEnable, cached 5 minutes, disabled with
`useSystemProxy: false`; accepts `host:port`, `scheme://…`, and the
`http=…;https=…` forms), with `NO_PROXY` taking precedence. A GUI-started
Host does not inherit shell proxy env vars — system-proxy auto-detection
keeps the gateway on the same route as the user's browser and IDE
(observed: direct connect times out with TUN off while the system proxy
answers). Transport-failure logs carry the undici cause-chain code (e.g.
`UND_ERR_CONNECT_TIMEOUT`) so dead networks and dead proxies are
distinguishable.

### 2.4 TLS

Node's stack (undici/OpenSSL), not the CLI's Electron/BoringSSL fingerprint.
The core library implements a raw TLS transport to mirror the CLI shape; as
of the snapshot date there is no evidence of TLS fingerprint gating
(dsh-antigravity-auth's docs do not list it as a check either). If a
fingerprint gate appears, see dsh-opencode-bridge's wreq-js approach.

## 3. Model catalog and routing

### 3.1 Pinned snapshot (wire enum table)

| Public id | Efforts | Wire name | Enum | Context | Output cap | Thinking config |
|---|---|---|---|---|---|---|
| claude-opus-4-6-thinking | none/low/medium/high | claude-opus-4-6-thinking | M26 | 200K | 64K/32K/32.7K/64K | budget 0/8192/16384/32768 |
| claude-sonnet-4-6 | same | claude-sonnet-4-6 | M35 | 200K | same | same |
| claude-opus-5-5 | low/medium/high | claude-opus-5-5-{tier} | M400/401/402 | 1M | 128K | adaptive: budget 0 + level |
| claude-sonnet-5-5 | low/medium/high | claude-sonnet-5-5-{tier} | M403/404/405 | 1M | 128K | same |
| gemini-3.8-flash | low/medium/high | gemini-3.8-flash-{tier} | M320/319/318 | 1M | 64K | budget 1000/4000/-1 |
| gemini-4-neon | low/medium/high/xhigh | gemini-4-neon-{tier} | M534/533/532/535 | 1M | 256K | level LOW/MEDIUM/HIGH/100 |
| gemini-4-hydrogen | same as neon | gemini-4-hydrogen-{tier} | M527/526/525/528 | 1M | 256K | same |
| gemini-4-carbon | low/medium/high | gemini-4-carbon-{tier} | M438/437/427 | 1M | 256K | level |
| gemini-4-argon | low/medium/high | gemini-4-argon-{tier} | M419/418/417 | 1M | 64K | level |
| gpt-oss-120b-medium | — | gpt-oss-120b-medium | MODEL_OPENAI_GPT_OSS_120B_MEDIUM | 128K | 32K | budget 8192 |

(M… = `MODEL_PLACEHOLDER_M…`. Sources: core 3.1.10's
AGY_NATIVE_MODEL_DEFINITIONS and HISTORICAL_AGY_MODEL_ENUMS; some limits are
community-capture observations, not official publications.)

Alias normalization: `antigravity-` prefix, historical `gemini-claude-`
prefix, `publishers/…/models/` prefix, `claude-opus-4-6` (no -thinking),
`claude-sonnet-4-6-thinking`, and tier suffixes (-low/-medium/-high/xhigh,
except the gpt- family) all normalize to a pinned id + effort.

**No retirement gate.** `resolveRoute` only checks membership in the pinned
snapshot and effort support. DSH catalog membership is advisory by design
(`listModels` feeds the selector; core routing accepts unlisted ids).

### 3.2 Per-account live catalog, availability, and quota

`POST /v1internal:fetchAvailableModels`, body `{project}` (or `{}` without a
project; one `{}` retry on 403 with a project). The response carries a
`models` map plus `agentModelSorts` and other grouping fields:

- `models[id]` carries `modelName`/`displayName`/`maxTokens`/
  `maxOutputTokens`, and also `disabled` (`true` when the plan does not
  include the model, e.g. `gemini-4-*-disabled` on non-paid accounts),
  `tagTitle` / `tagDescription` (upstream notice or lock reason), and
  `quotaInfo` (`remainingFraction` 0–1, `resetTime`).
- Only entries with `disabled !== true` and no `-disabled` suffix count as
  enabled; `definitionAvailable` matches exact wire names, canonical
  aliases, or explicit tier suffixes (`low|medium|high|xhigh`) — it never
  treats a `-disabled` id as a tier.
- Picker offering = pinned snapshot ∩ live enabled models (ordered by
  `agentModelSorts` recommendations), plus forced `extraModels`; an enabled
  model with `remainingFraction === 0` gets a warning badge in the picker
  (`Quota 0%` / `配额已用尽`).
- Account tier and quota summary: the settings page and `/agw models` /
  `/agw refresh` also read `v1internal:loadCodeAssist` (`currentTier` /
  `paidTier`) and `v1internal:retrieveUserQuotaSummary` (5-hour and weekly
  quota groups), producing a full availability report with the available
  list and the unavailable list (`disabled` with the upstream reason,
  `not-offered` for ids absent from the catalog).
- Disk cache and offline fallback: after a successful probe the non-secret
  availability result is written to `catalog-cache.json` beside the
  credential file (isolated per `accountKey`, contains no tokens). When a
  live probe fails (e.g. offline at boot) the catalog first falls back to
  that account's last verified cached offering — disabled or not-offered
  models never leak into the picker that way; the full pinned snapshot is
  used only when no live probe has ever succeeded for the account.
- TTL default 30s (`refresh` / the settings "Check availability" button pass
  `force: true` to skip it); logout/import invalidate the in-memory and disk
  caches. Catalog changes notify DSH's model directory through
  `registration.replace(providers)` and `llm/models-updated`.

The server returns different catalogs per account (plan, region, rollout);
the plugin no longer applies one fixed list to everyone.

## 4. Request envelope

### 4.1 Shape and field order

```jsonc
{
  "project": "<projectId>",          // omitted when absent or a placeholder id
  "requestId": "agent/<conversationId>/<timestamp>/<trajectoryId>/<stepCount>",
  "request": {
    "contents": [ /* Gemini format */ ],
    "systemInstruction": { "parts": [{ "text": "…" }] },
    "tools": [ /* see 4.3 */ ],
    "labels": { /* see 4.2 */ },
    "generationConfig": { /* maxOutputTokens, thinkingConfig, temperature, stopSequences */ },
    "sessionId": "<fnv1a64Signed('')>"
  },
  "model": "<wire name>",
  "userAgent": "antigravity",
  "requestType": "agent"
}
```

Fields inside `request` are ordered contents → systemInstruction → tools →
labels → generationConfig → sessionId (CLI shape,
`orderRequestPayloadInPlace`).

### 4.2 Session metadata

Each DSH sessionId maps through signed FNV-1a 64 to a session key owning a
conversationId/trajectoryId pair (randomUUID; in-process TTL 24h, cap 256).
`numericSessionId` is always `fnv1a64Signed('')` (print-mode CLI behavior).

labels: cascade_id, root_cascade_id (=conversationId), trajectory_id,
last_step_index (contents length - 1), model_enum, request_id
(`<trajectoryId>-<requestCount-1>`), used_claude, used_claude_conservative,
used_non_gemini_model, plus last_execution_id once a second user turn
appears (rotated per turn). Retries reuse the timestamp and do not advance
counters.

### 4.3 Message and tool mapping

- system messages + `options.system` → systemInstruction.parts.
- user → `{role:'user', parts:[{text}|{inlineData:{mimeType,data}}]}`;
  images read through attachments.readImage, degrading to placeholder text
  when unavailable or over the cap.
- assistant → `{role:'model', parts:[…]}`; reasoning blocks carry
  `thought:true`, signatures replayed from replayState (§5.2).
- tool → `{role:'user', parts:[{functionResponse:{name,
  response:{result|error}}}]}`; names resolved from the historical
  assistant tool-call id→name map.
- Claude routes: consecutive response-only user contents merge into one
  (`groupClaudeFunctionResponses`).
- Tool declarations: Gemini one `{functionDeclarations:[all]}`; Claude one
  entry per tool plus `toolConfig.functionCallingConfig.mode='VALIDATED'`.
  Empty schemas gain a `_placeholder` boolean property; names sanitize to
  `[a-zA-Z0-9_-]{1,64}`; Claude descriptions append the
  `⚠️ STRICT PARAMETERS: …` signature.
- Tool parameter schemas pass a whitelist sanitizer (`sanitizeToolSchema`):
  the endpoint's Schema proto rejects unknown JSON Schema keywords with
  400 INVALID_ARGUMENT (observed with `const`). `const` converts to an
  equivalent single-value `enum`; metadata and unsupported structural
  keywords ($schema/$ref/allOf/not/if-then-else/patternProperties/
  unevaluated* etc.) are dropped; the supported subset (type/format/
  description/nullable/enum/items/properties/required/oneOf/anyOf/numeric
  and length bounds/pattern/additionalProperties/propertyOrdering) survives
  and is sanitized recursively.
- Claude with tools injects the CRITICAL TOOL USAGE INSTRUCTIONS and the
  interleaved-thinking hint (verbatim CLI constants).

### 4.4 Prompt compatibility (promptCompatibility)

Reproduces the dsh-antigravity-auth issue #47 fix: in the
`system-prompt/assemble` waterfall, for this plugin's routes only, rewrite
three identity contributions — the `harness:identity` sentence "You are an
AI agent powered by DeepSeek Harness." → "You are an AI coding assistant.";
"DeepSeek Harness" → "host application" in `harness:source`/`app:web-surface`
(preserving quoted paths/URLs); the browser-context sentence replaced with
its neutral equivalent. Everything else is untouched. Disable with
`promptCompatibility: false`.

## 5. Response parsing and stream protocol

### 5.1 SSE → StreamChunk

`?alt=sse` returns `data: {…}` events. Parsing tolerances: the `)]}'` JSON
guard prefix, both `{response:{…}}`-wrapped and bare roots, the `[DONE]`
sentinel, multi-line data. Part classification: `functionCall` → tool-call
(args serialized to a JSON string); `thought:true` text → reasoning; plain
text → text. Usage converts from usageMetadata (promptTokenCount minus
cachedContentTokenCount gives uncached input; thoughtsTokenCount reported
separately). finishReason: STOP → stop/tool-calls (depending on tool calls),
MAX_TOKENS → max-tokens, SAFETY/RECITATION etc. → error(CONTENT_REFUSED).

Block protocol: block-start → deltas → block-end (assembled block) → usage →
finish. Every `functionCall` part carries complete `args` (optionally the
upstream `id`); a tool-call block that already holds argument text opens a
new block for any subsequent call (even to the same tool name), so parallel
same-name calls never concatenate into invalid JSON. When upstream supplies
no `id`, the adapter mints one (`call_<uuid12>`). Empty response
→ EMPTY_RESPONSE; abort → aborted(ABORTED).

### 5.2 Thinking-signature replay

Response thoughtSignatures (part-, candidate-, metadata.google-, and
envelope-level) collect into per-block state and ride the finish chunk's
`replayState.blocks[{kind,signature?}]` into session history. The next turn
maps assistant history by block order: reasoning blocks carry their original
signature; missing signatures use the official
`skip_thought_signature_validator` sentinel (as gemini-cli does — skip
validation instead of failing). Claude functionCalls carry a signature only
on the first call (CLI behavior). replayState reaches the adapter only when
it owns both the historical and target routes (DSH contract); cross-plugin
history degrades to the sentinel automatically.

## 6. Configuration and commands

### 6.1 Config schema (schemastery)

| Field | Default | Notes |
|---|---|---|
| providers | ['antigravity-gateway'] | routes the adapter owns |
| endpoint | daily-cloudcode-pa | primary endpoint |
| fallbackEndpoints | [cloudcode-pa] | transport-failure fallback |
| oauthPort | 51121 | loopback callback port (0 = random) |
| loginTimeoutMs | 300000 | sign-in wait cap |
| requestTimeoutMs | 600000 | total per-request timeout |
| responseHeaderTimeoutMs | 180000 | header timeout |
| idleTimeoutMs | 180000 | stream idle timeout |
| catalogTtlMs | 30000 | live catalog cache |
| extraModels | [] | pinned ids always advertised |
| promptCompatibility | true | §4.4 |
| imageInput | true | image input |
| maxImageBytes | 10MiB | per-image cap |
| proxyUrl | '' | explicit proxy |
| useSystemProxy | true | fall back to the Windows system proxy when no env/config |
| logLevel / logDir / logMaxBytes / logMaxFiles | info / auto / 512KiB / 5 | §9 |
| credentialFile | '' | file-fallback path override |
| dumpRequestsTo | unset | request-dump diagnostic |

### 6.2 Commands

`/agw` (alias `/antigravity-gateway`): status/login/cancel/logout/import/
models/refresh. Commands create no model message; login completes in the
background while the command returns the URL and instructions immediately.
import reads only dsh-antigravity-auth's auth.json (Windows
`%LOCALAPPDATA%/dsh-antigravity-auth/auth.json`, POSIX
`$XDG_DATA_HOME/dsh-antigravity-auth/auth.json`), takes refreshToken +
projectId, refreshes on its own, and never writes the sibling store.

### 6.3 Settings page and account RPC

The client half `client.js` registers through `window.__ModuleLoader__.load`
(id = package name); React comes from the host browser module table, no
duplicate installation. Inside `apply`: locale registers the
`settings.antigravityGateway` namespace before binding (English/Chinese,
falling back to the built-in dictionary on failure); the RPC client comes
from `connection.rpc`; one page registers into the `settings.section` slot
(id `antigravity-gateway`, order 31) with three tabs:

- **Account**: status card (login state/email/project/token expiry/storage
  backend), sign-in/cancel/import/logout buttons; while a sign-in is pending
  it polls status every 2s so the card flips automatically when the browser
  callback completes; the pending box shows the authorization link (manual
  fallback).
- **Models**: a one-click "Check availability" probe (`force: true`) showing
  the report source (live / cached / unverified snapshot), account tier,
  quota summary (5-hour and weekly windows), and the account's available
  models (with remaining quota) alongside unavailable ones (upstream
  disabled/not-offered reasons).
- **Diagnostic log**: level filter, refresh, copy, clear (reuses the log RPC).

Every service access is optional-chained and try/caught; `apply` never
throws (a failed activation is a fatal web-boot error). Styles use host
theme tokens and are removed on unmount.

On the Host, `AccountService` is the single implementation shared by
commands and UI; RPC routes
`/api/antigravity-gateway-account/{status,login,cancel,logout,import,models}`
reuse the log RPC envelope protocol. **Loopback guard** (same policy as
dsh-antigravity-auth): enabled when no WebServer exists (local-only
composition) or it is explicitly bound to `127.0.0.1`; on any other bind the
RPC registers inert routes (always `loopback-required`, never touching the
service) and commands fail closed as well. DSH command/RPC invocations carry
no caller authority with which to exempt the local user, so fail closed.

The login URL's redirect_uri is rewritten to the actually-bound port after
the callback server binds (essential when oauthPort=0 requests a random
port), keeping browser, Google, and the token exchange in agreement.

## 7. Failure classification and retries

| Situation | Code | Behavior |
|---|---|---|
| Not signed in | AUTH | hint /agw login or /agw import |
| 401/403 (nothing emitted yet) | AUTH | force one refresh and replay; then surface |
| 429 | RATE_LIMIT | Retry-After parsed (seconds/HTTP-date, capped 1h) carried on the failure |
| 400 + overflow wording | CONTEXT_WINDOW_EXCEEDED | triggers DSH compaction path |
| 503 + capacity wording | SERVER | backoff retry ≤2 (1.5s/3s, cap 8s) while nothing emitted |
| 404 (plan-locked model) | MODEL_UNSUPPORTED | probes/refreshes live availability and surfaces the upstream reason |
| Other 4xx/5xx | HTTP_<n> / SERVER | classified directly |
| Connect/TLS/timeout | TRANSPORT / TIMEOUT | one endpoint fallback |
| In-stream error event | mapped by status | terminal finish(error) |
| Empty response | EMPTY_RESPONSE | retryable code |
| Abort | ABORTED | terminal finish(aborted) |

The adapter never re-runs successful requests; DSH's dsh-llm-retry executes
retry policy at agent-step boundaries. BridgeError → LlmError code mapping:
INVALID_MODEL→UNKNOWN_MODEL, PROTOCOL_DRIFT→MALFORMED_RESPONSE,
CANCELLED→ABORTED; the rest pass through unchanged.

## 8. Credentials and security

- Tokens live in the DSH credential record
  `dsh-antigravity-gateway/google-account` (kind: grant) **and always mirror
  to an owner-only (0600) JSON file** (atomic tmp+rename writes). The
  credentials service resolves lazily per operation (activation order does
  not matter); when the service exists but holds no record, the file mirror
  is read and migrated into the service. Every Host boot finds the grant
  whether or not the credentials service is ready, so restarts never lose
  the sign-in.
- Single-flight refresh: concurrent requests share one refresh promise;
  Google-rotated refresh tokens persist immediately. Refresh 60s early.
- The PKCE verifier stays in Host memory (state→verifier map), so the
  authorization URL is safe to display. The callback server binds 127.0.0.1
  only; a wrong state rejects that request without killing the pending
  login; only Google's explicit error (access_denied) fails it.
- Log redaction in §9; credentials never reach logs, configuration, or tool
  output.
- Logout removes the local credential only; it does not revoke the Google
  grant.

## 9. Logging and diagnostics

PluginLogger (same design as dsh-opencode-bridge): five levels
(debug/info/warn/error/off), per-file cap + rotation (oldest deleted first),
in-memory ring fallback on disk failure, never throws. Redaction:
configured secrets, Bearer values, `ya29.` access tokens, `1//` refresh
tokens, `sk-/key-/token-/secret-` shapes; long strings truncated at 2000.

Request diagnostics: failures at warn (model/wire/duration/code/status),
successes at info (blocks/finish/token counts), debug adds catalog refresh,
token refresh, and endpoint-fallback detail.
`REQUEST_DIAGNOSTICS_VERSION = 1`.

Dual access: the `antigravity_gateway_log` tool and
`/api/antigravity-gateway-logs/*` RPC (read/stat/clear/level) share one
`LogService` implementation and mount the same `127.0.0.1` loopback guard via
`src/dsh/rpc.ts` as the account service.

## 10. Testing, releases, playbooks, and troubleshooting

Offline verification (`npm run verify`: `typecheck:ts` + `typecheck:client` +
`build` + 137 `node:test` cases) never calls Google:
- **Unit & protocol layers**: models/payload/schema/response/catalog-parser/transport/proxy/logger/atomic-writes/commands/prompt-compat.
- **Architecture & contract guards**: [architecture.test.mjs](tests/architecture.test.mjs) enforces the four-layer unidirectional boundaries and cycle freedom; [client-contract.test.mjs](tests/client-contract.test.mjs) verifies `client.js` load safety, `#agw-styles` deduplication, and 100% alignment with `rpc-contracts.ts`.
- **End-to-end integration (local fake server)**: text, parallel same-name tool calls, 401 refresh replay, 404 disabled-reason diagnosis, 429, 503 capacity backoff recovery, in-stream error/empty response, multi-turn thinking-signature replay, and plugin unload releasing the OAuth callback port & RPC routes.

CI: Node 22/24 × Ubuntu/Windows matrix running `typecheck`, `build`, `test:only`, archive validation, and clean-tree check.
Release: push a `v*` tag → identity validation → full verify → pack validation (rejecting `.npm-cache/`, `node_modules/`, `docs/refactoring/`) → SHA256 → GitHub Release.

### Maintenance Playbooks

1. **Adding or removing Antigravity models**:
   - Edit `MODEL_DEFINITIONS` (and `ID_ALIASES` if needed) in [src/protocol/models.ts](src/protocol/models.ts), backed by real `agy CLI` catalog/capture wire names, `model_enum`, and documented limit observations.
   - Add route/tier assertions in [tests/models.test.mjs](tests/models.test.mjs) and availability parsing coverage in [tests/catalog.test.mjs](tests/catalog.test.mjs) if applicable.
2. **Following Antigravity upstream protocol drift**:
   - Protocol logic is isolated inside `src/protocol/` ([constants.ts](src/protocol/constants.ts), [payload.ts](src/protocol/payload.ts), [schema-sanitizer.ts](src/protocol/schema-sanitizer.ts), [response.ts](src/protocol/response.ts), [catalog-parser.ts](src/protocol/catalog-parser.ts)) and [src/core/transport/](src/core/transport/index.ts).
   - Update capture dates and sanitized observations first, adjust the protocol module, and add regression cases in `tests/{payload,schema,response,adapter}.test.mjs`.
3. **Adapting to DSH host upgrades**:
   - Host contracts are isolated inside `src/dsh/` ([types.ts](src/dsh/types.ts), [config.ts](src/dsh/config.ts), [rpc.ts](src/dsh/rpc.ts), [adapter.ts](src/dsh/adapter.ts), [stream-assembler.ts](src/dsh/stream-assembler.ts)) and [client.js](client.js).
   - Run `npm run verify` afterwards to verify both TypeScript and `client.js` typechecking + contract tests.

### Verified Environment & Troubleshooting

- **Verified environment**: Node.js `24.18.0` (Windows 11 offline suite; CI covers Ubuntu/Windows × Node 22/24); DSH target baseline `@deepseek-ai/dsh-llm@0.2.2-rc.5` / `@deepseek-ai/cordis@4.1.0`. Live Google upstream traffic and full DSH Desktop runtime flows require manual E2E checks inside DSH.
- **Troubleshooting (check redacted logs via `antigravity_gateway_log`)**:
  - `AUTH` / 401 replay failure: inspect `/agw status` and re-run `/agw login` or `/agw import`.
  - `MODEL_UNSUPPORTED` (404): model is plan-locked or not offered; inspect Settings → Models or `/agw models` for `reasonTitle`/`reasonDetail`.
  - `loopback-required`: DSH WebServer is not bound to `127.0.0.1` (both account and log RPCs fail closed).
  - `TRANSPORT` / connect timeout: verify `useSystemProxy: true` on GUI-started Windows hosts or configure `proxyUrl` explicitly.
