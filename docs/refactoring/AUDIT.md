# 现场实证审计报告（Phase 1）

> **审计基准**：`main` @ `aedfa19f7bafd5f6a70c40a00c57b4f7fc5536f8`（`v0.1.0`）
> **审计时间**：2026-11-26 00:58 +08:00
> **结论来源**：逐行阅读全部源码、测试、构建脚本、CI/Release 工作流及实跑命令输出。

---

## 1. 仓库规模与基线实证对照

与 [REQUIREMENTS.md §1.1](REQUIREMENTS.md) 预审快照核对如下：

| 维度 | 预审快照 | 现场实证结果 | 差异说明 |
|---|---|---|---|
| **运行时与工具链** | Node `>=20.18.1`，TS ESM (`strict` + `noUncheckedIndexedAccess`)，单依赖 `undici` | Node `v24.18.0`，npm `11.16.0`；`tsconfig.json` 与 `package.json` 完全一致 | 无偏差 |
| **`src/` 代码体量** | 17 个文件，约 5,257 行 | 17 个文件，实测 **5,256 行**（216,005 字节） | 一致（尾行差异 1 行） |
| **`client.js` 体量** | 约 651 行 | 实测 **651 行**（36,136 字节） | 完全一致 |
| **测试体量** | 约 11 个测试文件 / 106 个离线测试 | 11 个文件（2,112 行），实测 **106/106 离线测试全部通过** | README/TECHNICAL 文中写的“102”已过时，实际为 **106** |
| **工作区状态** | 检查 `.npm-cache/` 与用户既有修改 | `.npm-cache/` 与 `lib/` 均在 `.gitignore` 中，未进入 Git 索引；所有 tracked 文件均干净无修改；仅 `docs/refactoring/` 为未跟踪目录 | 干净，无需保护性 stash |

### 1.1 现有源文件体量明细

| 文件 | 行数 | 当前职责混杂度评估 |
|---|---|---|
| `src/catalog.ts` | 745 | 高：协议解析（`parseLiveCatalog`、`parseQuotaSummary`）+ 模型过滤报告（`buildReportFromParsed`）+ 网络探测 + 内存/磁盘缓存耦合 |
| `src/payload.ts` | 641 | 高：FNV-1a/会话元数据 + JSON Schema 清洗 + 消息/工具/生成配置组装耦合 |
| `src/adapter.ts` | 591 | 高：DSH `LlmAdapter` 调度/重试 + 流式 `StreamChunk` 组装状态机 + 错误映射 + 诊断落盘 |
| `src/transport.ts` | 431 | 中高：环境变量/Windows 注册表代理 + `undici` 客户端 + SSE/有界体读取耦合 |
| `src/auth.ts` | 390 | 中：OAuth 登录状态机 + 刷新单飞 + `loadCodeAssist` 发现 + 兄弟插件导入 + 浏览器拉起 |
| `src/models.ts` | 350 | 适中：纯模型定义表与路由解析（仅错误类导入可转入 `shared`） |
| `src/logger.ts` | 291 | 适中：文件轮转 + 脱敏 + 内存环回退 |
| `src/index.ts` | 284 | 中高：同时承载 Schemastery `Config` 定义、手写 21 字段 `cfg` 断言、插件装配与过宽全量导出 |
| `src/oauth.ts` | 237 | 适中：PKCE URL、token 表单交换/刷新、loopback HTTP 回调服务器 |
| `src/log-service.ts` | 226 | 中：业务逻辑 + 重复的 `/api` JSON-RPC 包装（缺失 disposer 与 loopback 守卫）+ 工具注册 |
| `src/account-service.ts` | 206 | 中：账号服务 + 重复的 `/api` JSON-RPC 包装（缺失 fiber disposer） |
| `src/response.ts` | 204 | 适中：纯 SSE 事件解析与 finishReason 映射 |
| `src/commands.ts` | 174 | 适中：`/agw` 命令分发与文本渲染 |
| `src/credentials.ts` | 169 | 适中：DSH credentials service 惰性解析 + 文件镜像迁移 |
| `src/constants.ts` | 116 | 纯净：协议与 OAuth 常量 |
| `src/errors.ts` | 112 | 纯净：错误类、HTTP 映射、`Retry-After` 与错误文本识别 |
| `src/prompt-compat.ts` | 89 | 纯净：系统提示组装改写兼容钩子 |

---

## 2. 现有功能与契约基线

经源码与测试核实，以下功能构成不可回归的基线契约：

1. **插件注册与激活**：`cordis.patch.yml` 标识 `id: dsh-antigravity-gateway`；`src/index.ts` 导出 `name = 'dsh-antigravity-gateway'`、`inject = ['llm']`、`Config`、`apply(ctx, config)`。
2. **LLM Adapter 能力**（`src/adapter.ts`）：
   - `providerInfo` 返回 `{ id: provider, name: 'Antigravity Gateway' }`；
   - `listModels` 仅返回启用模型（`disabled !== true` 且无 `-disabled` 后缀），对 `remainingFraction === 0` 加 `Quota 0% / 配额已用尽` 徽标，支持 `extraModels` 与未登录回退；
   - `resolveModel` 支持 `claude-opus-4-6-thinking`、`claude-sonnet-4-6`、`claude-opus-5-5`、`claude-sonnet-5-5`、`gemini-3.8-flash`、`gemini-4-{neon,hydrogen,carbon,argon}`、`gpt-oss-120b-medium` 及历史别名/前缀/档位后缀；
   - `stream` 支持文本/推理/并行同名 tool-call 分块、`replayState` 签名回放（缺失时回退 `skip_thought_signature_validator`）、图片 `inlineData` 附件（及超限/卸载降级）、401/403 单次刷新重放、429 `Retry-After`、400 溢出识别、503 容量有限退避（≤2 次）、404 结合实时可用性返回 `MODEL_UNSUPPORTED`、传输失败跨端点回退。
3. **认证与凭据**（`src/oauth.ts`, `src/auth.ts`, `src/credentials.ts`）：
   - PKCE S256 + `127.0.0.1` 环回回调（支持端口 `0` 动态重写 `redirect_uri`）；
   - `dsh-antigravity-gateway/google-account` 凭据记录与 `0600` 文件双写镜像及晚挂载迁移；
   - 只读导入 `dsh-antigravity-auth` 的 `auth.json`；
   - `loadCodeAssist` 项目与账号等级（`currentTier` / `paidTier`）发现。
4. **目录与配额**（`src/catalog.ts`）：
   - `fetchAvailableModels`（403 带 project 重试 `{}`）+ `retrieveUserQuotaSummary` + `agentModelSorts` 排序；
   - `catalog-cache.json` 按 `accountKey` 隔离缓存与离线保底；
   - 更新时触发 `registration.replace(providers)` 与 `ctx.emit('llm/models-updated', provider)`。
5. **命令、工具、兼容钩子与设置面板**：
   - `/agw` & `/antigravity-gateway`（`status|login|cancel|logout|import|models|refresh`）；
   - `antigravity_gateway_log` 工具与 `/api/antigravity-gateway-logs/{read,stat,clear,level}`；
   - `/api/antigravity-gateway-account/{status,login,cancel,logout,import,models}`；
   - `system-prompt/assemble` 仅对自有 provider 改写 harness 身份句（保留引号内路径/URL）；
   - `client.js` 通过 `window.__ModuleLoader__.load({ id: 'dsh-antigravity-gateway', factory })` 注册 `settings.section` 三 Tab 设置页，且 `apply()` 永不抛异常。

---

## 3. 已确认问题清单（含符号、行号与调用链证据）

### 3.1 P0 严重缺陷（资源泄漏 / 安全缺口 / 并发中断）

| ID | 类别 | 源码位置（符号与行号） | 实证问题与调用链 |
|---|---|---|---|
| **AUD-P0-01** | 生命周期泄漏 | `src/index.ts:159, 139-269` | `apply()` 创建 `auth = new AuthManager(...)`（L159），并在 `ctx.effect` 中绑定了 `registerLogAccess`、`transport.close()`、`registration?.()`、`registerCommands`、`registerAccountAccess`、`mountPromptCompatibility`，但**未注册 `() => auth.cancelLogin()`**。当用户在浏览器登录等待期重载或卸载插件时，`pendingLogin.server`（默认占用 `127.0.0.1:51121`）与 `timeout` 定时器均不会被释放。 |
| **AUD-P0-02** | 安全策略缺口与资源泄漏 | `src/log-service.ts:87-142, 220-222` | 1）`registerLogAccess()` 调用 `ctx.inject(['connection'], ...)`（L90）但**完全丢弃了返回值（Cordis fiber）及 `routeDisposers`**，函数末尾 `disposers`（L88, L148）仅收集了 `tools.register()` 的 disposer。插件卸载时，4 个 `/api/antigravity-gateway-logs/*` 路由和 `inject` 监听器永久残留。<br>2）`registerLogAccess()` 重复手写 JSON 解析与 `server-response` 包装，且**未挂载 `accountModeFor(webServer)` 环回守卫**。非 `127.0.0.1` 绑定下，远端调用者可读取日志、获知服务端 `dir` 绝对路径，并可调用 `clear` 清空日志或 `level` 修改运行级别。 |
| **AUD-P0-03** | 并发取消耦合 | `src/auth.ts:103-126` | `getCredential(signal, forceRefresh)` 将首个调用者的 `signal` 直接透传至共享单飞任务 `this.refresh(stored, signal)`（L117 → L126 `refreshAccessToken(..., signal)`）。若请求 A 在刷新途中被用户中止，共享 `refreshInFlight` 随即被 `ABORTED` 拒绝，连带打断正在等待同一刷新结果的并发请求 B；同时请求 B 自身的 `signal` 在 `refreshInFlight` 已存在时完全无效。 |

### 3.2 P1 重要缺陷（并发、状态抖动、池泄漏、挂起与测试盲区）

| ID | 类别 | 源码位置（符号与行号） | 实证问题与调用链 |
|---|---|---|---|
| **AUD-P1-01** | **【审计新发现】流中止挂起** | `src/transport.ts:367, 417-431`；实证于 `tests/transport.test.mjs:46-64` | `iterateSse()` 在循环内执行 `await withIdleTimeout(reader.read(), idleTimeoutMs)`（L367）。`withIdleTimeout`（L417-431）仅监听 `setTimeout(..., idleTimeoutMs)`，**完全未监听 `options.signal`**。当底层流阻塞且调用方取消请求时，协程会死等完整个 `idleTimeoutMs`（测试中 `5000ms` 实测耗时 **5007.4ms**，占 106 个测试总时长 5313ms 的 94%；生产环境默认 `180_000ms` 即 **挂起整整 3 分钟**）后才进入 catch 检查 `options.signal?.aborted`！ |
| **AUD-P1-02** | 并发竞争与排序震荡 | `src/catalog.ts:523-620, 394` | 1）`fetchLiveState()` 无 single-flight 去重，`apply()` 预热、`listModels()`、`registerModelDiscovery()` 或 `getAvailabilityReport()` 并发调用时会重复探测上游并并发写 `catalog-cache.json`。<br>2）`definitionsForReport()`（L599-602）与 `offlineReport()` 磁盘恢复分支（L617）均用 `MODEL_DEFINITIONS.filter(...)` 返回静态定义顺序，覆盖了 `buildReportFromParsed()`（L304-308）按上游 `agentModelSorts` 排好的顺序。结果是：首次在线拉取按 `agentOrder` 排序，TTL 命中走 `definitionsForReport` 退回静态顺序，`notifyIfChanged()`（L498-508）因 `id` 拼接签名变化而在**模型集合未变的情况下反复触发 `registration.replace()` 与 `llm/models-updated`**。<br>3）构造器 L394 硬编码默认端点数组，未复用 `constants.ts` 的 `ANTIGRAVITY_ENDPOINT_FALLBACKS`。 |
| **AUD-P1-03** | 连接池未关闭泄漏 | `src/transport.ts:156-176, 179-187` | `dispatcherFor(url)` 在 `this.dispatcherKey !== key`（如请求命中 `NO_PROXY` 切换 `direct`/`proxy`，或 5 分钟后系统代理变更）时直接覆盖 `this.dispatcher`（L164-174），**从未调用旧 `Dispatcher.close()`**，导致底层 socket/Agent 池泄漏并频繁重建；`close()` 也只关闭最后一次留存的单个 dispatcher。 |
| **AUD-P1-04** | 写盘竞争与临时文件残留 | `src/credentials.ts:160-162`；`src/catalog.ts:738-740` | 两处均使用固定临时文件名 `${file}.tmp` 进行 `writeFileSync` + `renameSync`，并发写盘会互相覆盖损坏临时文件；且异常路径未清理残留 `.tmp` 文件。 |
| **AUD-P1-05** | `account-service` fiber 未回收 | `src/account-service.ts:155-205` | `registerAccountAccess()` 保留了 `disposeRoutes`，但同样丢弃了 `ctx.inject(['connection'], ...)` 的返回 fiber（L157）。若在 `connection` 就绪前卸载插件或连接服务重挂载，该 inject 监听无法撤销。 |
| **AUD-P1-06** | 测试脚本构建脱节 | `package.json:31` | `"test": "node --test tests/*.test.mjs"` 直接导入 `../lib/*.js`，修改 `src/` 后若未先运行 `npm run build`，`npm test` 会静默测试过期的编译产物，造成误判。 |
| **AUD-P1-07** | 核心路径测试盲区 | `tests/` 覆盖范围统计 | `src/index.ts`（284 行）、`src/log-service.ts`（226 行）、`src/commands.ts`（174 行）、`src/prompt-compat.ts`（89 行）、`client.js`（651 行）当前均为 **0 覆盖**；`src/auth.ts` 的 `importFromAntigravityAuth` 与 `discoverAccountMetadata`（tier 解析）也缺独立单测。 |

### 3.3 P2 冗余、命名、UI 与文档债务

| ID | 类别 | 源码位置 | 实证问题 |
|---|---|---|---|
| **AUD-P2-01** | 重复解析与冗余导入 | `src/payload.ts:227, 247-253`<br>`src/adapter.ts:157, 270` | `buildRequestMetadata()` 重新调用 `resolveRoute(wireModel)`（而 `buildEnvelope` 已持有 `resolved`）；`adapter.ts:157` 对已静态导入的 `./models.js` 再次动态 `await import('./models.js')`；`adapter.ts:270` 在流式热路径上动态导入 `node:fs` 并调用同步 `appendFileSync`；`account-service.ts:46, 59` 私有字段 `this.logger` 赋值后从未被使用；`log-service.ts:125` `stat` 端点重复调用 `service.read()` 读取全部行仅为了取行数。 |
| **AUD-P2-02** | `imageInput` 能力声明不一致 | `src/adapter.ts:171, 193`<br>`src/index.ts:248` | 三处均硬编码 `inputModalities: ['text', 'image']`，当用户配置 `imageInput: false` 时未同步收口为 `['text']`。 |
| **AUD-P2-03** | 配置类型手写重复 | `src/index.ts:37-76, 101-123` | `apply()` 内手写了 21 个字段的 `cfg` 类型断言，与 `Config` Schemastery 定义重复且缺乏单一真相源。 |
| **AUD-P2-04** | `client.js` 样式去重、守卫提示与类型检查缺失 | `client.js:286-296, 506-508` | `useStyles()` 每次挂载均创建匿名 `<style>` 标签（缺少 `id="agw-styles"` 去重）；`LogPanel` 在收到 `loopback-required` 错误码时未像 `AccountPanel`/`ModelsPanel` 那样映射为 `t('loopbackRequired')`；全文件无 `// @ts-check` 与前后端 RPC 契约测试。 |
| **AUD-P2-05** | 历史命名与过宽导出 | `src/errors.ts`、`src/credentials.ts`、`src/logger.ts`、`src/adapter.ts`、`src/index.ts:22-35` | 仍残留 `BridgeError` / `BridgeCredential` / `BridgeLogger` / `AntigravityBridgeAdapter` 命名；`src/index.ts` 使用多个 `export *` 与内部辅助函数导出。 |
| **AUD-P2-06** | 文档链接失效与数字漂移 | `TECHNICAL.md:38-52`、`TECHNICAL.us.md:40-56`、`README*.md` | 根目录 `TECHNICAL*.md` 内表格使用 `../src/...` 相对路径，指向仓库上一级目录（在 GitHub 上全部 404）；`README*.md` 与 `TECHNICAL*.md` 仍记录 `102` 个测试（实际已有 `106` 个）。 |

---

## 4. 合理风险与待验证假设区分

### 4.1 合理风险（可控但需在重构中防范）
1. **单向依赖与循环引用风险**：将 `errors.ts`、`catalog-parser.ts`、`stream-assembler.ts` 拆出后，需通过静态 AST/import 扫描测试（`tests/architecture.test.mjs`）防止后续开发重新在 `protocol` 引入宿主或 `fs` 依赖。
2. **Windows 与 Linux 测试执行环境差异**：在 DSH Windows `workspace-write` 受限沙箱中，Node.js 默认多进程 `node --test` 会因 piped stdio 触发 `spawn EPERM`；在 CI（Ubuntu/Windows 标准 runner）及完整权限终端中正常。Phase 2 设计 `package.json` 测试脚本时不得使用仅兼容 bash 的语法（如 `&&` 无问题，但路径通配与环境变量语法须兼容 `cmd.exe` 与 `bash`）。
3. **向后兼容导出与外部引用**：外部用户或老版本测试可能从包根导入 `AntigravityBridgeAdapter` 或 `BridgeError`，通过 `D-001` 保留 `0.x` `@deprecated` 别名可消除迁移摩擦。

### 4.2 待验证假设（离线不可证实，须留待 Phase 5 人工 E2E 清单）
1. **真实 Google Antigravity 上游协议兼容性**：`v1internal:streamGenerateContent`、`fetchAvailableModels`、`retrieveUserQuotaSummary`、`loadCodeAssist` 在真实 Google 账号下的响应细节与 TLS 行为（本仓库严禁在自动化测试中发起真实上游调用，目前基于 2026-11-22 观测）。
2. **真实 DSH Host 运行时集成**：`window.__ModuleLoader__.load` 加载 `client.js`、CSS token 渲染、Cordis 晚挂载 `credentials`/`connection`/`systemPrompt` 服务顺序及热重载插件时的真实表现。
3. **跨插件 `dsh-antigravity-auth` 真实文件导入**：Windows `%LOCALAPPDATA%` 与 POSIX `$XDG_DATA_HOME` 下真实 `auth.json` 读取与刷新。

---

## 5. 现有验证基线汇总

| 检查项 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | PASS（0） | 仅覆盖 `src/**/*.ts`，未检查 `client.js` |
| 构建产物 | `npm run build` | PASS（0） | 输出至 `lib/` |
| 离线测试 | `npm test` | PASS（106/106） | 需完整权限执行（受限 Windows 沙箱因 `node --test` 子进程管道报 `spawn EPERM`）；`iterateSse stops on abort` 耗时 `5007ms` 暴露中止挂起问题 |
| 发布身份校验 | `node scripts/release-check.mjs --tag v0.1.0` | PASS（0） | 版本、`CHANGELOG.md`、`README*.md` 一致 |
