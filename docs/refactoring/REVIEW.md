# dsh-antigravity-gateway 重构独立审查与质量验收报告（REVIEW）

> **审查角色**：独立软件架构审查者 / 代码审查者 / 质量验收工程师  
> **审查分支**：`refactor/modular-architecture` @ `e7fceeb`（对比基线 `main` @ `aedfa19`）  
> **审查时间**：2026-11-26  
> **审查依据**：逐文件审阅实际源码、`client.js`、测试套件、构建/发布脚本、CI/CD 工作流、Git Diff 与全部 `docs/refactoring/` 文档，并独立复跑类型检查、构建、离线测试及打包校验。

---

## 1. 验收结论与发布前门槛评估

- **总体结论**：**有条件满足发布前条件（Conditional Go）**。
- **核心判断**：
  1. 本次重构**完整兑现了四层单向依赖架构**，100% 保留了 Antigravity 线缆协议语义、DSH 插件契约与用户凭据/配置存储格式；`REQUIREMENTS.md` 第 4 节及 `AUDIT.md` 中列出的全部 P0/P1 缺陷均已落地修复并配齐离线回归测试。
  2. 独立复跑 `npm run verify`（`tsc` + `checkJs` + `build` + **18 个文件 / 137 项离线测试**）、`npm run pack:local` 与 `release-check.mjs --tag v0.1.0 --archive-dir .` **全部通过**。
  3. **未发现 P0 阻塞性缺陷**，但独立代码审查发现 **1 项 P1 兼容性问题**（[client.js](client.js) 第 698–700 行 `slots.register` 方法解绑导致 `this` 上下文丢失，存在在真实 DSH 桌面端注册设置页时抛出 `TypeError` 的风险）及 **8 项 P2 维护性/边界优化项**。
- **发布前建议**：
  1. **发布前必做**：修复 **P1-01**（`client.js` 中 `slots.register` 保持 `this` 绑定，并在 `tests/client-contract.test.mjs` 中校验 `this` 指向）。
  2. **真机 E2E 核验**：按 [REPORT.md §6.2](REPORT.md) 在真实 DSH Desktop 环境完成安装升级、OAuth 登录/取消、Settings 面板渲染、模型调用与卸载清理的人工 E2E 验证后再合并至 `main` 并打 Tag 发布。

---

## 2. 独立复跑验证结果（实测证据）

| 验证项目 | 执行命令 | 环境与条件 | 实际结果 | 备注 |
|---|---|---|---|---|
| **TypeScript & Client 类型检查** | `npm run typecheck` | Windows 11 · Node `v24.18.0` | **PASS (`exit 0`)** | 覆盖 `tsconfig.json` 与 `tsconfig.client.json`（`checkJs` + `strict`） |
| **清理并编译** | `npm run build` | 同上 | **PASS (`exit 0`)** | `scripts/clean.mjs` 清空 `lib/` 并编译产出 ESM + `.d.ts` + `.map` |
| **全量离线测试** | `npm run verify` | 同上（无管道限制权限） | **PASS (`exit 0`)** | **18 个测试文件 / 137 个用例全部通过**，总耗时 ~463ms（受限沙箱下 `node --test` 默认进程隔离因 piped stdio 触发已知 `spawn EPERM`） |
| **本地打包与身份校验** | `npm run pack:local` + `node scripts/release-check.mjs --tag v0.1.0 --archive-dir .` | 同上 | **PASS (`exit 0`)** | 产出 `dsh-antigravity-gateway-0.1.0.tgz`（156.9 kB / 133 文件），`tar -tzf` 验证无 `.npm-cache/`、`node_modules/`、`docs/refactoring/` 或测试源码泄露；校验后已清理临时 `.tgz` |
| **工作区与基线核对** | `git status` / `git diff --stat aedfa19..HEAD` | `refactor/modular-architecture` | **干净** | 76 个文件变更（+5842 / -2542）；30 个 `src/**/*.ts`（5,214 行）、18 个 `tests/*.test.mjs`（3,231 行）、`client.js`（682 行）；无未提交脏改；`version` 保持 `0.1.0` |

---

## 3. 十四项审查维度逐项验收结论

| # | 审查维度 | 结论 | 实证摘要 |
|---|---|---|---|
| **1** | **原始需求满足度**（[REQUIREMENTS.md](REQUIREMENTS.md)） | **满足** | 四层架构、16 个旧扁平文件清理、P0/P1 缺陷闭环、0 覆盖模块补测、CI/开源治理、双语文档同步及 `AGENTS.md` 收敛均已完成，且严守 Non-Goals（未加无关特性、未改协议/版本号/依赖）。 |
| **2** | **目标架构符合度**（[PLAN.md](PLAN.md)） | **满足** | `src/shared/`（4 文件）、`src/protocol/`（7 文件）、`src/core/`（9 文件）、`src/dsh/`（9 文件）、`src/index.ts`（235 行薄入口）职责清晰，与 `PLAN.md` 映射表一致。 |
| **3** | **功能退化或兼容性** | **基本满足（存在 1 项 P1）** | 线缆协议（`AGY_REQUEST_FIELD_ORDER`、`model_enum`、FNV-1a、Claude `VALIDATED`、签名回放）、`cordis.patch.yml`、`credential.json` 与 `@deprecated Bridge*` 导出别名均兼容；唯 `client.js:698-700` `registerSlot` 解绑 `this` 存在宿主兼容性风险（见 **P1-01**）。 |
| **4** | **模块职责与依赖方向** | **满足** | `tests/architecture.test.mjs` 基于 TypeScript AST 静态校验单向边 `shared ← protocol ← core ← dsh ← index` 与环依赖检测；`src/protocol/` 无宿主、`undici`、`fs`/`http`/`net`/`child_process`/`fs-atomic.ts` 依赖。 |
| **5** | **DSH 与 Antigravity 隔离** | **满足** | `@deepseek-ai/*` 仅出现于 `src/dsh/`（`config.ts`、`adapter.ts`、`stream-assembler.ts`）；`src/core/` 通过结构化接口（`CredentialsServiceLike`）解耦宿主；`src/protocol/` 完全脱离 I/O 与宿主。 |
| **6** | **过度工程化评估** | **克制合理** | 运行时仅保留单依赖 `undici`；未引入 DI 容器、微服务或多余抽象；采用 `D-007` 零额外依赖方案；唯一略显空壳的是 `resolveGatewayConfig` 仅做 `as GatewayConfig` 强转（见 **P2-01**）。 |
| **7** | **安全性、凭据、并发与资源管理** | **整体可靠（有少量 P2 边界）** | Account 与 Log RPC 均通过 `src/dsh/rpc.ts` 挂载 `127.0.0.1` loopback 守卫；原子写盘采用 PID+UUID 唯一临时文件与失败清理；OAuth PKCE verifier 仅存内存且回调仅绑 `127.0.0.1`；`PluginLogger` 五级脱敏且无敏感内容入库；`AgyTransport` 有界池与 `apply()` 卸载均正确释放资源。仅存在 `logout()`/`refresh()` 写回竞争等极低概率边界（见 **P2-05**、**P2-06**）。 |
| **8** | **流式响应、认证、错误处理、取消与超时** | **可靠（有 2 项 P2 改进空间）** | `iterateSse` 竞态监听 `AbortSignal`（毫秒级退出）；`AuthManager.getCredential` 解除 caller abort 耦合；`ModelCatalog.fetchLiveState` 实现 `accountKey` single-flight 与代数防过期；401 单次刷新重放、429 `Retry-After`、400 溢出、503 有限退避均正常。`readBoundedText` 尚未对非 SSE 流体读取做 abort 竞态（见 **P2-03**），`startCallbackServer` 未调用 `closeAllConnections()`（见 **P2-04**）。 |
| **9** | **测试真实有效性** | **良好（存在少量盲区）** | 18 个测试文件 / 137 用例全部离线确定性运行，覆盖协议序列化、签名回放、并行同名工具调用、401/404/429/503 端到端链路、并发原子写盘、卸载端口释放与前后端 RPC 契约；但尚未校验 `slots.register` 的 `this` 绑定、流式中途 abort 传递与 `MAX_DISPATCHERS` 淘汰（见 **P1-01**、**P2-07**）。 |
| **10** | **CI/CD、构建与插件打包流程** | **合理可靠** | `ci.yml`（Ubuntu/Windows × Node 22/24）与 `release.yml` 均使用 SHA 锁定 Actions、`persist-credentials: false`、最小 `permissions`、`npm ci`、`typecheck` + `build` + `test:only` + `npm pack` 产物白名单验证 + clean-tree 检查；`package.json#files` 精确收敛为 `docs/DETAIL.md`，阻断 `docs/refactoring/` 打入发行包。仅 `pack:local` 重复执行一次 `build`（见 **P2-08**）。 |
| **11** | **文档与真实实现一致性** | **主体一致（归档文档有轻微偏差）** | `AGENTS.md`、`TECHNICAL.md`、`TECHNICAL.us.md`、`README.md`、`README.us.md`、`CONTRIBUTING.md`、`SECURITY.md` 全部相对链接经脚本校验 0 死链，3 类演进 Playbooks 准确。但 `REPORT.md` 将 18 个测试文件误记为 17 个，`PROGRESS.md` 保留了未清理的 Phase 1 `Work in Progress`/`Known Issues` 段落（见 **P2-08**）。 |
| **12** | **废弃代码、临时文件与无用依赖** | **源码干净（本地缓存目录需注意）** | 旧 16 个扁平 `src/*.ts` 已从 Git 彻底删除且无残留引用；`AccountService` 中无用 `logger` 字段与 `adapter.ts` 动态 `import('./models.js')` 已清理；工作区根目录存在历史 `.npm-cache/`（2026-11-22 创建，已在 `.gitignore` 忽略且未入打包产物，建议提交/归档前按 `AGENTS.md` §5 清理）。 |
| **13** | **误标 `DONE` 的未完成任务** | **无核心功能漏项** | `P0-001`~`P5-003` 共 23 项任务主体均已真实落地并可独立复现；仅 `PROGRESS.md` 文档收尾不够干净，以及 `P3-004` 在 `client.js` 引入了 P1 `this` 解绑问题。 |
| **14** | **长期维护与扩展能力** | **优秀** | 四层边界清晰、AST 自动化守卫防止架构腐化、`rpc-contracts.ts` + `client-contract.test.mjs` 守护前后端一致、`CredentialStore`/`AuthManager`/`ModelCatalog` 无全局单例，满足未来多账号与协议漂移演进。 |

---

## 4. 分级问题清单

> 本次审查**未发现 P0 级严重问题**。以下列出独立审查确认的 **1 项 P1 问题**与 **8 项 P2 优化建议**。

### P1：重要问题（建议在发布前修复）

#### [P1-01] `client.js` 中 `slots.register` 解绑导致 `this` 丢失，存在真机设置页注册失败风险
- **代码位置**：[client.js:696-710](../../client.js#L696-L710)（及验证盲区 [tests/client-contract.test.mjs:146-156](../../tests/client-contract.test.mjs#L146-L156)）
- **问题原因**：对比基线提交 `aedfa19`，`client.js` 原为 `ctx.slots.register(...)`（保留 `this === ctx.slots`）。在 `P3-004` 引入 `// @ts-check` 时，为消除闭包内 TS2722 可空报错，代码被改写为：
  ```js
  const registerSlot = slots.register;
  slots.inject('settings.section', () =>
    registerSlot({ ... }, GatewayPanel),
  );
  ```
  该方法提取剥离了接收器对象，在严格模式下 `registerSlot(...)` 执行时 `this` 为 `undefined`。同时，由于 `slots.inject` 的回调通常在 slot 声明时异步触发，若发生异常将逃逸出 `apply()` 内的同步 `try/catch`。
- **影响范围**：若 DSH 宿主 `@deepseek-ai/dsh-client-ui-slots` 或 Cordis 服务代理在 `register()` 内部访问 `this`，真实 DSH Desktop 中 **Settings → Antigravity Gateway** 页面将静默或异常注册失败；离线测试因 mock 对象未使用 `this` 而未能拦截该回归。
- **修复建议**：
  1. 在 [client.js](../../client.js) 改为 `slots.register.call(slots, ...)` 或 `const registerSlot = slots.register.bind(slots)`；
  2. 在 [tests/client-contract.test.mjs](../../tests/client-contract.test.mjs) 的 `slots.register` mock 中增加 `assert.equal(this, ctx.slots)` 断言。

---

### P2：一般维护性问题（可后续或顺手优化）

#### [P2-01] `resolveGatewayConfig` 仅做类型强转，未实际应用 Schema 默认值
- **代码位置**：[src/dsh/config.ts:47, 56-58](../../src/dsh/config.ts#L47-L58)、[src/index.ts:64, 74](../../src/index.ts#L64-L74)
- **问题原因**：`resolveGatewayConfig(raw)` 直接执行 `return raw as GatewayConfig`，未调用 `Config(raw)`；且 `dumpRequestsTo: Schema.string()` 导致 `GatewayConfig['dumpRequestsTo']` 被推导为必选 `string` 而非 `string | undefined`。
- **影响范围**：正常经 Cordis 运行时加载会先由宿主求值 `Config`，但若测试或集成方直接调用 `apply(ctx, {})` 传入空对象或部分配置，`cfg.providers.join(',')` 会直接抛出 `TypeError`。
- **修复建议**：在 `resolveGatewayConfig` 中通过 `Config(raw)` 归一化配置（需注意 `dumpRequestsTo` 可选性），并在 `tests/index.test.mjs` 补充 `apply(ctx, {})` 缺省配置用例。

#### [P2-02] `ModelCatalog` 在 TTL 过期后由 `list()` 刷新时未重置 `cachedFullReport`，导致配额与 Tier 缓存超期复用
- **代码位置**：[src/core/catalog.ts:142, 305-322](../../src/core/catalog.ts#L305-L322)
- **问题原因**：先调用 `getAvailabilityReport()` 会将 `this.cachedFullReport` 设为 `true`。30s TTL 过期后若先调用 `list()`（`includeTierAndQuota = false`, `force = false`），`runFetchLiveState` 刷新 `parsed` 与 `expiresAt` 时仅在 `else if (force)` 分支重置 `this.cachedFullReport = false`，导致 `cachedFullReport` 仍保持 `true`。
- **影响范围**：随后在新的 30s 窗口内调用非强制的 `getAvailabilityReport()`（如 `/agw models`）会命中缓存，返回上一周期的旧 `quotaGroups`/`tier` 并带新的 `checkedAt`（设置页“重新检测”与 `/agw refresh` 传 `force: true` 不受影响）。
- **修复建议**：在 `!includeTierAndQuota` 分支统一设置 `this.cachedFullReport = false`（或独立记录配额/Tier 的缓存有效期）。

#### [P2-03] `readBoundedText` 未对阻塞读流竞态监听 `AbortSignal`，且超限抛错时未取消底层 body
- **代码位置**：[src/core/transport/sse.ts:18-45](../../src/core/transport/sse.ts#L18-L45)、[src/core/transport/http-client.ts:173-176](../../src/core/transport/http-client.ts#L173-L176)、[src/core/auth.ts:302](../../src/core/auth.ts#L302)、[src/core/catalog.ts:451](../../src/core/catalog.ts#L451)
- **问题原因**：`http-client.ts` 在收到响应头后即在 `finally` 中清除请求级超时与 `signal` 监听；`iterateSse` 已通过 `withIdleTimeout` 竞态监听 `signal`，但 `readBoundedText` 仍只在循环顶部检查 `signal?.aborted`，未对 `reader.read()` 做 abort 竞态，且超限抛错时未调用 `reader.cancel()`。
- **影响范围**：非 SSE 响应（`loadCodeAssist`、`fetchAvailableModels`、错误体）若在响应头返回后网络卡顿且调用方取消请求，需等待底层 undici `bodyTimeout`（默认 180s）才返回；超限抛错时流关闭依赖 GC。
- **修复建议**：在 `readBoundedText` 中使用 `raceWithAbort(reader.read(), signal)`，并在异常退出路径调用 `await reader.cancel().catch(() => {})`。

#### [P2-04] `startCallbackServer` 关闭时未强制断开 Keep-Alive 连接
- **代码位置**：[src/core/oauth.ts:214-235](../../src/core/oauth.ts#L214-L235)
- **问题原因**：`close()` 仅调用 `server.close()`，未调用 Node 18.2+ 提供的 `server.closeAllConnections?.()`；且 `server.once('error', ...)` 未清理 `options.signal` 上的 `onAbort` 监听器。
- **影响范围**：当浏览器在回调端口（默认 `51121`）保留 HTTP keep-alive 连接（例如请求 `/favicon.ico` 或重定向页后未立即断开）时，取消登录或卸载插件后端口释放可能延迟至 Node 默认 keep-alive 超时（约 5s）。
- **修复建议**：在 `close()` 中调用 `server.closeAllConnections?.()`，并在 `error` 回调中 `options.signal?.removeEventListener('abort', onAbort)`。

#### [P2-05] `AuthManager.logout()` 与在途 `refresh()` 之间存在凭据写回竞争
- **代码位置**：[src/core/auth.ts:65, 114-140, 219-224](../../src/core/auth.ts#L114-L140)
- **问题原因**：`logout()` 调用 `store.delete()` 但不使进行中的 `refresh()` 失效；若刷新请求正好在 `logout()` 期间返回，仍会执行 `await this.store.write(next)`。
- **影响范围**：极低概率并发时序下，已退出登录的本地凭据可能被在途刷新重新写入。
- **修复建议**：为 `AuthManager` 引入类似 `ModelCatalog` 的代数计数 `authGeneration`，在 `logout()` / `importFromAntigravityAuth()` 时递增并清空 `refreshInFlight`，`refresh()` 写盘前校验代数未变。

#### [P2-06] `rpc.ts` 对 `webServer` 环回守卫状态的求值固化在 `connection` 挂载瞬间
- **代码位置**：[src/dsh/rpc.ts:49-50, 80-82](../../src/dsh/rpc.ts#L49-L50)（与重构前行为一致）
- **问题原因**：`registerRpcNamespace` 在 `ctx.inject(['connection'], ...)` 回调执行时读取一次 `ctxWithConnection.get?.('webServer')` 并固定 `mode`。
- **影响范围**：若特殊组合下 `webServer` 晚于 `connection` 挂载且绑定非 `127.0.0.1` 地址，路由不会动态切换为 `blocked`。
- **修复建议**：在每个 RPC 路由的 `fetch` 处理内动态调用 `accountModeFor(ctxWithConnection.get?.('webServer') as WebServerLike | undefined)`。

#### [P2-07] 测试覆盖边界可进一步补充
- **代码位置**：[tests/adapter.test.mjs](../../tests/adapter.test.mjs)、[tests/transport.test.mjs](../../tests/transport.test.mjs)、[tests/client-contract.test.mjs](../../tests/client-contract.test.mjs)
- **问题原因**：当前测试未覆盖流式中途触发 `AbortSignal` 退出、`hasEmitted.value === true` 后发生异常禁止重试、`dumpRequestsTo` 异步落盘验证，以及 `AgyTransport` 超过 `MAX_DISPATCHERS`（4）时的 LRU 淘汰关闭行为。
- **影响范围**：上述边界仅靠代码走读保障，缺少自动化回归护卫。
- **修复建议**：后续在对应测试文件增补离线用例（连同 `P1-01` 的 `this` 绑定断言）。

#### [P2-08] 文档、脚本与工作区清洁度细节不一致
- **代码位置**：
  - [docs/refactoring/REPORT.md:15](REPORT.md#L15)：测试文件数写为 `17 文件`，实际为 **18 文件 / 137 用例**（11 原有 + 7 新增）；
  - [docs/refactoring/PROGRESS.md:46-48, 62-85](PROGRESS.md#L62-L85)：`Completed Work` 中 `P1-003` 重复出现两次，且下半部分残留 Phase 1 时期的 `Work in Progress`、`Verification Results`（106 测试）、`Known Issues and Blockers` 与 `Pending Decisions` 未随 Phase 5 终态同步清理/更新；
  - [package.json:36-37](../../package.json#L36-L37)：`pack:local` 先运行 `npm run build`，随后的 `npm pack` 触发 `prepack` 再次执行 `npm run build`（重复编译一次）；
  - [TECHNICAL.md:378](../../TECHNICAL.md#L378) / [TECHNICAL.us.md:420](../../TECHNICAL.us.md#L420)：仍引用 `BridgeError → LlmError`，可同步为 `GatewayError → LlmError`（保留 `BridgeError` 别名说明）；
  - 工作区根目录残留 `2026-11-22` 生成的 `.npm-cache/`（虽被 `.gitignore` 忽略且未进入 `.tgz`，但 `AGENTS.md §5` 要求提交前清理工作区 `.npm-cache/`）。
- **修复建议**：修正文档数字与陈旧段落、简化 `pack:local` 为 `npm pack`、更新 `TECHNICAL*.md` 主符号名，并在最终合并前清理本地 `.npm-cache/`。
