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

```
DSH agent loop
   │  GenerateOptions / messages / tools
   ▼
AntigravityBridgeAdapter            src/adapter.ts
   ├── resolveRoute                 模型 id + 努力级 → wire 路由（src/models.ts）
   ├── AuthManager.getCredential    单飞刷新（src/auth.ts）
   ├── buildEnvelope                消息映射 + Claude 变换 + 元数据（src/payload.ts）
   ├── AgyTransport.request         undici + 代理 + 超时（src/transport.ts）
   ├── iterateSse / parseProviderEvent   SSE → 中性 part（src/response.ts）
   └── StreamChunk 发射 + replayState
   ▼
https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
   （传输失败时回退 https://cloudcode-pa.googleapis.com）
```

其余模块：

| 模块 | 职责 |
|---|---|
| [constants.ts](../src/constants.ts) | OAuth 客户端、端点、路径、CLI 身份、Claude 提示常量 |
| [models.ts](../src/models.ts) | 固定模型目录、wire 枚举、档位解析、别名规范化（§3） |
| [catalog.ts](../src/catalog.ts) | 账号实时目录：fetchAvailableModels + TTL + 快照回退（§3.2） |
| [credentials.ts](../src/credentials.ts) | DSH 凭据记录优先，owner-only 文件回退（§8） |
| [oauth.ts](../src/oauth.ts) | PKCE S256、环回回调服务器、令牌交换/刷新（§8） |
| [auth.ts](../src/auth.ts) | 登录编排、单飞刷新、项目发现、显式导入（§8） |
| [payload.ts](../src/payload.ts) | envelope、字段序、labels、Claude 变换、签名回放（§4） |
| [response.ts](../src/response.ts) | SSE 事件解析、usage、finishReason、签名提取（§5） |
| [errors.ts](../src/errors.ts) | 失败分类、Retry-After、溢出/容量措辞检测（§7） |
| [logger.ts](../src/logger.ts)、[log-service.ts](../src/log-service.ts) | 有界脱敏日志 + 工具/RPC 双入口（§9） |
| [prompt-compat.ts](../src/prompt-compat.ts) | 429 身份句改写（§4.4） |
| [commands.ts](../src/commands.ts) | /agw 命令族（§6.2） |
| [account-service.ts](../src/account-service.ts) | 账号操作单一实现 + RPC + 环回守卫（§6.3） |
| [client.js](../client.js) | 设置页浏览器模块（非 tsc 产物，§6.3） |
| [index.ts](../src/index.ts) | Config schema + apply 装配 |

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

客户端 id/secret 是 Antigravity CLI 内嵌的公开桌面客户端凭据
（`1071006060591-…apps.googleusercontent.com`），不是机密。 scopes 与 CLI
一致：cloud-platform、userinfo.email、userinfo.profile、cclog、
experimentsandconfigs。

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
  `catalog-cache.json`（按 `accountKey` 隔离，不含任何令牌）。实时探测失败
  （如启动初期断网）优先回退到该账号上次已验证的缓存目录，避免把禁用或
  未提供模型放进选择器；仅在该账号从未成功拉取过实时目录时才回退完整
  固定快照。
- TTL 默认 30s（`refresh` /「重新检测」传 `force: true` 跳过缓存）；登出/
  导入时连同磁盘缓存一并清空。目录变化通过 `registration.replace(providers)`
  和 `llm/models-updated` 通知 DSH 模型目录。

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
| imageInput | true | 图片输入 |
| maxImageBytes | 10MiB | 单图上限 |
| proxyUrl | '' | 显式代理 |
| useSystemProxy | true | 无 env/配置时读 Windows 系统代理 |
| logLevel / logDir / logMaxBytes / logMaxFiles | info / 自动 / 512KiB / 5 | §9 |
| credentialFile | '' | 文件回退路径覆盖 |
| dumpRequestsTo | 未设 | 请求落盘诊断 |

### 6.2 命令

`/agw`（别名 `/antigravity-gateway`）：status/login/cancel/logout/import/
models/refresh。命令不产生模型消息；登录在后台完成，命令立即返回
URL 与指引。import 只读 dsh-antigravity-auth 的 auth.json
（Windows `%LOCALAPPDATA%/dsh-antigravity-auth/auth.json`，POSIX
`$XDG_DATA_HOME/dsh-antigravity-auth/auth.json`），取 refreshToken +
projectId 后自行刷新，不写对方存储。

### 6.3 设置页与账号 RPC

客户端半块 `client.js` 经 `window.__ModuleLoader__.load` 注册（id = 包名），
React 来自宿主浏览器模块表，不重复安装。`apply` 内：locale 先注册
`settings.antigravityGateway` 命名空间再 bind（中英双语，失败降级到内置
字典）；从 `connection.rpc` 取 RPC 客户端；向 `settings.section` slot 注册
一个页面（id `antigravity-gateway`，order 31），三个 tab：

- **账号**：状态卡片（登录态/邮箱/项目/计划等级/令牌过期/存储后端），
  登录/取消/导入/退出按钮；登录待决时每 2s 轮询 status，浏览器回调完成后
  卡片自动翻转；待决期展示授权链接（手动打开兜底）。
- **模型**：一键「重新检测」（`force: true`），显示探测来源（实时检测/缓存
  快照/未验证快照）、账号等级、配额摘要（5 小时与每周窗口），以及当前
  账号的可用模型（含剩余配额）与不可用模型（含上游锁定/未提供原因）。
- **诊断日志**：级别过滤、刷新、复制、清空（复用日志 RPC）。

所有服务访问可选链 + try/catch，`apply` 永不抛错（失败激活是致命
web-boot 错误）；样式用宿主主题 token，组件卸载时移除。

Host 侧 `AccountService` 是命令与 UI 的单一实现；RPC 路由
`/api/antigravity-gateway-account/{status,login,cancel,logout,import,models}`
沿用日志 RPC 的 envelope 协议。**环回守卫**（与 dsh-antigravity-auth 同策
略）：WebServer 不存在（纯本地组合）或显式绑定 `127.0.0.1` 时启用；其他
绑定下 RPC 注册为惰性路由（一律返回 `loopback-required`，不触碰服务），
命令同样失败关闭。DSH 的命令/RPC 调用不携带调用方权威，无法豁免本地
用户，故 fail closed。

登录 URL 的 redirect_uri 在回调服务器绑定后重写为实际端口（oauthPort=0
随机端口时尤其重要），浏览器、Google、令牌交换三方一致。

## 7. 失败分类与重试

| 情形 | 码 | 行为 |
|---|---|---|
| 未登录 | AUTH | 提示 /agw login 或 /agw import |
| 401/403（未发射任何块） | AUTH | 强制刷新一次并重放；再失败则抛出 |
| 429 | RATE_LIMIT | 解析 Retry-After（秒/HTTP-date，上限 1h）随失败携带 |
| 400 + 溢出措辞 | CONTEXT_WINDOW_EXCEEDED | 触发 DSH 压缩路径 |
| 503 + 容量措辞 | SERVER | 未发射块时退避重试 ≤2 次（1.5s/3s，上限 8s） |
| 404（计划不可用模型） | MODEL_UNSUPPORTED | 查询/刷新实时可用性并附带上游原因说明 |
| 其他 4xx/5xx | HTTP_<n> / SERVER | 直接分类 |
| 连接/TLS/超时 | TRANSPORT / TIMEOUT | 端点回退一次 |
| 流中 error 事件 | 按 status 映射 | 终止 finish(error) |
| 空响应 | EMPTY_RESPONSE | 可重试码 |
| 中止 | ABORTED | 终止 finish(aborted) |

适配器自身不重跑成功请求；DSH 的 dsh-llm-retry 在 agent 步边界执行
重试策略。BridgeError → LlmError 的码映射：INVALID_MODEL→UNKNOWN_MODEL、
PROTOCOL_DRIFT→MALFORMED_RESPONSE、CANCELLED→ABORTED，其余同名。

## 8. 凭据与安全

- 令牌存 DSH 凭据记录 `dsh-antigravity-gateway/google-account`
  （kind: grant），**同时总是镜像到 owner-only（0600）JSON 文件**（原子写
  tmp+rename）。凭据服务按操作惰性解析（激活顺序不影响）；服务存在但记录
  为空时回退读文件镜像并迁移进服务。任何一次 Host 启动无论凭据服务是否
  就绪都能找到授权，重启不丢登录。
- 刷新单飞：并发请求共享一个刷新 Promise；Google 轮换的 refresh token
  立即落盘。提前 60s 刷新。
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
RPC（read/stat/clear/level），同一 LogService 实现，为将来设置页预留。

## 10. 测试、发布与协议更新

离线测试（`npm test`，102 项）不访问 Google：模型/载荷/schema/响应/传输/日志/
目录/可用性与配额/OAuth/账号服务/凭据耐久单元验证 + 对本机假端点的适配器
端到端（含并行同名工具调用、401 刷新重放、404 禁用原因诊断、429、溢出、
签名回放、模型 envelope 逐字段断言），以及完整登录链路（本地回调 → 令牌
交换 → 项目发现 → 凭据落盘）与账号 RPC 环回策略。

CI：Node 22/24 × Ubuntu/Windows，typecheck + build + test + 工作树清洁
检查。发布：推 `v*` 标签 → 身份校验（标签=package.json=CHANGELOG 小节=
README 引用）→ 构建测试 → 打包校验 → SHA256 → GitHub Release（说明取
CHANGELOG 小节）。已存在 Release 不覆盖；标签移动拒绝发布。

协议漂移更新方法：
1. 用 mitmproxy 抓 agy CLI 当前版本的内容请求，核对 UA、字段序、labels、
   thinkingConfig 形状；更新 constants.ts / payload.ts 与本文档日期。
2. 新模型：读 CLI 目录或抓包拿 wire 名与枚举，加入 MODEL_DEFINITIONS，
   补路由测试。
3. 某路由被服务端移除后：后端拒绝会按标准失败码返回；届时从固定快照
   移除或保留为历史别名，更新 CHANGELOG。
