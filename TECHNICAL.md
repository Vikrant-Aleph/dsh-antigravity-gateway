# dsh-antigravity-gateway — 技术设计

中文 | [English](TECHNICAL.us.md)

面向本插件维护者，以及想参考一个私有端点 `LlmAdapter` 实现的 DSH 插件作者。

> **带日期的快照。** 上游事实建立于 2026-11-22：本机
> `dsh-antigravity-auth@0.1.13` / `@cortexkit/antigravity-auth-core@3.1.10`
> 发行代码阅读与 Google 官方模型文档抓取。
> 常量都是有日期的观测，不是规范；协议漂移时的更新方法见 §10。

总原则：**复刻官方客户端被网关检查的细节，其余按 DSH 的公开扩展契约实现。**
与参考项目（dsh-opencode-bridge、dsh-antigravity-auth）不同，本插件不做
客户端模型退役拦截——目录以账号实时返回为准。

## 1. 架构

代码按**四层轻量化单向依赖**组织（由 [architecture.test.mjs](tests/architecture.test.mjs) 静态 AST 守卫强制校验）：

```
DSH Host / Cordis / WebServer
   │
   ▼
src/index.ts                              薄装配入口（Config 绑定、ctx.effect、受控导出）
   ├──▶ src/dsh/                          DSH 宿主适配层（唯一允许导入 @deepseek-ai/*）
   │       ├──▶ src/core/                 运行时核心层（I/O、传输、OAuth、凭据、缓存、日志）
   │       │       ├──▶ src/protocol/     纯协议层（零宿主/undici/fs/http/child_process）
   │       │       └──▶ src/shared/         共享基础与契约（零内部依赖）
   │       ├──▶ src/protocol/
   │       └──▶ src/shared/
   └──▶ src/core/

DSH agent loop
   │  GenerateOptions / messages / tools
   ▼
AntigravityGatewayAdapter                 src/dsh/adapter.ts (0.x 保留 @deprecated AntigravityBridgeAdapter)
   ├── resolveRoute                       模型 id + 努力级 → wire 路由（src/protocol/models.ts）
   ├── AuthManager.getCredential          单飞刷新 + 调用方信号解耦（src/core/auth.ts）
   ├── buildEnvelope                      消息映射 + Claude 变换 + 元数据（src/protocol/payload.ts）
   ├── AgyTransport.request               undici 有界连接池 + 代理 + 超时（src/core/transport/）
   ├── iterateSse / parseProviderEvent    SSE → 中性 part（src/core/transport/sse.ts + src/protocol/response.ts）
   └── assembleStreamChunks               StreamChunk 状态机 + replayState（src/dsh/stream-assembler.ts）
   ▼
https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
   （传输失败时回退 https://cloudcode-pa.googleapis.com）
```

模块清单：

| 层级 | 模块 | 职责 |
|---|---|---|
| **共享** | [errors.ts](src/shared/errors.ts) | `GatewayError` 失败分类、`Retry-After`、溢出/容量措辞检测（0.x 保留 `BridgeError` 别名） |
| **共享** | [guards.ts](src/shared/guards.ts) | 运行时守卫（`isRecord`/`boundedString`）与 `raceWithAbort` |
| **共享** | [fs-atomic.ts](src/shared/fs-atomic.ts) | 唯一临时文件名原子写盘与失败清理 |
| **共享** | [rpc-contracts.ts](src/shared/rpc-contracts.ts) | 前后端共享 `/api` RPC 通道、命名空间、端点与 DTO 契约 |
| **协议** | [constants.ts](src/protocol/constants.ts) | OAuth 客户端、端点、路径、CLI 身份、Claude 提示常量 |
| **协议** | [models.ts](src/protocol/models.ts) | 固定模型目录、wire 枚举、档位解析、别名规范化（§3） |
| **协议** | [session-metadata.ts](src/protocol/session-metadata.ts) | FNV-1a 64 会话键、`RequestSessionStore` 与 labels 元数据（§4.2） |
| **协议** | [schema-sanitizer.ts](src/protocol/schema-sanitizer.ts) | 工具参数 JSON Schema 白名单清洗与空 schema 占位（§4.3） |
| **协议** | [payload.ts](src/protocol/payload.ts) | envelope、字段序、消息/工具映射、Claude 变换、签名回放（§4） |
| **协议** | [response.ts](src/protocol/response.ts) | SSE 事件解析、usage、finishReason、签名提取（§5） |
| **协议** | [catalog-parser.ts](src/protocol/catalog-parser.ts) | `fetchAvailableModels`/配额/账号等级纯解析、`selectQuotaForModel` 与 `accountCacheKey`（§3.2） |
| **核心** | [transport/](src/core/transport/index.ts) | 环境变量/Windows 系统代理（`proxy.ts`）、有界 `Dispatcher` 池（`http-client.ts`）、即时中止 SSE 迭代（`sse.ts`） |
| **核心** | [credentials.ts](src/core/credentials.ts) | 多账号 `CredentialVault`（单账号向后兼容 v1）、`withWriteLock` 原子镜像与共享项目 ID 隔离（§8） |
| **核心** | [oauth.ts](src/core/oauth.ts) | PKCE S256、环回回调服务器、令牌交换/刷新与 `id_token` 邮箱解析（§8） |
| **核心** | [auth.ts](src/core/auth.ts) | 多账号登录编排、按账号隔离的单飞刷新/代数守卫、账号切换、项目发现、显式导入（§8） |
| **核心** | [catalog.ts](src/core/catalog.ts) | 按账号隔离实时目录（v2 `catalog-cache.json`）、配额冷却与故障转移选号（§3.2） |
| **核心** | [logger.ts](src/core/logger.ts) | 有界脱敏文件日志 + 内存环回退（§9） |
| **宿主** | [types.ts](src/dsh/types.ts)、[config.ts](src/dsh/config.ts) | 宿主轻量结构接口；Schemastery `Config` 单一真相源推导 `GatewayConfig` |
| **宿主** | [rpc.ts](src/dsh/rpc.ts) | 统一 `/api` JSON-RPC 注册、校验、loopback 守卫与完整 fiber/路由释放 |
| **宿主** | [stream-assembler.ts](src/dsh/stream-assembler.ts)、[adapter.ts](src/dsh/adapter.ts) | DSH `LlmAdapter` 实现、流式块状态机、重试与错误映射（§7） |
| **宿主** | [account-service.ts](src/dsh/account-service.ts)、[log-service.ts](src/dsh/log-service.ts) | 账号与日志双入口服务（UI RPC + `/agw` 命令 / `antigravity_gateway_log` 工具） |
| **宿主** | [commands.ts](src/dsh/commands.ts)、[prompt-compat.ts](src/dsh/prompt-compat.ts) | `/agw` 命令族（§6.2）与 429 身份句改写钩子（§4.4） |
| **前端/入口** | [client.js](client.js)、[index.ts](src/index.ts) | 零打包器设置页与聊天框 `conversation.input.right` 额度模块（`tsconfig.client.json` 检查，§6.3）与薄装配入口 |

术语：**wire 路由**＝端点实际接受的模型名；**枚举**＝`labels.model_enum`
里的 `MODEL_PLACEHOLDER_M…`；**固定快照**＝插件内置的模型定义表；
**实时目录**＝账号从 fetchAvailableModels 拿到的模型集合。

## 2. 客户端身份

### 2.1 请求头

| 头 | 值 | 说明 |
|---|---|---|
| `User-Agent` | `antigravity/cli/1.5.8 (aidev_client; os_type=windows; arch=amd64; cl=1020628950; auth_method=consumer)` | agy CLI 1.5.8 抓包形状；平台/架构按真实值 |
| `Authorization` | `Bearer <access token>` | OAuth 令牌 |
| `Content-Type` | `application/json` | |
| `Accept-Encoding` | `gzip` | undici 自动解压 |

与 CLI 的差异（如实记录）：CLI 内容请求走 HTTP/1.1 `Transfer-Encoding:
chunked`（core 的 `buildAgyCliHeaderPairs`），本插件用 undici 的
Content-Length 形态。截至 2026-11-22 没有证据表明端点检查这一层；
CLIProxyAPI 等第三方实现同样用普通 HTTP 客户端正常工作。若将来出现
400/403 且怀疑传输形态，这是第一个排查点。

本插件**不发送** `X-DeepSeek-Harness-Attribution` 次级署名头
（dsh-antigravity-auth 发送它以保持 DSH 署名诚实）。这是有意取舍：
减少一个可被指纹化的额外头；DSH 署名仍可通过日志与 User-Agent 配置追溯。
如需与参考插件一致的署名行为，可在 transport 层加回。

### 2.2 OAuth 客户端

客户端 id/secret 是 Antigravity CLI 内嵌的公开桌面客户端标识
（`1071006060591-…apps.googleusercontent.com`），不是私密用户凭据。
为避免明文或单段 Base64 字面量触发 GitHub Push Protection，源码中在
[constants.ts](src/protocol/constants.ts) 以多字节 XOR 掩码整数数组存储并于运行时解码，
[oauth.ts](src/core/oauth.ts) 默认使用该公开标识保持零配置浏览器一键登录，
同时支持通过环境变量 `ANTIGRAVITY_OAUTH_CLIENT_ID` +
`ANTIGRAVITY_OAUTH_CLIENT_SECRET`（或 `ANTIGRAVITY_CLIENT_ID` +
`ANTIGRAVITY_CLIENT_SECRET`）成对覆盖；日志脱敏层同时屏蔽 OAuth client
secret 形态与 `client_secret=` 参数。scopes 与 CLI 一致：cloud-platform、
userinfo.email、userinfo.profile、cclog、experimentsandconfigs。

### 2.3 端点与代理

主端点 `daily-cloudcode-pa.googleapis.com`（CLI 实际流量），回退
`cloudcode-pa.googleapis.com`。回退只在**传输层失败**（连接/TLS/超时）时
触发；HTTP 错误状态不触发回退，直接分类。路径固定五个：
loadCodeAssist / streamGenerateContent / generateContent /
retrieveUserQuotaSummary / fetchAvailableModels（本插件用其中四个）。

代理解析顺序：`proxyUrl` 配置 → `HTTPS_PROXY → https_proxy → ALL_PROXY →
all_proxy` → Windows 系统代理（读注册表 ProxyServer/ProxyEnable，结果缓存
5 分钟，`useSystemProxy: false` 关闭；支持 `host:port`、`scheme://…` 与
`http=…;https=…` 三种取值形态），`NO_PROXY` 优先。GUI 启动的 Host 不继承
shell 代理环境变量——系统代理自动检测让插件与浏览器/IDE 走同一路由
（实测：TUN 关闭时直连超时，系统代理可达）。传输失败日志携带 undici
cause 链的错误码（如 `UND_ERR_CONNECT_TIMEOUT`），便于区分断网与代理故障。

### 2.4 TLS

Node（undici/OpenSSL）栈，不是 CLI 的 Electron/BoringSSL 指纹。
core 库实现原始 TLS 传输是为了复刻 CLI 形态；截至调查日没有端点检查
TLS 指纹的证据（dsh-antigravity-auth 的文档也未将其列为检测项）。
若将来出现指纹门禁，参考 dsh-opencode-bridge 的 wreq-js 方案。

## 3. 模型目录与路由

### 3.1 固定快照（wire 枚举表）

| 公开 id | 档位 | wire 名 | 枚举 | 上下文 | 输出上限 | 思考配置 |
|---|---|---|---|---|---|---|
| claude-opus-4-6-thinking | 无/low/medium/high | claude-opus-4-6-thinking | M26 | 200K | 64K/32K/32.7K/64K | budget 0/8192/16384/32768 |
| claude-sonnet-4-6 | 同上 | claude-sonnet-4-6 | M35 | 200K | 同上 | 同上 |
| claude-opus-5-5 | low/medium/high | claude-opus-5-5-{tier} | M400/401/402 | 1M | 128K | adaptive：budget 0 + level |
| claude-sonnet-5-5 | low/medium/high | claude-sonnet-5-5-{tier} | M403/404/405 | 1M | 128K | 同上 |
| gemini-3.8-flash | low/medium/high | gemini-3.8-flash-{tier} | M320/319/318 | 1M | 64K | budget 1000/4000/-1 |
| gemini-4-neon | low/medium/high/xhigh | gemini-4-neon-{tier} | M534/533/532/535 | 1M | 256K | level LOW/MEDIUM/HIGH/100 |
| gemini-4-hydrogen | 同 neon | gemini-4-hydrogen-{tier} | M527/526/525/528 | 1M | 256K | 同上 |
| gemini-4-carbon | low/medium/high | gemini-4-carbon-{tier} | M438/437/427 | 1M | 256K | level |
| gemini-4-argon | low/medium/high | gemini-4-argon-{tier} | M419/418/417 | 1M | 64K | level |
| gpt-oss-120b-medium | — | gpt-oss-120b-medium | MODEL_OPENAI_GPT_OSS_120B_MEDIUM | 128K | 32K | budget 8192 |

（M… 均指 `MODEL_PLACEHOLDER_M…`。来源：core 3.1.10 的
AGY_NATIVE_MODEL_DEFINITIONS 与 HISTORICAL_AGY_MODEL_ENUMS；部分限额为
社区抓包观测值，非官方公布值。）

别名规范化：`antigravity-` 前缀、`gemini-claude-` 历史前缀、
`publishers/…/models/` 前缀、`claude-opus-4-6`（无 -thinking）、
`claude-sonnet-4-6-thinking`、档位后缀（-low/-medium/-high/xhigh，
gpt- 家族除外）都归一到固定 id + 努力级。

**没有退役门禁。** `resolveRoute` 只校验「在固定快照内」与「努力级被该
模型支持」。DSH 的目录成员资格本来就是建议性的
（`listModels` 供选择器，核心路由接受未列出的 id）。

### 3.2 账号实时目录、可用性与配额检测

`POST /v1internal:fetchAvailableModels`，body `{project}`（无项目时 `{}`；
403 且带 project 时重试一次 `{}`）。响应结构包含 `models` 映射、
`agentModelSorts`、`groupedModels` 等字段：

- `models[id]` 除 `modelName`/`displayName`/`maxTokens`/`maxOutputTokens` 外，
  还包含 `disabled`（计划不可用时为 `true`，如非付费 Pro 账号上的
  `gemini-4-*-disabled`）、`tagTitle` / `tagDescription`（上游提示或锁定
  原因）、`quotaInfo`（`remainingFraction` 0–1、`resetTime`）。
- 只有 `disabled !== true` 且非 `-disabled` 后缀的条目视为可用；
  `definitionAvailable` 仅匹配精确 wire 名、规范化别名或明确档位后缀
  （`low|medium|high|xhigh`），不再把 `-disabled` 误当成档位。
- 选择器展示 = 固定快照 ∩ 实时启用模型（按 `agentModelSorts` 推荐顺序），
  外加 `extraModels` 强制项；若启用模型的 `remainingFraction === 0`，选择器
  标 warning 徽标（`Quota 0%` / `配额已用尽`）。
- 账号等级与配额摘要：设置页与 `/agw models` / `/agw refresh` 同时读取
  `v1internal:loadCodeAssist`（`currentTier` / `paidTier`）与
  `v1internal:retrieveUserQuotaSummary`（5 小时与每周配额组），生成包含
  可用列表与不可用列表（`disabled` 附上游原因、`not-offered` 标未提供）
  的完整可用性报告。
- 磁盘缓存与离线兜底：成功获取后把非敏感可用结果写入凭据同目录下的
  `catalog-cache.json`（v2 多账号映射，兼容读取 v1 单账号格式；按
  `accountCacheKey` 优先级 `email → id → projectId` 隔离，不含任何令牌）。
  实时探测失败（如启动初期断网）优先回退到该账号上次已验证的缓存目录，避免
  把禁用或未提供模型放进选择器；仅在该账号从未成功拉取过实时目录时才回退
  完整固定快照。
- 配额冷却与自动切号候选选择：`ModelCatalog` 维护按 `(accountKey, modelId)`
  隔离的运行时冷却时间与缓存 `resetTime` 校验，`selectBestAccountForModel()`
  在切号时跳过已尝试、已冷却或明确计划不可用（`disabled`）的账号，并优先选择
  已知余量更高的备用账号；已过 `resetTime` 的账号自动恢复可用状态。
- TTL 默认 30s（`refresh` /「重新检测」传 `force: true` 跳过缓存）；仅当某账号
  登出/重新登录或导入时按该账号 `accountKey` 失效缓存（不连坐其余账号），切号
  或目录变化通过 `onActiveAccountChanged()` → `registration.replace(providers)`
  和 `llm/models-updated` 即时通知 DSH 模型目录与前端。

服务器按账号（计划、区域、rollout）返回不同目录；插件不再用单一固定
名单套所有账号。

## 4. 请求 envelope

### 4.1 形状与字段序

```jsonc
{
  "project": "<projectId>",          // 无项目或占位 id 时省略
  "requestId": "agent/<conversationId>/<timestamp>/<trajectoryId>/<stepCount>",
  "request": {
    "contents": [ /* Gemini 格式 */ ],
    "systemInstruction": { "parts": [{ "text": "…" }] },
    "tools": [ /* 见 4.3 */ ],
    "labels": { /* 见 4.2 */ },
    "generationConfig": { /* maxOutputTokens, thinkingConfig, temperature, stopSequences */ },
    "sessionId": "<fnv1a64Signed('')>"
  },
  "model": "<wire 名>",
  "userAgent": "antigravity",
  "requestType": "agent"
}
```

`request` 内字段按 contents → systemInstruction → tools → labels →
generationConfig → sessionId 排序（CLI 形状，`orderRequestPayloadInPlace`）。

### 4.2 会话元数据

每个 DSH sessionId 经 FNV-1a 64（有符号）映射为会话键，对应一组
conversationId/trajectoryId（randomUUID，进程内 TTL 24h、上限 256）。
`numericSessionId` 恒为 `fnv1a64Signed('')`（print-mode CLI 行为）。

labels：cascade_id、root_cascade_id（=conversationId）、trajectory_id、
last_step_index（contents 长度-1）、model_enum、request_id
（`<trajectoryId>-<requestCount-1>`）、used_claude、
used_claude_conservative、used_non_gemini_model，以及第二个用户轮次出现后
的 last_execution_id（每轮轮换）。重试复用时间戳，不推进计数器。

### 4.3 消息与工具映射

- system 消息 + `options.system` → systemInstruction.parts。
- user → `{role:'user', parts:[{text}|{inlineData:{mimeType,data}}]}`；
  图片经 attachments.readImage 读取，超上限/不可用时降级为占位文本。
- assistant → `{role:'model', parts:[…]}`；reasoning 块带 `thought:true`，
  签名从 replayState 回放（§5.2）。
- tool → `{role:'user', parts:[{functionResponse:{name, response:{result|error}}}]}`；
  名字从历史 assistant tool-call 的 id→name 映射解析。
- Claude 路由：连续的纯 functionResponse user contents 合并为一条
  （`groupClaudeFunctionResponses`）。
- 工具声明：Gemini 一条 `{functionDeclarations:[全部]}`；Claude 每工具一条
  `{functionDeclarations:[单个]}` + `toolConfig.functionCallingConfig.mode=
  'VALIDATED'`。空 schema 补 `_placeholder` 布尔属性；名字净化为
  `[a-zA-Z0-9_-]{1,64}`；Claude 描述追加 `⚠️ STRICT PARAMETERS: …` 签名。
- 工具参数 schema 经白名单清洗（`sanitizeToolSchema`）：端点 Schema proto
  对未知 JSON Schema 关键字回 400 INVALID_ARGUMENT（实测 `const` 被拒）。
  `const` 等价转换为单值 `enum`；元数据与不支持的结构关键字（$schema/$ref/
  allOf/not/if-then-else/patternProperties/unevaluated* 等）丢弃；支持子集
  （type/format/description/nullable/enum/items/properties/required/oneOf/
  anyOf/数值与长度界限/pattern/additionalProperties/propertyOrdering）保留
  并递归清洗。
- Claude 有工具时注入 CRITICAL TOOL USAGE INSTRUCTIONS 与 interleaved
  thinking 提示（CLI 常量逐字）。

### 4.4 提示兼容（promptCompatibility）

复刻 dsh-antigravity-auth issue #47 的修复：在 `system-prompt/assemble`
瀑布里，仅对本插件路由改写三处身份贡献——
`harness:identity` 的「You are an AI agent powered by DeepSeek Harness.」
→「You are an AI coding assistant.」；`harness:source`/`app:web-surface`
的「DeepSeek Harness」→「host application」（保留引号内的路径/URL）；
浏览器上下文句替换为等价中性句。其余内容不动。可用
`promptCompatibility: false` 关闭。

## 5. 响应解析与流协议

### 5.1 SSE → StreamChunk

`?alt=sse` 返回 `data: {…}` 事件流。解析容差：`)]}'` JSON 防护前缀、
`{response:{…}}` 包裹与裸根两种形状、`[DONE]` 哨兵、多行 data。
part 分类：`functionCall` → tool-call（args 序列化为 JSON 字符串）；
`thought:true` 文本 → reasoning；普通文本 → text。usage 从
usageMetadata 换算（promptTokenCount 减去 cachedContentTokenCount 得
uncached input；thoughtsTokenCount 单列）。finishReason：STOP →
stop/tool-calls（视有无工具调用）、MAX_TOKENS → max-tokens、
SAFETY/RECITATION 等 → error(CONTENT_REFUSED)。

块协议：block-start → 各类 delta → block-end（携带组装块）→ usage →
finish。每个 `functionCall` part 携带完整 `args`（可选附上游 `id`）；
已有参数的工具块收到后续 `functionCall`（即使同名）一律新开块，避免并行
同名调用被拼接成无效 JSON。上游未提供 `id` 时由适配器生成
（`call_<uuid12>`）。空响应 → EMPTY_RESPONSE；中止 → aborted(ABORTED)。

### 5.2 思考签名回放

响应里的 thoughtSignature（part 级、candidate 级、metadata.google 级、
envelope 级）收集进每个块的 state，随 finish 的
`replayState.blocks[{kind,signature?}]` 存入会话历史。下一轮映射
assistant 历史时按块序取回：reasoning 块带原签名；无签名时用官方哨兵
`skip_thought_signature_validator`（gemini-cli 同款，跳过校验而非报错）。
Claude 的 functionCall 只给第一个带签名（CLI 行为）。replayState 只在
同一适配器拥有历史与目标路由时到达（DSH 契约），跨插件历史自动降级为
哨兵。

## 6. 配置与命令

### 6.1 Config schema（schemastery）

| 字段 | 默认 | 说明 |
|---|---|---|
| providers | ['antigravity-gateway'] | 适配器拥有的路由 |
| endpoint | daily-cloudcode-pa | 主端点 |
| fallbackEndpoints | [cloudcode-pa] | 传输失败回退 |
| oauthPort | 51121 | 环回回调端口（0=随机） |
| loginTimeoutMs | 300000 | 登录等待上限 |
| requestTimeoutMs | 600000 | 单请求总超时 |
| responseHeaderTimeoutMs | 180000 | 响应头超时 |
| idleTimeoutMs | 180000 | 流空闲超时 |
| catalogTtlMs | 30000 | 实时目录缓存 |
| extraModels | [] | 强制展示的固定 id |
| promptCompatibility | true | §4.4 |
| autoSwitchAccount | true | 额度耗尽时自动切号并保留原所选模型 |
| imageInput | true | 图片输入 |
| maxImageBytes | 10MiB | 单图上限 |
| proxyUrl | '' | 显式代理 |
| useSystemProxy | true | 无 env/配置时读 Windows 系统代理 |
| logLevel / logDir / logMaxBytes / logMaxFiles | info / 自动 / 512KiB / 5 | §9 |
| credentialFile | '' | 文件回退路径覆盖 |
| dumpRequestsTo | 未设 | 请求落盘诊断 |

### 6.2 命令

`/agw`（别名 `/antigravity-gateway`）：`status` / `accounts` / `switch <目标>` /
`login` / `cancel` / `logout [all]` / `import` / `models` / `refresh`。
命令不产生模型消息；`accounts` 列出全部已登录账号及激活标记，`switch` 支持按
1-based 序号、邮箱或 ID 切换当前账号，`logout` 默认移除当前账号并自动递补
下一可用账号，加 `all` 则清空全部凭据。登录在后台完成，命令立即返回 URL 与指引。
`import` 只读 dsh-antigravity-auth 的 `auth.json`（Windows
`%LOCALAPPDATA%/dsh-antigravity-auth/auth.json`，POSIX
`$XDG_DATA_HOME/dsh-antigravity-auth/auth.json`），取 `refreshToken` +
`projectId` 后自行刷新追加到多账号列表并激活，不写对方存储。

### 6.3 设置页、聊天框额度指示器与账号 RPC

客户端半块 `client.js` 经 `window.__ModuleLoader__.load` 注册（id = 包名），
React 来自宿主浏览器模块表，不重复安装。`apply` 内：locale 先注册
`settings.antigravityGateway` 命名空间再 bind（中英双语，失败降级到内置
字典）；从 `connection.rpc` 取 RPC 客户端；向 `settings.section` slot 注册
一个页面（id `antigravity-gateway`，order 31），三个 tab：

- **账号**：顶部操作栏、当前激活账号焦点卡（头像/邮箱/项目/等级/令牌过期/
  存储后端）与已登录账号列表（支持随时追加登录、切换当前账号与单独移除，并
  显示 `autoSwitchAccount` 状态）；登录待决时每 2s 轮询 status，浏览器回调
  完成后卡片自动翻转；待决期展示授权链接（手动打开兜底）。
- **模型**：一键「重新检测」（`force: true`），显示探测来源（实时检测/缓存
  快照/未验证快照）、当前账号与等级、两大配额分组卡片（`5h` 与 `weekly` 加粗
  窗口标签、大号百分比、通栏进度条与重置倒计时），以及精简版可用模型与可折叠
  不可用模型列表。
- **诊断日志**：级别过滤、刷新、复制、清空（复用日志 RPC）。

此外，通过独立受保护的 `ctx.inject(['slots', 'modelDirectories'], ...)` 软注入，
向 `conversation.input.right`（`order: 10`，紧邻模型选择器左侧）注册紧凑型
`ComposerQuotaBadge` 组件：
- 仅在当前会话所选 `provider` 属于插件 `providers` 时渲染无框对齐文字（如
  `5h | 87%`，无 5h 分组时回退 `quota | XX%`；每 60s 轮询并监听 `llm/models-updated`；
  点击可强制刷新；全部账号登出或 `AUTH` 失败时立即清空旧状态为 `5h | --`）。
- 悬停或键盘聚焦时通过 `ReactDOM.createPortal(..., document.body)` 弹出完整
  配额浮层（按两大配额分组展示进度条与重置时间，支持 `Escape` 关闭）。

所有服务访问可选链 + try/catch，`apply` 永不抛错（失败激活是致命
web-boot 错误）；样式用宿主主题 token，组件卸载时移除。

Host 侧 `AccountService` 是命令与 UI 的单一实现；RPC 路由
`/api/antigravity-gateway-account/{status,login,cancel,logout,import,models,switch}`
沿用日志 RPC 的 envelope 协议。**环回守卫**（与 dsh-antigravity-auth 同策略）：
WebServer 不存在（纯本地组合）或显式绑定 `127.0.0.1` 时启用；其他绑定下 RPC
注册为惰性路由（一律返回 `loopback-required`，不触碰服务），命令同样失败关闭。
DSH 的命令/RPC 调用不携带调用方权威，无法豁免本地用户，故 fail closed。

登录 URL 的 redirect_uri 在回调服务器绑定后重写为实际端口（oauthPort=0
随机端口时尤其重要），浏览器、Google、令牌交换三方一致。

## 7. 失败分类与重试

| 情形 | 码 | 行为 |
|---|---|---|
| 未登录 | AUTH | 提示 /agw login 或 /agw import |
| 401/403（未发射任何块） | AUTH | 强制刷新一次并重放；再失败则抛出 |
| 429 / 预检耗尽 / 发射前流内 429 | RATE_LIMIT | 当 `autoSwitchAccount` 为 true 且未发射任何块时，标记当前账号冷却并通过 CAS 选择最佳备用账号保留原 `model` 与 `reasoningEffort` 重试；全账号耗尽后解析 Retry-After（秒/HTTP-date，上限 1h）抛出 `RATE_LIMIT` |
| 400 + 溢出措辞 | CONTEXT_WINDOW_EXCEEDED | 触发 DSH 压缩路径 |
| 503 + 容量措辞 | SERVER | 未发射块时退避重试 ≤2 次（1.5s/3s，上限 8s） |
| 404（计划不可用模型） | MODEL_UNSUPPORTED | 查询/刷新实时可用性并附带上游原因说明 |
| 其他 4xx/5xx | HTTP_<n> / SERVER | 直接分类 |
| 连接/TLS/超时 | TRANSPORT / TIMEOUT | 端点回退一次 |
| 流中 error 事件 | 按 status 映射 | 终止 finish(error) |
| 空响应 | EMPTY_RESPONSE | 可重试码 |
| 中止 | ABORTED | 终止 finish(aborted) |

适配器自身不重跑成功请求；DSH 的 dsh-llm-retry 在 agent 步边界执行
重试策略。GatewayError → LlmError 的码映射（0.x 保留 `@deprecated BridgeError` 别名）：
INVALID_MODEL→UNKNOWN_MODEL、PROTOCOL_DRIFT→MALFORMED_RESPONSE、CANCELLED→ABORTED，其余同名。

## 8. 凭据与安全

- 多账号兼容存储：令牌存 DSH 凭据记录 `dsh-antigravity-gateway/google-account`
  （kind: grant），**同时总是镜像到 owner-only（0600）JSON 文件**（原子写
  tmp+rename）。所有写操作经 `withWriteLock` 异步串行化：仅 1 个账号时保持
  v1 单对象形状（向后兼容旧版），2 个及以上账号自动升级为 v2 `CredentialVault`
  （`{ version: 2, activeAccountId, accounts }`）；`switchAccountIfCurrent()`
  提供 CAS 原子切号防止并发请求连续跳号。
- 身份去重与共享项目隔离：不同账号即使共享消费级项目 ID（`aicode-consumers`、
  `inductive-dreamer-qrkws`），若 `email` 不同（或缺少 `email` 时 `refreshToken`
  不同）绝不合并覆盖；`oauth.ts` 同时从 Google `id_token` JWT 解析 `email` 作为
  `/userinfo` 偶发失败时的零网络兜底。
- 凭据服务按操作惰性解析（激活顺序不影响）；服务存在但记录为空时回退读文件镜像
  并迁移进服务。任何一次 Host 启动无论凭据服务是否就绪都能找到授权，重启不丢登录。
- 按账号隔离单飞刷新与代数守卫：并发请求共享各自 `accountId` 的刷新 Promise；
  Google 轮换的 refresh token 立即落盘；提前 60s 刷新。`accountGenerations`
  按账号隔离，仅在该账号登出或重新登录时失效对应在途刷新，`switchAccount`
  不中断其他账号正在进行的刷新。
- PKCE verifier 只存 Host 内存（state→verifier 映射），授权 URL 可安全
  展示。回调服务器只绑 127.0.0.1；错误 state 拒绝该请求但不终结待决
  登录；Google 显式 error（access_denied）才失败。
- 日志脱敏见 §9；凭据永不进日志、配置、工具输出。
- 登出只删本地凭据，不撤销 Google 授权。

## 9. 日志与诊断

PluginLogger（与 dsh-opencode-bridge 同设计）：五级
（debug/info/warn/error/off）、单文件上限 + 轮转（最旧先删）、磁盘失败
时内存环回退、永不抛错。脱敏：配置密钥、Bearer、`ya29.` 访问令牌、
`1//` 刷新令牌、`sk-/key-/token-/secret-` 形状；长字符串截断 2000。

请求诊断：失败 warn（模型/wire/耗时/码/状态），成功 info（块数/finish/
token 数），debug 级另有目录刷新、刷新令牌、端点回退等明细。
`REQUEST_DIAGNOSTICS_VERSION = 1`。

双入口：`antigravity_gateway_log` 工具与 `/api/antigravity-gateway-logs/*`
RPC（read/stat/clear/level），同一 `LogService` 实现，经 `src/dsh/rpc.ts`
统一挂载与账号控制一致的 `127.0.0.1` 环回守卫。

## 10. 测试、发布、演进剧本与排障

离线验证（`npm run verify` 包含 `typecheck:ts` + `typecheck:client` + `build` + 158 项 `node:test`）不访问 Google：
- **单元与协议层**：模型路由/载荷/schema/响应/catalog 解析/传输/代理/日志/凭据耐久/原子写盘/命令/提示兼容；
- **架构与契约守卫**：[architecture.test.mjs](tests/architecture.test.mjs) 校验四层单向依赖与无循环引用；[client-contract.test.mjs](tests/client-contract.test.mjs) 校验 `client.js` 加载安全、`#agw-styles` 去重与前后端 `rpc-contracts.ts` 100% 一致；
- **端到端集成（本机假端点）**：文本/并行同名工具调用/401 刷新重放/404 禁用原因诊断/429 与预检及流内 429 自动切号（并发 CAS）/503 容量退避恢复/流内错误/空响应/多轮思考签名回放/卸载释放回调端口与 RPC 路由。

CI：Node 22/24 × Ubuntu/Windows 矩阵，执行 `typecheck` + `build` + `test:only` + 打包产物校验 + 工作树清洁检查。
发布：推 `v*` 标签 → 身份校验（标签=package.json=CHANGELOG 小节=README 引用）→ 全量校验 → 打包校验（禁止包含 `.npm-cache/`、`node_modules/`、`docs/refactoring/`）→ SHA256 → GitHub Release。

### 常见变更演进剧本（Playbooks）

1. **新增或下线 Antigravity 模型**：
   - 在 [src/protocol/models.ts](src/protocol/models.ts) 更新 `MODEL_DEFINITIONS`（或 `ID_ALIASES`），**必须**核对来自最新 `agy CLI` 目录或抓包的真实 wire 名、`model_enum` 与限额观测依据（标注社区观测值）。
   - 在 [tests/models.test.mjs](tests/models.test.mjs) 补齐路由/档位/枚举断言，必要时在 [tests/catalog.test.mjs](tests/catalog.test.mjs) 补充可用性解析测试。
2. **应对 Antigravity 上游协议漂移**：
   - 定位层完全收敛在 `src/protocol/`（如 [constants.ts](src/protocol/constants.ts) 的 UA/端点/路径、[payload.ts](src/protocol/payload.ts) 的字段序/labels/Claude 变换、[schema-sanitizer.ts](src/protocol/schema-sanitizer.ts) 的 Schema 白名单、[response.ts](src/protocol/response.ts) 的 SSE/签名提取）及 [src/core/transport/](src/core/transport/index.ts)。
   - 先更新日期标注与脱敏观测记录，再修改协议模块并在 `tests/{payload,schema,response,adapter}.test.mjs` 补充回归测试。
3. **应对 DSH 宿主版本升级**：
   - 宿主接口收敛在 `src/dsh/`（如 [types.ts](src/dsh/types.ts)、[config.ts](src/dsh/config.ts)、[rpc.ts](src/dsh/rpc.ts)、[adapter.ts](src/dsh/adapter.ts)、[stream-assembler.ts](src/dsh/stream-assembler.ts)）与前端 [client.js](client.js)。
   - 更新后必须通过 `npm run verify`（含 `typecheck:client` 与 `client-contract.test.mjs`）。

### 已验证运行环境与典型排障

- **已验证环境**：Node.js `24.18.0`（Windows 11 本地实测通过离线验证；CI 覆盖 Ubuntu/Windows × Node 22/24）；DSH 目标开发基线 `@deepseek-ai/dsh-llm@0.2.2-rc.5` / `@deepseek-ai/cordis@4.1.0`。真实 Google 上游调用与 DSH Desktop 完整宿主流程需在宿主内人工验证。
- **典型错误定位（排查时只看脱敏日志 `antigravity_gateway_log`）**：
  - `AUTH` / 401 重放失败：检查登录态（`/agw status`）或重新 `/agw login` / `/agw import`。
  - `MODEL_UNSUPPORTED`（404）：账号计划未包含该模型或上游暂未开放，在设置页「模型」tab 或 `/agw models` 查看上游 `reasonTitle`/`reasonDetail`。
  - `loopback-required`：DSH WebServer 未绑定 `127.0.0.1`（按安全策略账号与日志面板均 fail-closed）。
  - `TRANSPORT` / 连接超时：GUI 启动不继承 shell 环境变量时确认 `useSystemProxy: true`（Windows 系统代理）或显式配置 `proxyUrl`。
